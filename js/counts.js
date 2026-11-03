/* ============================================================================
 * counts.js — GLOBAL shared counters (Abacus REST API)
 * ----------------------------------------------------------------------------
 * Every visitor on every device sees the same number, because the total lives
 * on a public counter service instead of in this browser's IndexedDB.
 *
 *   read      GET https://abacus.jasoncameron.dev/get/<ns>/<key>  -> {"value":N}
 *   increment GET https://abacus.jasoncameron.dev/hit/<ns>/<key>  -> {"value":N}
 *
 * Verified behaviour: `access-control-allow-origin: *`, no key/sign-up needed,
 * returns 404 `{"error":"Key not found"}` for a key that has never been hit,
 * and rejects variable names shorter than 3 or longer than 64 characters.
 * GET is used for writes as well: the service answers PUT with a 308 redirect
 * that browsers cannot follow, so `hit` must go over GET.
 *
 * Counting NEVER blocks rendering. Every call resolves to a number or null,
 * and null means "stay with the local fallback" — the site still works
 * offline, on file://, or if the service is down.
 * ==========================================================================*/

const Counts = (() => {

  const BASE = 'https://abacus.jasoncameron.dev';
  const NS = 'ammar-portfolio-v1';      // bump if keys are ever reshaped
  const SITE_KEY = 'site--visitors';
  const MAX_KEY = 64;                   // service hard limit on the variable
  const TIMEOUT = 5000;                 // never leave a request dangling
  const SEEN_KEY = 'counted_views';     // session dedupe, see hit()

  const cache = new Map();              // key -> last known global value
  const inflight = new Map();           // key -> Promise, single-flight

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

  /* ---- transport ---- */

  function request(verb, key) {
    if (!key) return Promise.resolve(null);
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
      .then(res => (res.ok ? res.json() : null))
      .then(data => (data && typeof data.value === 'number' ? data.value : null))
      .catch(() => null)
      .finally(() => { if (timer) clearTimeout(timer); });
  }

  // A read may be served from cache; an increment may NOT, or warm() would make
  // every later card view a no-op. Hence two paths, one shared cache.
  function read(key) {
    if (!key) return Promise.resolve(null);
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    const slot = 'get:' + key;
    if (inflight.has(slot)) return inflight.get(slot);
    const p = request('get', key).then(value => {
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
    const p = request('hit', key).then(value => {
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

  /* ---- micro DOM updates ---- */

  // Mutates only the matching view badges: no re-render, no layout thrash.
  // Deliberately does NOT touch the cache — an optimistic value must never
  // suppress the real request that follows it.
  function paint(key, value) {
    if (value == null || !key) return;
    document.querySelectorAll('.view-stat[data-ckey="' + key + '"]')
      .forEach(node => { node.textContent = '👁 ' + value; });
  }

  function hitAndPaint(key) {
    return hit(key).then(value => { paint(key, value); return value; });
  }

  // Synchronous read of the last known global total, so a re-render (language
  // switch) starts from the real number instead of flickering back to 0.
  function cached(key) {
    return cache.has(key) ? cache.get(key) : null;
  }

  /**
   * warm(items) — reads each global total on load. Fire-and-forget: the cards
   * paint instantly with their local number and the badge updates as replies
   * arrive, so a slow or unreachable service cannot delay the page.
   */
  function warm(items) {
    (items || []).forEach(item => {
      const key = keyFor(item);
      if (!key) return;
      get(key).then(value => paint(key, value));
    });
  }

  return { keyFor, get, hit, hitAndPaint, paint, warm, cached, SITE_KEY };
})();
