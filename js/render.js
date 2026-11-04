/* ============================================================================
 * render.js — turns DB data into the DOM (projects, skills, certificates)
 * ----------------------------------------------------------------------------
 * Only the three dynamic sections are rendered here; the rest of the page is
 * static. Every user-entered string is written via el()/textContent, never
 * innerHTML, so stored content cannot inject markup.
 *
 * Depends on globals provided by other files: DB, I18N, UI, and (guarded)
 * Admin for the delete affordance + inquiry modal.
 * ==========================================================================*/

const render = (() => {
  const { el } = UI;

  // Is the owner currently in admin mode? (Admin may load after this file, so
  // we resolve it lazily and default to false.)
  function admin() {
    return (typeof Admin !== 'undefined') && Admin.isAdmin();
  }

  // Visitors only ever see non-hidden items; the owner sees everything (with
  // hidden ones dimmed) so the eye toggle is reversible in place.
  function manage(items) {
    return admin() ? items : items.filter(i => !i.hidden);
  }

  // Adds the dimming class when the owner is viewing a hidden item.
  function hiddenClass(item) {
    return item.hidden ? ' is-hidden' : '';
  }

  /* ---- like / view stats (event-delegated, micro DOM updates) ---- */

  const itemIndex = new Map();                 // id -> live item object

  // `likes`/`views` on a stored item are a leftover from the versions that kept
  // counters in IndexedDB. Dropping them here means the object that later gets
  // saved by an admin edit no longer carries them either.
  function register(item) {
    delete item.likes;
    delete item.views;
    itemIndex.set(item.id, item);
  }

  // The heart is this visitor's own state, so it is the only thing that may live
  // in localStorage. It is a set of item ids, never a count.
  function likedSet() {
    try { return new Set(JSON.parse(localStorage.getItem('liked_cards') || '[]')); }
    catch (e) { return new Set(); }
  }
  function saveLiked(set) {
    try { localStorage.setItem('liked_cards', JSON.stringify([...set])); } catch (e) {}
  }

  // One heart + one view counter per card. On cards these float to the corners
  // (see .stat-row CSS); in the detail modal `inline` keeps them in the flow.
  // Both badges carry `data-ckey`, the GLOBAL counter key, so a shared total
  // arriving later — from a batch read, a click, or another visitor's write —
  // can patch this node without re-rendering the card.
  function statRow(item, inline) {
    const liked = likedSet().has(item.id);
    const ckey = Counts.keyFor(item);
    const like = el('button', {
      class: 'like-btn' + (liked ? ' is-liked' : ''), type: 'button',
      'data-id': item.id, 'aria-pressed': String(liked), 'aria-label': I18N.t('like'),
    },
      el('span', { class: 'like-ic' }, liked ? '♥' : '♡'),
      el('span', { class: 'like-count', 'data-ckey': ckey },
        Counts.likes.label(Counts.likes.cached(ckey))),
    );
    const views = el('span', {
      class: 'view-stat', 'data-id': item.id, 'data-ckey': ckey, title: I18N.t('views'),
    }, Counts.views.label(Counts.views.cached(ckey)));
    return el('div', { class: 'stat-row' + (inline ? ' is-inline' : '') }, like, views);
  }

  // Updates only the affected widgets — never a full re-render. Two separate
  // paints on purpose: a shared total arriving from the cloud must not flip
  // anyone's heart, and a heart click must not invent a number.
  function paintHeart(id, liked) {
    document.querySelectorAll('.like-btn[data-id="' + id + '"]').forEach(b => {
      b.classList.toggle('is-liked', liked);
      b.setAttribute('aria-pressed', String(liked));
      const ic = b.querySelector('.like-ic'); if (ic) ic.textContent = liked ? '♥' : '♡';
    });
  }

  // The click is answered on the screen before the network is: the shared total
  // this tab already knows, moved by this one like. Counts.likes then replaces it
  // with what the backend says — on Firebase that write also travels to every
  // other visitor, on Abacus an un-like cannot be written and is re-read instead.
  async function toggleLike(id) {
    const item = itemIndex.get(id); if (!item) return;
    const key = Counts.keyFor(item);
    const set = likedSet();
    const wasLiked = set.has(id);
    if (wasLiked) set.delete(id); else set.add(id);
    saveLiked(set);
    paintHeart(id, !wasLiked);

    // paint() deliberately never writes the cache, so starting from a placeholder
    // when no reply has landed yet costs nothing: the click is answered on the
    // screen at once, and the backend's number overwrites it a moment later.
    const known = Counts.likes.cached(key);
    Counts.likes.paint(key, Math.max(0, (known == null ? 0 : known) + (wasLiked ? -1 : 1)));
    Counts.likes.toggle(key, wasLiked ? -1 : 1);
  }

  // Opening a card sends one increment to the shared backend and repaints the
  // badge from its answer. Nothing about a view is kept in this browser: no
  // IndexedDB write, no local running total, so what a visitor sees is the
  // number every other visitor sees. Counts.views.hit() dedupes per session.
  function bumpView(item) {
    if (!item) return;
    const key = Counts.keyFor(item);
    const known = Counts.views.cached(key);
    Counts.views.paint(key, (known == null ? 0 : known) + 1);   // optimistic, never cached
    Counts.views.hitAndPaint(key);                               // authoritative total
  }

  // A single delegated listener serves every card and survives all re-renders.
  document.addEventListener('click', e => {
    const b = e.target.closest('.like-btn');
    if (b) toggleLike(b.getAttribute('data-id'));
  });

  // Email chips copy their address on click (works for the static fallback chip
  // too, which has no render-time wiring). We never preventDefault, so the
  // Gmail tab still opens — the clipboard is the belt-and-braces fallback.
  document.addEventListener('click', e => {
    const c = e.target.closest('[data-copy]');
    if (!c) return;
    const addr = c.getAttribute('data-copy');
    UI.copy(addr).then(ok => UI.toast(ok ? I18N.t('emailCopied') : addr, ok ? 'ok' : 'err'));
  });

  /* ---- header brand (logo + name + subtitle) ---- */

  async function brand() {
    const b = (await DB.getAll('brand'))[0] || {};
    const box = document.getElementById('logoBox');
    const svg = box && box.querySelector('.logo-svg');
    const img = document.getElementById('logoImg');
    if (img) {
      const url = await DB.resolveImg(b.logo);
      if (url) { img.setAttribute('src', url); img.hidden = false; if (svg) svg.style.display = 'none'; }
      else { img.hidden = true; if (svg) svg.style.display = ''; }
    }
    const set = (id, val) => { const n = document.getElementById(id); if (n && val) n.textContent = val; };
    set('brandName', I18N.pick(b.name));
    set('brandSub', I18N.pick(b.subtitle));
    const editBtn = document.getElementById('brandEditBtn');
    if (editBtn) editBtn.hidden = !admin();
  }

  /* ---- dynamic section chrome: nav + DOM order + titles + custom sections ---- */

  function layoutClass(layout) {
    return layout === 'list' ? 'sb-list' : layout === 'text' ? 'sb-text' : 'sb-grid';
  }

  // Short menu labels keep the header slim; the full `title` is used only for
  // the on-page heading. Falls back to the section title for unknown ids.
  const NAV_SHORT = {
    about:        { en: 'About', ar: 'عني' },
    skills:       { en: 'Skills', ar: 'المهارات' },
    projects:     { en: 'Projects', ar: 'المشاريع' },
    certificates: { en: 'Certificates', ar: 'الشهادات' },
    services:     { en: 'Services', ar: 'الخدمات' },
    experience:   { en: 'Experience', ar: 'الخبرة' },
    education:    { en: 'Education', ar: 'التعليم' },
    contact:      { en: 'Contact', ar: 'تواصل' },
  };

  // A header menu entry. In admin mode it gains move-left/right (and delete for
  // custom sections) plus double-click-to-rename, all confined to the nav item.
  function navItem(s, idx, len) {
    const a = el('a', { href: '#' + s.id }, I18N.pick(NAV_SHORT[s.id] || s.title));
    const item = el('div', { class: 'nav-item' }, a);
    if (admin()) {
      const mv = (side, label, fn, disabled) => el('button', {
        class: 'nav-mv ' + side, type: 'button', 'aria-label': label, title: label,
        disabled: disabled ? '' : null,
        onclick: e => { e.preventDefault(); e.stopPropagation(); fn(); },
      }, side === 'l' ? '‹' : '›');
      item.append(
        mv('l', I18N.t('moveLeft'), () => Admin.moveSection(s.id, -1), idx === 0),
        mv('r', I18N.t('moveRight'), () => Admin.moveSection(s.id, 1), idx === len - 1),
      );
      if (!s.builtin) {
        item.append(el('button', {
          class: 'nav-mv x', type: 'button', 'aria-label': I18N.t('deleteSection'), title: I18N.t('deleteSection'),
          onclick: e => { e.preventDefault(); e.stopPropagation(); Admin.deleteSection(s.id); },
        }, '✕'));
      }
      a.addEventListener('dblclick', e => { e.preventDefault(); Admin.renameSection(s.id); });
    }
    return item;
  }

  function newSectionEl(s) {
    const head = el('div', { class: 'sec-head' },
      el('h2', { class: 'sec-title' }, I18N.pick(s.title)),
      el('button', { class: 'admin-add btn p', 'data-kind': 'card', 'data-sec': s.id, type: 'button' },
        '＋ ' + I18N.t('addItem')),
    );
    const body = el('div', { class: 'sec-body ' + layoutClass(s.layout) });
    return el('section', { id: s.id }, head, body);
  }

  // Clicking a card is "viewing its details": bump the counter then open it.
  // Like / admin-tool clicks are ignored so they do not double-count.
  function bindCardOpen(card, item) {
    const open = () => { bumpView(item); openCardDetail(item); };
    card.style.cursor = 'pointer';
    card.addEventListener('click', e => { if (e.target.closest('.like-btn, .card-tools, a')) return; open(); });
    card.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
  }

  async function openCardDetail(item) {
    const body = el('div', { class: 'detail' });
    const mediaRef = item.cover || item.img || item.media;
    if (mediaRef) {
      const u = await DB.resolveImg(mediaRef);
      if (u) body.append(el('div', { class: 'd-cover' }, el('img', { src: u, alt: I18N.pick(item.title), loading: 'lazy', decoding: 'async' })));
    }
    body.append(el('h2', { class: 'd-title' }, I18N.pick(item.title)));
    const company = [I18N.pick(item.company), I18N.pick(item.dates)].filter(Boolean).join(' · ');
    if (company) body.append(el('p', { class: 'x-meta' }, company));
    if (item.degree && (item.degree.en || item.degree.ar)) body.append(el('p', {}, I18N.pick(item.degree)));
    if (item.status && (item.status.en || item.status.ar)) body.append(el('p', { class: 'x-meta' }, I18N.pick(item.status)));
    if (item.desc && (item.desc.en || item.desc.ar)) body.append(el('p', { class: 'd-desc' }, I18N.pick(item.desc)));
    if (item.courses && item.courses.length) body.append(el('div', { class: 'tagrow' }, ...item.courses.map(c => el('span', { class: 't' }, c))));
    if (item.tags && item.tags.length) body.append(el('div', { class: 'tagrow' }, ...item.tags.map(tg => el('span', { class: 't' }, tg))));
    body.append(statRow(item, true));
    body.prepend(backBtn());
    UI.Modal.open({ title: '', body, size: 'wide' });
  }

  async function customCard(layout, item) {
    const card = el('div', { class: 'c cc-' + layout + hiddenClass(item), 'data-reveal': '', tabindex: '0', role: 'button' },
      item.icon ? el('span', { class: 'ic' }, item.icon) : null,
      el('h3', {}, I18N.pick(item.title)),
    );
    if (item.desc && (item.desc.en || item.desc.ar)) card.append(el('p', {}, I18N.pick(item.desc)));
    if (layout === 'text' && item.media) {
      const url = await DB.resolveImg(item.media);
      if (url) card.prepend(el('div', { class: 'cc-media' }, el('img', { src: url, alt: I18N.pick(item.title), loading: 'lazy', decoding: 'async' })));
    }
    card.append(statRow(item));
    bindCardOpen(card, item);
    const tools = adminActions(item); if (tools) card.append(tools);
    return card;
  }

  async function renderCustomSection(s, node) {
    const title = node.querySelector('.sec-title');
    if (title) title.textContent = I18N.pick(s.title);
    const add = node.querySelector('.admin-add');
    if (add) add.textContent = '＋ ' + I18N.t('addItem');
    const body = node.querySelector('.sec-body');
    body.className = 'sec-body ' + layoutClass(s.layout);
    body.innerHTML = '';
    const items = manage((await DB.getAll('card')).filter(c => c.section === s.id));
    if (!items.length) { body.append(el('p', { class: 'empty' }, I18N.t('emptyCards'))); return; }
    for (const item of items) { register(item); body.append(await customCard(s.layout, item)); }
    UI.observeReveal(body);
  }

  // Rebuilds the header nav, reorders the on-page sections to match, refreshes
  // every title from the registry and renders any custom-section content. Called
  // on its own after a reorder so card DOM (and its like/view state) is reused.
  async function chrome() {
    const main = document.querySelector('main');
    const nav = document.getElementById('nav');
    if (!main) return;
    const sections = await DB.getAll('section');

    if (nav) {
      nav.innerHTML = '';
      sections.forEach((s, i) => nav.append(navItem(s, i, sections.length)));
    }

    for (const s of sections) {
      let node = document.getElementById(s.id);
      if (!node) {
        if (s.builtin) continue;            // built-in markup must already exist
        node = newSectionEl(s);
        main.append(node);
      }
      main.append(node);                    // appendChild re-positions -> registry order
      const h = node.querySelector('.sec-title');
      if (h && s.builtin) h.textContent = I18N.pick(s.title);
      if (!s.builtin) await renderCustomSection(s, node);
    }

    const hero = document.getElementById('home');
    if (hero) main.insertBefore(hero, main.firstElementChild);

    document.dispatchEvent(new Event('sections:ready'));
  }

  // Ordered list of ImageRefs for a project: cover first, then gallery, no dupes.
  function previewRefs(item) {
    const seen = new Set();
    const out = [];
    for (const ref of [item.cover, ...(item.gallery || [])]) {
      if (!ref) continue;
      const id = ref.src || ref.key;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(ref);
    }
    return out;
  }

  // A small image placeholder when a card/detail has no picture.
  function noImage(label) {
    return el('div', { class: 'noimg', 'aria-hidden': 'true' },
      el('span', {}, (label || '?').slice(0, 1).toUpperCase()));
  }

  // Inline GitHub mark (octocat path) used on the detail "GitHub" button.
  function githubIcon() {
    return el('svg', { class: 'ic-svg', viewBox: '0 0 16 16', width: '16', height: '16', 'aria-hidden': 'true', focusable: 'false' },
      el('path', { fill: 'currentColor', d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z' }));
  }

  // Back button used at the top of detail/inquiry modals (closes the top modal).
  function backBtn() {
    return el('div', { class: 'back-row' },
      el('button', { class: 'btn back', type: 'button', onclick: () => UI.Modal.closeTop() }, '‹ ' + I18N.t('back')));
  }

  // Admin management toolbar shown on every card/chip: move up, move down,
  // visibility (eye), edit (only for editable types) and delete. Returns null
  // for visitors so callers can append it unconditionally. Each button stops
  // propagation so it never opens the card's detail modal.
  function adminActions(item) {
    if (!admin()) return null;
    const canEdit = typeof Admin !== 'undefined' && Admin.canEdit && Admin.canEdit(item.type);
    const btn = (cls, label, icon, fn) => el('button', {
      class: 'ct ' + cls, type: 'button', 'aria-label': label, title: label,
      onclick: e => { e.stopPropagation(); fn(); },
    }, icon);
    return el('div', { class: 'card-tools' },
      btn('ct-up', I18N.t('moveUp'), '⬆', () => Admin.move(item, -1)),
      btn('ct-down', I18N.t('moveDown'), '⬇', () => Admin.move(item, 1)),
      btn('ct-eye', item.hidden ? I18N.t('show') : I18N.t('hide'), item.hidden ? '🙈' : '👁', () => Admin.toggleHidden(item)),
      canEdit ? btn('ct-edit', I18N.t('edit'), '✏', () => Admin.editItem(item)) : null,
      btn('ct-del', I18N.t('delete'), '🗑', () => Admin.removeItem(item)),
    );
  }

  /* ---- star rating helpers ---- */

  function starRow(rating) {
    const row = el('span', { class: 'stars', 'aria-label': `${rating} / 5` });
    for (let i = 1; i <= 5; i++) {
      row.append(el('span', { class: i <= Math.round(rating) ? 'star on' : 'star' }, '★'));
    }
    return row;
  }

  // Interactive 1..5 picker for the feedback form.
  function starPicker(onChange) {
    let value = 0;
    const wrap = el('div', { class: 'star-picker', role: 'radiogroup' });
    const btns = [];
    for (let i = 1; i <= 5; i++) {
      const b = el('button', {
        type: 'button', class: 'star', role: 'radio', 'aria-label': `${i} star${i > 1 ? 's' : ''}`,
        onclick: () => { value = i; paint(); if (onChange) onChange(value); },
        onmouseenter: () => paint(i),
        onfocus: () => paint(i),
      }, '★');
      b.addEventListener('mouseleave', () => paint());
      btns.push(b);
      wrap.append(b);
    }
    function paint(hover) {
      const shown = hover == null ? value : hover;
      btns.forEach((b, idx) => b.classList.toggle('on', idx < shown));
    }
    return { node: wrap, get: () => value };
  }

  /* ---- PROJECTS ---- */

  async function projects() {
    const host = document.getElementById('projects-grid');
    if (!host) return;
    host.innerHTML = '';
    const items = manage(await DB.getAll('project'));

    if (!items.length) {
      host.append(el('p', { class: 'empty' }, I18N.t('emptyProjects')));
      return;
    }

    for (const item of items) {
      register(item);
      const refs = previewRefs(item);
      const urls = await DB.resolveAll(refs);

      // --- media (cover with in-card switcher) ---
      let idx = 0;
      const cover = el('img', { class: 'pj-cover', src: urls[0] || '', alt: I18N.pick(item.title), loading: 'lazy', decoding: 'async' });
      if (!urls.length) cover.remove();
      const counter = el('span', { class: 'pj-count' }, urls.length ? `1/${urls.length}` : '');
      const media = el('div', { class: 'pj-media' }, urls.length ? cover : noImage(I18N.pick(item.title)), counter);

      function show(n) {
        if (!urls.length) return;
        idx = (n + urls.length) % urls.length;
        cover.setAttribute('src', urls[idx]);
        counter.textContent = `${idx + 1}/${urls.length}`;
      }
      if (urls.length > 1) {
        const prev = el('button', { class: 'pj-arrow prev', type: 'button', 'aria-label': 'Previous image' }, '‹');
        const next = el('button', { class: 'pj-arrow next', type: 'button', 'aria-label': 'Next image' }, '›');
        // Cycling images must NOT open the detail view.
        prev.addEventListener('click', e => { e.stopPropagation(); show(idx - 1); });
        next.addEventListener('click', e => { e.stopPropagation(); show(idx + 1); });
        media.append(prev, next);
      }

      // --- body ---
      const body = el('div', { class: 'pj-body' },
        el('h3', { class: 'pj-title' }, I18N.pick(item.title)),
        el('p', { class: 'pj-excerpt' }, I18N.pick(item.desc)),
      );
      if (item.tags && item.tags.length) {
        body.append(el('div', { class: 'tagrow' }, ...item.tags.map(tg => el('span', { class: 't' }, tg))));
      }
      body.append(el('button', { class: 'btn p pj-view', type: 'button' }, I18N.t('viewDetails')));
      body.append(statRow(item));

      const card = el('article', { class: 'pj-card' + hiddenClass(item), 'data-reveal': '', tabindex: '0', role: 'button' }, media, body);
      const open = () => { bumpView(item); projectDetail(item.id); };
      card.addEventListener('click', e => { if (e.target.closest('.like-btn, .card-tools')) return; open(); });
      card.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });

      const tools = adminActions(item); if (tools) card.append(tools);

      host.append(card);
    }
    UI.observeReveal(host);
  }

  /* ---- PROJECT DETAIL (full-screen modal) ---- */

  async function projectDetail(id) {
    const item = (await DB.getAll('project')).find(p => p.id === id);
    if (!item) return;

    const urls = await DB.resolveAll(previewRefs(item));
    const body = el('div', { class: 'detail' });

    // 1) top cover
    body.append(
      urls.length
        ? el('div', { class: 'd-cover' }, el('img', { src: urls[0], alt: I18N.pick(item.title), loading: 'lazy', decoding: 'async' }))
        : el('div', { class: 'd-cover' }, noImage(I18N.pick(item.title)))
    );

    // 2) gallery screenshots (everything after the cover)
    const gallery = urls.slice(1);
    if (gallery.length) {
      body.append(el('div', { class: 'd-gallery' },
        ...gallery.map((u, i) => el('img', { src: u, alt: `${I18N.pick(item.title)} ${i + 2}`, loading: 'lazy', decoding: 'async' }))));
    }

    // 3) full description
    body.append(
      el('h2', { class: 'd-title' }, I18N.pick(item.title)),
      el('p', { class: 'd-desc' }, I18N.pick(item.desc)),
    );
    if (item.tags && item.tags.length) {
      body.append(el('div', { class: 'tagrow' }, ...item.tags.map(tg => el('span', { class: 't' }, tg))));
    }

    // Project demo video (uploaded file), rendered inline when present.
    if (item.video) {
      const vurl = await DB.resolveImg(item.video);
      if (vurl) body.append(
        el('h4', { class: 'd-sub' }, I18N.t('projectVideo')),
        el('div', { class: 'd-video' }, el('video', { src: vurl, controls: true, preload: 'metadata', playsinline: 'true' })),
      );
    }

    // GitHub + APK download actions, shown only for what the admin filled in.
    const linkRow = [];
    if (item.links && item.links.url) {
      linkRow.push(el('a', { class: 'btn gh', href: item.links.url, target: '_blank', rel: 'noopener' },
        githubIcon(), el('span', {}, I18N.t('github'))));
    }
    if (item.apk) {
      const apkUrl = await DB.resolveImg(item.apk);
      if (apkUrl) linkRow.push(el('a', { class: 'btn dl', href: apkUrl, download: item.apk.name || 'app.apk', rel: 'noopener' },
        '⬇', el('span', {}, I18N.t('downloadApk'))));
    }
    if (linkRow.length) body.append(el('div', { class: 'd-links' }, ...linkRow));

    // 4) CTA + feedback
    const ctaRow = el('div', { class: 'd-cta' },
      el('button', { class: 'btn p', type: 'button', onclick: () => Admin.openInquiry(item) }, I18N.t('inquire')),
      el('button', { class: 'btn', type: 'button', onclick: () => Admin.openInquiry(item, true) }, I18N.t('orderSimilar')),
    );
    body.append(el('div', { class: 'd-actions' },
      ctaRow,
      el('div', { class: 'd-reviews' }, await reviewsBlock(id)),
      el('div', { class: 'd-feedback' }, await feedbackForm(id)),
    ));

    body.prepend(backBtn());
    UI.Modal.open({ title: '', body, size: 'full' });
  }

  // Approved reviews list, appended to the detail body. In admin mode each card
  // gets a trash button that deletes the review from IndexedDB and updates the
  // DOM in place; visitors never see it.
  async function reviewsBlock(projectId) {
    const wrap = el('div', { class: 'reviews' });
    wrap.append(el('h4', {}, I18N.t('clientReviews')));
    const all = await DB.getAll('feedback');
    const approved = all
      .filter(f => f.projectId === projectId && f.status === 'approved')
      .sort((a, b) => b.ts - a.ts);

    if (!approved.length) {
      wrap.append(el('p', { class: 'empty reviews-empty' }, I18N.t('noReviewsYet')));
      return wrap;
    }

    const canDelete = admin();
    for (const f of approved) {
      const node = el('div', { class: 'review', dataset: { fb: f.id } },
        el('div', { class: 'review-head' }, starRow(f.rating), el('span', { class: 'review-name' }, f.name)),
        el('p', { class: 'review-text' }, f.comment),
      );
      if (canDelete) {
        node.append(el('button', {
          class: 'review-del', type: 'button', 'aria-label': I18N.t('deleteReview'),
          onclick: async () => {
            if (!window.confirm(I18N.t('deleteReviewConfirm'))) return;
            await DB.del(f.id);
            node.remove();
            if (!wrap.querySelector('.review')) {
              wrap.append(el('p', { class: 'empty reviews-empty' }, I18N.t('noReviewsYet')));
            }
            UI.toast(I18N.t('saved'), 'ok');
          },
        }, '🗑'));
      }
      wrap.append(node);
    }
    return wrap;
  }

  // Public feedback form. Submissions enter a pending state (not shown here).
  function feedbackForm(projectId) {
    const nameIn = el('input', { type: 'text', class: 'fld', placeholder: I18N.t('yourName'), maxlength: '80' });
    const commentIn = el('textarea', { class: 'fld', placeholder: I18N.t('comment'), rows: '3', maxlength: '500' });
    const picker = starPicker();

    const submit = el('button', { class: 'btn p', type: 'button' }, I18N.t('submitFeedback'));
    submit.addEventListener('click', async () => {
      const name = nameIn.value.trim();
      const comment = commentIn.value.trim();
      const rating = picker.get();
      if (!name || !comment || !rating) { UI.toast(I18N.t('feedbackNeeds'), 'err'); return; }

      await DB.put({
        id: DB.uid('fb'), type: 'feedback', projectId, name, rating, comment,
        status: 'pending', ts: Date.now(),
      });
      UI.toast(I18N.t('feedbackThanks'), 'ok');
      nameIn.value = ''; commentIn.value = '';
      if (typeof Admin !== 'undefined') Admin.refreshNotifications();
    });

    return el('form', { class: 'fb-form', onsubmit: e => e.preventDefault() },
      el('h4', {}, I18N.t('feedbackTitle')),
      el('label', { class: 'fld-label' }, I18N.t('yourName')), nameIn,
      el('label', { class: 'fld-label' }, I18N.t('rating')), picker.node,
      el('label', { class: 'fld-label' }, I18N.t('comment')), commentIn,
      submit,
    );
  }

  /* ---- SKILLS ---- */

  async function skills() {
    const host = document.getElementById('skills-grid');
    if (!host) return;
    host.innerHTML = '';
    const items = manage(await DB.getAll('skill'));
    if (!items.length) { host.append(el('p', { class: 'empty' }, I18N.t('emptySkills'))); return; }

    for (const item of items) {
      register(item);
      const card = el('div', { class: 'sk-card' + hiddenClass(item), 'data-reveal': '', tabindex: '0', role: 'button' },
        el('h3', { class: 'sk-title' }, I18N.pick(item.title)),
      );
      if (item.desc && (item.desc.en || item.desc.ar)) {
        card.append(el('p', { class: 'sk-desc' }, I18N.pick(item.desc)));
      }
      card.append(statRow(item));
      bindCardOpen(card, item);
      const tools = adminActions(item); if (tools) card.append(tools);
      host.append(card);
    }
    UI.observeReveal(host);
  }

  /* ---- CERTIFICATES ---- */

  async function certificates() {
    const host = document.getElementById('certs-grid');
    if (!host) return;
    host.innerHTML = '';
    const items = manage(await DB.getAll('certificate'));
    if (!items.length) { host.append(el('p', { class: 'empty' }, I18N.t('emptyCertificates'))); return; }

    for (const item of items) {
      register(item);
      const coverUrl = await DB.resolveImg(item.cover);
      const media = el('div', { class: 'cert-media' },
        coverUrl ? el('img', { src: coverUrl, alt: I18N.pick(item.title), loading: 'lazy', decoding: 'async' }) : noImage(I18N.pick(item.title)),
        el('span', { class: 'cert-badge' }, '🏅'),
      );
      const body = el('div', { class: 'cert-body' },
        el('h3', { class: 'cert-title' }, I18N.pick(item.title)),
        el('p', { class: 'cert-excerpt' }, I18N.pick(item.desc)),
      );
      body.append(statRow(item));
      const card = el('article', { class: 'cert-card' + hiddenClass(item), 'data-reveal': '', tabindex: '0', role: 'button' },
        media, body,
      );
      const open = () => { bumpView(item); certDetail(item.id); };
      card.addEventListener('click', e => { if (e.target.closest('.like-btn, .card-tools')) return; open(); });
      card.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
      const tools = adminActions(item); if (tools) card.append(tools);
      host.append(card);
    }
    UI.observeReveal(host);
  }

  async function certDetail(id) {
    const item = (await DB.getAll('certificate')).find(c => c.id === id);
    if (!item) return;
    const coverUrl = await DB.resolveImg(item.cover);
    const extraUrls = await DB.resolveAll(item.attachments || []);

    const body = el('div', { class: 'detail cert-detail' },
      coverUrl ? el('div', { class: 'd-cover' }, el('img', { src: coverUrl, alt: I18N.pick(item.title), loading: 'lazy', decoding: 'async' }))
               : el('div', { class: 'd-cover' }, noImage(I18N.pick(item.title))),
      el('h2', { class: 'd-title' }, I18N.pick(item.title)),
      el('p', { class: 'd-desc' }, I18N.pick(item.desc)),
    );
    if (extraUrls.length) {
      body.append(el('div', { class: 'd-gallery' },
        ...extraUrls.map((u, i) => el('img', { src: u, alt: `Attachment ${i + 1}`, loading: 'lazy', decoding: 'async' }))));
    }
    body.prepend(backBtn());
    UI.Modal.open({ title: '', body, size: 'wide' });
  }

  /* ---- ABOUT (single editable record) ---- */

  async function about() {
    const host = document.getElementById('about-body');
    if (!host) return;
    const a = (await DB.getAll('about'))[0];
    if (!a) return;                       // no record -> leave the hardcoded fallback
    const has = x => x && (x.en || x.ar);

    // Build the nodes first; only replace the static fallback when the record
    // actually carries content, so "About me" can never render empty.
    const nodes = [];
    if (has(a.headline)) nodes.push(el('p', { class: 'about-lead', 'data-reveal': '' }, I18N.pick(a.headline)));
    if (has(a.bio)) nodes.push(el('p', { 'data-reveal': '' }, I18N.pick(a.bio)));
    if (has(a.bioMore)) nodes.push(el('p', { 'data-reveal': '' }, I18N.pick(a.bioMore)));
    if (a.tags && a.tags.length) {
      nodes.push(el('div', { class: 'tagrow' }, ...a.tags.map(tg => el('span', { class: 't' }, I18N.pick(tg)))));
    }
    if (!nodes.length) return;            // empty/stale record -> keep the fallback text
    host.innerHTML = '';
    nodes.forEach(n => host.append(n));
    UI.observeReveal(host);
  }

  /* ---- SERVICES ---- */

  async function services() {
    const host = document.getElementById('services-grid');
    if (!host) return;
    host.innerHTML = '';
    const items = manage(await DB.getAll('service'));

    for (const item of items) {
      register(item);
      const card = el('div', { class: 'c' + hiddenClass(item), 'data-reveal': '', tabindex: '0', role: 'button' });
      if (item.icon) card.append(el('span', { class: 'ic' }, item.icon));
      card.append(el('h3', {}, I18N.pick(item.title)));
      if (item.desc && (item.desc.en || item.desc.ar)) card.append(el('p', {}, I18N.pick(item.desc)));
      card.append(statRow(item));
      bindCardOpen(card, item);
      const tools = adminActions(item); if (tools) card.append(tools);
      host.append(card);
    }
    UI.observeReveal(host);
  }

  /* ---- EXPERIENCE ---- */

  async function experience() {
    const host = document.getElementById('experience-grid');
    if (!host) return;
    host.innerHTML = '';
    const items = manage(await DB.getAll('experience'));

    for (const item of items) {
      register(item);
      const card = el('div', { class: 'c' + hiddenClass(item), 'data-reveal': '', tabindex: '0', role: 'button' },
        el('h3', {}, I18N.pick(item.title)));
      const meta = [I18N.pick(item.company), I18N.pick(item.dates)].filter(Boolean).join(' · ');
      if (meta) card.append(el('p', { class: 'x-meta' }, meta));
      if (item.desc && (item.desc.en || item.desc.ar)) card.append(el('p', {}, I18N.pick(item.desc)));
      card.append(statRow(item));
      bindCardOpen(card, item);
      const tools = adminActions(item); if (tools) card.append(tools);
      host.append(card);
    }
    UI.observeReveal(host);
  }

  /* ---- EDUCATION ---- */

  async function education() {
    const host = document.getElementById('education-grid');
    if (!host) return;
    host.innerHTML = '';
    const items = manage(await DB.getAll('education'));

    for (const item of items) {
      register(item);
      const card = el('div', { class: 'c' + hiddenClass(item), 'data-reveal': '', tabindex: '0', role: 'button' },
        el('h3', {}, I18N.pick(item.title)));
      if (item.degree && (item.degree.en || item.degree.ar)) card.append(el('p', {}, I18N.pick(item.degree)));
      if (item.status && (item.status.en || item.status.ar)) card.append(el('p', { class: 'x-meta' }, I18N.pick(item.status)));
      if (item.courses && item.courses.length) {
        card.append(el('div', { class: 'tagrow' }, ...item.courses.map(c => el('span', { class: 't' }, c))));
      }
      card.append(statRow(item));
      bindCardOpen(card, item);
      const tools = adminActions(item); if (tools) card.append(tools);
      host.append(card);
    }
    UI.observeReveal(host);
  }

  /* ---- HERO (single editable record) ---- */

  async function hero() {
    const h = (await DB.getAll('hero'))[0];
    if (!h) return;
    const set = (id, val) => { const n = document.getElementById(id); if (n && val) n.textContent = val; };
    set('hero-badge', I18N.pick(h.badge));
    set('hero-name', I18N.pick(h.name));
    set('hero-role', I18N.pick(h.role));
    set('hero-summary', I18N.pick(h.summary));

    const img = document.getElementById('hero-img');
    if (img) {
      const url = await DB.resolveImg(h.img);
      if (url) img.setAttribute('src', url);
      img.style.display = '';
    }
    // The photo-swap button is an owner-only affordance.
    const photoBtn = document.getElementById('heroPhotoBtn');
    if (photoBtn) photoBtn.hidden = !admin();
  }

  /* ---- CONTACTS (social + freelance link chips) ---- */

  // Web Gmail composer — opens in the browser instead of the OS mail client.
  const GMAIL_COMPOSE = 'https://mail.google.com/mail/?view=cm&fs=1&to=';
  // Encode everything that would break a query value, but keep "@" literal so
  // the URL matches Gmail's own compose link exactly.
  const encAddr = addr => encodeURIComponent(addr).replace(/%40/g, '@');

  // Returns the bare address if this contact is an email link, else ''.
  // Accepts "mailto:a@b.c" and a plain "a@b.c"; ignores real http(s) URLs.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function emailOf(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (/^mailto:/i.test(raw)) {
      const addr = raw.slice(7).split('?')[0].trim();
      return EMAIL_RE.test(addr) ? addr : '';
    }
    if (raw.includes('://')) return '';           // a genuine URL, not an address
    return EMAIL_RE.test(raw) ? raw : '';
  }

  // One link chip: opens the exact stored URL. http(s) links open in a new tab;
  // mailto: links are upgraded to the web Gmail composer. Admin gets the toolbar.
  function renderContactGroup(container, items) {
    if (!container) return;
    container.innerHTML = '';
    for (const item of items) {
      const addr = emailOf(item.url);
      const external = /^https?:/i.test(item.url || '');
      const chip = el('a', {
        class: 'cbtn' + hiddenClass(item),
        href: addr ? GMAIL_COMPOSE + encAddr(addr) : (item.url || '#'),
        target: (external || addr) ? '_blank' : null,
        rel: (external || addr) ? 'noopener noreferrer' : null,
        // data-copy makes the address land on the clipboard whatever else happens
        'data-copy': addr || null,
      },
        el('span', { class: 'cbtn-ic' }, item.icon || '🔗'),
        el('span', { class: 'cbtn-t' }, I18N.pick(item.title)),
      );
      const slot = el('div', { class: 'cbtn-slot' }, chip);
      const tools = adminActions(item); if (tools) slot.append(tools);
      container.append(slot);
    }
  }

  async function contacts() {
    const all = await DB.getAll('contact');
    const main = manage(all.filter(c => (c.group || 'main') === 'main'));
    const free = manage(all.filter(c => c.group === 'freelance'));
    renderContactGroup(document.getElementById('contact-main'), main);
    renderContactGroup(document.getElementById('contact-freelance'), free);
  }

  /* ---- entry point ---- */
  async function all() {
    await Promise.all([
      brand(), hero(), about(), projects(), skills(), certificates(),
      services(), experience(), education(), contacts(),
    ]);
    await chrome(); // after content exists so custom sections can attach cleanly
    // Fire-and-forget: badges already show the last shared total (or the
    // placeholder) and are patched as each reply lands, so a slow service cannot
    // delay the page. Views and likes are both warmed by this one call.
    Counts.warm([...itemIndex.values()]);
  }

  return {
    all, brand, chrome, hero, about, projects, skills, certificates,
    services, experience, education, contacts, projectDetail, certDetail,
    openCardDetail, customCard, bumpView, toggleLike,
  };
})();
