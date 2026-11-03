/* ============================================================================
 * counts.js — GLOBAL shared counters
 * ----------------------------------------------------------------------------
 * A view total belongs to the world, not to this browser. It is never written to
 * localStorage or IndexedDB and never painted from a browser-private number: a
 * badge either shows what the shared backend reported, or says it does not know.
 *
 * Two backends, one at a time, picked per request:
 *
 *   1. Firebase, once js/cloud.js is configured — /portfolio/views/<key>.
 *      Incremented by a conditional write and pushed back to every open visitor
 *      over the stream cloud.js already holds, so a view on one device shows up
 *      on another one without a reload.
 *   2. Abacus, which needs no setup at all:
 *        GET https://abacus.jasoncameron.dev/get/<ns>/<key>  -> {"value":N}
 *        GET https://abacus.jasoncameron.dev/hit/<ns>/<key>  -> {"value":N}
 *      A public counter service: shared by every device, but it cannot push, so
 *      open tabs converge on a timer (and when the tab regains focus) rather
 *      than at the instant of the click.
 *
 * Both use the same keyFor() value, so a project keeps one identity across them.
 * The totals themselves do not migrate when the backend changes: enabling
 * Firebase starts from whatever the shared node holds and counts up from there.
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
 * Counting NEVER blocks rendering: every call resolves to a number or null, and
 * null means "unknown", which is displayed as such.
 * ==========================================================================*/

const Counts = (() => {

  const BASE = 'https://abacus.jasoncameron.dev';
  const NS = 'ammar-portfolio-v1';      // bump if keys are ever reshaped
  const SITE_KEY = 'site--visitors';
  const MAX_KEY = 64;                   // service hard limit on the variable
  const TIMEOUT = 15000;                // see the cold-start note above
  const SEEN_KEY = 'counted_views';     // session dedupe, see hit()
  const RESYNC_MS = 60000;              // Abacus cannot push, see resync()
  const UNKNOWN = '—';                  // shown until the shared total arrives

  const cache = new Map();              // key -> last known global value
  const inflight = new Map();           // key -> Promise, single-flight
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
  const viaFirebase = () => typeof Cloud !== 'undefined'
    && typeof Cloud.bumpView === 'function' && Cloud.enabled();

  function abacus(verb, key) {
    let ctrl = null, timer = null;
    if ('AbortController' in window) {
      ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    }
    return fetch(`${BASE}/${verb}/${NS}/${key}`, {
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
   * fetchTotal('get'|'hit', key) — the shared number, or null when it could not
   * be determined. Whichever branch answers, the value came off a server.
   */
  function fetchTotal(verb, key) {
    if (viaFirebase()) {
      return verb === 'hit' ? Cloud.bumpView(key) : Cloud.readView(key);
    }
    return abacus(verb, key);
  }

  /* ---- reads and writes ---- */

  // A read may be served from cache; an increment may NOT, or warm() would make
  // every later card view a no-op. Hence two paths, one shared cache.
  function read(key) {
    if (!key) return Promise.resolve(null);
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    const slot = 'get:' + key;
    if (inflight.has(slot)) return inflight.get(slot);
    const p = Promise.resolve(fetchTotal('get', key)).then(value => {
      inflight.delete(slot);
      if (value != null) cache.set(key, value);
      return value;
    });
    inflight.set(slot, p);
    return p;
  }

  // Single-flight per key, but always reaches the service at least once.
  function bump(key) {
    if (!key) return Promise.resolve(null);
    const slot = 'hit:' + key;
    if (inflight.has(slot)) return inflight.get(slot);
    const p = Promise.resolve(fetchTotal('hit', key)).then(value => {
      inflight.delete(slot);
      if (value != null) cache.set(key, value);
      return value;
    });
    inflight.set(slot, p);
    return p;
  }

  const get = read;

  /* ---- one increment per visitor per session ---- */

  function seen() {
    try { return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) || '[]')); }
    catch (e) { return new Set(); }
  }

  // Re-opening the same card would otherwise let one visitor inflate the
  // global total indefinitely, so each key is counted at most once per session.
  // A failed request un-marks the key so a later interaction can retry it.
  function hit(key) {
    if (!key) return Promise.resolve(null);
    const done = seen();
    if (done.has(key)) return read(key);
    try {
      done.add(key);
      sessionStorage.setItem(SEEN_KEY, JSON.stringify([...done]));
    } catch (e) {}
    return bump(key).then(value => {
      if (value == null) {
        try {
          const now = seen();
          now.delete(key);
          sessionStorage.setItem(SEEN_KEY, JSON.stringify([...now]));
        } catch (e) {}
      }
      return value;
    });
  }

  /* ---- display ---- */

  // One formatter for both the placeholder and a real total, so a badge can
  // never look like a number it does not have.
  function label(value) { return '👁 ' + (value == null ? UNKNOWN : value); }

  // Mutates only the matching view badges: no re-render, no layout thrash.
  // Deliberately does NOT touch the cache — an optimistic value must never
  // suppress the real request that follows it. An unknown (null) leaves the last
  // shared value on screen rather than blanking it.
  function paint(key, value) {
    if (value == null || !key) return;
    document.querySelectorAll('.view-stat[data-ckey="' + key + '"]')
      .forEach(node => { node.textContent = label(value); });
  }

  function hitAndPaint(key) {
    return hit(key).then(value => { paint(key, value); return value; });
  }

  // Synchronous read of the last known global total, so a re-render (language
  // switch) starts from the real number instead of the placeholder.
  function cached(key) {
    return cache.has(key) ? cache.get(key) : null;
  }

  /**
   * warm(items) — read each shared total on load. Fire-and-forget: cards paint
   * as replies arrive, so a slow or unreachable backend cannot delay the page.
   */
  function warm(items) {
    watched = (items || []).map(keyFor).filter(Boolean);
    watched.forEach(key => get(key).then(value => paint(key, value)));
    keepInSync();
  }

  /**
   * resync() — re-read every key on the page. Unnecessary with Firebase (the
   * stream already repaints), and the point with Abacus: shared totals that
   * cannot push still reach an open tab without a reload.
   */
  function resync() {
    watched.forEach(key => {
      cache.delete(key);
      get(key).then(value => paint(key, value));
    });
  }

  // Installed once, on the first warm(). Polls only while the page is visible,
  // and only for the backend that has no push channel.
  function keepInSync() {
    if (resyncTimer || typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !viaFirebase()) resync();
    });
    resyncTimer = setInterval(() => {
      if (viaFirebase() || document.hidden) return;
      resync();
    }, RESYNC_MS);
  }

  return { keyFor, get, hit, hitAndPaint, paint, warm, resync, cached, label, SITE_KEY };
})();
