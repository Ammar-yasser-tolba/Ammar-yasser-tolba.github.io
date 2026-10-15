const root = document.documentElement;
const items = document.querySelectorAll('[data-ar]');

// نحفظ النص الانجليزي الاصلي لكل عنصر
items.forEach(el => { el.dataset.en = el.textContent; });

function setLang(lang) {
  root.lang = lang;
  root.dir = lang === 'ar' ? 'rtl' : 'ltr';
  items.forEach(el => { el.textContent = lang === 'ar' ? el.dataset.ar : el.dataset.en; });
  document.getElementById('langBtn').textContent = lang === 'ar' ? 'EN' : 'عربي';
  try { localStorage.setItem('lang', lang); } catch (e) {}
}

function setTheme(theme) {
  root.dataset.theme = theme;
  document.getElementById('themeBtn').textContent = theme === 'dark' ? '☀' : '☾';
  try { localStorage.setItem('theme', theme); } catch (e) {}
}

document.getElementById('langBtn').onclick = () => setLang(root.lang === 'ar' ? 'en' : 'ar');
document.getElementById('themeBtn').onclick = () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark');

let lang = 'en', theme = 'dark';
try { lang = localStorage.getItem('lang') || lang; theme = localStorage.getItem('theme') || theme; } catch (e) {}
setTheme(theme);
setLang(lang);

// ===== قايمة الموبايل =====
const nav = document.getElementById('nav');
document.getElementById('menuBtn').onclick = () => nav.classList.toggle('open');
nav.addEventListener('click', e => { if (e.target.tagName === 'A') nav.classList.remove('open'); });

// ===== تمييز القسم الحالي في القايمة =====
const links = [...nav.querySelectorAll('a')];
const spy = new IntersectionObserver(es => es.forEach(e => {
  if (e.isIntersecting) links.forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id));
}), { rootMargin: '-45% 0px -50% 0px' });
document.querySelectorAll('main section[id]').forEach(s => spy.observe(s));

// ===== ظهور العناصر مع النزول بالصفحة =====
const targets = document.querySelectorAll('section h2, .c, .pj, #about p');
targets.forEach(el => el.classList.add('rv'));
const rev = new IntersectionObserver((es, o) => es.forEach(e => {
  if (!e.isIntersecting) return;
  const el = e.target;
  el.style.transitionDelay = ([...el.parentElement.children].indexOf(el) % 4) * 90 + 'ms';
  el.classList.add('in');
  o.unobserve(el);
  setTimeout(() => { el.classList.remove('rv', 'in'); el.style.transitionDelay = ''; }, 1100);
}), { threshold: 0.12 });
targets.forEach(el => rev.observe(el));
