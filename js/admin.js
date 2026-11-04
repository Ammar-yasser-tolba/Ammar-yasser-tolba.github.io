/* ============================================================================
 * admin.js — owner mode: auth, full CRUD across every section, uploads,
 *            visibility toggle, reordering, inquiry + feedback moderation
 * ----------------------------------------------------------------------------
 * IMPORTANT — this is a *client-side* gate, not real security. Anyone can open
 * dev tools and read this file, so the password only hides the editing UI from
 * casual visitors; it does not protect data. Change ADMIN_PASSWORD below.
 *
 * Every content item may carry two management fields set here:
 *   order  -> sort key used by DB.getAll and the move up/down buttons
 *   hidden -> when true the item is invisible to visitors (still shown, dimmed,
 *             to the admin so it can be re-enabled)
 * ==========================================================================*/

const Admin = (() => {
  const { el } = UI;

  /* ---- configuration (edit these) ---- */
  const ADMIN_PASSWORD = 'admin';                 // <-- change me
  const CONTACT = {
    whatsapp: '201044016570',                     // international format, digits only
    email: 'ammar.3yasser7@gmail.com',
    linkedin: 'https://www.linkedin.com/in/ammar-yasser-othman-tolba-574a92250/',
  };

  const SINGLE = ['about', 'hero'];               // one fixed record per type
  const MEDIA = ['project', 'skill', 'certificate']; // types with image upload

  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  /* ---- cloud reachability, stated honestly ----
     With no shared database an admin write lands in this browser's IndexedDB and
     nowhere else. Reporting that as "Saved." is how a certificate added on one
     laptop ends up missing for every visitor with nobody the wiser: the owner
     watched it appear. So the message says which of the two happened.
     Cloud.enabled() is false while CONFIG.databaseURL is empty, and also after
     Firebase has refused this device. Enabled is not the same as delivered,
     though: a signed-out owner, a network that will not answer and a rule that
     rejects the write all leave the change at home, so the toast waits for the
     publish Cloud.flush() and reports its answer. */
  const cloudOn = () => typeof Cloud !== 'undefined'
    && typeof Cloud.enabled === 'function' && Cloud.enabled();

  // Fire-and-forget by design: the modal is already closed and the page already
  // redrawn when the verdict arrives a moment later. Nothing here may reject —
  // a toast that cannot be shown must not become an unhandled error.
  function reportShared(okKey, localKey) {
    const say = shared => {
      try { UI.toast(I18N.t(shared ? okKey : localKey), shared ? 'ok' : 'err'); } catch (e) {}
    };
    if (!cloudOn() || typeof Cloud.flush !== 'function') return say(false);
    Promise.resolve().then(() => Cloud.flush()).then(shared => say(!!shared), () => say(false));
  }

  function toastSaved() { reportShared('saved', 'savedLocal'); }

  function toastDeleted() { reportShared('deleted', 'deletedLocal'); }

  // Once per tab, at the moment admin mode becomes usable — the rest of the
  // session does not need it repeated on every render.
  function warnCloudOff() {
    if (!isAdmin() || cloudOn()) return;
    try {
      if (sessionStorage.getItem('cloudWarned')) return;
      sessionStorage.setItem('cloudWarned', '1');
    } catch (e) {}
    UI.toast(I18N.t('cloudOff'), 'err');
  }

  /* ---- schemas for the text(+optional image) sections ---- */
  // Each field: {k, label, type} — type is biText | biArea | text | list |
  // biList | select | image. titleKey/urlKey are required-field checks.
  const SCHEMAS = {
    about: {
      editLabel: 'editAbout', titleKey: 'title',
      fields: [
        { k: 'title', label: 'secTitleLbl', type: 'biText' },
        { k: 'headline', label: 'headline', type: 'biText' },
        { k: 'bio', label: 'bio', type: 'biArea' },
        { k: 'bioMore', label: 'bioMore', type: 'biArea' },
        { k: 'tags', label: 'tagsLbl', type: 'biList' },
      ],
    },
    hero: {
      editLabel: 'editHero', titleKey: 'name',
      fields: [
        { k: 'name', label: 'nameLbl', type: 'biText' },
        { k: 'role', label: 'roleLbl', type: 'biText' },
        { k: 'summary', label: 'summaryLbl', type: 'biArea' },
        { k: 'badge', label: 'badgeLbl', type: 'biText' },
        { k: 'img', label: 'photoLbl', hint: 'photoHint', type: 'image' },
      ],
    },
    service: {
      addLabel: 'addService', editLabel: 'editService', titleKey: 'title',
      fields: [
        { k: 'icon', label: 'icon', type: 'text' },
        { k: 'title', label: 'titleLbl', type: 'biText' },
        { k: 'desc', label: 'descLbl', type: 'biArea' },
      ],
    },
    experience: {
      addLabel: 'addExperience', editLabel: 'editExperience', titleKey: 'title',
      fields: [
        { k: 'title', label: 'roleField', type: 'biText' },
        { k: 'company', label: 'company', type: 'biText' },
        { k: 'dates', label: 'dates', type: 'biText' },
        { k: 'desc', label: 'descLbl', type: 'biArea' },
      ],
    },
    education: {
      addLabel: 'addEducation', editLabel: 'editEducation', titleKey: 'title',
      fields: [
        { k: 'title', label: 'institution', type: 'biText' },
        { k: 'degree', label: 'degree', type: 'biArea' },
        { k: 'status', label: 'status', type: 'biText' },
        { k: 'courses', label: 'courses', type: 'list' },
      ],
    },
    contact: {
      addLabel: 'addContact', editLabel: 'editContact', titleKey: 'title', urlKey: 'url',
      fields: [
        { k: 'title', label: 'titleLbl', type: 'biText' },
        { k: 'url', label: 'urlLbl', hint: 'urlHint', type: 'text' },
        { k: 'icon', label: 'iconLbl', type: 'text' },
        { k: 'group', label: 'groupLbl', type: 'select',
          options: [{ value: 'main', label: 'groupMain' }, { value: 'freelance', label: 'groupFreelance' }] },
      ],
    },
    // A generic card inside a custom (builder-created) section.
    card: {
      addLabel: 'addItem', editLabel: 'editItem', titleKey: 'title',
      fields: [
        { k: 'icon', label: 'icon', type: 'text' },
        { k: 'title', label: 'titleLbl', type: 'biText' },
        { k: 'desc', label: 'descLbl', type: 'biArea' },
        { k: 'media', label: 'imageOpt', type: 'image' },
      ],
    },
  };

  /* ---- session ---- */
  // With Authentication configured, the local flag alone is not enough: edits
  // would be refused by the rules, so the affordances stay hidden until a live
  // token exists (Cloud.init restores one from this tab before Admin.init runs).
  function isAdmin() {
    let flagged = false;
    try { flagged = localStorage.getItem('admin') === '1'; } catch (e) { return false; }
    if (!flagged) return false;
    if (typeof Cloud !== 'undefined' && Cloud.authAvailable() && !Cloud.authed()) return false;
    return true;
  }
  function setSession(on) {
    try { on ? localStorage.setItem('admin', '1') : localStorage.removeItem('admin'); } catch (e) {}
  }
  function applyAdminState() {
    document.body.classList.toggle('admin', isAdmin());
    render.all();
    refreshNotifications();
    warnCloudOff();
  }

  /* ---- unlock prompt (Ctrl+Shift+E) ---- */
  function requestUnlock() {
    if (isAdmin()) { lock(); return; }
    const err = el('p', { class: 'fld-err' });

    // Without a cloud sign-in the password here is only a UI gate; with one it
    // is Firebase deciding whether this browser may write at all.
    if (!(typeof Cloud !== 'undefined' && Cloud.authAvailable())) {
      const input = el('input', { type: 'password', class: 'fld', placeholder: I18N.t('enterPassword') });
      const confirm = el('button', { class: 'btn p', type: 'button' }, I18N.t('save'));
      const m = UI.Modal.open({
        title: I18N.t('adminUnlocked'), size: 'md',
        body: el('div', { class: 'auth' },
          el('label', { class: 'fld-label' }, I18N.t('enterPassword')), input, err, confirm),
      });
      const submit = () => {
        if (input.value === ADMIN_PASSWORD) {
          setSession(true); m.close(); applyAdminState(); UI.toast(I18N.t('adminUnlocked'), 'ok');
        } else { err.textContent = I18N.t('wrongPassword'); }
      };
      confirm.addEventListener('click', submit);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
      input.focus();
      return;
    }

    const email = el('input', { type: 'email', class: 'fld', autocomplete: 'username',
      placeholder: I18N.t('signInEmail') });
    const pass = el('input', { type: 'password', class: 'fld', autocomplete: 'current-password',
      placeholder: I18N.t('signInPassword') });
    const confirm = el('button', { class: 'btn p', type: 'button' }, I18N.t('save'));
    const m = UI.Modal.open({
      title: I18N.t('adminUnlocked'), size: 'md',
      body: el('div', { class: 'auth' },
        el('label', { class: 'fld-label' }, I18N.t('signInEmail')), email,
        el('label', { class: 'fld-label' }, I18N.t('signInPassword')), pass, err, confirm),
    });
    const submit = async () => {
      confirm.disabled = true;
      confirm.textContent = I18N.t('signingIn');
      const r = await Cloud.signIn(email.value, pass.value);
      pass.value = '';                          // never leave a password on screen
      confirm.disabled = false;
      confirm.textContent = I18N.t('save');
      if (r.ok) {
        setSession(true); m.close(); applyAdminState(); UI.toast(I18N.t('adminUnlocked'), 'ok');
        return;
      }
      // Firebase's own codes are English service strings; translating them keeps
      // an Arabic page from showing a raw English error.
      err.textContent = r.reason === 'WRONG_ACCOUNT' ? I18N.t('notOwner')
        : I18N.t('wrongCredentials');
      confirm.focus();
    };
    confirm.addEventListener('click', submit);
    pass.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    email.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    email.focus();
  }
  function lock() {
    setSession(false);
    if (typeof Cloud !== 'undefined') Cloud.signOut();   // do not leave write rights in the tab
    applyAdminState();
    UI.toast(I18N.t('adminOff'));
  }

  /* ---- ordering helper ---- */
  async function nextOrder(type) {
    const list = await DB.getAll(type);
    return list.reduce((m, i) => Math.max(m, i.order || 0), 0) + 1;
  }

  /* ---- image field (single or multiple, with pre-existing refs) ---- */
  // entries are {kind:'keep', ref, url} or {kind:'new', blob, dataURL}.
  // `initial` is an array of {ref, url} shown as removable existing previews.
  function imageField({ label, hint, multi, initial }) {
    const input = el('input', { type: 'file', accept: 'image/*', hidden: '' });
    if (multi) input.multiple = true;
    const previews = el('div', { class: 'previews' });
    const entries = [];

    const makeBox = entry => {
      const url = entry.kind === 'new' ? entry.dataURL : entry.url;
      const box = el('div', { class: 'preview' },
        el('img', { src: url || '', alt: '' }),
        el('button', { class: 'preview-x', type: 'button', 'aria-label': I18N.t('remove') }, '×'));
      box.querySelector('.preview-x').addEventListener('click', () => {
        const i = entries.indexOf(entry); if (i !== -1) entries.splice(i, 1); box.remove();
      });
      return box;
    };

    (initial || []).forEach(({ ref, url }) => {
      const e = { kind: 'keep', ref, url }; entries.push(e); previews.append(makeBox(e));
    });

    input.addEventListener('change', () => {
      const list = [...input.files];
      if (!multi) { entries.length = 0; while (previews.firstChild) previews.firstChild.remove(); }
      list.slice(0, multi ? 12 : 1).forEach(async file => {
        try {
          const { blob, dataURL } = await UI.readImage(file);
          const e = { kind: 'new', blob, dataURL }; entries.push(e); previews.append(makeBox(e));
        } catch (err) { /* ignore non-images */ }
      });
      input.value = '';
    });

    const node = el('div', { class: 'img-field' },
      el('div', { class: 'img-field-head' },
        el('label', { class: 'fld-label' }, label),
        hint ? el('span', { class: 'hint' }, hint) : null,
        el('button', { class: 'btn sm', type: 'button', onclick: () => input.click() },
          multi ? I18N.t('chooseMany') : I18N.t('choose'))),
      input, previews);
    return { node, entries: () => entries.slice() };
  }

  // Persist entries to Blob refs; existing refs pass through untouched.
  async function persistEntries(field) {
    const out = [];
    for (const e of field.entries()) {
      if (e.kind === 'keep') out.push(e.ref);
      else { const key = DB.uid('img'); await DB.putImage(key, e.blob); out.push({ key }); }
    }
    return out;
  }

  /* ---- non-image single file (APK / video) with keep/replace/remove ---- */
  function fileField({ label, hint, accept, prefix, initial }) {
    const input = el('input', { type: 'file', accept, hidden: '' });
    const name = el('span', { class: 'file-name' }, initial ? (initial.name || I18N.t('noFile')) : I18N.t('noFile'));
    let chosen = null, removed = false;
    input.addEventListener('change', () => {
      if (input.files[0]) { chosen = input.files[0]; removed = false; name.textContent = chosen.name; }
    });
    const removeBtn = initial ? el('button', {
      class: 'btn sm danger', type: 'button', onclick: () => {
        chosen = null; removed = true; name.textContent = I18N.t('noFile');
      } }, I18N.t('remove')) : null;
    const node = el('div', { class: 'img-field' },
      el('div', { class: 'img-field-head' },
        el('label', { class: 'fld-label' }, label),
        hint ? el('span', { class: 'hint' }, hint) : null,
        el('button', { class: 'btn sm', type: 'button', onclick: () => input.click() }, I18N.t('chooseFile')),
        removeBtn),
      input, name);
    // resolve(): new -> store & replace; removed -> delete old; else keep.
    const resolve = async existingRef => {
      if (chosen) {
        if (existingRef && existingRef.key) await DB.delImage(existingRef.key);
        const key = DB.uid(prefix); await DB.putImage(key, chosen);
        return { key, name: chosen.name, type: chosen.type };
      }
      if (removed) { if (existingRef && existingRef.key) await DB.delImage(existingRef.key); return null; }
      return existingRef || null;
    };
    return { node, resolve };
  }

  /* ---- bilingual (EN/AR) text field, optionally pre-filled ---- */
  function bilingualField(labelEn, labelAr, multiline, init) {
    const mk = lang => (multiline
      ? el('textarea', { class: 'fld', rows: '3', dir: lang === 'ar' ? 'rtl' : null })
      : el('input', { class: 'fld', type: 'text', dir: lang === 'ar' ? 'rtl' : null }));
    const en = mk('en'), ar = mk('ar');
    en.value = (init && init.en) || '';
    ar.value = (init && init.ar) || '';
    return {
      node: el('div', { class: 'bi-field' },
        el('label', { class: 'fld-label' }, labelEn), en,
        el('label', { class: 'fld-label' }, labelAr), ar),
      value: () => ({ en: en.value.trim(), ar: ar.value.trim() }),
    };
  }

  /* ---- generic field builder for schema forms (image handled by caller) ---- */
  function makeField(f, initial) {
    const label = I18N.t(f.label);
    const cur = initial ? initial[f.k] : undefined;

    if (f.type === 'biText' || f.type === 'biArea') {
      const multiline = f.type === 'biArea';
      const mk = lang => (multiline
        ? el('textarea', { class: 'fld', rows: '3', dir: lang === 'ar' ? 'rtl' : null })
        : el('input', { class: 'fld', type: 'text', dir: lang === 'ar' ? 'rtl' : null }));
      const en = mk('en'), ar = mk('ar');
      en.value = (cur && cur.en) || '';
      ar.value = (cur && cur.ar) || '';
      return {
        node: el('div', { class: 'bi-field' },
          el('label', { class: 'fld-label' }, label),
          el('span', { class: 'lang-tag' }, 'English'), en,
          el('span', { class: 'lang-tag' }, 'العربية'), ar),
        get: () => ({ en: en.value.trim(), ar: ar.value.trim() }),
      };
    }

    if (f.type === 'list') {
      const inp = el('input', { class: 'fld', type: 'text' });
      inp.value = (cur || []).join(', ');
      return {
        node: el('div', { class: 'bi-field' }, el('label', { class: 'fld-label' }, label), inp),
        get: () => inp.value.split(',').map(s => s.trim()).filter(Boolean),
      };
    }

    if (f.type === 'biList') {
      const ta = el('textarea', { class: 'fld', rows: '4' });
      ta.value = (cur || []).map(o => `${o.en}${o.ar ? ' | ' + o.ar : ''}`).join('\n');
      return {
        node: el('div', { class: 'bi-field' },
          el('label', { class: 'fld-label' }, label),
          el('span', { class: 'hint' }, 'English | عربي'), ta),
        get: () => ta.value.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
          const parts = l.split('|');
          return { en: (parts[0] || '').trim(), ar: (parts[1] || '').trim() };
        }),
      };
    }

    if (f.type === 'select') {
      const sel = el('select', { class: 'fld' });
      (f.options || []).forEach(o => sel.append(el('option', { value: o.value }, I18N.t(o.label))));
      sel.value = cur || (f.options && f.options[0] && f.options[0].value) || '';
      return { node: el('div', { class: 'bi-field' }, el('label', { class: 'fld-label' }, label), sel), get: () => sel.value };
    }

    // default: plain text (with optional hint)
    const inp = el('input', { class: 'fld', type: 'text' });
    inp.value = cur || '';
    return {
      node: el('div', { class: 'bi-field' },
        el('label', { class: 'fld-label' }, label),
        f.hint ? el('span', { class: 'hint' }, I18N.t(f.hint)) : null, inp),
      get: () => inp.value.trim(),
    };
  }

  /* ---- generic add/edit form for schema types ---- */
  async function openEditForm(type, item, ctx) {
    const schema = SCHEMAS[type];
    if (!schema) return;
    const err = el('p', { class: 'fld-err' });
    const initial = Object.assign({}, item || {});
    if (ctx && ctx.group && type === 'contact') initial.group = ctx.group;
    if (ctx && ctx.section && type === 'card') initial.section = ctx.section;
    const isEdit = SINGLE.includes(type) ? true : !!(item && item.id);

    const fields = [];
    for (const f of schema.fields) {
      if (f.type === 'image') {
        const ref = initial[f.k] || null;
        const url = ref ? await DB.resolveImg(ref) : '';
        const field = imageField({
          label: I18N.t(f.label), hint: f.hint ? I18N.t(f.hint) : null, multi: false,
          initial: ref ? [{ ref, url }] : [],
        });
        fields.push({ f, node: field.node, get: async () => ((await persistEntries(field))[0] || null) });
      } else {
        const built = makeField(f, initial);
        fields.push({ f, node: built.node, get: built.get });
      }
    }

    const form = el('div', { class: 'add-form' }, ...fields.map(x => x.node), err);
    const title = I18N.t(isEdit ? (schema.editLabel || schema.addLabel) : (schema.addLabel || schema.editLabel));
    const m = UI.Modal.open({ title, body: form, size: 'wide' });
    const actions = el('div', { class: 'form-actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => m.close() }, I18N.t('cancel')),
      el('button', { class: 'btn p', type: 'button' }, I18N.t('save')));
    form.append(actions);

    actions.lastElementChild.addEventListener('click', async () => {
      err.textContent = '';
      const obj = { type };
      obj.id = (item && item.id) ? item.id : (SINGLE.includes(type) ? type : DB.uid(type.slice(0, 2)));
      obj.order = (item && item.order != null) ? item.order : await nextOrder(type);
      obj.hidden = item ? !!item.hidden : false;
      if (type === 'card') obj.section = (item && item.section) || (ctx && ctx.section) || null;
      for (const x of fields) obj[x.f.k] = await x.get();
      if (schema.titleKey) {
        const tv = obj[schema.titleKey];
        if (!tv || (!tv.en && !tv.ar)) { err.textContent = I18N.t('titleRequired'); return; }
      }
      if (schema.urlKey && !obj[schema.urlKey]) { err.textContent = I18N.t('urlLbl'); return; }
      await DB.put(obj);
      m.close(); await render.all(); toastSaved();
    });
  }

  function openEdit(type, item, ctx) {
    if (!isAdmin() || !SCHEMAS[type]) return;
    if (SINGLE.includes(type) && !item) {
      DB.getAll(type).then(list => openEditForm(type, list[0] || { type }, ctx));
      return;
    }
    openEditForm(type, item, ctx);
  }

  /* ---- media add/edit form (project / skill / certificate) ---- */
  async function openMediaForm(kind, item) {
    if (!isAdmin()) return;
    const isEdit = !!item;
    const err = el('p', { class: 'fld-err' });
    const titleField = bilingualField(I18N.t('titleEn'), I18N.t('titleAr'), false, item && item.title);
    const descField = bilingualField(I18N.t('descEn'), I18N.t('descAr'), true, item && item.desc);
    const form = el('div', { class: 'add-form' }, titleField.node, descField.node);

    let cover, gallery, attach, apk, video, tagsIn, linkIn;

    const resolveRefs = async refs => Promise.all((refs || []).map(async ref => ({ ref, url: await DB.resolveImg(ref) })));

    if (kind === 'project') {
      tagsIn = el('input', { class: 'fld', type: 'text', placeholder: I18N.t('tags'), value: ((item && item.tags) || []).join(', ') });
      linkIn = el('input', { class: 'fld', type: 'url', placeholder: I18N.t('github'), value: (item && item.links && item.links.url) || '' });
      const coverInit = item && item.cover ? [{ ref: item.cover, url: await DB.resolveImg(item.cover) }] : [];
      const galInit = await resolveRefs(item && item.gallery);
      cover = imageField({ label: I18N.t('coverImage'), hint: I18N.t('coverImgHint'), multi: false, initial: coverInit });
      gallery = imageField({ label: I18N.t('galleryImages'), hint: I18N.t('galleryHint'), multi: true, initial: galInit });
      apk = fileField({ label: I18N.t('apkFile'), hint: I18N.t('apkHint'), accept: '.apk,application/vnd.android.package-archive', prefix: 'apk', initial: item && item.apk ? { ref: item.apk, name: item.apk.name } : null });
      video = fileField({ label: I18N.t('videoFile'), hint: I18N.t('videoHint'), accept: 'video/*', prefix: 'vid', initial: item && item.video ? { ref: item.video, name: item.video.name } : null });
      form.append(cover.node, gallery.node,
        el('label', { class: 'fld-label' }, I18N.t('tags')), tagsIn,
        el('label', { class: 'fld-label' }, I18N.t('githubLink')), linkIn,
        apk.node, video.node);
    } else if (kind === 'certificate') {
      const coverInit = item && item.cover ? [{ ref: item.cover, url: await DB.resolveImg(item.cover) }] : [];
      const attInit = await resolveRefs(item && item.attachments);
      cover = imageField({ label: I18N.t('coverImage'), hint: I18N.t('coverImgHint'), multi: false, initial: coverInit });
      attach = imageField({ label: I18N.t('attachments'), hint: I18N.t('attachmentsHint'), multi: true, initial: attInit });
      form.append(cover.node, attach.node);
    }
    form.append(err);

    const m = UI.Modal.open({ title: I18N.t(`${isEdit ? 'edit' : 'add'}${cap(kind)}`), size: 'wide', body: form });
    const actions = el('div', { class: 'form-actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => m.close() }, I18N.t('cancel')),
      el('button', { class: 'btn p', type: 'button' }, I18N.t('save')));
    form.append(actions);

    actions.lastElementChild.addEventListener('click', async () => {
      err.textContent = '';
      const tv = titleField.value();
      if (!tv.en && !tv.ar) { err.textContent = I18N.t('titleRequired'); return; }
      if (kind === 'certificate' && !cover.entries().length) { err.textContent = I18N.t('coverRequired'); return; }
      const obj = {
        id: item ? item.id : DB.uid(kind.slice(0, 2)), type: kind, title: tv, desc: descField.value(),
        order: item && item.order != null ? item.order : await nextOrder(kind),
        hidden: item ? !!item.hidden : false,
      };
      if (kind === 'project') {
        obj.cover = (await persistEntries(cover))[0] || null;
        obj.gallery = await persistEntries(gallery);
        obj.tags = tagsIn.value.split(',').map(s => s.trim()).filter(Boolean);
        const gh = linkIn.value.trim();
        obj.links = gh ? { url: gh, label: 'GitHub' } : undefined;
        obj.apk = await apk.resolve(item && item.apk);
        obj.video = await video.resolve(item && item.video);
      } else if (kind === 'certificate') {
        obj.cover = (await persistEntries(cover))[0] || null;
        obj.attachments = await persistEntries(attach);
      }
      await DB.put(obj);
      m.close(); await render.all(); toastSaved();
    });
  }

  function openAdd(kind, item) {
    if (!isAdmin()) return;
    if (MEDIA.includes(kind)) openMediaForm(kind, item);
    else openEdit(kind, item);
  }

  /* ---- routing used by the card toolbars ---- */
  function canEdit(type) { return !!SCHEMAS[type] || MEDIA.includes(type); }
  function editItem(item) {
    if (!isAdmin() || !item) return;
    if (MEDIA.includes(item.type)) openMediaForm(item.type, item);
    else openEdit(item.type, item);
  }

  async function move(item, dir) {
    if (!isAdmin()) return;
    const group = item.group;
    const list = (await DB.getAll(item.type)).filter(i => (group ? i.group === group : true));
    const idx = list.findIndex(i => i.id === item.id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= list.length) return;
    const a = list[idx], b = list[j];
    const tmp = a.order; a.order = b.order; b.order = tmp;
    await DB.put(a); await DB.put(b);
    await render.all();
  }

  async function toggleHidden(item) {
    if (!isAdmin()) return;
    item.hidden = !item.hidden;
    await DB.put(item);
    await render.all();
  }

  /* ---- delete a rendered item ---- */
  async function removeItem(item) {
    if (!isAdmin()) return;
    if (!window.confirm(I18N.t('deleteConfirm'))) return;
    await DB.del(item.id);
    await render.all();
    refreshNotifications();
  }

  /* ---- inquiry modal (CTA from project detail) ---- */
  function openInquiry(project, orderMode) {
    const pTitle = I18N.pick(project.title) || I18N.pick({ en: 'your project', ar: 'مشروعك' });
    const heading = orderMode ? I18N.t('orderSimilar') : I18N.t('inquire');
    const subject = `${I18N.t('inquirySubject')} ${pTitle}`;

    const wa = `https://wa.me/${CONTACT.whatsapp}?text=${encodeURIComponent(subject)}`;
    // Email opens Gmail's web composer directly (NOT mailto) in a new tab.
    // The address keeps its literal "@" so the link matches Gmail's own form.
    const toAddr = encodeURIComponent(CONTACT.email).replace(/%40/g, '@');
    const gmail = `https://mail.google.com/mail/?view=cm&fs=1&to=${toAddr}&su=${encodeURIComponent(subject)}`;
    const li = CONTACT.linkedin;

    const linkRow = (href, label, icon) => el('a', { class: 'ch', href, target: '_blank', rel: 'noopener noreferrer' },
      el('span', { class: 'ch-ic' }, icon), el('span', { class: 'ch-label' }, label));
    // Gmail in a new tab, and the address always lands on the clipboard as well.
    const emailRow = el('button', {
      class: 'ch', type: 'button', onclick: () => {
        window.open(gmail, '_blank', 'noopener,noreferrer');
        UI.copy(CONTACT.email).then(ok => UI.toast(ok ? I18N.t('emailCopied') : CONTACT.email, ok ? 'ok' : 'err'));
      } },
      el('span', { class: 'ch-ic' }, '✉'), el('span', { class: 'ch-label' }, I18N.t('email')));

    const body = el('div', { class: 'inquiry' },
      el('p', { class: 'inquiry-note' }, I18N.t('contactVia')),
      linkRow(wa, I18N.t('whatsapp'), '💬'),
      emailRow,
      linkRow(li, I18N.t('linkedin'), 'in'),
      el('button', { class: 'btn back', type: 'button', onclick: () => UI.Modal.closeTop() }, I18N.t('back')));
    UI.Modal.open({ title: heading, body, size: 'md' });
  }

  /* ---- notifications + moderation ---- */
  async function pendingCount() {
    const all = await DB.getAll('feedback');
    return all.filter(f => f.status === 'pending').length;
  }
  async function refreshNotifications() {
    const bell = document.getElementById('adminBell');
    const badge = document.getElementById('notifCount');
    if (!bell || !badge) return;
    const n = await pendingCount();
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.hidden = n === 0;
  }

  async function openModeration() {
    if (!isAdmin()) return;
    const all = await DB.getAll('feedback');
    const pending = all.filter(f => f.status === 'pending').sort((a, b) => b.ts - a.ts);
    const projects = await DB.getAll('project');
    const titleOf = id => { const p = projects.find(x => x.id === id); return p ? I18N.pick(p.title) : '—'; };

    const list = el('div', { class: 'mod-list' });
    if (!pending.length) list.append(el('p', { class: 'empty' }, I18N.t('noPending')));
    const m = UI.Modal.open({ title: I18N.t('pendingReviews'), body: list, size: 'wide' });

    for (const f of pending) {
      const stars = el('span', { class: 'stars' });
      for (let i = 1; i <= 5; i++) stars.append(el('span', { class: i <= f.rating ? 'star on' : 'star' }, '★'));
      const applyDecision = async status => {
        if (status === 'approved') await DB.put({ ...f, status: 'approved' }); else await DB.del(f.id);
        await render.all(); refreshNotifications();
        const node = list.querySelector(`[data-fb="${f.id}"]`); if (node) node.remove();
        if (!list.children.length) list.append(el('p', { class: 'empty' }, I18N.t('noPending')));
      };
      list.append(el('div', { class: 'mod-item', dataset: { fb: f.id } },
        el('div', { class: 'mod-main' },
          el('div', { class: 'mod-meta' }, el('strong', {}, f.name), stars),
          el('p', { class: 'mod-project' }, `${I18N.t('forProject')} ${titleOf(f.projectId)}`),
          el('p', { class: 'mod-text' }, f.comment)),
        el('div', { class: 'mod-actions' },
          el('button', { class: 'btn ok', type: 'button', onclick: e => { e.target.disabled = true; applyDecision('approved'); } }, I18N.t('approve')),
          el('button', { class: 'btn danger', type: 'button', onclick: e => { e.target.disabled = true; applyDecision('rejected'); } }, I18N.t('reject')))));
    }
    return m;
  }

  /* ---- brand (header logo + name + subtitle) ---- */
  async function openBrand() {
    if (!isAdmin()) return;
    const list = await DB.getAll('brand');
    const b = list[0] || { id: 'brand', type: 'brand', order: 0, name: {}, subtitle: {}, logo: null };
    const err = el('p', { class: 'fld-err' });
    const nameField = bilingualField(I18N.t('brandNameEn'), I18N.t('brandNameAr'), false, b.name);
    const subField = bilingualField(I18N.t('brandSubEn'), I18N.t('brandSubAr'), false, b.subtitle);
    const logoInit = b.logo ? [{ ref: b.logo, url: await DB.resolveImg(b.logo) }] : [];
    const logo = imageField({ label: I18N.t('logoLbl'), hint: I18N.t('logoHint'), multi: false, initial: logoInit });
    const form = el('div', { class: 'add-form' }, nameField.node, subField.node, logo.node, err);
    const m = UI.Modal.open({ title: I18N.t('editBrand'), size: 'wide', body: form });
    const actions = el('div', { class: 'form-actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => m.close() }, I18N.t('cancel')),
      el('button', { class: 'btn p', type: 'button' }, I18N.t('save')));
    form.append(actions);
    actions.lastElementChild.addEventListener('click', async () => {
      err.textContent = '';
      const nm = nameField.value();
      if (!nm.en && !nm.ar) { err.textContent = I18N.t('titleRequired'); return; }
      // reclaim the old uploaded logo blob if it is being replaced/removed
      const refs = await persistEntries(logo);
      const newRef = refs[0] || null;
      if (b.logo && b.logo.key && (!newRef || newRef.key !== b.logo.key)) await DB.delImage(b.logo.key);
      await DB.put({ ...b, name: nm, subtitle: subField.value(), logo: newRef });
      m.close(); await render.brand(); toastSaved();
    });
  }

  /* ---- custom section builder ---- */
  function openSectionForm() {
    if (!isAdmin()) return;
    const err = el('p', { class: 'fld-err' });
    const titleField = bilingualField(I18N.t('secTitleEn'), I18N.t('secTitleAr'), false);
    const layoutSel = el('select', { class: 'fld' });
    [['grid', 'layoutGrid'], ['list', 'layoutList'], ['text', 'layoutText']].forEach(([value, label]) =>
      layoutSel.append(el('option', { value }, I18N.t(label))));
    const form = el('div', { class: 'add-form' },
      titleField.node,
      el('div', { class: 'bi-field' }, el('label', { class: 'fld-label' }, I18N.t('layoutLbl')), layoutSel),
      err);
    const m = UI.Modal.open({ title: I18N.t('addSection'), size: 'md', body: form });
    const actions = el('div', { class: 'form-actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => m.close() }, I18N.t('cancel')),
      el('button', { class: 'btn p', type: 'button' }, I18N.t('save')));
    form.append(actions);
    actions.lastElementChild.addEventListener('click', async () => {
      err.textContent = '';
      const tv = titleField.value();
      if (!tv.en && !tv.ar) { err.textContent = I18N.t('titleRequired'); return; }
      await DB.put({
        id: DB.uid('sec'), type: 'section', builtin: false, layout: layoutSel.value,
        title: tv, order: await nextOrder('section'),
      });
      m.close(); await render.all(); toastSaved();
    });
  }

  // Swap a section with its neighbour and re-order just the chrome (nav + DOM).
  async function moveSection(id, dir) {
    if (!isAdmin()) return;
    const list = await DB.getAll('section');
    const idx = list.findIndex(s => s.id === id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= list.length) return;
    const a = list[idx], b = list[j];
    const tmp = a.order; a.order = b.order; b.order = tmp;
    await DB.put(a); await DB.put(b);
    await render.chrome();
  }

  async function renameSection(id) {
    if (!isAdmin()) return;
    const list = await DB.getAll('section');
    const s = list.find(x => x.id === id);
    if (!s) return;
    const err = el('p', { class: 'fld-err' });
    const titleField = bilingualField(I18N.t('secTitleEn'), I18N.t('secTitleAr'), false, s.title);
    const form = el('div', { class: 'add-form' }, titleField.node, err);
    const m = UI.Modal.open({ title: I18N.t('editSection'), size: 'md', body: form });
    const actions = el('div', { class: 'form-actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => m.close() }, I18N.t('cancel')),
      el('button', { class: 'btn p', type: 'button' }, I18N.t('save')));
    form.append(actions);
    actions.lastElementChild.addEventListener('click', async () => {
      err.textContent = '';
      const tv = titleField.value();
      if (!tv.en && !tv.ar) { err.textContent = I18N.t('titleRequired'); return; }
      await DB.put({ ...s, title: tv });
      m.close(); await render.chrome(); toastSaved();
    });
  }

  async function deleteSection(id) {
    if (!isAdmin()) return;
    const list = await DB.getAll('section');
    const s = list.find(x => x.id === id);
    if (!s || s.builtin) return;
    if (!window.confirm(I18N.t('deleteSectionConfirm'))) return;
    const cards = (await DB.getAll('card')).filter(c => c.section === id);
    for (const c of cards) await DB.del(c.id);
    await DB.del(id);
    const node = document.getElementById(id); if (node) node.remove();
    await render.chrome();
    toastDeleted();
  }

  /* ---- wiring (called once from main.js after DOM ready) ---- */
  function init() {
    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'E' || e.key === 'e')) { e.preventDefault(); requestUnlock(); }
    });
    document.addEventListener('click', e => {
      if (e.target.closest('#brandEditBtn')) { openBrand(); return; }
      if (e.target.closest('#addSectionBtn')) { openSectionForm(); return; }
      const add = e.target.closest('.admin-add');
      if (add && add.dataset.kind) {
        const k = add.dataset.kind, ctx = { group: add.dataset.group, section: add.dataset.sec };
        SCHEMAS[k] ? openEdit(k, null, ctx) : openMediaForm(k, null);
        return;
      }
      const edit = e.target.closest('.admin-edit');
      if (edit && edit.dataset.kind) { openEdit(edit.dataset.kind, null); return; }
      if (e.target.closest('#adminBell')) openModeration();
    });
    applyAdminState();
  }

  return {
    init, isAdmin, openAdd, openEdit, openMediaForm, editItem,
    move, toggleHidden, canEdit, openInquiry, removeItem,
    refreshNotifications, openModeration, lock, CONTACT,
    openBrand, openSectionForm, moveSection, renameSection, deleteSection,
  };
})();
