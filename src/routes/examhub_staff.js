/** Port of CBT_UI's examhub/staff_views.py. */
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const db = require('../db');
const {
  Subject, Bundle, Exam, ExamAttempt, ExamSection, Question, QuestionBank, User, AttemptAnswer, Payment, Plan, repairChoices,
} = require('../models');
const { route, render, redirect, messages, getOr404, jsonResponse, Http404 } = require('../web');
const { parseLocalDateTime } = require('../templating');
const { sanitizeRichHtml } = require('../services/sanitize');
const { saveBytes } = require('../forms');
const { attachDepartments } = require('../services/billing');
const X = require('../services/exams');
const {
  contains, strip, lines, intOrNull, decimalOrNull, readCsvDicts, writeCsv, round2,
  pyRepr, pyStrip, pyOr, pyTruthyLite, pyFloat, pyIntValue,
} = require('../services/util');

const router = express.Router();
const isTeacher = (req) => req.user.is_authenticated && req.user.can_manage_exams;
const DONE = "('completed','timed_out','auto_submitted')";

function denied(req, res) {
  messages.error(req, 'Access denied.');
  return redirect(res, '/');
}

function buildMcqSlots(q) {
  const existing = repairChoices(q ? (q.choices_data || []) : []) || [];
  return 'ABCDEF'.split('').map((label, i) => {
    const slot = existing[i];
    if (slot && typeof slot === 'object') return { label, text: slot.text ?? '', is_correct: Boolean(slot.is_correct) };
    return { label, text: '', is_correct: false };
  });
}

function parseJsonField(raw, fallback) {
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

async function getBank(pk) {
  return getOr404(db.one('SELECT * FROM examhub_questionbank WHERE id = ?', [pk]).then((r) => QuestionBank.hydrate(r)));
}

// ─────────────────────────────────────────── DASHBOARD ──

route(router, 'examhub:staff_dashboard', async (req, res) => {
  if (!isTeacher(req)) return denied(req, res);

  const pendingGrading = Number(await db.value(
    `SELECT COUNT(*) FROM examhub_attemptanswer a JOIN examhub_examquestion q ON q.id = a.exam_question_id
       LEFT JOIN examhub_question b ON b.id = q.bank_question_id
     WHERE a.manual_score IS NULL AND (q.question_type = 'theory' OR b.question_type = 'theory') AND a.text_answer <> ''`,
  ));
  const recentAttempts = ExamAttempt.hydrateAll(await db.all(
    `SELECT * FROM examhub_examattempt WHERE status IN ${DONE} ORDER BY completed_at IS NULL, completed_at DESC LIMIT 8`,
  ));
  await X.attachUsers(recentAttempts, 'student_id', 'student');
  await X.attachExams(recentAttempts);

  let platformStats = null;
  if (req.user.is_super_admin) {
    const now = new Date();
    const recentPayments = Payment.hydrateAll(await db.all("SELECT * FROM billing_payment WHERE status = 'success' ORDER BY verified_at IS NULL, verified_at DESC LIMIT 5"));
    await X.attachUsers(recentPayments, 'student_id', 'student');
    const plans = await X.byIds(Plan, 'billing_plan', recentPayments.map((p) => p.plan_id));
    for (const p of recentPayments) p.plan = plans.get(p.plan_id);
    platformStats = {
      total_students: Number(await db.value("SELECT COUNT(*) FROM accounts_user WHERE role = 'student'")),
      total_staff: Number(await db.value("SELECT COUNT(*) FROM accounts_user WHERE role = 'staff'")),
      total_admins: Number(await db.value("SELECT COUNT(*) FROM accounts_user WHERE role = 'admin'")),
      active_subscriptions: Number(await db.value("SELECT COUNT(*) FROM billing_subscription WHERE status = 'active' AND ends_at >= ?", [now])),
      total_revenue: Number(await db.value("SELECT COALESCE(SUM(amount), 0) FROM billing_payment WHERE status = 'success'")) || 0,
      recent_signups: User.hydrateAll(await db.all("SELECT * FROM accounts_user WHERE role = 'student' ORDER BY created_at DESC LIMIT 5")),
      recent_payments: recentPayments,
    };
  }

  return render(req, res, 'examhub/staff/dashboard.html', {
    active: 'dashboard',
    bank_count: Number(await db.value('SELECT COUNT(*) FROM examhub_questionbank')),
    question_count: Number(await db.value('SELECT COUNT(*) FROM examhub_question')),
    exam_count: Number(await db.value('SELECT COUNT(*) FROM examhub_exam WHERE is_self_study = 0')),
    published_count: Number(await db.value('SELECT COUNT(*) FROM examhub_exam WHERE is_self_study = 0 AND is_published = 1')),
    pending_grading: pendingGrading,
    recent_attempts: recentAttempts,
    platform_stats: platformStats,
  });
}, { login: true });

// ─────────────────────────────────────────── QUESTION BANKS ──

route(router, 'examhub:bank_list', async (req, res) => {
  if (!isTeacher(req)) return denied(req, res);
  const banks = QuestionBank.hydrateAll(await db.all(
    'SELECT b.*, (SELECT COUNT(*) FROM examhub_question q WHERE q.bank_id = b.id) AS question_count FROM examhub_questionbank b ORDER BY b.created_at DESC',
  ));
  const subjects = await X.byIds(Subject, 'catalog_subject', banks.map((b) => b.subject_id));
  for (const b of banks) b.subject = subjects.get(b.subject_id) || null;
  await X.attachUsers(banks, 'created_by_id', 'created_by');
  return render(req, res, 'examhub/staff/bank_list.html', { active: 'banks', banks });
}, { login: true });

async function bankForm(req, res, { pk = null } = {}) {
  if (!isTeacher(req)) return denied(req, res);
  const bank = pk ? await getBank(pk) : null;
  if (req.method === 'POST') {
    const name = strip(req.POST.get('name', ''));
    if (!name) {
      messages.error(req, 'Bank name is required.');
    } else {
      const data = { name, description: strip(req.POST.get('description', '')), subject_id: intOrNull(req.POST.get('subject') || null) };
      let id;
      if (bank) { await db.update('examhub_questionbank', bank.id, data); id = bank.id; } else {
        id = await db.insert('examhub_questionbank', { ...data, created_by_id: req.user.id, created_at: new Date() });
      }
      messages.success(req, 'Question bank saved.');
      return redirect(res, 'examhub:bank_questions', id);
    }
  }
  return render(req, res, 'examhub/staff/bank_form.html', {
    active: 'banks', bank, subjects: Subject.hydrateAll(await db.all('SELECT * FROM catalog_subject ORDER BY name')),
  });
}
route(router, 'examhub:bank_add', (req, res) => bankForm(req, res), { login: true });
route(router, 'examhub:bank_edit', (req, res, p) => bankForm(req, res, p), { login: true });

route(router, 'examhub:bank_delete', async (req, res, { pk }) => {
  if (!isTeacher(req)) return redirect(res, '/');
  const bank = await getBank(pk);
  await db.remove('examhub_questionbank', bank.id);
  messages.success(req, `Bank "${bank.name}" deleted.`);
  return redirect(res, 'examhub:bank_list');
}, { login: true, post: true });

route(router, 'examhub:bank_questions', async (req, res, { bank_pk }) => {
  if (!isTeacher(req)) return denied(req, res);
  const bank = await getBank(bank_pk);
  bank.subject = bank.subject_id ? Subject.hydrate(await db.one('SELECT * FROM catalog_subject WHERE id = ?', [bank.subject_id])) : null;
  const qtype = req.GET.get('type', '');
  const diff = req.GET.get('difficulty', '');
  const topic = req.GET.get('topic', '');
  const search = req.GET.get('q', '');
  const where = ['bank_id = ?'];
  const params = [bank.id];
  if (qtype) { where.push('question_type = ?'); params.push(qtype); }
  if (diff) { where.push('difficulty = ?'); params.push(diff); }
  if (topic) { where.push("topic LIKE ? ESCAPE '\\\\'"); params.push(contains(topic)); }
  if (search) { where.push("stem LIKE ? ESCAPE '\\\\'"); params.push(contains(search)); }
  return render(req, res, 'examhub/staff/bank_questions.html', {
    active: 'banks', bank,
    questions: Question.hydrateAll(await db.all(`SELECT * FROM examhub_question WHERE ${where.join(' AND ')} ORDER BY created_at DESC`, params)),
    type_choices: Question.TYPE_CHOICES, difficulty_choices: Question.DIFFICULTY_CHOICES,
    filters: { type: qtype, difficulty: diff, topic, q: search },
  });
}, { login: true });

/** Type-specific answer fields, shared by the bank question form and inline section questions. */
function readTypeFields(post, qt, target, { strict }) {
  if (qt === 'mcq_single' || qt === 'mcq_multi') {
    const texts = post.getlist('choice_text[]');
    const corrects = post.getlist('choice_correct[]');
    target.choices_data = texts.map((t, i) => ({ t, i })).filter(({ t }) => t.trim())
      .map(({ t, i }) => ({ text: sanitizeRichHtml(t.trim()), is_correct: corrects.includes(String(i)) }));
  } else if (qt === 'true_false') {
    target.tf_answer = post.get('tf_answer') === 'true';
  } else if (qt === 'fill_blank') {
    const v = parseJsonField(post.get('blank_answers_json', '[]'), undefined);
    if (v !== undefined) target.blank_answers = v; else if (strict) target.blank_answers = [];
  } else if (qt === 'numeric') {
    const ans = decimalOrNull(post.get('numeric_answer', '0'));
    if (ans !== null || strict) target.numeric_answer = ans;
    const tol = decimalOrNull(post.get('numeric_tolerance', '0'));
    if (tol !== null) target.numeric_tolerance = tol; else if (strict) target.numeric_tolerance = 0;
    target.numeric_unit = strip(post.get('numeric_unit', ''));
  } else if (qt === 'theory') {
    target.model_answer = sanitizeRichHtml(strip(post.get('model_answer', '')));
    target.keywords = strip(post.get('keywords', '')).split(',').map((k) => k.trim()).filter(Boolean);
  } else if (qt === 'match') {
    target.match_left = lines(post.get('match_left', ''));
    target.match_right = lines(post.get('match_right', ''));
    const v = parseJsonField(post.get('correct_pairs_json', '[]'), undefined);
    if (v !== undefined) target.correct_pairs = v; else if (strict) target.correct_pairs = [];
  } else if (qt === 'order') {
    target.order_items = lines(post.get('order_items', ''));
  } else if (qt === 'category') {
    target.categories = lines(post.get('categories', ''));
    const v = parseJsonField(post.get('category_items_json', '[]'), undefined);
    if (v !== undefined) target.category_items = v; else if (strict) target.category_items = [];
  }
}

async function questionForm(req, res, { bank_pk, pk = null }) {
  if (!isTeacher(req)) return denied(req, res);
  const bank = await getBank(bank_pk);
  const q = pk ? await getOr404(db.one('SELECT * FROM examhub_question WHERE id = ? AND bank_id = ?', [pk, bank.id]).then((r) => Question.hydrate(r))) : null;
  const renderForm = () => render(req, res, 'examhub/staff/question_form.html', {
    active: 'banks', bank, q, type_choices: Question.TYPE_CHOICES, difficulty_choices: Question.DIFFICULTY_CHOICES,
    bloom_choices: Question.BLOOM_CHOICES, mcq_choice_slots: buildMcqSlots(q),
  });

  if (req.method === 'POST') {
    const post = req.POST;
    const qt = post.get('question_type', '');
    const stem = strip(post.get('stem', ''));
    if (!stem || !qt) {
      messages.error(req, 'Question type and stem are required.');
      return renderForm();
    }
    const data = {
      question_type: qt, stem: sanitizeRichHtml(stem), difficulty: post.get('difficulty', 'medium'),
      bloom_level: post.get('bloom_level', ''), topic: strip(post.get('topic', '')), subtopic: strip(post.get('subtopic', '')),
      year_asked: intOrNull(post.get('year_asked', '') || null), explanation: sanitizeRichHtml(strip(post.get('explanation', ''))),
      stem_image_url: strip(post.get('stem_image_url', '')), default_points: decimalOrNull(post.get('default_points', '1')) ?? 1,
    };
    readTypeFields(post, qt, data, { strict: true });
    if (qt === 'mcq_single' || qt === 'mcq_multi') {
      if (!data.choices_data.length) { messages.error(req, 'Add at least two answer choices.'); return renderForm(); }
      if (!data.choices_data.some((c) => c.is_correct)) { messages.error(req, 'Mark at least one choice as correct.'); return renderForm(); }
    }
    if (q) await db.update('examhub_question', q.id, { ...data, updated_at: new Date() });
    else await X.createQuestion({ ...data, bank_id: bank.id, created_by_id: req.user.id });
    messages.success(req, 'Question saved.');
    if (post.get('add_another') === '1') return redirect(res, 'examhub:question_add', bank.id);
    return redirect(res, 'examhub:bank_questions', bank.id);
  }
  return renderForm();
}
route(router, 'examhub:question_add', (req, res, p) => questionForm(req, res, p), { login: true });
route(router, 'examhub:question_edit', (req, res, p) => questionForm(req, res, p), { login: true });

route(router, 'examhub:question_delete', async (req, res, { bank_pk, pk }) => {
  if (!isTeacher(req)) return redirect(res, '/');
  const bank = await getBank(bank_pk);
  await getOr404(db.one('SELECT id FROM examhub_question WHERE id = ? AND bank_id = ?', [pk, bank.id]));
  await db.remove('examhub_question', pk);
  messages.success(req, 'Question deleted.');
  return redirect(res, 'examhub:bank_questions', bank_pk);
}, { login: true, post: true });

// ─────────────────────────────────────────── BULK UPLOAD ──

async function createImportedQuestion(bank, user, row, i, createdRows, errorRows) {
  try {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`'${Array.isArray(row) ? 'list' : typeof row}' object has no attribute 'get'`);
    const get = (k) => row[k];
    const qtype = pyStrip(pyOr(get('type'), get('question_type'), 'mcq_single')).toLowerCase();
    const stem = pyStrip(pyOr(get('stem'), get('question'), ''));
    if (!stem) { errorRows.push({ row: i, reason: 'Missing stem', raw_repr: pyRepr(row) }); return; }

    const data = {
      bank_id: bank.id, question_type: qtype, stem: sanitizeRichHtml(stem), created_by_id: user.id,
      explanation: sanitizeRichHtml(pyStrip(pyOr(get('explanation'), ''))),
      difficulty: pyStrip(pyOr(get('difficulty'), 'medium')),
      bloom_level: pyStrip(pyOr(get('bloom_level'), '')) || '',
      topic: pyStrip(pyOr(get('topic'), '')), subtopic: pyStrip(pyOr(get('subtopic'), '')),
      default_points: round2(pyFloat(pyOr(get('points'), get('default_points'), 1))),
      year_asked: pyTruthyLite(get('year')) ? pyIntValue(get('year')) : null,
    };
    if (qtype === 'mcq_single' || qtype === 'mcq_multi') {
      if ('choices' in row && Array.isArray(row.choices)) {
        data.choices_data = row.choices.map((c) => ({ ...c, text: sanitizeRichHtml(c && c.text !== undefined ? c.text : '') }));
      } else {
        const choices = [];
        const correctRaw = String(row.correct ?? '').trim().toUpperCase();
        for (const letter of ['A', 'B', 'C', 'D', 'E', 'F']) {
          const key = `choice_${letter.toLowerCase()}`;
          if (pyStrip(key in row ? row[key] : '')) choices.push({ text: sanitizeRichHtml(pyStrip(row[key])), is_correct: correctRaw.includes(letter) });
        }
        data.choices_data = choices;
      }
    } else if (qtype === 'true_false') {
      data.tf_answer = ['true', '1', 'yes', 't'].includes(String(pyOr(get('answer'), get('correct'), 'true')).trim().toLowerCase());
    } else if (qtype === 'fill_blank') {
      if ('blank_answers' in row && Array.isArray(row.blank_answers)) data.blank_answers = row.blank_answers;
      else data.blank_answers = [String(pyOr(get('answer'), get('correct'), '')).split('|').map((a) => a.trim()).filter(Boolean)];
    } else if (qtype === 'numeric') {
      data.numeric_answer = pyTruthyLite(get('answer')) ? pyFloat(get('answer')) : null;
      data.numeric_tolerance = pyFloat(pyOr(get('tolerance'), 0));
      data.numeric_unit = pyStrip(pyOr(get('unit'), ''));
    } else if (qtype === 'theory') {
      data.model_answer = sanitizeRichHtml(pyStrip(pyOr(get('model_answer'), get('answer'), '')));
      const kwRaw = pyOr(get('keywords'), get('keyword'), '');
      data.keywords = Array.isArray(kwRaw) ? kwRaw : String(kwRaw).split(',').map((k) => k.trim()).filter(Boolean);
    } else if (qtype === 'match') {
      if ('match_left' in row && Array.isArray(row.match_left)) {
        data.match_left = row.match_left;
        data.match_right = row.match_right ?? [];
        data.correct_pairs = row.correct_pairs ?? row.match_left.map((_, j) => [j, j]);
      }
    } else if (qtype === 'order') {
      if ('order_items' in row && Array.isArray(row.order_items)) data.order_items = row.order_items;
      else data.order_items = String(pyOr(get('items'), '')).split('|').map((x) => x.trim()).filter(Boolean);
    } else if (qtype === 'category') {
      if ('categories' in row && Array.isArray(row.categories)) { data.categories = row.categories; data.category_items = row.category_items ?? []; }
    }
    const id = await X.createQuestion(data);
    createdRows.push({ row: i, pk: id, stem: data.stem, type: (Question.TYPE_CHOICES.find(([v]) => v === qtype) || [qtype, qtype])[1] });
  } catch (err) {
    errorRows.push({ row: i, reason: err.sqlMessage || err.message, raw_repr: pyRepr(row) });
  }
}

route(router, 'examhub:bulk_upload', async (req, res, { bank_pk }) => {
  if (!isTeacher(req)) return denied(req, res);
  const bank = await getBank(bank_pk);
  const base = { active: 'banks', bank, type_choices: Question.TYPE_CHOICES };
  if (req.method !== 'POST') return render(req, res, 'examhub/staff/bulk_upload.html', base);

  const upload = req.FILES.get('bulk_file');
  const rawText = strip(req.POST.get('raw_json', ''));
  const fmt = req.POST.get('fmt', 'json');
  const createdRows = [];
  const errorRows = [];
  if (!upload && !rawText) {
    messages.error(req, 'Choose a file or paste JSON before importing.');
    return render(req, res, 'examhub/staff/bulk_upload.html', base);
  }

  let parseError = null;
  let totalRows = 0;
  try {
    const fileText = upload ? (await fs.promises.readFile(upload.path)).toString('utf8') : null;
    if (fmt === 'json' || (upload && upload.originalname.endsWith('.json'))) {
      let data = JSON.parse(upload ? fileText : rawText);
      if (data && typeof data === 'object' && !Array.isArray(data) && 'questions' in data) data = data.questions;
      if (!Array.isArray(data)) data = [data];
      totalRows = data.length;
      for (let i = 0; i < data.length; i++) await createImportedQuestion(bank, req.user, data[i], i + 1, createdRows, errorRows);
    } else if (fmt === 'csv' || (upload && upload.originalname.endsWith('.csv'))) {
      const rows = readCsvDicts(upload ? fileText : rawText);
      totalRows = rows.length;
      for (let i = 0; i < rows.length; i++) await createImportedQuestion(bank, req.user, rows[i], i + 1, createdRows, errorRows);
    } else {
      parseError = 'Unsupported format.';
    }
  } catch (err) {
    parseError = err.message;
  }

  if (parseError) messages.error(req, `Could not parse the file: ${parseError}`);
  else if (createdRows.length && !errorRows.length) messages.success(req, `All ${createdRows.length} question(s) imported successfully.`);
  else if (createdRows.length) messages.warning(req, `${createdRows.length} imported, ${errorRows.length} skipped — see details below.`);
  else if (errorRows.length) messages.error(req, `No questions imported — all ${errorRows.length} row(s) failed. See details below.`);

  return render(req, res, 'examhub/staff/bulk_upload.html', {
    ...base,
    result: (totalRows || parseError) ? { total_rows: totalRows, created_rows: createdRows, error_rows: errorRows, parse_error: parseError } : null,
  });
}, { login: true });

route(router, 'examhub:bulk_upload_template', async (req, res, { fmt }) => {
  if (!isTeacher(req)) return redirect(res, '/');
  if (fmt === 'csv') {
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', 'attachment; filename="questions_template.csv"');
    return res.send(writeCsv([
      ['type', 'difficulty', 'points', 'topic', 'stem', 'choice_a', 'choice_b', 'choice_c', 'choice_d', 'correct', 'explanation'],
      ['mcq_single', 'medium', '1', 'Grammar', 'Which of these is a noun?', 'Dog', 'Run', 'Quickly', 'Before', 'A', 'Dog is a common noun.'],
      ['true_false', 'easy', '1', 'Ecology', 'Plants produce their own food.', '', '', '', '', 'true', 'Photosynthesis.'],
    ]));
  }
  res.set('Content-Type', 'application/json');
  res.set('Content-Disposition', 'attachment; filename="questions_template.json"');
  return res.send(JSON.stringify([
    {
      type: 'mcq_single', difficulty: 'medium', points: 1, topic: 'Algebra', stem: 'Simplify: 3(2x - 4)',
      choices: [{ text: '6x - 12', is_correct: true }, { text: '6x - 4', is_correct: false }, { text: '6x + 12', is_correct: false }, { text: '3x - 12', is_correct: false }],
      explanation: 'Distribute: 3×2x = 6x, 3×(-4) = -12',
    },
    { type: 'theory', difficulty: 'hard', points: 5, topic: 'Democracy', stem: 'Explain the concept of separation of powers.', keywords: 'separation,powers,legislative,executive,judicial' },
  ], null, 2));
}, { login: true });

// ─────────────────────────────────────────── EXAMS ──

/** Per-row numbers on the exam list (attempts, average, question count, the single section to jump into). */
async function examRowStats(exam) {
  const agg = await db.one(`SELECT COUNT(*) AS n, AVG(score_pct) AS avg, SUM(passed = 1) AS passes FROM examhub_examattempt WHERE exam_id = ? AND status IN ${DONE}`, [exam.id]);
  exam.attempt_count = Number(agg.n);
  const sections = ExamSection.hydrateAll(await db.all('SELECT * FROM examhub_examsection WHERE exam_id = ? ORDER BY `order`, id', [exam.id]));
  exam.total_q = Number(await db.value('SELECT COUNT(*) FROM examhub_examquestion q JOIN examhub_examsection s ON s.id = q.section_id WHERE s.exam_id = ?', [exam.id]));
  exam.only_section = sections.length === 1 ? sections[0] : null;
  if (exam.attempt_count) {
    exam.avg_score = Math.round((Number(agg.avg) || 0) * 10) / 10;
    exam.pass_rate = Math.round((Number(agg.passes) / exam.attempt_count) * 1000) / 10;
  } else {
    exam.avg_score = null;
    exam.pass_rate = null;
  }
  return exam;
}

/** Department choices for authoring: active postgraduate programmes (one per department in practice). */
async function departmentBundles() {
  const rows = await db.all(
    `SELECT b.* FROM catalog_bundle b LEFT JOIN catalog_department d ON d.id = b.department_id LEFT JOIN catalog_faculty f ON f.id = d.faculty_id
     WHERE b.level = 'postgraduate' AND b.is_active = 1 ORDER BY f.\`order\`, d.name, b.name`,
  );
  return attachDepartments(Bundle.hydrateAll(rows));
}

function yearSort(a, b) {
  const na = a.year === null ? 1 : 0;
  const nb = b.year === null ? 1 : 0;
  if (na !== nb) return na - nb;
  if ((b.year || 0) !== (a.year || 0)) return (b.year || 0) - (a.year || 0);
  return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
}

/** Exams grouped as staff think about them: EPT, then one section per department (even with no exams yet). */
route(router, 'examhub:staff_exam_list', async (req, res) => {
  if (!isTeacher(req)) return denied(req, res);
  const deptBundles = await departmentBundles();
  const year = req.GET.get('year');
  const exams = Exam.hydrateAll(await db.all(
    `SELECT * FROM examhub_exam WHERE is_self_study = 0 ${year ? 'AND year = ?' : ''} ORDER BY created_at DESC`, year ? [intOrNull(year) ?? -1] : [],
  ));
  await X.attachSubjectBundle(exams);
  await X.attachUsers(exams, 'created_by_id', 'created_by');
  const years = (await db.all('SELECT DISTINCT year FROM examhub_exam WHERE year IS NOT NULL ORDER BY year DESC')).map((r) => r.year);

  const eptItems = [];
  const otherItems = [];
  const byBundle = new Map();
  for (const exam of exams) {
    await examRowStats(exam);
    if (exam.counts_as_ept) eptItems.push(exam);
    else if (exam.bundle_id) {
      if (!byBundle.has(exam.bundle_id)) byBundle.set(exam.bundle_id, []);
      byBundle.get(exam.bundle_id).push(exam);
    } else otherItems.push(exam);
  }
  eptItems.sort(yearSort);
  otherItems.sort(yearSort);

  const departmentSections = [];
  for (const b of deptBundles) {
    const items = (byBundle.get(b.id) || []).sort(yearSort);
    byBundle.delete(b.id);
    departmentSections.push({ bundle: b, items });
  }
  // A programme deactivated after its exams were created still keeps them visible.
  for (const items of byBundle.values()) departmentSections.push({ bundle: items[0].bundle, items: items.sort(yearSort) });

  return render(req, res, 'examhub/staff/exam_list.html', {
    active: 'exams',
    exam_total: eptItems.length + otherItems.length + departmentSections.reduce((s, d) => s + d.items.length, 0),
    ept_items: eptItems, department_sections: departmentSections, other_items: otherItems, years, filters: { year },
  });
}, { login: true });

/** Every exam needs a section; postgraduate papers need exactly one, created invisibly. */
async function defaultSection(examId) {
  const s = await db.one('SELECT * FROM examhub_examsection WHERE exam_id = ? ORDER BY `order`, id LIMIT 1', [examId]);
  if (s) return s.id;
  return X.createSection({ exam_id: examId, title: 'Questions', order: 0 });
}

function intOr(raw, fallback) {
  const s = strip(raw);
  if (!s) return fallback;
  return /^[-+]?\d+$/.test(s) ? parseInt(s, 10) : fallback;
}

async function examForm(req, res, { pk = null } = {}) {
  if (!isTeacher(req)) return denied(req, res);
  const exam = pk ? await getOr404(X.getExam(pk)) : null;
  const deptBundles = await departmentBundles();

  if (req.method === 'POST') {
    const p = req.POST;
    const kind = p.get('kind', 'department');
    const bundlePk = intOrNull(p.get('bundle') || null);
    const title = strip(p.get('title', ''));
    if (!title) {
      messages.error(req, 'Title is required.');
    } else if (kind === 'department' && !bundlePk) {
      messages.error(req, 'Choose which department this exam belongs to.');
    } else {
      const isEpt = kind === 'ept';
      const negPct = strip(p.get('negative_marking_pct') || '');
      const data = {
        is_ept: isEpt, bundle_id: isEpt ? null : bundlePk, subject_id: null, title,
        year: intOr(p.get('year') || '', null),
        time_limit_minutes: intOr(p.get('time_limit_minutes') || '', null),
        pass_score: intOr(p.get('pass_score') || '', 50),
        instructions: strip(p.get('instructions', '')),
        mode: p.get('mode') || 'test',
        max_attempts: intOr(p.get('max_attempts') || '', 0),
        negative_marking: p.has('negative_marking'),
        negative_marking_pct: negPct ? (decimalOrNull(negPct) ?? 25) : 25,
        require_fullscreen: p.has('require_fullscreen'),
        detect_tab_switch: p.has('detect_tab_switch'),
        max_tab_switches: intOr(p.get('max_tab_switches') || '', 3),
        allow_calculator: p.has('allow_calculator'),
        allow_scratch_pad: p.has('allow_scratch_pad'),
        available_from: p.get('available_from') ? parseLocalDateTime(p.get('available_from')) : null,
        available_until: p.get('available_until') ? parseLocalDateTime(p.get('available_until')) : null,
      };
      let examId = exam ? exam.id : null;
      if (examId) await db.update('examhub_exam', examId, data);
      else examId = await X.createExam({ ...data, created_by_id: req.user.id });
      const sectionId = await defaultSection(examId);

      messages.success(req, 'Exam saved.');
      if (Number(await db.value('SELECT COUNT(*) FROM examhub_examsection WHERE exam_id = ?', [examId])) === 1) {
        return redirect(res, 'examhub:section_questions', sectionId);
      }
      return redirect(res, 'examhub:exam_sections', examId);
    }
  }

  return render(req, res, 'examhub/staff/exam_form.html', {
    active: 'exams', exam, department_bundles: deptBundles, mode_choices: Exam.MODE_CHOICES,
    initial_kind: req.GET.get('kind', ''), initial_bundle: req.GET.get('bundle', ''),
  });
}
route(router, 'examhub:exam_add', (req, res) => examForm(req, res), { login: true });
route(router, 'examhub:exam_edit', (req, res, p) => examForm(req, res, p), { login: true });

route(router, 'examhub:exam_delete', async (req, res, { pk }) => {
  if (!isTeacher(req)) return redirect(res, '/');
  const exam = await getOr404(X.getExam(pk));
  await db.remove('examhub_exam', exam.id);
  messages.success(req, `Exam "${exam.title}" deleted.`);
  return redirect(res, 'examhub:staff_exam_list');
}, { login: true, post: true });

route(router, 'examhub:exam_clone', async (req, res, { pk }) => {
  if (!isTeacher(req)) return redirect(res, '/');
  const o = await getOr404(X.getExam(pk));
  const title = `Copy of ${o.title}`;
  const newId = await db.transaction(async (tx) => {
    const id = await X.createExam({
      subject_id: o.subject_id, bundle_id: o.bundle_id, is_ept: o.is_ept, title, instructions: o.instructions, mode: o.mode,
      time_limit_minutes: o.time_limit_minutes, pass_score: o.pass_score, negative_marking: o.negative_marking,
      negative_marking_pct: o.negative_marking_pct, max_attempts: o.max_attempts, require_fullscreen: o.require_fullscreen,
      detect_tab_switch: o.detect_tab_switch, max_tab_switches: o.max_tab_switches, allow_calculator: o.allow_calculator,
      allow_scratch_pad: o.allow_scratch_pad, is_published: false, created_by_id: req.user.id,
    }, tx);
    for (const s of await tx.all('SELECT * FROM examhub_examsection WHERE exam_id = ? ORDER BY `order`, id', [o.id])) {
      const sid = await X.createSection({
        exam_id: id, subject_id: s.subject_id, title: s.title, instructions: s.instructions, order: s.order,
        time_limit_minutes: s.time_limit_minutes, randomize_questions: s.randomize_questions,
        randomize_choices: s.randomize_choices, questions_to_pick: s.questions_to_pick,
      }, tx);
      for (const eq of await tx.all('SELECT * FROM examhub_examquestion WHERE section_id = ? ORDER BY `order`, id', [s.id])) {
        const { id: _id, section_id: _s, ...rest } = eq;
        await tx.insert('examhub_examquestion', { ...rest, section_id: sid });
      }
    }
    return id;
  });
  messages.success(req, `Exam cloned as "${title}".`);
  return redirect(res, 'examhub:exam_sections', newId);
}, { login: true, post: true });

route(router, 'examhub:exam_sections', async (req, res, { pk }) => {
  if (!isTeacher(req)) return denied(req, res);
  const exam = await getOr404(X.getExam(pk));
  if (req.method === 'POST') {
    const action = req.POST.get('action');
    if (action === 'add_section') {
      const title = strip(req.POST.get('title', ''));
      if (title) {
        await X.createSection({ exam_id: exam.id, title, order: Number(await db.value('SELECT COUNT(*) FROM examhub_examsection WHERE exam_id = ?', [exam.id])) });
        messages.success(req, `Section "${title}" added.`);
      }
    } else if (action === 'delete_section') {
      await db.run('DELETE FROM examhub_examsection WHERE id = ? AND exam_id = ?', [intOrNull(req.POST.get('section_pk')) ?? -1, exam.id]);
      messages.success(req, 'Section deleted.');
    } else if (action === 'publish') {
      await db.update('examhub_exam', exam.id, { is_published: true });
      messages.success(req, 'Exam published.');
    } else if (action === 'unpublish') {
      await db.update('examhub_exam', exam.id, { is_published: false });
      messages.success(req, 'Exam unpublished.');
    }
    return redirect(res, 'examhub:exam_sections', pk);
  }
  const sections = await X.examSectionsWithQuestions(exam.id);
  return render(req, res, 'examhub/staff/exam_sections.html', {
    active: 'exams', exam, sections,
    total_q: sections.reduce((s, sec) => s + sec.question_count, 0),
    total_pts: sections.reduce((s, sec) => s + sec.total_points, 0),
  });
}, { login: true });

route(router, 'examhub:section_questions', async (req, res, { section_pk }) => {
  if (!isTeacher(req)) return denied(req, res);
  const section = await getOr404(db.one('SELECT * FROM examhub_examsection WHERE id = ?', [section_pk]).then((r) => ExamSection.hydrate(r)));
  const exam = await X.getExam(section.exam_id);

  if (req.method === 'POST') {
    const post = req.POST;
    const action = post.get('action');
    const nextOrder = async () => Number(await db.value('SELECT COUNT(*) FROM examhub_examquestion WHERE section_id = ?', [section.id]));
    if (action === 'publish' || action === 'unpublish') {
      await db.update('examhub_exam', exam.id, { is_published: action === 'publish' });
      messages.success(req, action === 'publish' ? 'Exam published.' : 'Exam unpublished.');
      return redirect(res, 'examhub:section_questions', section_pk);
    }
    if (action === 'add_from_bank') {
      let added = 0;
      for (const bqPk of post.getlist('bq_pks[]')) {
        const bq = await db.one('SELECT id, default_points FROM examhub_question WHERE id = ?', [intOrNull(bqPk) ?? -1]);
        if (!bq) continue;
        await X.createExamQuestion({ section_id: section.id, bank_question_id: bq.id, order: await nextOrder(), points: bq.default_points });
        added += 1;
      }
      messages.success(req, `Added ${added} question(s) from bank.`);
    } else if (action === 'add_inline') {
      const qt = post.get('question_type', '');
      const stem = strip(post.get('stem', ''));
      if (stem && qt) {
        const data = {
          section_id: section.id, order: await nextOrder(), points: decimalOrNull(post.get('points', '1')) ?? 1,
          question_type: qt, stem: sanitizeRichHtml(stem), stem_image_url: strip(post.get('stem_image_url', '')),
        };
        readTypeFields(post, qt, data, { strict: false });
        data.explanation = sanitizeRichHtml(strip(post.get('explanation', '')));
        await X.createExamQuestion(data);
        messages.success(req, 'Inline question added.');
      }
    } else if (action === 'remove_question') {
      await db.run('DELETE FROM examhub_examquestion WHERE id = ? AND section_id = ?', [intOrNull(post.get('question_pk')) ?? -1, section.id]);
      messages.success(req, 'Question removed.');
    } else if (action === 'update_points') {
      for (const eq of await db.all('SELECT id FROM examhub_examquestion WHERE section_id = ?', [section.id])) {
        const val = decimalOrNull(post.get(`points_${eq.id}`) || '');
        if (val !== null) await db.update('examhub_examquestion', eq.id, { points: val });
      }
      messages.success(req, 'Points updated.');
    }
    return redirect(res, 'examhub:section_questions', section_pk);
  }

  const banks = QuestionBank.hydrateAll(await db.all('SELECT * FROM examhub_questionbank ORDER BY created_at DESC'));
  const bankPk = req.GET.get('bank');
  let bankQuestions = [];
  if (bankPk) {
    const params = [intOrNull(bankPk) ?? -1];
    let sql = 'SELECT * FROM examhub_question WHERE bank_id = ?';
    const qtypeF = req.GET.get('qtype', '');
    if (qtypeF) { sql += ' AND question_type = ?'; params.push(qtypeF); }
    bankQuestions = Question.hydrateAll(await db.all(`${sql} ORDER BY created_at DESC`, params));
  }
  const existing = await X.sectionQuestions(section.id);
  return render(req, res, 'examhub/staff/section_questions.html', {
    active: 'exams', exam, section, existing_qs: existing, banks, bank_questions: bankQuestions, selected_bank_pk: bankPk,
    type_choices: Question.TYPE_CHOICES, total_pts: existing.reduce((s, q) => s + Number(q.points), 0),
    is_only_section: Number(await db.value('SELECT COUNT(*) FROM examhub_examsection WHERE exam_id = ?', [exam.id])) === 1,
  });
}, { login: true });

route(router, 'examhub:grade_theory', async (req, res, { attempt_pk }) => {
  if (!isTeacher(req)) return denied(req, res);
  const attempt = await getOr404(db.one('SELECT * FROM examhub_examattempt WHERE id = ?', [attempt_pk]).then((r) => ExamAttempt.hydrate(r)));
  attempt.exam = await X.getExam(attempt.exam_id);
  attempt.student = User.hydrate(await db.one('SELECT * FROM accounts_user WHERE id = ?', [attempt.student_id]));
  const theoryAnswers = (await X.attemptAnswers(attempt.id)).filter((aa) => (
    aa.exam_question.question_type === 'theory' || (aa.exam_question.bank_question && aa.exam_question.bank_question.question_type === 'theory')
  ));

  if (req.method === 'POST') {
    for (const aa of theoryAnswers) {
      const scoreVal = req.POST.get(`score_${aa.id}`);
      if (scoreVal === undefined) continue;
      const parsed = decimalOrNull(scoreVal);
      if (parsed === null) continue;
      const points = Number(aa.exam_question.points);
      const score = Math.min(parsed, points);
      await db.update('examhub_attemptanswer', aa.id, {
        manual_score: round2(score), instructor_feedback: strip(req.POST.get(`feedback_${aa.id}`, '')),
        graded_by_id: req.user.id, graded_at: new Date(), is_correct: score >= points,
      });
    }
    const all = AttemptAnswer.hydrateAll(await db.all('SELECT * FROM examhub_attemptanswer WHERE attempt_id = ?', [attempt.id]));
    const total = all.reduce((s, a) => s + Number(a.effective_score), 0);
    const max = Number(attempt.max_score);
    const pct = max ? round2((total / max) * 100) : 0;
    await db.update('examhub_examattempt', attempt.id, { raw_score: round2(total), score_pct: pct, passed: pct >= attempt.exam.pass_score });
    messages.success(req, 'Theory answers graded.');
    return redirect(res, 'examhub:staff_exam_list');
  }
  return render(req, res, 'examhub/staff/grade_theory.html', { active: 'exams', attempt, theory_answers: theoryAnswers });
}, { login: true });

route(router, 'examhub:exam_analytics', async (req, res, { pk }) => {
  if (!isTeacher(req)) return denied(req, res);
  const exam = await getOr404(X.getExam(pk));
  const attempts = ExamAttempt.hydrateAll(await db.all(`SELECT * FROM examhub_examattempt WHERE exam_id = ? AND status IN ${DONE} ORDER BY started_at DESC`, [exam.id]));
  if (!attempts.length) return render(req, res, 'examhub/staff/analytics.html', { active: 'exams', exam, no_data: true });
  await X.attachUsers(attempts, 'student_id', 'student');
  const passCount = attempts.filter((a) => a.passed).length;
  const eqs = await X.hydrateExamQuestions(await db.all(
    'SELECT q.* FROM examhub_examquestion q JOIN examhub_examsection s ON s.id = q.section_id WHERE s.exam_id = ? ORDER BY q.`order`, q.id', [exam.id],
  ));
  const qStats = [];
  for (const eq of eqs) {
    const agg = await db.one('SELECT COUNT(*) AS total, SUM(is_correct = 1) AS correct FROM examhub_attemptanswer WHERE exam_question_id = ? AND attempt_id IN (?)', [eq.id, attempts.map((a) => a.id)]);
    const total = Number(agg.total);
    const correct = Number(agg.correct || 0);
    qStats.push({ eq, total, correct, difficulty_pct: total ? Math.round((correct / total) * 1000) / 10 : 0 });
  }
  return render(req, res, 'examhub/staff/analytics.html', {
    active: 'exams', exam, attempts,
    avg_score: Math.round((attempts.reduce((s, a) => s + Number(a.score_pct), 0) / attempts.length) * 10) / 10,
    pass_rate: Math.round((passCount / attempts.length) * 1000) / 10, pass_count: passCount,
    total_attempts: attempts.length, fail_count: attempts.length - passCount, q_stats: qStats, no_data: false,
  });
}, { login: true });

route(router, 'examhub:staff_exam_results', async (req, res, { pk }) => {
  if (!isTeacher(req)) return redirect(res, '/');
  const exam = await getOr404(X.getExam(pk));
  const attempts = ExamAttempt.hydrateAll(await db.all('SELECT * FROM examhub_examattempt WHERE exam_id = ? ORDER BY started_at DESC', [exam.id]));
  await X.attachUsers(attempts, 'student_id', 'student');

  if (req.GET.get('export') === 'csv') {
    const utc = (d) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') : ''); // Django wrote these in UTC
    const rows = [['Student', 'Reg No', 'Email', 'Score', 'Max Score', 'Percent', 'Passed', 'Status', 'Started', 'Completed', 'Duration (s)']];
    for (const a of attempts) {
      rows.push([
        a.student.get_full_name || a.student.username, a.student.registration_number, a.student.email,
        Number(a.raw_score).toFixed(2), Number(a.max_score).toFixed(2), `${Number(a.score_pct).toFixed(1)}%`,
        a.passed ? 'Yes' : 'No', a.status, utc(a.started_at), utc(a.completed_at), a.time_taken_seconds || '',
      ]);
    }
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="results_${exam.id}.csv"`);
    return res.send(writeCsv(rows));
  }
  for (const a of attempts) a.has_ungraded_theory = await X.hasUngradedTheory(a.id);
  const completed = attempts.filter((a) => X.DONE_STATUSES.includes(a.status));
  return render(req, res, 'examhub/staff/results.html', {
    active: 'exams', exam, attempts, total_done: completed.length, pass_count: completed.filter((a) => a.passed).length,
    avg_score: completed.length ? completed.reduce((s, a) => s + Number(a.score_pct), 0) / completed.length : 0,
  });
}, { login: true });

// ─────────────────────────────────────────── RICH EDITOR ASSET UPLOAD ──

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

route(router, 'examhub:upload_asset', async (req, res) => {
  if (!isTeacher(req)) return jsonResponse(res, { error: 'Access denied' }, 403);
  let content;
  let ext = 'png';
  const upload = req.FILES.get('file');
  if (upload) {
    if (!ALLOWED_IMAGE_TYPES[upload.mimetype]) return jsonResponse(res, { error: `Unsupported file type: ${upload.mimetype}` }, 400);
    if (upload.size > MAX_UPLOAD_BYTES) return jsonResponse(res, { error: 'File too large (max 8 MB)' }, 400);
    ext = ALLOWED_IMAGE_TYPES[upload.mimetype];
    content = await fs.promises.readFile(upload.path);
  } else {
    const dataUrl = req.POST.get('data_url', '');
    if (!dataUrl.startsWith('data:image/')) return jsonResponse(res, { error: 'No file received' }, 400);
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return jsonResponse(res, { error: 'Invalid image data' }, 400);
    const contentType = dataUrl.slice(0, comma).split(';')[0].replace('data:', '');
    if (!ALLOWED_IMAGE_TYPES[contentType]) return jsonResponse(res, { error: `Unsupported image type: ${contentType}` }, 400);
    ext = ALLOWED_IMAGE_TYPES[contentType];
    const b64 = dataUrl.slice(comma + 1);
    if (!/^[A-Za-z0-9+/=\s]*$/.test(b64)) return jsonResponse(res, { error: 'Invalid image data' }, 400);
    content = Buffer.from(b64, 'base64');
    if (content.length > MAX_UPLOAD_BYTES) return jsonResponse(res, { error: 'Image too large (max 8 MB)' }, 400);
  }
  const saved = await saveBytes(`question_assets/${crypto.randomBytes(16).toString('hex')}.${ext}`, content);
  return jsonResponse(res, { url: `/media/${saved}` });
}, { login: true, post: true });

module.exports = { router };
