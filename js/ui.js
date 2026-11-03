/* ============================================================================
 * ui.js — shared UI primitives (no content knowledge)
 * ----------------------------------------------------------------------------
 *   UI.esc / UI.el   -> safe DOM building helpers
 *   UI.Modal         -> stacked modal system (Esc, backdrop, focus handling)
 *   UI.toast         -> transient notifications
 *   UI.observeReveal -> scroll-reveal for dynamically added cards
 *   UI.readImage     -> File -> {blob, dataURL} for upload previews
 * ==========================================================================*/

const UI = (() => {

  /* ---- escaping + element helper ---- */

  // Escape a value for interpolation into an innerHTML template.
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      ));
  }

  // Tiny createElement helper: el('div', {class:'x', onclick:fn}, childOrStr...)
  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(kid));
    }
    return node;
  }

  /* ---- modal engine ---- */

  const Modal = (() => {
    const stack = []; // open modals, top = last
    let backdrop;

    function ensureBackdrop() {
      if (backdrop) return backdrop;
      backdrop = el('div', {
        class: 'overlay',
        onclick: e => { if (e.target === backdrop) closeTop(); },
      });
      document.body.append(backdrop);
      return backdrop;
    }

    /**
     * open({title, body, size, dismissable})
     *   body: HTMLElement | html string
     *   size: 'md' | 'wide' | 'full'
     *   dismissable: false blocks backdrop click (X + Esc still work)
     * Returns a handle {el, close}.
     */
    function open(opts = {}) {
      ensureBackdrop();
      const wasFocused = document.activeElement;
      const size = opts.size || 'md';
      const dismissable = opts.dismissable !== false;

      const closeBtn = el('button', { class: 'modal-x', 'aria-label': I18N.t('close'), onclick: () => handle.close() }, '×');
      const header = el('div', { class: 'modal-head' },
        el('h3', { class: 'modal-title' }, opts.title || ''),
        closeBtn);

      const bodyNode = opts.body instanceof Node
        ? opts.body
        : el('div', { class: 'modal-body', html: opts.body || '' });
      if (opts.body instanceof Node) bodyNode.classList.add('modal-body');

      const panel = el('div', { class: `modal modal-${size}` }, header, bodyNode);
      const wrap = el('div', { class: 'modal-wrap', role: 'dialog', 'aria-modal': 'true' }, panel);
      // Layer modals so a modal opened on top (e.g. Inquiry over Project
      // Details) sits above it: 9000, 10000, 11000… by stack depth.
      wrap.style.zIndex = String(9000 + stack.length * 1000);
      backdrop.append(wrap);

      // lock body scroll while anything is open
      document.body.classList.add('no-scroll');
      requestAnimationFrame(() => wrap.classList.add('open'));

      const handle = {
        el: panel,
        wrap,
        close() {
          const i = stack.indexOf(handle);
          if (i === -1) return;
          stack.splice(i, 1);
          wrap.classList.remove('open');
          setTimeout(() => wrap.remove(), 220);
          if (!stack.length) {
            document.body.classList.remove('no-scroll');
            if (backdrop) backdrop.classList.remove('show');
          }
          if (wasFocused && wasFocused.focus) wasFocused.focus();
        },
        dismissable,
      };
      stack.push(handle);
      backdrop.classList.add('show');

      // focus first focusable element inside the modal
      const focusable = panel.querySelector('input,button,textarea,select,[tabindex]');
      (focusable || closeBtn).focus({ preventScroll: true });

      if (typeof opts.onOpen === 'function') opts.onOpen(handle);
      return handle;
    }

    function closeTop() {
      const top = stack[stack.length - 1];
      if (top && top.dismissable !== false) top.close();
    }

    // Esc closes the topmost dismissable modal; Tab is trapped within it.
    document.addEventListener('keydown', e => {
      if (!stack.length) return;
      const top = stack[stack.length - 1];
      if (e.key === 'Escape') {
        if (top.dismissable !== false) { e.preventDefault(); top.close(); }
      } else if (e.key === 'Tab') {
        trapTab(e, top.el);
      }
    });

    function trapTab(e, panel) {
      const nodes = [...panel.querySelectorAll(
        'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])'
      )].filter(n => n.offsetParent !== null);
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    return { open, closeTop, get count() { return stack.length; } };
  })();

  /* ---- toast ---- */

  let toastHost;
  function toast(msg, kind = '') {
    if (!toastHost) {
      toastHost = el('div', { class: 'toasts', 'aria-live': 'polite' });
      document.body.append(toastHost);
    }
    const node = el('div', { class: `toast ${kind}` }, msg);
    toastHost.append(node);
    requestAnimationFrame(() => node.classList.add('show'));
    setTimeout(() => {
      node.classList.remove('show');
      setTimeout(() => node.remove(), 260);
    }, 2600);
  }

  /* ---- scroll reveal (reused for dynamic cards) ---- */

  let revealObserver;
  function observeReveal(scope) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const targets = (scope || document).querySelectorAll('[data-reveal]:not(.in)');
    if (reduce) { targets.forEach(el => el.classList.add('in')); return; }

    if (!revealObserver) {
      revealObserver = new IntersectionObserver((entries, obs) => {
        entries.forEach(e => {
          if (!e.isIntersecting) return;
          const node = e.target;
          const siblings = [...node.parentElement.children];
          node.style.transitionDelay = ((siblings.indexOf(node) % 4) * 80) + 'ms';
          node.classList.add('in');
          obs.unobserve(node);
        });
      }, { threshold: 0.12 });
    }
    targets.forEach(node => revealObserver.observe(node));
  }

  /* ---- image file -> preview ---- */

  // Reads an image File into a Blob (to store) + a dataURL (for instant preview).
  function readImage(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith('image/')) { reject(new Error('not-an-image')); return; }
      const reader = new FileReader();
      reader.onload = () => resolve({ blob: file, dataURL: reader.result });
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  return { esc, el, Modal, toast, observeReveal, readImage };
})();
