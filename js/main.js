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

  /* ---- total visitor count (once per browser session) ---- */
  async function trackVisitor() {
    let total = Number(await DB.getMeta('visitors')) || 0;
    let active = false;
    try {
      active = sessionStorage.getItem('session_active') === '1';
      if (!active) {
        total += 1;
        await DB.setMeta('visitors', total);
        sessionStorage.setItem('session_active', '1');
      }
    } catch (e) { /* private mode: sessionStorage may throw, counts still render */ }
    const node = document.getElementById('visitorCount');
    if (node) node.textContent = total;
  }

  /* ---- boot ---- */
  async function boot() {
    // restore persisted preferences first (no flash of wrong theme/language)
    let theme = 'dark', lang = 'en';
    try { theme = localStorage.getItem('theme') || theme; lang = localStorage.getItem('lang') || lang; } catch (e) {}
    I18N.setTheme(theme);
    I18N.setLang(lang); // also swaps static [data-ar] text

    // open the database (seeds static content into the dynamic store on first run)
    const { memoryMode } = await DB.init();
    if (memoryMode) UI.toast('Storage limited: uploads may not persist.', 'err');

    // first paint of the dynamic sections + reveal the static ones
    await render.all();
    observeSections();
    UI.observeReveal(document);
    await trackVisitor();

    // now that the DB is open and painted, re-render dynamic sections on lang change
    I18N.setOnChange(() => render.all());

    // start admin mode (restores any saved session, wires shortcut + buttons)
    Admin.init();
  }

  boot();
})();
