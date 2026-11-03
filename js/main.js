/* ============================================================================
 * main.js — application bootstrap & global wiring
 * ----------------------------------------------------------------------------
 * Load order matters (see index.html): db, i18n, ui, render, admin, then here.
 * This file: starts storage, wires the header controls + nav + scroll-spy,
 * reveals static sections, renders the dynamic content, tracks visitors and
 * starts admin mode.
 * ==========================================================================*/

(function () {
  /* ---- header controls ---- */
  document.getElementById('langBtn').addEventListener('click', () => I18N.toggleLang());
  document.getElementById('themeBtn').addEventListener('click', () => I18N.toggleTheme());

  /* ---- mobile navigation ---- */
  const nav = document.getElementById('nav');
  document.getElementById('menuBtn').addEventListener('click', () => nav.classList.toggle('open'));
  nav.addEventListener('click', e => { if (e.target.closest('a')) nav.classList.remove('open'); });

  /* ---- scroll spy: highlight the section link in view ----
     The nav + section order can be rebuilt by the admin (chrome()), so we
     never cache the link nodes; we re-query #nav a on each intersection and
     re-observe whenever sections:ready fires after a reorder. */
  const spy = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      const id = e.target.id;
      nav.querySelectorAll('a[href="#' + id + '"]').forEach(a => a.classList.add('on'));
      nav.querySelectorAll('a').forEach(a => {
        if (a.getAttribute('href') !== '#' + id) a.classList.remove('on');
      });
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  function observeSections() {
    spy.disconnect();
    document.querySelectorAll('main section[id]').forEach(s => spy.observe(s));
  }
  document.addEventListener('sections:ready', observeSections);

  /* ---- reveal static blocks on scroll ----
     Dynamic cards tag themselves with data-reveal; here we tag the hand-written
     section content so the same observer animates it. */
  document.querySelectorAll('#about p, .c, section h2, .home-wrap > *')
    .forEach(el => el.setAttribute('data-reveal', ''));

  /* ---- total visitor count ----
     The shared global counter, so every device sees the same number. It is never
     mirrored into browser storage: until the backend answers, the footer says it
     does not know instead of inventing a private figure.
     Counts.hit() is the dedupe: it increments a key at most once per session,
     which replaces the old manual `session_active` flag. */
  async function trackVisitor() {
    const node = document.getElementById('visitorCount');
    if (!node) return;
    node.textContent = Counts.cached(Counts.SITE_KEY) ?? '—';
    const total = await Counts.hit(Counts.SITE_KEY);
    if (total != null) node.textContent = total;
  }

  /* ---- boot ---- */

  // Remote changes arrive over the stream in bursts (an admin edit touches
  // several records). One re-render per burst, not per event.
  let rerenderTimer = null;
  function rerenderSoon() {
    clearTimeout(rerenderTimer);
    rerenderTimer = setTimeout(() => render.all(), 300);
  }

  async function boot() {
    // restore persisted preferences first (no flash of wrong theme/language)
    let theme = 'dark', lang = 'en';
    try { theme = localStorage.getItem('theme') || theme; lang = localStorage.getItem('lang') || lang; } catch (e) {}
    I18N.setTheme(theme);
    I18N.setLang(lang); // also swaps static [data-ar] text

    // open the database (seeds static content into the dynamic store on first run)
    const { memoryMode } = await DB.init();
    if (memoryMode) UI.toast('Storage limited: uploads may not persist.', 'err');

    // First paint comes from the local cache, never from the network, so the
    // page is instant and still renders with no connection at all.
    await render.all();
    observeSections();
    UI.observeReveal(document);
    await trackVisitor();

    // then adopt the shared cloud copy and keep it live. followDB() turns every
    // local write (admin edits, visitor feedback) into a cloud write, so no
    // individual call site needed changing. Inert when CONFIG.databaseURL is ''.
    try {
      Cloud.followDB();
      const cloud = await Cloud.init(rerenderSoon);
      if (cloud.synced) { render.all().then(observeSections); }
      if (cloud.enabled && !cloud.hadData && cloud.synced) {
        console.info('[cloud] published local content as the first cloud doc');
      }
    } catch (e) {
      console.warn('[cloud] sync failed; continuing from local data', e);
    }

    // now that the DB is open and painted, re-render dynamic sections on lang change
    I18N.setOnChange(() => render.all());

    // start admin mode (restores any saved session, wires shortcut + buttons)
    Admin.init();
  }

  boot();
})();
