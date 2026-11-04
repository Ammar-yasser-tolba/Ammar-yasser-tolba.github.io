/* ============================================================================
 * counts.js — GLOBAL shared counters (views and likes)
 * ----------------------------------------------------------------------------
 * A total belongs to the world, not to this browser. Neither the view count nor
 * the like count is ever written to localStorage or IndexedDB, and neither is
 * ever painted from a browser-private number: a badge shows what the shared
 * backend reported. Until it reports, the badge shows 0 — an em dash or a blank
 * corner of a card reads to a visitor as a broken page.
 *
 * That 0 is a display choice and nothing more. Internally an unread total stays
 * null and is never written into the cache, so an optimistic +1 can never be
 * built on top of a placeholder, and a backend that is down cannot pass itself
 * off as a real zero to the rest of the code.
 *
 * Two meters, one code path, two backends (picked per request):
 *
 *   1. Firebase, once js/cloud.js is configured — /portfolio/views/<key> and
 *      /portfolio/likes/<key>. Both directions work (+1 and -1) through a
 *      conditional write, and every write comes back down the stream cloud.js
 *      already holds, so a click on one device repaints every other visitor's
 *      badge at once, with no reload.
 *   2. Abacus, which needs no setup at all:
 *        GET https://abacus.jasoncameron.dev/get/<ns>/<key>  -> {"value":N}
 *        GET https://abacus.jasoncameron.dev/hit/<ns>/<key>  -> {"value":N}
 *      Shared by every device, but it CANNOT subtract (measured: `hit?by=-1`
 *      still increments, and `by=3` adds only one) and it cannot push, so on
 *      this backend a like is written at most once per session and an un-like
 *      only re-reads the truth. Open tabs converge by re-reading the page a few
 *      keys at a time, instead of at the instant of the click.
 *
 * Each meter has its own Abacus namespace, because one variable cannot hold a
 * project's views and its likes at the same time; Firebase keeps them in their
 * own nodes. Both meters use the same keyFor() value, so a project keeps one
 * identity across backends. Totals do not migrate when the backend changes:
 * enabling Firebase starts from whatever the shared node holds.
 *
 * Abacus behaviour verified from here: `access-control-allow-origin: *`, no key
 * and no sign-up, `hit` creates the key on first use, a key that has never been
 * hit answers 404 {"error":"Key not found"} — which is a real shared ZERO, not an
 * unknown — and variable names must be 3..64 characters. GET is used for writes
 * as well, because PUT answers 308 with a redirect a browser cannot follow.
 * Its first request of a session can take many seconds (measured: over 15s cold,
 * then about 0.5s), which is why TIMEOUT is generous and why a slow read shows
 * the placeholder instead of quietly falling back to a local count.
 *
 * Counting NEVER blocks rendering and NEVER rejects: every call resolves to a
 * number or null, null means "the backend could not tell me", and a null leaves a
 * badge showing whatever it already had — which on a first load is the
 * placeholder. A network glitch can cost a number, never the layout.
 * ==========================================================================*/

const Counts = (() => {

  const BASE = 'https://abacus.jasoncameron.dev';
  const SITE_KEY = 'site--visitors';    // footer total, on the views meter
  const MAX_KEY = 64;                   // Abacus hard limit on the variable
  const TIMEOUT = 15000;                // see the cold-start note above
  const RESYNC_MS = 5000;               // Abacus cannot push, see resync()
  const RESYNC_BATCH = 6;               // keys per tick, so the sweep stays polite
  // What a badge shows before the shared total arrives. A number, not a dash: an
  // empty-looking corner reads as a broken page. It is a PLACEHOLDER only — it is
  // never written into the cache, so no read, no optimistic increment and no
  // comparison against a real total is ever built on it.
  const PLACEHOLDER = 0;

  const METERS = {
    views: {
      ns: 'ammar-portfolio-v1',
      seen: 'counted_views',            // session dedupe, see hit()
      sel: '.view-stat',
      label: value => '👁 ' + (value == null ? PLACEHOLDER : value),
      read: key => Cloud.readView(key),
      write: key => Cloud.bumpView(key),           // a view never goes down
      batch: tree => tree.views,
    },
    likes: {
      ns: 'ammar-portfolio-likes',
      seen: 'counted_likes',
      sel: '.like-count',
      label: value => String(value == null ? PLACEHOLDER : value),
      read: key => Cloud.readLike(key),
      write: (key, delta) => Cloud.bumpLike(key, delta),
      batch: tree => tree.likes,
    },
  };

  let watched = [];                     // keys on the page, for resync()
  let resyncTimer = null;

  /* ---- stable, cross-device keys ---- */

  function slug(text) {
    return String(text || '')
      .normalize('NFKD').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  }

  // djb2 in base36. Titles are the identity, but an Arabic-only title slugs to
  // nothing, so the signature keeps those items distinguishable.
  function sig(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  /**
   * keyFor(item) — seed ids are uid() values (timestamp + random), so they
   * differ on every device and cannot be shared. Keys are derived from the
   * English title instead, which is identical everywhere. An item may pin its
   * own key with `item.ckey` to keep a total across renames.
   */
  function keyFor(item) {
    if (!item) return null;
    // Guarded on presence: String(undefined) is "undefined", which would have
    // collapsed every item onto one shared counter. Sanitised because the key
    // goes into a URL path and an attribute selector.
    if (item.ckey) {
      const pinned = slug(String(item.ckey)).replace(/^-+|-+$/g, '');
      if (pinned.length >= 3) return pinned.slice(0, MAX_KEY);
    }
    const type = slug(item.type) || 'item';
    const title = (item.title && (item.title.en || item.title.ar)) || '';
    const stem = slug(title);
    const tag = sig(title || String(item.id || type));
    const key = stem ? `${type}--${stem}-${tag}` : `${type}--item-${tag}`;
    return key.length < 3 ? `${type}-${tag}`.slice(0, MAX_KEY) : key.slice(0, MAX_KEY);
  }

  /* ---- transports ---- */

  // Firebase owns the totals as soon as the database is configured, because it
  // can push them as well. `Cloud` is a later script, so this is asked per call.
  const useFirebase = () => typeof Cloud !== 'undefined'
    && typeof Cloud.bumpView === 'function' && Cloud.enabled();

  function abacus(cfg, verb, key) {
    let ctrl = null, timer = null;
    if ('AbortController' in window) {
      ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    }
    return fetch(`${BASE}/${verb}/${cfg.ns}/${key}`, {
      method: 'GET',
      cache: 'no-store',               // `hit` must never come from cache
      signal: ctrl && ctrl.signal,
    })
      .then(async res => {
        if (res.status === 404) return 0;             // never hit: a shared zero
        if (!res.ok) return null;
        const data = await res.json().catch(() => null);
        return data && typeof data.value === 'number' ? data.value : null;
      })
      .catch(() => null)
      .finally(() => { if (timer) clearTimeout(timer); });
  }

  /**
   * ask(cfg, key, delta) — the shared number, or null when it could not be
   * determined. `delta === 0` is a read; anything else is a write. Whichever
   * branch answers, the value came off a server.
   */
  function ask(cfg, key, delta) {
    if (useFirebase()) return delta === 0 ? cfg.read(key) : cfg.write(key, delta);
    // Abacus adds exactly one per request and cannot subtract at all, so a
    // negative delta asks for the current shared total instead of writing.
    return abacus(cfg, delta > 0 ? 'hit' : 'get', key);
  }

  /* ---- one meter: its own cache, its own in-flight map ---- */

  function makeMeter(name) {
    const cfg = METERS[name];
    const cache = new Map();              // key -> last known global value
    const inflight = new Map();           // slot -> Promise, single-flight
    const wroteAt = new Map();            // key -> when THIS device last wrote

    // ask() runs inside the executor, so a backend that throws synchronously
    // becomes a rejection here instead of unwinding the caller's stack, and the
    // answer a rejection turns into is the same null the transports already give
    // for "unknown". Nothing downstream can ever see a rejected promise, which is
    // what lets every call site stay fire-and-forget.
    const askSafe = (key, delta) =>
      new Promise(resolve => resolve(ask(cfg, key, delta))).catch(() => null);

    // A read may be served from cache; a write may NOT, or warm() would make
    // every later click a no-op. Hence two paths, one cache.
    function get(key) {
      if (!key) return Promise.resolve(null);
      if (cache.has(key)) return Promise.resolve(cache.get(key));
      const slot = 'get:' + key;
      if (inflight.has(slot)) return inflight.get(slot);
      // finally, not then: a slot left behind by a failed read would pin its
      // promise to that key and every later click would be answered by the dead
      // request instead of the service.
      const p = askSafe(key, 0).then(value => {
        if (value != null) cache.set(key, value);
        return value;
      }).finally(() => inflight.delete(slot));
      inflight.set(slot, p);
      return p;
    }

    // Single-flight per key and direction, but always reaches the service.
    function bump(key, delta) {
      if (!key) return Promise.resolve(null);
      const slot = 'hit:' + key + ':' + delta;
      if (inflight.has(slot)) return inflight.get(slot);
      const p = askSafe(key, delta).then(value => {
        if (value != null) { cache.set(key, value); wroteAt.set(key, Date.now()); }
        return value;
      }).finally(() => inflight.delete(slot));
      inflight.set(slot, p);
      return p;
    }

    /* ---- at most one dedupe'd write per visitor per session ---- */

    function seen() {
      try { return new Set(JSON.parse(sessionStorage.getItem(cfg.seen) || '[]')); }
      catch (e) { return new Set(); }
    }

    // What lives in the browser is only "has this visitor already written this
    // key" — never a count. Without it one visitor could inflate a shared total
    // by re-opening the same card. A failed write un-marks the key so a later
    // interaction can retry it.
    function mark(key, on) {
      try {
        const done = seen();
        if (on) done.add(key); else done.delete(key);
        sessionStorage.setItem(cfg.seen, JSON.stringify([...done]));
      } catch (e) {}
    }

    function hit(key) {
      if (!key) return Promise.resolve(null);
      if (seen().has(key)) return get(key);
      mark(key, true);
      return bump(key, 1).then(value => {
        if (value == null) mark(key, false);
        return value;
      });
    }

    /* ---- display ---- */

    // Mutates only the matching badges: no re-render, no layout thrash.
    // Deliberately does NOT touch the cache — an optimistic value must never
    // suppress the real request that follows it. An unknown (null) leaves the
    // number already on screen rather than blanking it, and a badge built before
    // any reply carries the placeholder, so a paint can only ever change a digit.
    // Guarded because most callers are fire-and-forget: a DOM failure here must
    // cost the update, not throw into a chain nobody is awaiting.
    function paint(key, value) {
      if (value == null || !key) return;
      try {
        document.querySelectorAll(cfg.sel + '[data-ckey="' + key + '"]')
          .forEach(node => { node.textContent = cfg.label(value); });
      } catch (e) {}
    }

    function hitAndPaint(key) {
      return hit(key).then(value => { paint(key, value); return value; });
    }

    function bumpAndPaint(key, delta) {
      return bump(key, delta).then(value => { paint(key, value); return value; });
    }

    // Re-read after dropping the cached value: what the backend says now, even
    // if this tab believed something else.
    function refresh(key) {
      if (!key) return Promise.resolve(null);
      cache.delete(key);
      return get(key).then(value => { paint(key, value); return value; });
    }

    /**
     * toggle(key, delta) — a visitor changing their own like.
     *   Firebase: a real +1/-1 conditional write, whose answer reaches every
     *   open tab through the stream.
     *   Abacus: cannot subtract, so a like is written at most once per session
     *   and an un-like writes nothing but re-reads — the badge keeps showing the
     *   number every other visitor sees, never a private, lower one.
     */
    function toggle(key, delta) {
      if (!key) return Promise.resolve(null);
      if (useFirebase()) return bumpAndPaint(key, delta);
      if (delta > 0) return hitAndPaint(key);
      return refresh(key);
    }

    // An authoritative value arrived from outside (the cloud stream, or a batch
    // read): remember it, so a re-render starts from the truth, and show it.
    // `notBefore` is when that snapshot was taken — a value older than this tab's
    // own last click must never walk a badge backwards.
    function note(key, value, notBefore) {
      if (value == null || !key) return;
      if (notBefore && (wroteAt.get(key) || 0) > notBefore) return;
      cache.set(key, value);
      paint(key, value);
    }

    // The whole counter node disappeared upstream: nothing on the page may keep
    // showing a total that no longer exists anywhere. Keys this device wrote more
    // recently keep their own value, and keys no longer on the page are dropped
    // so that a later read goes back to the service.
    function resetAll(value, notBefore) {
      watched.forEach(key => note(key, value, notBefore));
      for (const key of [...cache.keys()]) {
        if (!watched.includes(key)) cache.delete(key);
      }
    }

    // Synchronous read of the last known global total, so a re-render (language
    // switch) starts from the real number instead of the placeholder.
    function cached(key) {
      return cache.has(key) ? cache.get(key) : null;
    }

    return {
      get, bump, hit, hitAndPaint, bumpAndPaint, refresh, toggle,
      paint, note, resetAll, cached, label: cfg.label,
    };
  }

  const ALL = { views: makeMeter('views'), likes: makeMeter('likes') };
  const NAMES = Object.keys(ALL);

  /* ---- page-wide passes ---- */

  function pull(meter, keys, notBefore) {
    keys.forEach(key => meter.get(key).then(value => meter.note(key, value, notBefore)));
  }

  /**
   * warm(items) — put every shared total on the page. Fire-and-forget: cards
   * paint as replies arrive, so a slow or unreachable backend cannot delay the
   * page. With Firebase the whole set arrives in two requests (one per meter)
   * instead of one per card per meter, which is what makes the badges feel
   * instant on load.
   */
  function warm(items) {
    watched = [...new Set((items || []).map(keyFor).filter(Boolean))];
    cursor = 0;                          // a fresh page starts the sweep at the top
    const startedAt = Date.now();      // a click made while this is in flight wins

    if (useFirebase() && typeof Cloud.readCounters === 'function') {
      const apply = tree => NAMES.forEach(name => {
        const meter = ALL[name];
        const map = tree ? METERS[name].batch(tree) : null;
        // null map: this meter could not be read at all, so ask per key.
        if (map == null) return pull(meter, watched, startedAt);
        // A key the node does not list is a real shared zero, not an unknown.
        watched.forEach(key => meter.note(key, Number(map[key]) || 0, startedAt));
      });
      // Two requests for the whole page is the fast path. When it fails the
      // badges must still get real numbers, so fall back to the per-key reads
      // instead of leaving the placeholder standing there looking like a total.
      Promise.resolve().then(() => Cloud.readCounters()).then(apply,
        () => NAMES.forEach(name => pull(ALL[name], watched, startedAt)));
      keepInSync();
      return;
    }

    NAMES.forEach(name => pull(ALL[name], watched, startedAt));
    keepInSync();
  }

  /**
   * resync() — re-read shared totals this tab did not produce itself. Unnecessary
   * with Firebase (the stream is already the update), and the point with Abacus:
   * totals that cannot push still reach an open tab without a reload.
   *
   * It walks the page in slices rather than re-reading all ~30 keys every tick:
   * this is a free public counter service used by every visitor, and a full sweep
   * every few seconds per open tab would be both abusive and slower than the
   * small batch it replaces. One sweep covers the whole page every few ticks.
   */
  let cursor = 0;

  function sweep(count) {
    if (!watched.length) return;
    const end = Math.min(watched.length, cursor + count);
    for (; cursor < end; cursor++) {
      ALL.views.refresh(watched[cursor]);
      ALL.likes.refresh(watched[cursor]);
    }
    if (cursor >= watched.length) cursor = 0;
  }

  function resync() {
    if (useFirebase()) return;
    sweep(RESYNC_BATCH);
  }

  // Installed once, on the first warm(). Polls only while the page is visible,
  // and only for the backend that has no push channel. Coming back to the tab
  // restarts the sweep from the top of the page, where the visitor is looking.
  function keepInSync() {
    if (resyncTimer || typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || useFirebase()) return;
      cursor = 0;
      sweep(RESYNC_BATCH);
    });
    resyncTimer = setInterval(() => {
      if (document.hidden) return;
      resync();
    }, RESYNC_MS);
  }

  return { keyFor, warm, resync, SITE_KEY, views: ALL.views, likes: ALL.likes };
})();
