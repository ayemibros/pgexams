/**
 * Named URL table — every route path, keyed by the same "namespace:name" the
 * Django CBT_UI project used, with identical paths. Routers register handlers
 * by name (route() in src/web.js) and templates build links with
 * url('ns:name', arg1, …) or url('ns:name', role='staff') — Django's {% url %}.
 */
const URLS = {
  // ── accounts ─────────────────────────────────────────────────────────
  'accounts:login': '/accounts/login/',
  'accounts:register': '/accounts/register/',
  'accounts:logout': '/accounts/logout/',
  'accounts:post_login_redirect': '/accounts/redirect/',
  'accounts:change_password': '/accounts/change-password/',
  'accounts:my_profile': '/accounts/profile/',
  'accounts:account_list': '/accounts/staff/accounts/',
  'accounts:account_create': '/accounts/staff/accounts/new/:role/',
  'accounts:account_toggle_active': '/accounts/staff/accounts/:pk/toggle-active/',

  // ── branding (public site + site settings) ───────────────────────────
  'branding:home': '/',
  'branding:support': '/support/',
  'branding:how_it_works': '/how-it-works/',
  'branding:pricing': '/pricing/',
  'branding:site_settings': '/staff/settings/',

  // ── catalog ──────────────────────────────────────────────────────────
  'catalog:faculty_list': '/staff/faculties/',
  'catalog:faculty_add': '/staff/faculties/new/',
  'catalog:faculty_edit': '/staff/faculties/:pk/edit/',
  'catalog:faculty_delete': '/staff/faculties/:pk/delete/',
  'catalog:subject_list': '/staff/subjects/',
  'catalog:subject_add': '/staff/subjects/new/',
  'catalog:subject_edit': '/staff/subjects/:pk/edit/',
  'catalog:subject_delete': '/staff/subjects/:pk/delete/',
  'catalog:department_list': '/staff/departments/',
  'catalog:department_add': '/staff/departments/new/',
  'catalog:department_edit': '/staff/departments/:pk/edit/',
  'catalog:department_delete': '/staff/departments/:pk/delete/',
  'catalog:program_list': '/staff/programs/',
  'catalog:program_add': '/staff/programs/new/',
  'catalog:program_edit': '/staff/programs/:pk/edit/',
  'catalog:program_delete': '/staff/programs/:pk/delete/',

  // ── billing ──────────────────────────────────────────────────────────
  'billing:plan_list': '/staff/plans/',
  'billing:plan_add': '/staff/plans/new/',
  'billing:plan_edit': '/staff/plans/:pk/edit/',
  'billing:plan_delete': '/staff/plans/:pk/delete/',
  'billing:tier_list': '/staff/pricing/',
  'billing:tier_add': '/staff/pricing/add/',
  'billing:tier_delete': '/staff/pricing/:pk/delete/',
  'billing:subscription_list': '/staff/subscriptions/',
  'billing:subscription_add': '/staff/subscriptions/new/',
  'billing:subscription_edit': '/staff/subscriptions/:pk/edit/',
  'billing:subscription_cancel': '/staff/subscriptions/:pk/cancel/',
  'billing:payment_list': '/staff/payments/',
  'billing:plans_browse': '/subscribe/',
  'billing:checkout_cart': '/subscribe/checkout/',
  'billing:checkout_start': '/subscribe/:plan_pk/pay/',
  'billing:sim_payment': '/subscribe/test-payment/:reference/',
  'billing:checkout_callback': '/subscribe/callback/',
  'billing:payment_webhook': '/subscribe/webhook/',

  // ── examhub: student ─────────────────────────────────────────────────
  'examhub:student_dashboard': '/dashboard/',
  'examhub:exam_list': '/exams/',
  'examhub:exam_start': '/exams/:pk/start/',
  'examhub:practice_setup': '/practice/',
  'examhub:student_results': '/results/',
  'examhub:exam_take': '/attempt/:attempt_pk/take/',
  'examhub:save_answer': '/attempt/:attempt_pk/save/',
  'examhub:flag': '/attempt/:attempt_pk/flag/',
  'examhub:track_tab': '/attempt/:attempt_pk/tab/',
  'examhub:track_fullscreen': '/attempt/:attempt_pk/fullscreen/',
  'examhub:check_timeout': '/attempt/:attempt_pk/check-timeout/',
  'examhub:submit': '/attempt/:attempt_pk/submit/',
  'examhub:exam_results': '/attempt/:attempt_pk/results/',
  'examhub:exam_review': '/attempt/:attempt_pk/review/',

  // ── examhub: staff ───────────────────────────────────────────────────
  'examhub:staff_dashboard': '/staff/',
  'examhub:bank_list': '/staff/banks/',
  'examhub:bank_add': '/staff/banks/new/',
  'examhub:bank_edit': '/staff/banks/:pk/edit/',
  'examhub:bank_delete': '/staff/banks/:pk/delete/',
  'examhub:bank_questions': '/staff/banks/:bank_pk/questions/',
  'examhub:question_add': '/staff/banks/:bank_pk/questions/add/',
  'examhub:question_edit': '/staff/banks/:bank_pk/questions/:pk/edit/',
  'examhub:question_delete': '/staff/banks/:bank_pk/questions/:pk/delete/',
  'examhub:bulk_upload': '/staff/banks/:bank_pk/bulk-upload/',
  'examhub:bulk_upload_start': '/staff/bulk-upload/',
  'examhub:bulk_upload_template': '/staff/bulk-upload/template/:fmt/',
  'examhub:upload_asset': '/staff/upload-asset/',
  'examhub:staff_exam_list': '/staff/exams/',
  'examhub:exam_add': '/staff/exams/new/',
  'examhub:exam_edit': '/staff/exams/:pk/edit/',
  'examhub:exam_delete': '/staff/exams/:pk/delete/',
  'examhub:exam_clone': '/staff/exams/:pk/clone/',
  'examhub:exam_sections': '/staff/exams/:pk/sections/',
  'examhub:section_questions': '/staff/sections/:section_pk/questions/',
  'examhub:grade_theory': '/staff/attempt/:attempt_pk/grade/',
  'examhub:exam_analytics': '/staff/exams/:pk/analytics/',
  'examhub:staff_exam_results': '/staff/exams/:pk/results/',
};

// Django's <int:…> params. Express 5 has no inline regex params, so the route
// wrapper skips to the next route when one of these isn't all digits.
const INT_PARAMS = new Set(['pk', 'section_pk', 'bank_pk', 'attempt_pk', 'plan_pk']);
// <slug:…> params (none in this project; kept for the shared route wrapper).
const SLUG_PARAMS = new Set([]);

function expressPath(name) {
  const p = URLS[name];
  if (!p) throw new Error(`Unknown URL name: ${name}`);
  return p;
}

class NoReverseMatch extends Error {}

/**
 * reverse('ns:name', ...args). Positional args fill the path params in order;
 * a trailing Nunjucks keyword-args object ({ role: 'staff', __keywords: true })
 * fills params by name — Django's {% url 'x' role='staff' %}.
 */
function reverse(name, ...args) {
  const p = URLS[name];
  if (!p) throw new NoReverseMatch(`Reverse for '${name}' not found.`);
  let kwargs = {};
  const last = args[args.length - 1];
  if (last && typeof last === 'object' && last.__keywords) { kwargs = last; args = args.slice(0, -1); }
  let i = 0;
  return p.replace(/:([a-z_]+)/g, (_, param) => {
    const v = param in kwargs ? kwargs[param] : args[i++];
    if (v === undefined || v === null || v === '') throw new NoReverseMatch(`Reverse for '${name}' missing argument '${param}'.`);
    return encodeURIComponent(String(v));
  });
}

module.exports = { URLS, INT_PARAMS, SLUG_PARAMS, expressPath, reverse, NoReverseMatch };
