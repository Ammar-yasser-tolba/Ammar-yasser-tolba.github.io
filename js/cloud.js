/* ============================================================================
 * cloud.js — Firebase Realtime Database sync (plain REST, no SDK)
 * ----------------------------------------------------------------------------
 *   1. CONFIG — the only thing you edit
 *   2. what syncs, and what deliberately does not
 *   3. credentials (Firebase Authentication)
 *   4. transport
 *   5. doc encode / decode against the IndexedDB cache
 *   6. real-time watch
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
 *   4. For a gate that actually protects the data, enable Build -> Authentication
 *      -> Sign-in method -> Email/Password, create one user for yourself, open
 *      that user and copy its uid, then set CONFIG.webApiKey (Project settings ->
 *      General -> your Web API key) and CONFIG.ownerUid. Rules -> paste:
 *        {
 *          "rules": {
 *            "portfolio": {
 *              ".read": true,
 *              "content":  { ".write": "auth != null && auth.uid == 'YOUR_UID'" },
 *              "feedback": { ".write": true },
 *              "likes":    { ".write": true },
 *              "views":    { ".write": true }
 *            }
 *          }
 *        }
 *      content holds the admin-owned data and is the only gated node; visitors
 *      legitimately need to write their own review, like and view. With
 *      webApiKey set, unlocking Admin asks for that email and password and every
 *      write carries the resulting ID token, so the rule above is enforced by
 *      Firebase rather than by a string in this file. A signed-out device that
 *      is refused on content stops trying to publish content and loses nothing
 *      else: it still reads, still follows live edits, still posts reviews.
 *   5. Without Authentication the only alternative is { ".write": true } on
 *      content plus CONFIG.secret as a legacy app secret (console -> Project
 *      settings -> Service accounts -> Database secrets — that tab exists only on
 *      projects old enough to have one). A brand-new project has no such secret,
 *      and an open content rule means anyone who reads the page source can edit
 *      or wipe your content for every visitor.
 *
 * A token is kept in sessionStorage, not localStorage: it dies with the tab
 * instead of sitting on a shared machine granting write access to whoever opens
 * the browser next. Re-enter the password once per tab.
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
    secret: '',                 // legacy app secret, only if Authentication is off
    webApiKey: '',              // Project settings -> General -> Web API key
    ownerUid: '',               // Authentication -> your user -> uid
    mediaMaxKB: 400,            // per-image budget for base64 inside the doc
    docMaxKB: 2048,             // doc ceiling; imagery is dropped past this
    pushDelay: 700,             // coalesce a burst of admin edits into one PUT
    pollMs: 8000,               // fallback cadence when streaming is unavailable
  };

  /* ---- 2. scope ----------------------------------------------------------- */
  const CONTENT_TYPES = ['project', 'skill', 'certificate', 'service', 'experience',
    'education', 'about', 'hero', 'contact', 'brand', 'section', 'card'];
  // Views and likes live in their own shared nodes (/views/<key>, /likes/<key>),
  // never inside the doc, so they are not part of it. Excluding them is also what
  // stops a card click from producing a content write.
  const STRIP = ['views', 'likes'];
  const SCHEMA = 1;
  const BINARY = /^(apk|vid)_/;   // APK/video blobs: far too large for JSON

  /* ---- state ------------------------------------------------------------- */
  let applying = false;         // local writes while adopting a cloud doc
  let disabled = false;         // permission lost: stop calling, stay local
  let contentBlocked = false;   // this device is a visitor: only content writes fail
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
  const credential = () => idToken || CONFIG.secret;
  const withAuth = u => {
    const c = credential();
    return !c ? u : u + (u.includes('?') ? '&' : '?') + 'auth=' + encodeURIComponent(c);
  };

  /* ---- 3. credentials -----------------------------------------------------
     Writes carry a Firebase ID token once Admin signs in, which is what makes
     the `auth.uid == ...` rule real. A legacy app secret is used instead when
     that is all the project has. */
  const AUTH_KEY = 'cloudAuth';
  let idToken = null, refreshToken = null, expiresAt = 0, refresher = null;

  const authAvailable = () => !!CONFIG.webApiKey && isURL(CONFIG.databaseURL);
  // "can authorise a write": a live token, or the refresh token to get one back,
  // since call() renews transparently when a request is refused.
  const authed = () => (!!idToken && Date.now() < expiresAt - 30000) || !!refreshToken;

  function remember(session) {
    try {
      if (!session) sessionStorage.removeItem(AUTH_KEY);
      else sessionStorage.setItem(AUTH_KEY, JSON.stringify(session));
    } catch (e) {}
  }

  function adopt(session) {
    idToken = session.id;
    refreshToken = session.refresh;
    expiresAt = session.expiresAt;
    remember(session);
    scheduleRefresh();
  }

  // An hour goes fast during an editing session: renew while the tab is still
  // open rather than failing the next save.
  function scheduleRefresh() {
    clearTimeout(refresher);
    if (!refreshToken || !enabled()) return;
    refresher = setTimeout(() => { renew().catch(() => {}); },
      Math.max(30000, expiresAt - Date.now() - 120000));
  }

  function signOut() {
    clearTimeout(refresher);
    idToken = null; refreshToken = null; expiresAt = 0;
    remember(null);
  }

  async function post(url, body) {
    try {
      const res = await fetch(url, {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: signal(),
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch (e) { return { ok: false, status: 0, data: {} }; }
  }

  /**
   * signIn(email, password) — {ok:true} or {ok:false, reason}. The password is
   * never stored anywhere; only the tokens the exchange returns are.
   */
  async function signIn(email, password) {
    if (!authAvailable()) return { ok: false, reason: 'no webApiKey configured' };
    const r = await post('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword'
      + '?key=' + encodeURIComponent(CONFIG.webApiKey),
      { email: String(email || '').trim(), password: String(password || ''), returnSecureToken: true });
    if (!r.ok) {
      return { ok: false, reason: (r.data.error && r.data.error.message) || ('HTTP ' + r.status) };
    }
    const d = r.data;
    // Checked here only to give a clear message; Firebase enforces the rule anyway.
    if (CONFIG.ownerUid && d.localId !== CONFIG.ownerUid) {
      return { ok: false, reason: 'WRONG_ACCOUNT' };
    }
    adopt({ id: d.idToken, refresh: d.refreshToken,
      expiresAt: Date.now() + Number(d.expiresIn || 3600) * 1000 });
    // A device that was locked out before now becomes able to write, so undo the
    // earlier give-up and publish whatever was edited while read-only.
    disabled = false; warned = false; contentBlocked = false;
    if (!source && !poller) startWatch(onChange);
    pushNow().catch(() => {});
    return { ok: true };
  }

  async function renew() {
    if (!refreshToken) return false;
    const r = await post('https://securetoken.googleapis.com/v1/token'
      + '?key=' + encodeURIComponent(CONFIG.webApiKey),
      { grant_type: 'refresh_token', refresh_token: refreshToken });
    if (!r.ok) { signOut(); return false; }
    adopt({ id: r.data.id_token, refresh: r.data.refresh_token,
      expiresAt: Date.now() + Number(r.data.expires_in || 3600) * 1000 });
    return true;
  }

  // A reload in the same tab must not ask for the password again.
  function restoreAuth() {
    let s = null;
    try { s = JSON.parse(sessionStorage.getItem(AUTH_KEY) || 'null'); } catch (e) {}
    if (!s || !s.id) return false;
    if (s.expiresAt - 30000 > Date.now()) {
      idToken = s.id; refreshToken = s.refresh; expiresAt = s.expiresAt;
      scheduleRefresh();
      return true;
    }
    if (s.refresh) { refreshToken = s.refresh; renew(); return true; }  // best effort
    return false;
  }

  /* ---- 4. transport ------------------------------------------------------ */
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
    const hint = authAvailable() && !idToken ? ' — Admin must sign in to sync' : '';
    console.warn('[cloud] Firebase refused the request. Check the Rules and the sign-in. '
      + 'The site keeps working from local data.');
    if (window.UI && UI.toast) {
      UI.toast('Cloud sync unavailable (HTTP ' + status + ') — using local data' + hint, 'err');
    }
  }

  async function call(method, url, value, headers) {
    const once = () => fetch(withAuth(url), {
      method,
      cache: 'no-store',
      // A GET with a Content-Type header is not what the REST examples send, so
      // only requests that carry a body claim to.
      headers: value === undefined ? Object.assign({}, headers)
        : Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
      body: value === undefined ? undefined : JSON.stringify(value),
      signal: signal(),
    });
    let res = await once();
    // An expired token and a refused rule look the same from here, so spend one
    // refresh before believing the answer.
    if ((res.status === 401 || res.status === 403) && refreshToken) {
      if (await renew()) res = await once();
    }
    return res;
  }

  async function getJSON(url) {
    if (!url) return null;
    try {
      const res = await call('GET', url);
      if (res.status === 404 || res.status === 204) return null;   // empty node
      if (res.status === 401 || res.status === 403) { deny(res.status); return null; }
      return res.ok ? await res.json() : null;
    } catch (e) { return null; }
  }

  async function send(method, url, value) {
    if (!url || !configured()) return false;
    try {
      const res = await call(method, url, value);
      if (res.status === 401 || res.status === 403) { deny(res.status); return false; }
      return res.ok;
    } catch (e) { return false; }
  }

  /**
   * Content is the one node the rules reserve for the owner, so a refusal here
   * means two very different things and must not get one answer:
   *   - a signed-out device was refused: correct and permanent, it is a visitor.
   *     Stop trying to publish and change nothing else, because this device can
   *     still read, still receives live updates and still posts reviews.
   *   - anything else (a signed-in owner refused, or no sign-in path exists):
   *     the setup itself is wrong, so say so and stop calling.
   */
  async function sendContent(doc) {
    try {
      const res = await call('PUT', contentURL(), doc);
      if (res.status === 401 || res.status === 403) {
        if (authAvailable() && !authed()) {
          if (!contentBlocked) {
            contentBlocked = true;
            console.info('[cloud] content is owner-only; edits on this device stay local until Admin signs in.');
          }
          return false;
        }
        deny(res.status);
        return false;
      }
      return res.ok;
    } catch (e) { return false; }
  }

  const sizeKB = doc => JSON.stringify(doc).length / 1024;

  /* ---- 5. doc <-> cache -------------------------------------------------- */

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
    if (!enabled() || applying || contentBlocked) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushNow, CONFIG.pushDelay);
  }

  async function pushNow() {
    if (!enabled() || applying) return false;
    clearTimeout(pushTimer);
    if (contentBlocked) return false;
    const doc = await exportContent();
    const raw = fingerprint(doc);
    if (!raw || raw === lastRaw) return false;      // counter churn only
    if (!(await sendContent(doc))) return false;
    lastRaw = raw;
    return true;
  }

  // A visitor may only ever touch their own child, which is precisely the path
  // the rules make publicly writable. Content is unreachable from here.
  const putFeedback = fb => send('PUT', feedbackNode() + '/' + encodeURIComponent(fb.id) + '.json', fb);
  const deleteFeedback = id => send('DELETE', feedbackNode() + '/' + encodeURIComponent(id) + '.json');

  /* ---- shared counters: likes and views ---------------------------------
     Both live in their own node under the root and are keyed by Counts.keyFor(),
     so a total belongs to the database rather than to any one browser. The rules
     leave both publicly writable; content is the only gated node.

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

     Being a node like any other, a counter write also arrives on the open
     stream: that is how a like or a view on one device repaints every other
     visitor's badge at the instant it happens, with no refresh. readCounters()
     covers the other half of the feel — the whole page's totals on load cost two
     requests rather than one per card.
  -------------------------------------------------------------------------- */
  // A page re-render (language switch, live edit) must not re-fetch every total,
  // so the last known value is kept per node and key.
  const counterCache = { likes: new Map(), views: new Map() };
  const counterURL = (node, key) =>
    root() + '/' + node + '/' + encodeURIComponent(key) + '.json';

  async function bumpCounter(node, key, delta) {
    if (!enabled() || !key) return null;
    const cache = counterCache[node];
    const url = counterURL(node, key);
    for (let attempt = 0; attempt < 3; attempt++) {
      let current = 0, etag = null, res;
      try {
        res = await call('GET', url, undefined, { 'X-Firebase-ETag': 'true' });
      } catch (e) { return null; }
      if (res.status === 401 || res.status === 403) { deny(res.status); return null; }
      if (res.ok) {
        try { current = Number(await res.json()) || 0; } catch (e) { current = 0; }
      }
      try { etag = res.headers.get('etag'); } catch (e) { etag = null; }

      const next = Math.max(0, current + delta);
      if (next === current) { cache.set(key, current); return current; }  // un-liking at zero

      if (!etag) {                                 // no CAS: last write wins
        if (!(await send('PUT', url, next))) return null;
        cache.set(key, next);
        return next;
      }

      try {
        res = await call('PUT', url, next, { 'if-match': etag });
      } catch (e) { return null; }
      if (res.ok) { cache.set(key, next); return next; }
      if (res.status === 412) continue;              // lost the race, retry
      if (res.status === 401 || res.status === 403) { deny(res.status); }
      return null;
    }
    return null;
  }

  /**
   * readCounter — a number, or null when the total could not be determined.
   * A key that has never been written is a real shared ZERO, not an unknown:
   * conflating the two is what makes a fresh project look broken.
   */
  async function readCounter(node, key) {
    if (!enabled() || !key) return null;
    const cache = counterCache[node];
    if (cache.has(key)) return cache.get(key);
    try {
      const res = await call('GET', counterURL(node, key));
      if (res.status === 404 || res.status === 204) { cache.set(key, 0); return 0; }
      if (res.status === 401 || res.status === 403) { deny(res.status); return null; }
      if (!res.ok) return null;
      const value = await res.json();
      const total = value == null ? 0 : (typeof value === 'number' ? value : null);
      if (total != null) cache.set(key, total);
      return total;
    } catch (e) { return null; }
  }

  const bumpLike = (key, delta) => bumpCounter('likes', key, delta);
  const readLike = key => readCounter('likes', key);
  const bumpView = key => bumpCounter('views', key, 1);
  const readView = key => readCounter('views', key);

  /**
   * readNode(node) — every total of one meter in a single request.
   *   {}    the node does not exist yet: every total is a real shared zero
   *   map   key -> total
   *   null  it could not be read at all, which must never be shown as 0
   */
  async function readNode(node) {
    try {
      const res = await call('GET', root() + '/' + node + '.json');
      if (res.status === 401 || res.status === 403) { deny(res.status); return null; }
      if (!res.ok) return null;
      const data = await res.json();
      if (data == null) return {};
      return typeof data === 'object' ? data : null;
    } catch (e) { return null; }
  }

  /**
   * readCounters() — the whole page's likes AND views in two round trips instead
   * of one per card per meter. This is what lets warm() stay cheap as the number
   * of projects grows. null means neither meter could be read.
   */
  async function readCounters() {
    if (!enabled()) return null;
    const both = await Promise.all([readNode('likes'), readNode('views')]);
    if (both[0] == null && both[1] == null) return null;
    return { likes: both[0], views: both[1] };
  }

  // Totals that arrive inside a bigger payload (the initial pull, or a whole-tree
  // put on the stream) still have to reach the page. `notBefore` is when that
  // snapshot was taken, so a visitor's own click cannot be undone by older news.
  function applyCounters(tree, notBefore) {
    if (!tree || typeof Counts === 'undefined') return;
    for (const node of ['likes', 'views']) {
      const meter = Counts[node];
      if (!meter) continue;
      const cache = counterCache[node];
      const map = tree[node];
      if (map == null) { cache.clear(); meter.resetAll(0, notBefore); continue; }  // gone
      for (const [k, v] of Object.entries(map)) {
        const total = Number(v) || 0;
        cache.set(k, total);
        meter.note(k, total, notBefore);
      }
    }
  }

  /* ---- 6. real-time watch ------------------------------------------------ */

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
    // Counter nodes: keep both caches exact and put the new total straight onto
    // the page, for likes as well as views. This is what makes another visitor's
    // click visible here without a reload.
    const counter = /^\/(likes|views)(?:\/([^/]+))?$/.exec(path);
    if (counter) {
      const node = counter[1];
      const meter = typeof Counts !== 'undefined' && Counts[node];
      const cache = counterCache[node];
      if (!meter) return;
      if (counter[2]) {
        const key = decodeURIComponent(counter[2]);
        // An emptied counter collapses to null, which is a shared ZERO.
        const total = data == null ? 0 : (Number(data) || 0);
        cache.set(key, total);
        meter.note(key, total);
        return;
      }
      cache.clear();
      if (data == null || typeof data !== 'object') { meter.resetAll(0); return; }
      for (const [k, v] of Object.entries(data)) {
        const total = Number(v) || 0;
        cache.set(k, total);
        meter.note(k, total);
      }
      return;
    }
    if (name === 'put' && path === '/') {
      applyCounters(data || {});
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
    restoreAuth();

    const pulledAt = Date.now();
    const tree = await getJSON(nodeURL());
    let synced = false, hadData = !!tree;
    if (tree) {
      // The one pull that happens anyway already carries every counter, so the
      // badges get their real totals without waiting on a per-key read.
      applyCounters(tree, pulledAt);
      synced = await hydrateFrom(tree);
      lastRaw = tree.content ? fingerprint(tree.content) : lastRaw;
    }
    // Only a device that can actually write seeds an empty database: otherwise
    // the first visitor takes a refusal and gets marked read-only for nothing.
    if (enabled() && !hadData && !(authAvailable() && !authed())) {
      if (await pushNow()) synced = true;
    }
    if (enabled()) startWatch(onChange);
    return { enabled: enabled(), synced, hadData, signedIn: authed() };
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
    CONFIG, enabled, init, followDB, bumpLike, readLike, bumpView, readView,
    readCounters, authAvailable, authed, signIn, signOut,
    get status() {
      return { enabled: enabled(), watching: !!source, polling: !!poller,
        disabled, contentBlocked, signedIn: authed() };
    },
  };
})();
