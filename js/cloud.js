/* ============================================================================
 * cloud.js — Firebase Realtime Database sync (plain REST, no SDK)
 * ----------------------------------------------------------------------------
 *   1. CONFIG — the only thing you edit
 *   2. what syncs, and what deliberately does not
 *   3. transport
 *   4. doc encode / decode against the IndexedDB cache
 *   5. real-time watch
 *
 * IndexedDB stays as the cache that paints instantly; the cloud is the shared
 * source of truth on top of it. With CONFIG.databaseURL empty this module is
 * inert and the site behaves exactly as before — still offline-safe and
 * file://-safe.
 *
 * FIREBASE SETUP (~3 minutes, one paste below)
 *   1. console.firebase.google.com -> new project -> Build -> Realtime Database
 *      -> Create database.
 *   2. Copy the Database URL, e.g. https://<id>-default-r.firebaseio.com
 *   3. Paste it into CONFIG.databaseURL.
 *   4. Rules -> paste:
 *        {
 *          "rules": {
 *            "portfolio": {
 *              ".read": true,
 *              "content":  { ".write": "auth != null" },
 *              "feedback": { ".write": true },
 *              "likes":    { ".write": true }
 *            }
 *          }
 *        }
 *      content holds the admin-owned data and is the only gated node; visitors
 *      legitimately need to write their own review and their own like.
 *   5. For that gated write, set CONFIG.secret. The REST API accepts `auth=` as
 *      a legacy app *secret* (console -> Project settings -> Service accounts ->
 *      Database secrets — only exists on projects old enough to have one) or a
 *      Firebase Auth ID token, which expires within about an hour. A brand-new
 *      project usually has neither, in which case leave it empty and change the
 *      content rule to { ".write": true }. That is an OPEN write path: anyone
 *      who reads the page source could edit or wipe your content for every
 *      visitor. Genuine protection means a real sign-in plus a uid check in the
 *      rules — ask and that can be added.
 *
 * VERIFIED against live firebaseio.com: cross-origin responses carry
 * access-control-allow-origin, and the OPTIONS preflight answers
 * "Allow: OPTIONS,GET,POST,PUT,DELETE,PATCH", so browser PUT writes are allowed.
 * Streaming is documented as `Accept: text/event-stream` with named
 * put / patch / keep-alive / cancel / auth_revoked events carrying {path, data}.
 * ==========================================================================*/

const Cloud = (() => {

  /* ---- 1. CONFIG ---------------------------------------------------------- */
  const CONFIG = {
    databaseURL: '',            // 'https://<id>-default-r.firebaseio.com'
    path: 'portfolio',          // root node owned by this site
    secret: '',                 // optional auth= credential for content writes
    mediaMaxKB: 400,            // per-image budget for base64 inside the doc
    docMaxKB: 2048,             // doc ceiling; imagery is dropped past this
    pushDelay: 700,             // coalesce a burst of admin edits into one PUT
    pollMs: 30000,              // fallback cadence when streaming is unavailable
  };

  /* ---- 2. scope ----------------------------------------------------------- */
  const CONTENT_TYPES = ['project', 'skill', 'certificate', 'service', 'experience',
    'education', 'about', 'hero', 'contact', 'brand', 'section', 'card'];
  // Views and likes already live on the shared counter service, so they are not
  // part of the doc. Excluding them is also what stops a card click from
  // producing a cloud write.
  const STRIP = ['views', 'likes'];
  const SCHEMA = 1;
  const BINARY = /^(apk|vid)_/;   // APK/video blobs: far too large for JSON

  /* ---- state ------------------------------------------------------------- */
  let applying = false;         // local writes while adopting a cloud doc
  let disabled = false;         // permission lost: stop calling, stay local
  let pushTimer = null, repullTimer = null;
  let source = null, poller = null;
  let lastRaw = null;           // echo + no-op detection
  let onChange = () => {};

  function isURL(u) {
    u = String(u || '');
    if (/^https:\/\/[A-Za-z0-9._-]+$/.test(u)) return true;
    // The Firebase Local Emulator Suite serves plain http on loopback only, so
    // that is the sole non-TLS exception: a real credential must never travel
    // over http to a host we cannot vouch for.
    return /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(u);
  }
  const enabled = () => !disabled && isURL(CONFIG.databaseURL);
  const configured = () => isURL(CONFIG.databaseURL);

  const root = () => CONFIG.databaseURL.replace(/\/+$/, '') + '/' +
    CONFIG.path.replace(/^\/+|\/+$/g, '');
  const nodeURL = () => root() + '.json';
  const contentURL = () => root() + '/content.json';
  const feedbackNode = () => root() + '/feedback';   // node, not *.json: child
  // paths are built by appending an id, and /feedback.json/<id>.json is a
  // different location that would silently create a key named "feedback.json".
  const withAuth = u => !CONFIG.secret ? u
    : u + (u.includes('?') ? '&' : '?') + 'auth=' + encodeURIComponent(CONFIG.secret);

  /* ---- 3. transport ------------------------------------------------------ */
  const TIMEOUT = 12000;
  function signal() {
    try { return AbortSignal.timeout(TIMEOUT); } catch (e) { return undefined; }
  }

  let warned = false;
  function deny(status) {
    if (warned) return;
    warned = true;
    disabled = true;
    stopWatch();
    const msg = 'Cloud sync unavailable (HTTP ' + status + ') — using local data';
    console.warn('[cloud] Firebase refused the request. Check the Rules and CONFIG.secret. '
      + 'The site keeps working from local data.');
    if (window.UI && UI.toast) UI.toast(msg, 'err');
  }

  async function getJSON(url) {
    if (!url) return null;
    try {
      const res = await fetch(withAuth(url), { cache: 'no-store', signal: signal() });
      if (res.status === 404 || res.status === 204) return null;   // empty node
      if (res.status === 401 || res.status === 403) { deny(res.status); return null; }
      return res.ok ? await res.json() : null;
    } catch (e) { return null; }
  }

  async function send(method, url, value) {
    if (!url || !configured()) return false;
    try {
      const res = await fetch(withAuth(url), {
        method,
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: value === undefined ? null : JSON.stringify(value),
        signal: signal(),
      });
      if (res.status === 401 || res.status === 403) { deny(res.status); return false; }
      return res.ok;
    } catch (e) { return false; }
  }

  const sizeKB = doc => JSON.stringify(doc).length / 1024;

  /* ---- 4. doc <-> cache -------------------------------------------------- */

  function refsOf(item) {
    const out = [];
    for (const f of ['cover', 'media', 'logo', 'img']) if (item[f]) out.push(item[f]);
    for (const f of ['apk', 'video']) if (item[f]) out.push(item[f]);
    for (const f of ['gallery', 'attachments']) {
      if (Array.isArray(item[f])) out.push(...item[f].filter(Boolean));
    }
    return out;
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  async function dataURLtoBlob(url) {
    try { const r = await fetch(url); return r.ok ? await r.blob() : null; }
    catch (e) { return null; }
  }

  // A stable fingerprint of everything the doc is responsible for. `updatedAt`
  // is excluded on purpose: it changes on every push and would defeat the
  // "nothing actually changed" and echo checks.
  function fingerprint(doc) {
    if (!doc || !doc.items) return null;
    return JSON.stringify({
      schema: doc.schema,
      items: doc.items,
      media: Object.keys(doc.media || {}).sort(),
    });
  }

  async function exportContent() {
    const items = {}, media = {};
    const wanted = new Set();
    for (const type of CONTENT_TYPES) {
      for (const item of await DB.getAll(type)) {
        const copy = Object.assign({}, item);
        for (const k of STRIP) delete copy[k];
        items[item.id] = copy;
        for (const ref of refsOf(item)) {
          if (ref.key && !BINARY.test(ref.key)) wanted.add(ref.key);
        }
      }
    }
    const skipped = [];
    for (const key of wanted) {
      const blob = await DB.getImage(key);
      if (!blob) continue;                                  // not on this device
      if (blob.size > CONFIG.mediaMaxKB * 1024) { skipped.push(key); continue; }
      try { media[key] = await blobToDataURL(blob); } catch (e) { skipped.push(key); }
    }

    const doc = { schema: SCHEMA, updatedAt: Date.now(), items, media };
    if (sizeKB(doc) > CONFIG.docMaxKB) {
      doc.media = {};
      doc.mediaOmitted = true;
      if (window.UI && UI.toast) UI.toast('Cloud doc too large — images not synced', 'err');
    } else if (skipped.length && window.UI && UI.toast) {
      UI.toast(skipped.length + ' upload(s) too large for cloud sync', 'err');
    }
    return doc;
  }

  /**
   * Adopt a cloud content doc. The cloud is authoritative, so local items of a
   * synced type that are absent upstream are deleted — that is how an admin
   * delete reaches every visitor. Per-item counters are merged back in because
   * they are not in the doc.
   */
  async function applyContent(doc) {
    if (!doc || doc.schema !== SCHEMA || !doc.items) return false;
    const raw = fingerprint(doc);
    if (!raw || raw === lastRaw) return false;               // our own echo
    lastRaw = raw;

    applying = true;
    let changed = false;
    try {
      const cloud = doc.items;
      // one pass per type: local index for diffing
      const localById = new Map();
      for (const type of CONTENT_TYPES) {
        for (const item of await DB.getAll(type)) localById.set(item.id, item);
      }
      for (const [id, item] of localById) {
        if (!(id in cloud)) { await DB.del(id); changed = true; }
      }
      for (const id of Object.keys(cloud)) {
        const remote = cloud[id];
        if (!remote || !CONTENT_TYPES.includes(remote.type)) continue;
        const local = localById.get(id);
        const merged = Object.assign({}, local, remote);
        if (!local || JSON.stringify(local) !== JSON.stringify(merged)) {
          await DB.put(merged); changed = true;
        }
      }
      // Adopt blobs we do not already have.
      for (const [key, dataURL] of Object.entries(doc.media || {})) {
        if (await DB.getImage(key)) continue;
        const blob = await dataURLtoBlob(dataURL);
        if (blob) { await DB.putImage(key, blob); changed = true; }
      }
    } finally {
      applying = false;
    }
    return changed;
  }

  // Reviews are merged in from the cloud, and a review the cloud no longer lists
  // is treated as moderated away (approved or rejected) and dropped locally. That
  // pruning only runs when a `feedback` node actually exists, so a review this
  // device wrote while sync was still unconfigured is not wiped on first connect.
  async function applyFeedback(node, prune) {
    applying = true;
    let changed = false;
    try {
      const cloud = node || {};
      const local = await DB.getAll('feedback');
      const localById = new Map(local.map(f => [f.id, f]));
      for (const id of Object.keys(cloud)) {
        const fb = cloud[id];
        if (!fb || fb.type !== 'feedback') continue;
        const known = localById.get(id);
        if (!known || known.status !== fb.status || known.comment !== fb.comment
          || known.rating !== fb.rating) {
          await DB.put(fb); changed = true;
        }
      }
      if (prune !== false) {
        for (const f of local) {
          if (!(f.id in cloud)) { await DB.del(f.id); changed = true; }
        }
      }
    } finally {
      applying = false;
    }
    return changed;
  }

  // A single review deleted upstream (the admin rejected it) cannot be detected by
  // the merge above: once its last child goes, the whole `feedback` node stops
  // existing, so absence proves nothing. Drop the local copy directly instead.
  async function dropFeedback(id) {
    applying = true;
    try {
      for (const f of await DB.getAll('feedback')) {
        if (f.id === id) { await DB.del(id); return true; }
      }
    } finally {
      applying = false;
    }
    return false;
  }

  async function hydrateFrom(tree) {
    if (!tree) return false;
    const a = await applyContent(tree.content);
    const b = await applyFeedback(tree.feedback, 'feedback' in tree);
    return a || b;
  }

  /* ---- push -------------------------------------------------------------- */

  function queuePush() {
    if (!enabled() || applying) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushNow, CONFIG.pushDelay);
  }

  async function pushNow() {
    if (!enabled() || applying) return false;
    clearTimeout(pushTimer);
    const doc = await exportContent();
    const raw = fingerprint(doc);
    if (!raw || raw === lastRaw) return false;      // counter churn only
    if (!(await send('PUT', contentURL(), doc))) return false;
    lastRaw = raw;
    return true;
  }

  // A visitor may only ever touch their own child, which is precisely the path
  // the rules make publicly writable. Content is unreachable from here.
  const putFeedback = fb => send('PUT', feedbackNode() + '/' + encodeURIComponent(fb.id) + '.json', fb);
  const deleteFeedback = id => send('DELETE', feedbackNode() + '/' + encodeURIComponent(id) + '.json');

  /* ---- shared like totals -----------------------------------------------
     The REST API has no atomic increment. Its documented equivalent is a
     conditional write: read the value plus its ETag, then PUT with `if-match`.
     A 412 means someone else wrote first, and the response carries their value
     and ETag, so we re-read and try again (bounded).

     Caveat verified as far as possible from here: the ETag is only readable
     from browser JS if the server lists it under Access-Control-Expose-Headers.
     Preflight does accept the X-Firebase-ETag request header, but exposure
     could not be confirmed because Firebase's public example database has no
     data left to fetch. So if the header comes back empty we fall back to a
     plain write: the total is still shared by everyone, just last-write-wins
     when two people click in the same instant.
  -------------------------------------------------------------------------- */
  const likeURL = key => root() + '/likes/' + encodeURIComponent(key) + '.json';
  // A page re-render (language switch, live edit) must not re-fetch every total,
  // so the last known value is kept per key and refreshed by each successful write.
  const likeCache = new Map();

  async function bumpLike(key, delta) {
    if (!enabled() || !key) return null;
    const url = likeURL(key);
    for (let attempt = 0; attempt < 3; attempt++) {
      let current = 0, etag = null;
      try {
        const res = await fetch(withAuth(url), {
          cache: 'no-store', headers: { 'X-Firebase-ETag': 'true' }, signal: signal(),
        });
        if (res.status === 401 || res.status === 403) { deny(res.status); return null; }
        if (res.ok) current = Number(await res.json()) || 0;
        try { etag = res.headers.get('etag'); } catch (e) { etag = null; }
      } catch (e) { return null; }

      const next = Math.max(0, current + delta);
      if (next === current) { likeCache.set(key, current); return current; }  // un-liking at zero

      if (!etag) {                                 // no CAS: last write wins
        if (!(await send('PUT', url, next))) return null;
        likeCache.set(key, next);
        return next;
      }

      try {
        const res = await fetch(withAuth(url), {
          method: 'PUT',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'if-match': etag },
          body: String(next),
          signal: signal(),
        });
        if (res.ok) { likeCache.set(key, next); return next; }
        if (res.status === 412) continue;              // lost the race, retry
        if (res.status === 401 || res.status === 403) { deny(res.status); }
        return null;
      } catch (e) { return null; }
    }
    return null;
  }

  async function readLike(key) {
    if (!enabled() || !key) return null;
    if (likeCache.has(key)) return likeCache.get(key);
    const value = await getJSON(likeURL(key));
    const total = typeof value === 'number' ? value : null;
    if (total != null) likeCache.set(key, total);
    return total;
  }

  /* ---- 5. real-time watch ------------------------------------------------ */

  function scheduleRepull() {
    clearTimeout(repullTimer);
    repullTimer = setTimeout(async () => {
      if (!enabled()) return;
      if (await hydrateFrom(await getJSON(nodeURL()))) onChange();
    }, 250);
  }

  /**
   * put / patch semantics from the streaming contract:
   *   put path "/"        -> whole node replaced
   *   put path "/content" -> replace content
   *   patch               -> partial, so refetch to stay correct
   */
  async function applyEvent(name, payload) {
    if (!payload) return;                            // keep-alive
    const path = String(payload.path || '/');
    const data = payload.data;
    // Like totals are not stored as items, but a write anywhere under /likes
    // makes our cached number stale — drop it so the next paint re-reads.
    if (path === '/likes' || /^\/likes\//.test(path)) {
      if (data == null) likeCache.clear();
      else {
        const one = /^\/likes\/([^/]+)$/.exec(path);
        if (one) likeCache.delete(decodeURIComponent(one[1]));
        else likeCache.clear();
      }
      return;
    }
    if (name === 'put' && path === '/') {
      if (await hydrateFrom(data || {})) onChange();
      return;
    }
    if (name === 'put' && /^\/content\/?$/.test(path)) {
      if (await applyContent(data)) onChange();
      return;
    }
    if (name === 'put' && /^\/feedback\/?$/.test(path)) {
      if (await applyFeedback(data)) onChange();
      return;
    }
    if (name === 'put' && data == null) {
      const one = /^\/feedback\/([^/]+)$/.exec(path);
      if (one) {
        if (await dropFeedback(decodeURIComponent(one[1]))) onChange();
        return;
      }
    }
    scheduleRepull();
  }

  function startWatch(cb) {
    if (typeof cb === 'function') onChange = cb;
    if (!enabled()) return false;
    stopWatch();
    if (typeof EventSource === 'function') {
      try {
        source = new EventSource(withAuth(nodeURL()));
        const handle = ev => {
          let payload = null;
          try { payload = JSON.parse(ev.data); } catch (e) { return; }
          applyEvent(ev.type, payload);
        };
        source.addEventListener('put', handle);
        source.addEventListener('patch', scheduleRepull);
        source.addEventListener('cancel', stopWatch);
        source.addEventListener('auth_revoked', () => deny(401));
        // EventSource reconnects by itself; only if that keeps failing do we poll.
        source.onerror = () => { if (!poller && source) startPolling(); };
        return true;
      } catch (e) { /* fall through */ }
    }
    startPolling();
    return false;
  }

  function startPolling() {
    stopPolling();
    poller = setInterval(async () => {
      if (!enabled()) return;
      if (await hydrateFrom(await getJSON(nodeURL()))) onChange();
    }, CONFIG.pollMs);
  }
  function stopPolling() { if (poller) { clearInterval(poller); poller = null; } }
  function stopWatch() {
    if (source) { try { source.close(); } catch (e) {} source = null; }
    stopPolling();
    clearTimeout(repullTimer);
  }

  /* ---- init -------------------------------------------------------------- */

  /**
   * init(onChange) — pull once, adopt, publish if the database is still empty,
   * then open the live stream. A failed pull is not an error: the local cache
   * still renders, which is the whole point of keeping it.
   */
  async function init(cb) {
    if (typeof cb === 'function') onChange = cb;
    if (!configured()) return { enabled: false, synced: false, hadData: false };

    const tree = await getJSON(nodeURL());
    let synced = false, hadData = !!tree;
    if (tree) {
      synced = await hydrateFrom(tree);
      lastRaw = tree.content ? fingerprint(tree.content) : lastRaw;
    }
    if (enabled() && !hadData) {
      // First device to visit an empty database seeds it for everyone else.
      if (await pushNow()) synced = true;
    }
    if (enabled()) startWatch(cb);
    return { enabled: enabled(), synced, hadData };
  }

  /**
   * followDB() — every local write becomes a cloud write, except writes made
   * while adopting a cloud doc. Requires the DB.onWrite hook in db.js.
   */
  function followDB() {
    if (typeof DB === 'undefined' || typeof DB.onWrite !== 'function') return false;
    DB.onWrite((kind, detail) => {
      if (applying || !enabled() || !detail) return;
      if (kind === 'remove' && detail.type === 'feedback') { deleteFeedback(detail.id); return; }
      if (detail.item && detail.item.type === 'feedback') { putFeedback(detail.item); return; }
      if (kind === 'image') { queuePush(); return; }
      queuePush();
    });
    return true;
  }

  return {
    CONFIG, enabled, init, followDB, bumpLike, readLike,
    get status() { return { enabled: enabled(), watching: !!source, polling: !!poller, disabled }; },
  };
})();
