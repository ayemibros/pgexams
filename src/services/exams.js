/**
 * Shared exam data loaders/writers used by the student and staff routes —
 * the Django ORM patterns (select_related, related counts, create with model
 * defaults) that several views repeat.
 */
const db = require('../db');
const {
  Exam, ExamSection, ExamQuestion, Question, ExamAttempt, AttemptAnswer, Subject, User, DONE_STATUSES,
} = require('../models');
const { loadBundles } = require('./billing');

const now = () => new Date();

async function byIds(Model, table, ids) {
  const uniq = [...new Set(ids.filter((x) => x !== null && x !== undefined))];
  if (!uniq.length) return new Map();
  const rows = await db.all(`SELECT * FROM \`${table}\` WHERE id IN (?)`, [uniq]);
  return new Map(Model.hydrateAll(rows).map((o) => [o.id, o]));
}

/** select_related("subject", "bundle__department__faculty") for exams (or anything with subject_id/bundle_id). */
async function attachSubjectBundle(items) {
  const subjects = await byIds(Subject, 'catalog_subject', items.map((e) => e.subject_id));
  const bundles = new Map((await loadBundles([...new Set(items.map((e) => e.bundle_id).filter(Boolean))])).map((b) => [b.id, b]));
  for (const e of items) {
    e.subject = subjects.get(e.subject_id) || null;
    if ('bundle_id' in e) e.bundle = bundles.get(e.bundle_id) || null;
  }
  return items;
}

async function attachUsers(items, fk, attr) {
  const users = await byIds(User, 'accounts_user', items.map((i) => i[fk]));
  for (const i of items) i[attr] = users.get(i[fk]) || null;
  return items;
}

async function attachExams(items) {
  const exams = await byIds(Exam, 'examhub_exam', items.map((a) => a.exam_id));
  await attachSubjectBundle([...exams.values()]);
  for (const a of items) a.exam = exams.get(a.exam_id) || null;
  return items;
}

async function getExam(id, extraWhere = '', params = []) {
  const exam = Exam.hydrate(await db.one(`SELECT * FROM examhub_exam WHERE id = ? ${extraWhere}`, [id, ...params]));
  if (exam) await attachSubjectBundle([exam]);
  return exam;
}

/** ExamQuestion rows with `bank_question` (a Question or null) attached. */
async function hydrateExamQuestions(rows) {
  const eqs = ExamQuestion.hydrateAll(rows);
  const banks = await byIds(Question, 'examhub_question', eqs.map((q) => q.bank_question_id));
  for (const q of eqs) q.bank_question = banks.get(q.bank_question_id) || null;
  return eqs;
}

async function sectionQuestions(sectionId) {
  return hydrateExamQuestions(await db.all('SELECT * FROM examhub_examquestion WHERE section_id = ? ORDER BY `order`, id', [sectionId]));
}

/** exam.sections ordered, each with questions, question_count, total_points and subject. */
async function examSectionsWithQuestions(examId) {
  const sections = ExamSection.hydrateAll(await db.all('SELECT * FROM examhub_examsection WHERE exam_id = ? ORDER BY `order`, id', [examId]));
  const subjects = await byIds(Subject, 'catalog_subject', sections.map((s) => s.subject_id));
  const ids = sections.map((s) => s.id);
  const questions = ids.length
    ? await hydrateExamQuestions(await db.all('SELECT * FROM examhub_examquestion WHERE section_id IN (?) ORDER BY `order`, id', [ids]))
    : [];
  for (const s of sections) {
    s.subject = subjects.get(s.subject_id) || null;
    s.questions = questions.filter((q) => q.section_id === s.id);
    s.question_count = s.questions.length;
    s.total_points = s.questions.reduce((sum, q) => sum + Number(q.points), 0);
  }
  return sections;
}

async function examTotalMarks(examId) {
  return Number(await db.value(
    'SELECT COALESCE(SUM(q.points), 0) FROM examhub_examquestion q JOIN examhub_examsection s ON s.id = q.section_id WHERE s.exam_id = ?', [examId],
  )) || 0;
}

const EXAM_DEFAULTS = () => ({
  subject_id: null, bundle_id: null, year: null, is_ept: false, instructions: '', mode: 'test',
  time_limit_minutes: null, pass_score: 50, negative_marking: false, negative_marking_pct: 25, max_attempts: 0,
  require_fullscreen: false, detect_tab_switch: true, max_tab_switches: 3, allow_calculator: false,
  allow_scratch_pad: true, is_published: false, available_from: null, available_until: null,
  is_self_study: false, owner_id: null, created_by_id: null,
});

async function createExam(fields, tx = db) {
  return tx.insert('examhub_exam', { ...EXAM_DEFAULTS(), ...fields, created_at: now() });
}

async function createSection(fields, tx = db) {
  return tx.insert('examhub_examsection', {
    subject_id: null, instructions: '', order: 0, time_limit_minutes: null, randomize_questions: false,
    randomize_choices: false, questions_to_pick: 0,
    ...fields,
  });
}

const EQ_DEFAULTS = () => ({
  bank_question_id: null, order: 0, points: 1, question_type: '', stem: '', stem_image_url: '', choices_data: [],
  tf_answer: null, blank_answers: [], numeric_answer: null, numeric_tolerance: 0, numeric_unit: '', model_answer: '',
  keywords: [], match_left: [], match_right: [], correct_pairs: [], order_items: [], categories: [], category_items: [],
  explanation: '',
});

async function createExamQuestion(fields, tx = db) {
  return tx.insert('examhub_examquestion', { ...EQ_DEFAULTS(), ...fields });
}

const QUESTION_DEFAULTS = () => ({
  question_type: 'mcq_single', stem: '', stem_image_url: '', choices_data: [], tf_answer: null, blank_answers: [],
  numeric_answer: null, numeric_tolerance: 0, numeric_unit: '', model_answer: '', keywords: [], match_left: [],
  match_right: [], correct_pairs: [], order_items: [], categories: [], category_items: [], explanation: '',
  explanation_image_url: '', default_points: 1, topic: '', subtopic: '', difficulty: 'medium', bloom_level: '',
  year_asked: null, is_verified: false, created_by_id: null,
});

function questionRow(fields) {
  const t = now();
  return { ...QUESTION_DEFAULTS(), ...fields, created_at: t, updated_at: t };
}

async function createQuestion(fields, tx = db) {
  return tx.insert('examhub_question', questionRow(fields));
}

async function createAttempt(fields, tx = db) {
  return tx.insert('examhub_examattempt', {
    started_at: now(), completed_at: null, time_taken_seconds: null, question_order: [], raw_score: 0, max_score: 0,
    score_pct: 0, passed: false, tab_switches: 0, fullscreen_exits: 0, status: 'in_progress',
    ...fields,
  });
}

/** AttemptAnswer.objects.get_or_create(attempt=…, exam_question=…). */
async function getOrCreateAnswer(attemptId, examQuestionId, tx = db) {
  await tx.run(
    `INSERT IGNORE INTO examhub_attemptanswer
       (attempt_id, exam_question_id, selected_indices, text_answer, numeric_answer, answer_data, auto_score, is_correct,
        manual_score, graded_by_id, graded_at, instructor_feedback, flagged, time_spent_seconds)
     VALUES (?, ?, '[]', '', NULL, NULL, 0, 0, NULL, NULL, NULL, '', 0, 0)`,
    [attemptId, examQuestionId],
  );
  return AttemptAnswer.hydrate(await tx.one('SELECT * FROM examhub_attemptanswer WHERE attempt_id = ? AND exam_question_id = ?', [attemptId, examQuestionId]));
}

/** Persist an AttemptAnswer's answer fields (JSON null stays SQL NULL for answer_data). */
async function saveAnswer(aa, tx = db) {
  await tx.update('examhub_attemptanswer', aa.id, {
    selected_indices: aa.selected_indices ?? [],
    text_answer: aa.text_answer ?? '',
    numeric_answer: aa.numeric_answer,
    answer_data: aa.answer_data === null || aa.answer_data === undefined ? null : JSON.stringify(aa.answer_data),
    flagged: aa.flagged,
    time_spent_seconds: aa.time_spent_seconds,
    auto_score: aa.auto_score,
    is_correct: aa.is_correct,
  });
}

/** attempt.answers with exam_question (+ bank_question, section) attached, in section/question order. */
async function attemptAnswers(attemptId) {
  const rows = await db.all(
    `SELECT a.* FROM examhub_attemptanswer a
       JOIN examhub_examquestion q ON q.id = a.exam_question_id
       JOIN examhub_examsection s ON s.id = q.section_id
     WHERE a.attempt_id = ? ORDER BY s.\`order\`, q.\`order\`, a.id`, [attemptId],
  );
  const answers = AttemptAnswer.hydrateAll(rows);
  const eqIds = [...new Set(answers.map((a) => a.exam_question_id))];
  const eqs = eqIds.length ? await hydrateExamQuestions(await db.all('SELECT * FROM examhub_examquestion WHERE id IN (?)', [eqIds])) : [];
  const sections = await byIds(ExamSection, 'examhub_examsection', eqs.map((q) => q.section_id));
  const eqMap = new Map(eqs.map((q) => { q.section = sections.get(q.section_id) || null; return [q.id, q]; }));
  for (const a of answers) a.exam_question = eqMap.get(a.exam_question_id) || null;
  return answers;
}

/** ExamAttempt.has_ungraded_theory */
async function hasUngradedTheory(attemptId) {
  return Boolean(await db.value(
    `SELECT COUNT(*) FROM examhub_attemptanswer a
       JOIN examhub_examquestion q ON q.id = a.exam_question_id
       LEFT JOIN examhub_question b ON b.id = q.bank_question_id
     WHERE a.attempt_id = ? AND a.manual_score IS NULL AND (q.question_type = 'theory' OR b.question_type = 'theory')`, [attemptId],
  ));
}

async function completedAttemptCount(examId, studentId) {
  return Number(await db.value(
    "SELECT COUNT(*) FROM examhub_examattempt WHERE exam_id = ? AND student_id = ? AND status IN ('completed','timed_out','auto_submitted')",
    [examId, studentId],
  ));
}

async function inProgressAttempt(examId, studentId) {
  return ExamAttempt.hydrate(await db.one(
    "SELECT * FROM examhub_examattempt WHERE exam_id = ? AND student_id = ? AND status = 'in_progress' ORDER BY started_at DESC LIMIT 1",
    [examId, studentId],
  ));
}

module.exports = {
  byIds, attachSubjectBundle, attachUsers, attachExams, getExam, hydrateExamQuestions, sectionQuestions,
  examSectionsWithQuestions, examTotalMarks, createExam, createSection, createExamQuestion, questionRow, createQuestion,
  createAttempt, getOrCreateAnswer, saveAnswer, attemptAnswers, hasUngradedTheory, completedAttemptCount,
  inProgressAttempt, DONE_STATUSES,
};
