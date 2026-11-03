/* ============================================================================
 * i18n.js — bilingual (EN/AR) strings + language/theme core
 * ----------------------------------------------------------------------------
 * Two kinds of translatable content:
 *   1. Static UI in index.html that uses data-ar attributes (the original
 *      pattern). setLang() swaps textContent on the fly.
 *   2. Dynamic content + JS-generated labels: a t(key) dictionary here, plus
 *      pick({en,ar}) for user-entered items stored in the DB.
 *
 * When the language changes we notify the app (via the onChange hook) so the
 * dynamic sections re-render in the new language.
 * ==========================================================================*/

const I18N = (() => {
  const root = document.documentElement;

  // Every UI string the JS injects, keyed for t().
  const STRINGS = {
    // project / certificate cards
    viewDetails:   { en: 'View Details', ar: 'عرض التفاصيل' },
    back:          { en: 'Back', ar: 'رجوع' },
    close:         { en: 'Close', ar: 'إغلاق' },
    details:       { en: 'Details', ar: 'التفاصيل' },

    // admin affordances
    add:           { en: 'Add', ar: 'إضافة' },
    addProject:    { en: 'Add Project', ar: 'إضافة مشروع' },
    addSkill:      { en: 'Add Skill', ar: 'إضافة مهارة' },
    addCertificate:{ en: 'Add Certificate', ar: 'إضافة شهادة' },
    editProject:   { en: 'Edit Project', ar: 'تعديل المشروع' },
    editSkill:     { en: 'Edit Skill', ar: 'تعديل المهارة' },
    editCertificate:{ en: 'Edit Certificate', ar: 'تعديل الشهادة' },
    delete:        { en: 'Delete', ar: 'حذف' },
    deleted:       { en: 'Deleted.', ar: 'تم الحذف.' },
    remove:        { en: 'Remove', ar: 'إزالة' },
    deleteConfirm: { en: 'Delete this item permanently?', ar: 'حذف هذا العنصر نهائيًا؟' },

    // admin form fields
    titleEn:       { en: 'Title (English)', ar: 'العنوان (إنجليزي)' },
    titleAr:       { en: 'Title (Arabic)', ar: 'العنوان (عربي)' },
    descEn:        { en: 'Description (English)', ar: 'الوصف (إنجليزي)' },
    descAr:        { en: 'Description (Arabic)', ar: 'الوصف (عربي)' },
    tags:          { en: 'Tags (comma separated)', ar: 'الوسوم (بفاصلة)' },
    link:          { en: 'Link (optional)', ar: 'رابط (اختياري)' },
    coverImage:    { en: 'Cover image', ar: 'صورة الغلاف' },
    coverImgHint:  { en: 'Thumbnail shown on the card', ar: 'الصورة المصغّرة على البطاقة' },
    galleryImages: { en: 'Gallery images', ar: 'صور المعرض' },
    galleryHint:   { en: 'Project screenshots (multiple)', ar: 'لقطات المشروع (متعددة)' },
    attachments:   { en: 'Additional images', ar: 'صور إضافية' },
    attachmentsHint:{ en: 'Optional supporting images', ar: 'صور داعمة اختيارية' },
    choose:        { en: 'Choose file', ar: 'اختر ملفًا' },
    chooseMany:    { en: 'Choose files', ar: 'اختر ملفات' },
    requiredField: { en: 'Title (required)', ar: 'العنوان (مطلوب)' },
    optional:      { en: 'optional', ar: 'اختياري' },
    save:          { en: 'Save', ar: 'حفظ' },
    cancel:        { en: 'Cancel', ar: 'إلغاء' },
    coverRequired: { en: 'A certificate cover image is required.', ar: 'صورة غلاف الشهادة مطلوبة.' },
    titleRequired: { en: 'Please enter a title.', ar: 'الرجاء إدخال العنوان.' },
    saved:         { en: 'Saved.', ar: 'تم الحفظ.' },

    // inquiry / CTA
    inquire:       { en: 'Inquire About This Service', ar: 'استفسر عن هذه الخدمة' },
    orderSimilar:  { en: 'Order a Similar Project', ar: 'اطلب مشروعًا مشابهًا' },
    contactVia:    { en: 'Reach me directly', ar: 'تواصل معي مباشرة' },
    whatsapp:      { en: 'WhatsApp', ar: 'واتساب' },
    email:         { en: 'Email (Gmail)', ar: 'بريد إلكتروني (Gmail)' },
    emailCopied:   { en: 'Opening Gmail — email copied to clipboard', ar: 'فتح Gmail — تم نسخ البريد إلى الحافظة' },
    linkedin:      { en: 'LinkedIn', ar: 'لينكدإن' },
    inquirySubject:{ en: 'Inquiry about', ar: 'استفسار عن' },

    // feedback + reviews
    feedbackTitle: { en: 'Leave your feedback', ar: 'اترك تقييمك' },
    yourName:      { en: 'Your name', ar: 'اسمك' },
    rating:        { en: 'Rating', ar: 'التقييم' },
    comment:       { en: 'Your comment', ar: 'تعليقك' },
    submitFeedback:{ en: 'Submit Feedback', ar: 'إرسال التقييم' },
    feedbackThanks:{ en: 'Thank you! Your review is pending approval.', ar: 'شكرًا لك! تقييمك بانتظار الموافقة.' },
    feedbackNeeds: { en: 'Please add your name, a rating and a comment.', ar: 'الرجاء إدخال الاسم والتقييم والتعليق.' },
    clientReviews: { en: 'Client Reviews', ar: 'آراء العملاء' },
    noReviewsYet:  { en: 'No reviews yet — be the first!', ar: 'لا توجد تقييمات بعد — كن أول من يقيّم!' },

    // moderation / notifications
    notifications: { en: 'Notifications', ar: 'الإشعارات' },
    moderation:    { en: 'Pending Reviews', ar: 'التقييمات المعلّقة' },
    pendingReviews:{ en: 'Pending Reviews', ar: 'تقييمات معلّقة' },
    noPending:     { en: 'No pending reviews.', ar: 'لا توجد تقييمات معلّقة.' },
    approve:       { en: 'Approve', ar: 'قبول' },
    reject:        { en: 'Reject', ar: 'رفض' },
    forProject:    { en: 'for', ar: 'لمشروع' },

    // admin session
    adminUnlocked: { en: 'Admin mode on', ar: 'وضع الإدارة مفعّل' },
    adminOff:      { en: 'Admin mode off', ar: 'وضع الإدارة متوقف' },
    enterPassword: { en: 'Enter admin password', ar: 'أدخل كلمة مرور الإدارة' },
    wrongPassword: { en: 'Wrong password', ar: 'كلمة المرور غير صحيحة' },
    signInEmail:   { en: 'Owner email', ar: 'بريد المالك' },
    signInPassword: { en: 'Owner password', ar: 'كلمة مرور المالك' },
    signingIn:     { en: 'Signing in…', ar: 'جارٍ تسجيل الدخول…' },
    wrongCredentials: { en: 'Sign-in failed — check the email and password', ar: 'فشل تسجيل الدخول — تحقق من البريد وكلمة المرور' },
    notOwner:      { en: 'This account is not the one this site syncs to', ar: 'هذا الحساب ليس هو الذي يتزامن الموقع إليه' },

    // empty states
    emptyProjects: { en: 'No projects yet.', ar: 'لا توجد مشاريع بعد.' },
    emptySkills:   { en: 'No skills yet.', ar: 'لا توجد مهارات بعد.' },
    emptyCertificates: { en: 'No certificates yet.', ar: 'لا توجد شهادات بعد.' },

    // edit affordance (used across all admin-editable sections)
    edit:          { en: 'Edit', ar: 'تعديل' },

    // add / edit labels per section
    editAbout:     { en: 'Edit About', ar: 'تعديل نبذة عني' },
    addService:    { en: 'Add Service', ar: 'إضافة خدمة' },
    editService:   { en: 'Edit Service', ar: 'تعديل الخدمة' },
    addExperience: { en: 'Add Experience', ar: 'إضافة خبرة' },
    editExperience:{ en: 'Edit Experience', ar: 'تعديل الخبرة' },
    addEducation:  { en: 'Add Education', ar: 'إضافة تعليم' },
    editEducation: { en: 'Edit Education', ar: 'تعديل التعليم' },

    // form field labels for the new sections
    headline:      { en: 'Headline', ar: 'العنوان الرئيسي' },
    bio:           { en: 'Bio (main paragraph)', ar: 'النبذة (الفقرة الأساسية)' },
    bioMore:       { en: 'Bio (second paragraph)', ar: 'النبذة (الفقرة الثانية)' },
    tagsLbl:       { en: 'Highlight tags (comma separated)', ar: 'وسوم بارزة (بفاصلة)' },
    icon:          { en: 'Icon (emoji)', ar: 'أيقونة (إيموجي)' },
    roleField:     { en: 'Role', ar: 'المسمى' },
    company:       { en: 'Company', ar: 'الجهة' },
    dates:         { en: 'Dates', ar: 'التاريخ' },
    institution:   { en: 'Institution', ar: 'الجهة التعليمية' },
    degree:        { en: 'Degree / Faculty', ar: 'الدرجة / الكلية' },
    status:        { en: 'Status', ar: 'الحالة' },
    courses:       { en: 'Courses (comma separated)', ar: 'الكورسات (بفاصلة)' },
    titleLbl:      { en: 'Title', ar: 'العنوان' },
    descLbl:       { en: 'Description', ar: 'الوصف' },

    // project extras: GitHub link, APK download, project video
    github:        { en: 'GitHub', ar: 'GitHub' },
    githubLink:    { en: 'GitHub link (optional)', ar: 'رابط GitHub (اختياري)' },
    apkFile:       { en: 'APK file (optional)', ar: 'ملف APK (اختياري)' },
    apkHint:       { en: 'Android package offered for download', ar: 'حزمة أندرويد متاحة للتحميل' },
    videoFile:     { en: 'Project video (optional)', ar: 'فيديو المشروع (اختياري)' },
    videoHint:     { en: 'MP4 / WebM demo of the app', ar: 'عرض MP4 / WebM للتطبيق' },
    chooseFile:    { en: 'Choose file', ar: 'اختر ملفًا' },
    noFile:        { en: 'No file selected', ar: 'لم يتم اختيار ملف' },
    downloadApk:   { en: 'Download APK', ar: 'تحميل APK' },
    projectVideo:  { en: 'Project video', ar: 'فيديو المشروع' },

    // admin review delete
    deleteReview:  { en: 'Delete this review', ar: 'حذف هذا التقييم' },
    deleteReviewConfirm: { en: 'Are you sure you want to delete this review?', ar: 'هل أنت متأكد من حذف هذا التقييم؟' },

    // visibility + reordering (all sections)
    show:          { en: 'Show to visitors', ar: 'إظهار للزوار' },
    hide:          { en: 'Hide from visitors', ar: 'إخفاء عن الزوار' },
    hiddenTag:     { en: 'Hidden', ar: 'مخفي' },
    moveUp:        { en: 'Move up', ar: 'تحريك لأعلى' },
    moveDown:      { en: 'Move down', ar: 'تحريك لأسفل' },

    // hero + section title editing
    editHero:      { en: 'Edit Hero', ar: 'تعديل الغلاف' },
    secTitleLbl:   { en: 'Section title', ar: 'عنوان القسم' },
    nameLbl:       { en: 'Full name', ar: 'الاسم الكامل' },
    roleLbl:       { en: 'Job title', ar: 'المسمى الوظيفي' },
    summaryLbl:    { en: 'Bio summary', ar: 'ملخص النبذة' },
    badgeLbl:      { en: 'Status badge', ar: 'شارة الحالة' },
    photoLbl:      { en: 'Profile photo', ar: 'الصورة الشخصية' },
    photoHint:     { en: 'Shown in the hero, displayed whole (no cropping)', ar: 'تظهر في الغلاف كاملة بدون قص' },

    // contact / social links
    addContact:    { en: 'Add Link', ar: 'إضافة رابط' },
    editContact:   { en: 'Edit Link', ar: 'تعديل الرابط' },
    urlLbl:        { en: 'Direct link / URL', ar: 'الرابط المباشر' },
    urlHint:       { en: 'Full URL, or a mailto:/wa.me handler', ar: 'رابط كامل أو mailto:/wa.me' },
    iconLbl:       { en: 'Icon (emoji, optional)', ar: 'أيقونة (إيموجي، اختياري)' },
    groupLbl:      { en: 'Which list', ar: 'أي قائمة' },
    groupMain:     { en: 'Get in touch', ar: 'تواصل معي' },
    groupFreelance:{ en: 'Freelance platforms', ar: 'منصات العمل الحر' },

    // header brand editing (logo + name + subtitle)
    editBrand:     { en: 'Edit Brand', ar: 'تعديل الهوية' },
    brandNameLbl:  { en: 'Brand name', ar: 'اسم العلامة' },
    brandSubLbl:   { en: 'Brand subtitle', ar: 'الوصف الفرعي' },
    brandNameEn:   { en: 'Brand name (English)', ar: 'اسم العلامة (إنجليزي)' },
    brandNameAr:   { en: 'Brand name (Arabic)', ar: 'اسم العلامة (عربي)' },
    brandSubEn:    { en: 'Subtitle (English)', ar: 'الوصف الفرعي (إنجليزي)' },
    brandSubAr:    { en: 'Subtitle (Arabic)', ar: 'الوصف الفرعي (عربي)' },
    secTitleEn:    { en: 'Section title (English)', ar: 'عنوان القسم (إنجليزي)' },
    secTitleAr:    { en: 'Section title (Arabic)', ar: 'عنوان القسم (عربي)' },
    logoLbl:       { en: 'Logo image', ar: 'صورة الشعار' },
    logoHint:      { en: 'Fits the fixed header box, never crops', ar: 'يلائم الإطار الثابت بدون قص' },

    // likes + views + visitors
    like:          { en: 'Like', ar: 'إعجاب' },
    likes:         { en: 'Likes', ar: 'إعجابات' },
    views:         { en: 'Views', ar: 'مشاهدات' },
    visitors:      { en: 'visitors', ar: 'زائرًا' },

    // dynamic section builder + header reordering
    addSection:    { en: 'Add Section', ar: 'إضافة قسم' },
    editSection:   { en: 'Rename Section', ar: 'إعادة تسمية القسم' },
    deleteSection: { en: 'Delete section', ar: 'حذف القسم' },
    deleteSectionConfirm: { en: 'Delete this section and all of its items?', ar: 'حذف هذا القسم وكل عناصره؟' },
    moveLeft:      { en: 'Move section left', ar: 'تحريك القسم لليسار' },
    moveRight:     { en: 'Move section right', ar: 'تحريك القسم لليمين' },
    renameHint:    { en: 'Double-click a menu item to rename it', ar: 'انقر مرتين على أي عنصر في القائمة لإعادة تسميته' },
    layoutLbl:     { en: 'Layout', ar: 'التخطيط' },
    layoutGrid:    { en: 'Grid cards', ar: 'بطاقات شبكية' },
    layoutList:    { en: 'List / timeline', ar: 'قائمة / خط زمني' },
    layoutText:    { en: 'Text & media', ar: 'نصوص ووسائط' },
    addItem:       { en: 'Add Item', ar: 'إضافة عنصر' },
    editItem:      { en: 'Edit Item', ar: 'تعديل العنصر' },
    emptyCards:    { en: 'No items yet.', ar: 'لا توجد عناصر بعد.' },
    imageOpt:      { en: 'Image (optional)', ar: 'صورة (اختياري)' },
    sectionTitleReq: { en: 'Please enter a section title.', ar: 'الرجاء إدخال عنوان القسم.' },
  };

  let lang = 'en';

  function t(key) {
    const s = STRINGS[key];
    if (!s) return key;
    return s[lang] || s.en;
  }

  // Resolve a stored {en,ar} field object to the active language.
  function pick(field) {
    if (typeof field === 'string') return field;
    if (!field) return '';
    return (field[lang] != null && field[lang] !== '') ? field[lang]
         : (field.en != null && field.en !== '') ? field.en
         : (field.ar || '');
  }

  // Called by the app when the language changes so dynamic views refresh.
  let onChange = () => {};
  function setOnChange(fn) { if (typeof fn === 'function') onChange = fn; }

  function setLang(next) {
    lang = next === 'ar' ? 'ar' : 'en';
    root.lang = lang;
    root.dir = lang === 'ar' ? 'rtl' : 'ltr';

    // Swap static [data-ar] text. Capture the original English the first time.
    document.querySelectorAll('[data-ar]').forEach(el => {
      if (!('en' in el.dataset)) el.dataset.en = el.textContent;
      el.textContent = lang === 'ar' ? el.dataset.ar : el.dataset.en;
    });

    const btn = document.getElementById('langBtn');
    if (btn) btn.textContent = lang === 'ar' ? 'EN' : 'عربي';

    try { localStorage.setItem('lang', lang); } catch (e) {}
    onChange(); // re-render dynamic sections
  }

  function toggleLang() { setLang(lang === 'ar' ? 'en' : 'ar'); }

  function setTheme(theme) {
    root.dataset.theme = theme === 'light' ? 'light' : 'dark';
    const btn = document.getElementById('themeBtn');
    if (btn) btn.textContent = theme === 'dark' ? '☀' : '☾';
    try { localStorage.setItem('theme', theme); } catch (e) {}
  }

  function toggleTheme() {
    setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark');
  }

  return {
    t, pick, setLang, toggleLang, setTheme, toggleTheme, setOnChange,
    get lang() { return lang; },
    get isRTL() { return lang === 'ar'; },
  };
})();
