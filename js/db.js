/* ============================================================================
 * db.js — IndexedDB persistence layer + one-time seed (static -> dynamic)
 * ----------------------------------------------------------------------------
 * Everything the site renders lives here. Two object stores:
 *   items  -> {id, type:'project'|'skill'|'certificate'|'feedback', ...}
 *   images -> {key, blob} for files the admin uploads
 *
 * An "ImageRef" is one of:
 *   {src:'images/foo.jpg'}  -> a bundled file (used by the seeded content)
 *   {key:'img_ab12'}        -> a Blob stored in the images store (uploaded)
 *   null                    -> no image
 *
 * If IndexedDB is unavailable (old browser / strict file://), we transparently
 * fall back to an in-memory store so the site still renders the seed data.
 * ==========================================================================*/

const DB = (() => {
  const DB_NAME = 'portfolioDB';
  const DB_VERSION = 1;

  let idb = null;          // live IDBDatabase, null when in memory fallback
  let useMemory = false;   // true when IndexedDB could not be opened
  const memItems = new Map(); // in-memory fallback for items
  const memImages = new Map(); // in-memory fallback for image blobs

  // Cache of object: URLs created from stored Blobs, keyed by image key.
  // Kept for the page lifetime so re-renders never show a broken image.
  const urlCache = new Map();

  /* ---- low-level IndexedDB helpers (promise-wrapped) ---- */

  function open() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('no-idb')); return; }
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) { reject(e); return; }

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('items')) {
          const store = db.createObjectStore('items', { keyPath: 'id' });
          store.createIndex('type', 'type', { unique: false });
        }
        if (!db.objectStoreNames.contains('images')) {
          db.createObjectStore('images', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'k' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Run a single transaction, return a promise of its request result.
  function tx(storeName, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = idb.transaction(storeName, mode);
      const store = t.objectStore(storeName);
      let result;
      try { result = fn(store); } catch (e) { reject(e); return; }
      if (result && 'onsuccess' in result) {
        result.onsuccess = () => resolve(result.result);
        result.onerror = () => reject(result.error);
      } else {
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
      }
    });
  }

  /* ---- public CRUD API ---- */

  // Stable ascending order by the persisted `order` field; items without one sort last.
  function byOrder(a, b) {
    return (a.order == null ? Infinity : a.order) - (b.order == null ? Infinity : b.order);
  }

  /* ---- write notifications ----
     cloud.js subscribes to mirror changes into the shared database. Emitted
     after the local write succeeds so a failed put never triggers a push. */
  const writers = [];
  function emit(kind, detail) {
    for (const fn of writers) { try { fn(kind, detail); } catch (e) {} }
  }
  function onWrite(fn) {
    if (typeof fn === 'function') writers.push(fn);
  }

  async function getAll(type) {
    const items = useMemory
      ? [...memItems.values()].filter(i => i.type === type)
      : (await tx('items', 'readonly', s => s.getAll())).filter(i => i.type === type);
    return items.sort(byOrder);
  }

  async function put(item) {
    if (useMemory) { memItems.set(item.id, item); emit('item', { item }); return; }
    await tx('items', 'readwrite', s => s.put(item));
    emit('item', { item });
  }

  async function del(id) {
    const item = useMemory ? memItems.get(id)
      : await tx('items', 'readonly', s => s.get(id));
    // Remove any Blob images this item referenced so we do not leak storage.
    if (item) {
      const refs = [...(item.gallery || []), ...(item.attachments || []),
        item.cover, item.apk, item.video]
        .filter(r => r && r.key);
      for (const r of refs) await delImage(r.key);
    }
    if (useMemory) { memItems.delete(id); emit('remove', { id, item, type: item && item.type }); return; }
    await tx('items', 'readwrite', s => s.delete(id));
    emit('remove', { id, item, type: item && item.type });
  }

  async function putImage(key, blob) {
    if (useMemory) { memImages.set(key, blob); emit('image', { key, removed: false }); return; }
    await tx('images', 'readwrite', s => s.put({ key, blob }));
    emit('image', { key, removed: false });
  }

  async function getImage(key) {
    if (useMemory) return memImages.get(key);
    const rec = await tx('images', 'readonly', s => s.get(key));
    return rec ? rec.blob : null;
  }

  async function delImage(key) {
    urlCache.delete(key);
    if (useMemory) { memImages.delete(key); emit('image', { key, removed: true }); return; }
    await tx('images', 'readwrite', s => s.delete(key));
    emit('image', { key, removed: true });
  }

  /**
   * Turn an ImageRef into a value usable as <img src>. Async because a stored
   * Blob has to be read out of IndexedDB the first time. Returns '' for null.
   */
  async function resolveImg(ref) {
    if (!ref) return '';
    if (ref.src) return ref.src;               // bundled file path
    if (ref.key) {
      if (urlCache.has(ref.key)) return urlCache.get(ref.key);
      const blob = await getImage(ref.key);
      if (!blob) return '';
      const url = URL.createObjectURL(blob);
      urlCache.set(ref.key, url);
      return url;
    }
    return '';
  }

  // Resolve a list of refs to src strings in order (dropping empty ones).
  async function resolveAll(refs) {
    const urls = await Promise.all((refs || []).map(resolveImg));
    return urls.filter(Boolean);
  }

  /* ---- meta (seed flag) ---- */

  async function getMeta(k) {
    if (useMemory) return memMeta.get(k);
    const rec = await tx('meta', 'readonly', s => s.get(k));
    return rec ? rec.v : undefined;
  }
  async function setMeta(k, v) {
    if (useMemory) { memMeta.set(k, v); return; }
    await tx('meta', 'readwrite', s => s.put({ k, v }));
  }
  const memMeta = new Map();

  /* ---- id generator ---- */

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ---- seed: migrates hardcoded content into the dynamic store ---- */
  // Idempotent PER content type: a meta flag short-circuits re-runs, and we
  // also skip any type that already has items. This means adding new content
  // types (or editing the arrays below) never duplicates for returning visitors.
  async function ensureSeeded(type, items) {
    if (await getMeta('seed_' + type)) return;
    const existing = await getAll(type);
    if (existing.length) { await setMeta('seed_' + type, true); return; }
    for (const it of items) await put(it);
    await setMeta('seed_' + type, true);
  }

  async function seed() {
    const bilingual = (en, ar) => ({ en, ar });
    const blList = pairs => pairs.map(([en, ar]) => ({ en, ar }));

    const projects = [
      {
        id: uid('pj'), type: 'project',
        title: bilingual('Healthcare App', 'تطبيق رعاية صحية'),
        desc: bilingual(
          'A Flutter healthcare app with patient and doctor flows: appointment booking, doctor profiles, schedules and payment UI. I built the reusable screens and the interactive flows for both journeys.',
          'تطبيق Flutter للرعاية الصحية فيه مسارين للمريض والطبيب: حجز المواعيد، وملفات الأطباء، والجداول، وواجهة الدفع. بنيت الشاشات القابلة لإعادة الاستخدام وتدفقات التطبيق لكل رحلة.'),
        tags: ['Dart', 'Flutter'],
        cover: { src: 'images/healthcare/login.jpg' },
        gallery: [
          { src: 'images/healthcare/login.jpg' },
          { src: 'images/healthcare/patient-home.jpg' },
          { src: 'images/healthcare/appointment-1.jpg' },
          { src: 'images/healthcare/doctor-home.jpg' },
          { src: 'images/healthcare/prescription.jpg' },
          { src: 'images/healthcare/wallet.jpg' },
        ],
      },
      {
        id: uid('pj'), type: 'project',
        title: bilingual('Fashion Shopping App', 'تطبيق تسوق للأزياء'),
        desc: bilingual(
          'A Flutter shopping app for browsing clothing, viewing details and changing quantities with a live total price, then checking out through a validated, editable shipping-address form.',
          'تطبيق تسوق بـ Flutter لتصفح الملابس وعرض التفاصيل وتغيير الكميات مع حساب السعر الإجمالي لحظيًا، ثم الدفع ونموذج عنوان الشحن مع التحقق والتعديل.'),
        tags: ['Dart', 'Flutter'],
        cover: { src: 'images/fashion/home.jpg' },
        gallery: [
          { src: 'images/fashion/home.jpg' },
          { src: 'images/fashion/choose-parts.jpg' },
          { src: 'images/fashion/checkout.jpg' },
          { src: 'images/fashion/pay-by-visa.jpg' },
        ],
      },
      {
        id: uid('pj'), type: 'project',
        title: bilingual('Snake Game', 'لعبة الثعبان'),
        desc: bilingual(
          'A C++ game built to practise programming logic and object-oriented design.',
          'لعبة بـ C++ لتدريب المنطق البرمجي والتصميم كائني التوجه.'),
        tags: ['C++', 'OOP'],
        cover: null,
        gallery: [],
      },
      {
        id: uid('pj'), type: 'project',
        title: bilingual('Domino Games', 'ألعاب الدومينو'),
        desc: bilingual(
          'Python domino games applying game rules, logical decisions and object-oriented programming.',
          'ألعاب دومينو بـ Python تطبق القواعد والقرارات المنطقية والبرمجة كائنية التوجه.'),
        tags: ['Python', 'OOP'],
        cover: { src: 'images/domino.png' },
        gallery: [{ src: 'images/domino.png' }],
        links: { url: 'https://github.com/Ammar-yasser-tolba/Dominoes-Game', label: 'GitHub' },
      },
    ];

    const skills = [
      { id: uid('sk'), type: 'skill', title: bilingual('Languages', 'لغات البرمجة'),
        desc: bilingual('Dart · C++ · Python · SQL · JavaScript (basics)', 'Dart · C++ · Python · SQL · JavaScript (أساسيات)') },
      { id: uid('sk'), type: 'skill', title: bilingual('Frameworks', 'التقنيات'),
        desc: bilingual('Flutter · HTML5 · CSS3', 'Flutter · HTML5 · CSS3') },
      { id: uid('sk'), type: 'skill', title: bilingual('Tools', 'الأدوات'),
        desc: bilingual('VS Code · Android Studio · Git & GitHub · Figma', 'VS Code · Android Studio · Git & GitHub · Figma') },
      { id: uid('sk'), type: 'skill', title: bilingual('Core CS', 'أساسيات علوم الحاسب'),
        desc: bilingual('OOP · Data Structures · Algorithms · Operating Systems · Databases & SQL',
          'OOP · هياكل البيانات · الخوارزميات · نظم التشغيل · قواعد البيانات و SQL') },
      { id: uid('sk'), type: 'skill', title: bilingual('Soft skills', 'مهارات شخصية'),
        desc: bilingual('Analytical thinking · Creativity · Attention to detail · Teamwork · Continuous learning',
          'التفكير التحليلي · الإبداع · الانتباه للتفاصيل · العمل الجماعي · التعلم المستمر') },
      { id: uid('sk'), type: 'skill', title: bilingual('Languages spoken', 'اللغات'),
        desc: bilingual('Arabic: native · English: fluent in conversation', 'العربية: لغة أم · الإنجليزية: محادثة بطلاقة') },
    ];

    // Certificates start empty (a cover image is required, so we avoid a fake
    // placeholder). The admin "+" in the Certificates section fills this in.
    const certificates = [];

    const about = [{
      id: 'about', type: 'about',
      headline: bilingual('Flutter Developer & Computer Science Student', 'مطور Flutter وطالب علوم حاسب'),
      bio: bilingual(
        'I’m a Flutter Developer and Computer Science student who enjoys building mobile applications and turning ideas into real, functional products. I focus on creating clean, responsive, and user-friendly interfaces while making sure the app works smoothly across different screen sizes. I’m always learning new technologies, improving my problem-solving skills, and looking for opportunities to build better applications.',
        'أنا مطور Flutter وطالب علوم حاسب أستمتع ببناء تطبيقات الموبايل وتحويل الأفكار إلى منتجات حقيقية تعمل. أركز على واجهات نظيفة ومتجاوبة وسهلة الاستخدام، مع التأكد من أن التطبيق يعمل بسلاسة على مختلف أحجام الشاشات. أتعلم تقنيات جديدة باستمرار وأطور مهارتي في حل المشكلات.'),
      bioMore: bilingual(
        'I enjoy logical thinking, solving complex problems, and tackling challenging tasks that require creativity and analytical skills. For me, programming is more than just designing interfaces; it’s about understanding how things work, finding efficient solutions, and turning ideas into functional applications.',
        'أحب التفكير المنطقي وحل المشكلات المعقدة والمهام التي تتطلب إبداعًا وتحليلًا. البرمجة بالنسبة لي ليست تصميم واجهات فقط، بل فهم كيف تعمل الأشياء وإيجاد حلول فعالة وتحويل الأفكار إلى تطبيقات تعمل.'),
      tags: blList([
        ['Mobile apps', 'تطبيقات الموبايل'],
        ['Logical thinking', 'التفكير المنطقي'],
        ['Problem solving', 'حل المشكلات'],
        ['Strategy games', 'ألعاب الاستراتيجية'],
        ['Clean Code', 'Clean Code'],
      ]),
    }];

    const services = [
      { id: uid('sv'), type: 'service', icon: '📱',
        title: bilingual('Flutter mobile apps', 'تطبيقات Flutter'),
        desc: bilingual('Android and iOS apps from a single Flutter codebase.', 'تطبيقات أندرويد و iOS من كود Flutter واحد.') },
      { id: uid('sv'), type: 'service', icon: '🎨',
        title: bilingual('UI implementation', 'تنفيذ التصميمات'),
        desc: bilingual('Turning Figma designs into clean, working Flutter screens.', 'تحويل تصميمات Figma إلى شاشات Flutter نظيفة وتعمل.') },
      { id: uid('sv'), type: 'service', icon: '📐',
        title: bilingual('Responsive layouts', 'واجهات متجاوبة'),
        desc: bilingual('Screens that adapt to different phone and tablet sizes.', 'شاشات تتأقلم مع أحجام الموبايل والتابلت المختلفة.') },
      { id: uid('sv'), type: 'service', icon: '🛠️',
        title: bilingual('Fixes and new features', 'إصلاح وتطوير'),
        desc: bilingual('Debugging and adding features to existing Flutter apps.', 'إصلاح الأخطاء وإضافة مزايا لتطبيقات Flutter قائمة.') },
    ];

    const experience = [
      { id: uid('xp'), type: 'experience',
        title: bilingual('Flutter training, DEPI', 'تدريب Flutter في DEPI'),
        company: bilingual('Digital Egypt Pioneers Initiative', 'مبادرة رواد مصر الرقمية'),
        dates: bilingual('17 Jul – 8 Dec 2026', '17 يوليو – 8 ديسمبر 2026'),
        desc: bilingual('Cross-platform development with Dart and Flutter, plus a progressive Flutter UI challenge.',
          'تطوير تطبيقات متعددة المنصات بـ Dart وFlutter، مع المشاركة في تحدي واجهات Flutter المتدرج.') },
      { id: uid('xp'), type: 'experience',
        title: bilingual('Freelance', 'أعمال حرة'),
        company: bilingual('', ''), dates: bilingual('', ''),
        desc: bilingual('I’m building practical projects and will list client work here as it is confirmed.',
          'أبني مشاريع عملية وأضيفها هنا فور تأكدها.') },
      { id: uid('xp'), type: 'experience',
        title: bilingual('Achievements', 'إنجازات'),
        company: bilingual('', ''), dates: bilingual('', ''),
        desc: bilingual('Completed multiple programming projects in Flutter, Python, JavaScript and C++.',
          'أنجزت عدة مشاريع برمجية بـ Flutter وPython وJavaScript وC++.') },
    ];

    const education = [
      { id: uid('ed'), type: 'education',
        title: bilingual('Fayoum University', 'جامعة الفيوم'),
        degree: bilingual('Faculty of Computers, Information and AI — Information Systems', 'كلية الحاسبات والمعلومات والذكاء الاصطناعي، قسم نظم المعلومات'),
        status: bilingual('Fourth year · expected graduation 2027', 'الفرقة الرابعة · التخرج المتوقع 2027'),
        courses: [] },
      { id: uid('ed'), type: 'education',
        title: bilingual('Courses', 'الكورسات'),
        degree: bilingual('', ''), status: bilingual('', ''),
        courses: ['Dart Programming', 'Flutter Development', 'OOP with Dart', 'C++ Programming', 'OOP with C++', 'Data Structures', 'Algorithms', 'Database Systems and SQL'] },
    ];

    // Hero content lives in the store too so it is fully editable in Admin mode.
    const hero = [{
      id: 'hero', type: 'hero', order: 0,
      name: bilingual('Ammar Yasser Tolba', 'عمار ياسر طلبة'),
      role: bilingual('Flutter Developer | Cross-Platform Mobile App Developer', 'مطور Flutter | مطور تطبيقات موبايل متعددة المنصات'),
      summary: bilingual(
        'I build responsive, user-friendly mobile apps with clean code and practical functionality.',
        'أبني تطبيقات موبايل متجاوبة وسهلة الاستخدام بكود نظيف ووظائف عملية.'),
      badge: bilingual('Open to internships, junior roles and freelance', 'متاح لفرص التدريب والوظائف والعمل الحر'),
      img: { src: 'images/profile.jpg' },
    }];

    // Social + freelance links, one dynamic record each (editable/reorderable).
    const contacts = [
      { id: uid('ct'), type: 'contact', group: 'main', icon: '✉️',
        title: bilingual('ammar.3yasser7@gmail.com', 'ammar.3yasser7@gmail.com'), url: 'mailto:ammar.3yasser7@gmail.com' },
      { id: uid('ct'), type: 'contact', group: 'main', icon: '💬',
        title: bilingual('WhatsApp: +20 104 401 6570', 'واتساب: +20 104 401 6570'), url: 'https://wa.me/201044016570' },
      { id: uid('ct'), type: 'contact', group: 'main', icon: 'in',
        title: bilingual('LinkedIn', 'لينكدإن'), url: 'https://www.linkedin.com/in/ammar-yasser-othman-tolba-574a92250/' },
      { id: uid('ct'), type: 'contact', group: 'main', icon: '⌥',
        title: bilingual('GitHub', 'GitHub'), url: 'https://github.com/Ammar-yasser-tolba' },
      { id: uid('ct'), type: 'contact', group: 'freelance',
        title: bilingual('Khamsat', 'خمسات'), url: 'https://khamsat.com/user/ammar_yasser_tolba' },
      { id: uid('ct'), type: 'contact', group: 'freelance',
        title: bilingual('Mostaql', 'مستقل'), url: 'https://mostaql.com/u/ammar_yasser_47' },
      { id: uid('ct'), type: 'contact', group: 'freelance',
        title: bilingual('Nafezly', 'نافذلي'), url: 'https://nafezly.com/u/ammaryasserothman' },
      { id: uid('ct'), type: 'contact', group: 'freelance',
        title: bilingual('Freelancer', 'Freelancer'), url: 'https://www.freelancer.com/u/ammaryassertolba' },
      { id: uid('ct'), type: 'contact', group: 'freelance',
        title: bilingual('Upwork', 'Upwork'), url: 'https://www.upwork.com/freelancers/~01111c54baed152a34' },
    ];

    // Header brand: logo blob + editable name/subtitle (persisted, real-time).
    const brand = [{
      id: 'brand', type: 'brand', order: 0,
      name: bilingual('Ammar', 'عمار'),
      subtitle: bilingual('Flutter Dev', 'مطور فلاتر'),
      logo: null,
    }];

    // Section registry: one record drives nav order, on-page order and the title
    // for each block. Built-ins map to markup that already exists in index.html;
    // custom sections are created on demand with a chosen layout template.
    const sections = [
      { id: 'about', type: 'section', builtin: true, order: 0, title: bilingual('About me', 'عني') },
      { id: 'skills', type: 'section', builtin: true, order: 1, title: bilingual('Skills', 'المهارات') },
      { id: 'projects', type: 'section', builtin: true, order: 2, title: bilingual('Projects', 'المشاريع') },
      { id: 'certificates', type: 'section', builtin: true, order: 3, title: bilingual('Certificates & Achievements', 'الشهادات والإنجازات') },
      { id: 'services', type: 'section', builtin: true, order: 4, title: bilingual('Services', 'الخدمات') },
      { id: 'experience', type: 'section', builtin: true, order: 5, title: bilingual('Experience', 'الخبرة') },
      { id: 'education', type: 'section', builtin: true, order: 6, title: bilingual('Education', 'التعليم') },
      { id: 'contact', type: 'section', builtin: true, order: 7, title: bilingual('Get in touch', 'تواصل معي') },
    ];

    // Stamp a stable order on every seeded record (index within its type).
    for (const list of [projects, skills, certificates, services, experience, education, contacts]) {
      list.forEach((it, i) => { if (it.order == null) it.order = i; });
    }

    await ensureSeeded('project', projects);
    await ensureSeeded('skill', skills);
    await ensureSeeded('certificate', certificates);
    await ensureSeeded('about', about);
    await ensureSeeded('service', services);
    await ensureSeeded('experience', experience);
    await ensureSeeded('education', education);
    await ensureSeeded('hero', hero);
    await ensureSeeded('contact', contacts);
    await ensureSeeded('brand', brand);
    await ensureSeeded('section', sections);
  }

  /* ---- init ---- */

  // Fill in `order` for records created before ordering existed, so reordering
  // is stable for returning visitors. Runs once (meta flag).
  async function migrateOrder() {
    if (await getMeta('orderVer') === 1) return;
    const types = ['project', 'skill', 'certificate', 'about', 'service', 'experience', 'education', 'hero', 'contact'];
    for (const type of types) {
      const list = await getAll(type);
      let c = list.reduce((m, i) => Math.max(m, i.order || 0), 0);
      for (const it of list) {
        if (it.order == null) { it.order = ++c; await put(it); }
      }
    }
    await setMeta('orderVer', 1);
  }

  async function init() {
    try {
      idb = await open();
    } catch (e) {
      useMemory = true;
      console.warn('IndexedDB unavailable — using in-memory store (uploads will not persist across reloads).', e);
    }
    await seed();
    await migrateOrder();
    return { memoryMode: useMemory };
  }

  return {
    init, getAll, put, del,
    putImage, getImage, delImage,
    resolveImg, resolveAll,
    uid, getMeta, setMeta, onWrite,
    get isMemoryMode() { return useMemory; },
  };
})();
