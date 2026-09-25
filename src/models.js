/**
 * Model layer — the Node equivalent of CBT_UI's Django models. Each class
 * wraps a DB row: it decodes JSON/boolean/file columns on hydrate() and
 * exposes the same computed properties the Django models had
 * (get_FOO_display, eff_*, counts_as_ept, is_active_now, whatsapp_url, …) as
 * JS getters so templates read them exactly as the Django templates did.
 * Relations are attached explicitly by whoever loads them.
 */
const config = require('./config');

// ─────────────────────────────────────────────────────────── helpers ──

function parseJson(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (_) { return fallback; }
}

/** Mimics Django's FieldFile: truthy only when a file is set; exposes .url/.name. */
class FieldFile {
  constructor(name) { this.name = name; }
  get url() { return config.MEDIA_URL + this.name.split('/').map(encodeURIComponent).join('/'); }
  toString() { return this.name; }
}
const fileField = (name) => (name ? new FieldFile(name) : null);

function choiceLabel(choices, value) {
  const hit = choices.find((c) => c[0] === value);
  return hit ? hit[1] : (value || '');
}

class Model {
  static hydrate(row) {
    if (!row) return null;
    const obj = new this();
    Object.assign(obj, row);
    for (const f of this.jsonFields || []) obj[f] = parseJson(row[f], this.jsonDefaults?.[f] ?? []);
    for (const f of this.boolFields || []) obj[f] = row[f] === null || row[f] === undefined ? null : Boolean(row[f]);
    for (const f of this.fileFields || []) obj[f] = fileField(row[f]);
    return obj;
  }
  static hydrateAll(rows) { return rows.map((r) => this.hydrate(r)); }
  get pk() { return this.id; }
}

// ─────────────────────────────────────────────────────────── accounts ──

const ROLE_CHOICES = [
  ['super_admin', 'Super Admin'],
  ['admin', 'Admin'],
  ['staff', 'Exam Officer / Staff'],
  ['student', 'Student'],
];

class User extends Model {
  static table = 'accounts_user';
  static boolFields = ['is_superuser', 'is_staff', 'is_active', 'must_change_password'];
  static fileFields = ['avatar'];

  get is_authenticated() { return true; }
  get get_full_name() { return `${this.first_name || ''} ${this.last_name || ''}`.trim(); }
  get get_role_display() { return choiceLabel(ROLE_CHOICES, this.role); }
  get is_super_admin() { return this.role === 'super_admin'; }
  /** Admin-or-above — true for Admin and Super Admin alike. */
  get is_admin() { return this.role === 'admin' || this.role === 'super_admin'; }
  get is_student() { return this.role === 'student'; }
  get can_manage_exams() { return ['staff', 'admin', 'super_admin'].includes(this.role); }
  get initials() {
    const first = (this.first_name || this.username || '?').slice(0, 1);
    const last = (this.last_name || '').slice(0, 1);
    return (first + last).toUpperCase();
  }
  toString() { return `${this.get_full_name || this.username} (${this.get_role_display})`; }
}
User.ROLE_CHOICES = ROLE_CHOICES;

// ─────────────────────────────────────────────────────────── catalog ──

class Subject extends Model {
  static table = 'catalog_subject';
  static boolFields = ['is_active'];
  toString() { return this.name; }
}

class Faculty extends Model {
  static table = 'catalog_faculty';
  static boolFields = ['is_active'];
  toString() { return this.name; }
}

class Department extends Model {
  static table = 'catalog_department';
  static boolFields = ['is_active'];
  toString() { return this.name; }
}

const BUNDLE_LEVEL_CHOICES = [
  ['post_utme', 'Post-UTME'],
  ['postgraduate', 'Postgraduate'],
];

class Bundle extends Model {
  static table = 'catalog_bundle';
  static boolFields = ['is_active'];
  get get_level_display() { return choiceLabel(BUNDLE_LEVEL_CHOICES, this.level); }
  toString() { return this.name; }
}
Bundle.LEVEL_CHOICES = BUNDLE_LEVEL_CHOICES;
Bundle.LEVEL_POST_UTME = 'post_utme';
Bundle.LEVEL_POSTGRADUATE = 'postgraduate';

// ─────────────────────────────────────────────────────────── branding ──

class SiteSettings extends Model {
  static table = 'branding_sitesettings';
  static fileFields = ['logo'];

  /** `tel:` link target — digits and a leading + only. */
  get phone_href() {
    const cleaned = String(this.contact_phone || '').replace(/[^\d+]/g, '');
    return cleaned ? `tel:${cleaned}` : '';
  }

  /** A wa.me chat link; a Nigerian local number (0803…) becomes 234803… */
  get whatsapp_url() {
    let digits = String(this.whatsapp_number || '').replace(/\D/g, '');
    if (digits.startsWith('0') && digits.length === 11) digits = `234${digits.slice(1)}`;
    if (!digits) return '';
    // Python's urllib.parse.quote(): like encodeURIComponent but also escapes !'()* and keeps "/".
    const text = encodeURIComponent(`Hello, I need help with ${this.school_name}.`)
      .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
      .replace(/%2F/g, '/');
    return `https://wa.me/${digits}?text=${text}`;
  }

  get effective_logo_url() { return this.logo ? this.logo.url : this.logo_url; }
  toString() { return this.school_name; }
}

// ─────────────────────────────────────────────────────────── billing ──

class Plan extends Model {
  static table = 'billing_plan';
  static boolFields = ['is_all_access', 'is_active', 'is_order_snapshot'];
  toString() { return this.name; }
}

class PricingTier extends Model {
  static table = 'billing_pricingtier';
  static boolFields = ['is_active'];
  get duration_days() { return this.months * 30; }
  toString() { return `${this.months} month${this.months !== 1 ? 's' : ''} — ₦${Math.round(Number(this.price)).toLocaleString('en-US')}`; }
}

const SUBSCRIPTION_STATUS_CHOICES = [['active', 'Active'], ['expired', 'Expired'], ['cancelled', 'Cancelled']];

class Subscription extends Model {
  static table = 'billing_subscription';
  get get_status_display() { return choiceLabel(SUBSCRIPTION_STATUS_CHOICES, this.status); }
  get is_active_now() {
    const now = new Date();
    return this.status === 'active' && this.starts_at <= now && now <= this.ends_at;
  }
}
Subscription.STATUS_CHOICES = SUBSCRIPTION_STATUS_CHOICES;

const PAYMENT_STATUS_CHOICES = [['pending', 'Pending'], ['success', 'Success'], ['failed', 'Failed']];

class Payment extends Model {
  static table = 'billing_payment';
  static jsonFields = ['raw_response'];
  static jsonDefaults = { raw_response: {} };
  get get_status_display() { return choiceLabel(PAYMENT_STATUS_CHOICES, this.status); }
}
Payment.STATUS_CHOICES = PAYMENT_STATUS_CHOICES;

// ─────────────────────────────────────────────────────────── examhub ──

const QUESTION_JSON_FIELDS = [
  'choices_data', 'blank_answers', 'keywords', 'match_left', 'match_right',
  'correct_pairs', 'order_items', 'categories', 'category_items',
];

const TYPE_CHOICES = [
  ['mcq_single', 'Multiple Choice — Single Answer'],
  ['mcq_multi', 'Multiple Choice — Multiple Answers'],
  ['true_false', 'True / False'],
  ['fill_blank', 'Fill in the Blank'],
  ['numeric', 'Numeric Answer'],
  ['theory', 'Theory / Essay'],
  ['match', 'Match Pairs'],
  ['order', 'Ordering / Sequencing'],
  ['category', 'Drag into Categories'],
];
const DIFFICULTY_CHOICES = [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']];
const BLOOM_CHOICES = [
  ['remember', 'Remember'], ['understand', 'Understand'], ['apply', 'Apply'],
  ['analyze', 'Analyze'], ['evaluate', 'Evaluate'], ['create', 'Create'],
];

/** Best-effort equivalent of ast.literal_eval for a list of simple dicts. */
function parsePythonLiteral(text) {
  try {
    const jsonish = text
      .replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')
      .replace(/'((?:[^'\\]|\\.)*)'/g, (_, s) => JSON.stringify(s.replace(/\\'/g, "'")));
    return JSON.parse(jsonish);
  } catch (_) {
    return null;
  }
}

/** Defensively repair choices_data corrupted by a buggy client submission (port of _repair_choices). */
function repairChoices(choicesData) {
  if (!choicesData || !Array.isArray(choicesData)) return choicesData;
  const cleaned = [];
  for (const item of choicesData) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const text = item.text ?? '';
    if (typeof text === 'string' && text.startsWith('[{') && text.endsWith('}]')) {
      const recovered = parsePythonLiteral(text);
      if (Array.isArray(recovered) && recovered.length && recovered[0] && typeof recovered[0] === 'object') {
        cleaned.push(...recovered);
        continue;
      }
    }
    cleaned.push(item);
  }
  const seen = new Set();
  const deduped = [];
  for (const item of cleaned) {
    const t = String(item.text ?? '').trim();
    if (t && !seen.has(t)) { seen.add(t); deduped.push(item); }
  }
  return deduped.length ? deduped.slice(0, 6) : choicesData;
}

class QuestionBank extends Model {
  static table = 'examhub_questionbank';
  toString() { return this.name; }
}

class Question extends Model {
  static table = 'examhub_question';
  static jsonFields = QUESTION_JSON_FIELDS;
  static boolFields = ['tf_answer', 'is_verified'];
  get get_question_type_display() { return choiceLabel(TYPE_CHOICES, this.question_type); }
  get get_difficulty_display() { return choiceLabel(DIFFICULTY_CHOICES, this.difficulty); }
  get get_bloom_level_display() { return choiceLabel(BLOOM_CHOICES, this.bloom_level); }
  toString() { return `[${this.get_question_type_display}] ${String(this.stem || '').slice(0, 80)}`; }
}
Question.TYPE_CHOICES = TYPE_CHOICES;
Question.DIFFICULTY_CHOICES = DIFFICULTY_CHOICES;
Question.BLOOM_CHOICES = BLOOM_CHOICES;

const EXAM_MODE_CHOICES = [
  ['test', 'Test — Timed, score at end'],
  ['practice', 'Practice — Immediate feedback per question'],
  ['exam', 'Exam — Strict: 1 attempt, locked browser'],
  ['assessment', 'Assessment — Untimed, multiple attempts'],
];

/**
 * Callers attach `subject` and `bundle` (with `bundle.level`) after hydrating —
 * counts_as_ept / is_postgraduate_practice / effective_max_attempts read them.
 */
class Exam extends Model {
  static table = 'examhub_exam';
  static boolFields = [
    'is_ept', 'negative_marking', 'require_fullscreen', 'detect_tab_switch', 'allow_calculator',
    'allow_scratch_pad', 'is_published', 'is_self_study',
  ];
  get get_mode_display() { return choiceLabel(EXAM_MODE_CHOICES, this.mode); }

  /**
   * The EPT is shared by every department, so it belongs to no programme. An
   * exam flagged EPT *and* attached to a programme stays gated by that
   * programme (least privilege).
   */
  get counts_as_ept() { return this.is_ept && !this.bundle_id; }

  /** EPT and postgraduate department exams are past-question practice: unlimited retakes. */
  get is_postgraduate_practice() {
    return this.counts_as_ept || Boolean(this.bundle_id && this.bundle && this.bundle.level === 'postgraduate');
  }

  effective_max_attempts() {
    if (this.mode === 'exam' && !this.is_postgraduate_practice) return 1;
    return this.max_attempts;
  }
  toString() { return this.title; }
}
Exam.MODE_CHOICES = EXAM_MODE_CHOICES;

class ExamSection extends Model {
  static table = 'examhub_examsection';
  static boolFields = ['randomize_questions', 'randomize_choices'];
}

/**
 * A snapshot of a question inside an exam section. eff_* returns the linked
 * bank question's value when there is one, else the inline copy on this row.
 * Callers attach `bank_question` (a Question or null) after hydrating.
 */
class ExamQuestion extends Model {
  static table = 'examhub_examquestion';
  static jsonFields = QUESTION_JSON_FIELDS;
  static boolFields = ['tf_answer'];

  _eff(field) { return this.bank_question ? this.bank_question[field] : this[field]; }
  get eff_type() { return this._eff('question_type'); }
  get eff_stem() { return this._eff('stem'); }
  get eff_stem_image_url() { return this._eff('stem_image_url'); }
  get eff_choices_data() { return repairChoices(this._eff('choices_data')); }
  get eff_tf_answer() { return this._eff('tf_answer'); }
  get eff_blank_answers() { return this._eff('blank_answers'); }
  get eff_numeric_answer() { return this._eff('numeric_answer'); }
  get eff_numeric_tolerance() { return this._eff('numeric_tolerance'); }
  get eff_numeric_unit() { return this._eff('numeric_unit'); }
  get eff_model_answer() { return this._eff('model_answer'); }
  get eff_keywords() { return this._eff('keywords'); }
  get eff_match_left() { return this._eff('match_left'); }
  get eff_match_right() { return this._eff('match_right'); }
  get eff_correct_pairs() { return this._eff('correct_pairs'); }
  get eff_order_items() { return this._eff('order_items'); }
  get eff_categories() { return this._eff('categories'); }
  get eff_category_items() { return this._eff('category_items'); }
  get eff_explanation() { return this._eff('explanation'); }
  get eff_topic() { return this.bank_question ? this.bank_question.topic : ''; }
  get eff_difficulty() { return this.bank_question ? this.bank_question.difficulty : 'medium'; }
}

const ATTEMPT_STATUS_CHOICES = [
  ['in_progress', 'In Progress'],
  ['completed', 'Completed'],
  ['timed_out', 'Timed Out'],
  ['auto_submitted', 'Auto Submitted'],
];
const DONE_STATUSES = ['completed', 'timed_out', 'auto_submitted'];

class ExamAttempt extends Model {
  static table = 'examhub_examattempt';
  static jsonFields = ['question_order'];
  static boolFields = ['passed'];
  get get_status_display() { return choiceLabel(ATTEMPT_STATUS_CHOICES, this.status); }
}

class AttemptAnswer extends Model {
  static table = 'examhub_attemptanswer';
  static jsonFields = ['selected_indices', 'answer_data'];
  static jsonDefaults = { selected_indices: [], answer_data: null };
  static boolFields = ['is_correct', 'flagged'];
  get effective_score() { return this.manual_score !== null && this.manual_score !== undefined ? this.manual_score : this.auto_score; }
}

module.exports = {
  parseJson, FieldFile, fileField, choiceLabel, repairChoices,
  User, Subject, Faculty, Department, Bundle, SiteSettings,
  Plan, PricingTier, Subscription, Payment,
  QuestionBank, Question, Exam, ExamSection, ExamQuestion, ExamAttempt, AttemptAnswer,
  DONE_STATUSES, QUESTION_JSON_FIELDS,
};
