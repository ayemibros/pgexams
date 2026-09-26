/** Port of CBT_UI's examhub/student_views.py — subscription-gated exams. */
const express = require('express');
const db = require('../db');
const {
  Exam, ExamAttempt, ExamSection, Question, QuestionBank, Subject, AttemptAnswer, DONE_STATUSES,
} = require('../models');
const { route, render, redirect, messages, getOr404, jsonResponse, reverse, Http404 } = require('../web');
const { formatDate, pyTruthy, safe } = require('../templating');
const { sparklineSvg } = require('../services/charts');
const { gradeAnswer } = require('../services/grading');
const { AccessProfile, hasAccess, loadBundles } = require('../services/billing');
const X = require('../services/exams');
const { contains, strip, intOrNull, decimalOrNull, shuffle, round2 } = require('../services/util');

const router = express.Router();
const isStudent = (req) => req.user.is_authenticated && req.user.is_student;
const DONE = "('completed','timed_out','auto_submitted')";

function denied(req, res) {
  messages.error(req, 'Access denied.');
  return redirect(res, '/');
}

/** Where to go 'back' to from an exam, and what to call it. */
function listNav(exam) {
  if (exam.is_self_study) return ['examhub:practice_setup', 'Practice'];
  return ['examhub:exam_list', 'My Exams'];
}

// ─────────────────────────────────────────── FREE TRIAL ──
// Every applicant can try one short practice test before paying: TRIAL_SIZE
// questions drawn from the published exams (the EPT first), with instant
// feedback. It is a private self-study exam, so it needs no subscription, and
// it allows one attempt only.

const TRIAL_TITLE = 'Free Trial — 10 questions';
const TRIAL_SIZE = 10;
const TRIAL_MINUTES = 15;
const isTrialExam = (exam) => Boolean(exam && exam.is_self_study && exam.title === TRIAL_TITLE);

/** { state: 'none' | 'in_progress' | 'used', attempt_id } for the student's free trial. */
async function trialState(user) {
  const att = await db.one(
    `SELECT a.id, a.status FROM examhub_examattempt a JOIN examhub_exam e ON e.id = a.exam_id
     WHERE a.student_id = ? AND e.owner_id = ? AND e.is_self_study = 1 AND e.title = ? ORDER BY a.id DESC LIMIT 1`,
    [user.id, user.id, TRIAL_TITLE],
  );
  if (!att) return { state: 'none', attempt_id: null };
  return { state: att.status === 'in_progress' ? 'in_progress' : 'used', attempt_id: att.id };
}

/** Auto-marked bank questions used in published exams: EPT ones when there are enough, otherwise all. */
async function trialQuestionPool() {
  const rows = await db.all(
    `SELECT DISTINCT q.id, (e.is_ept = 1 AND e.bundle_id IS NULL) AS ept
     FROM examhub_examquestion eq JOIN examhub_examsection s ON s.id = eq.section_id JOIN examhub_exam e ON e.id = s.exam_id
     JOIN examhub_question q ON q.id = eq.bank_question_id
     WHERE e.is_published = 1 AND e.is_self_study = 0 AND q.question_type <> 'theory'`,
  );
  const ept = [...new Set(rows.filter((r) => Number(r.ept)).map((r) => r.id))];
  return ept.length >= TRIAL_SIZE ? ept : [...new Set(rows.map((r) => r.id))];
}

/** Bank question ids from the published exams this student's subscription covers. */
async function allowedQuestionIds(profile) {
  const exams = (await publishedExams()).filter((e) => profile.allows(e.subject, e.bundle, e.counts_as_ept));
  if (!exams.length) return [];
  const rows = await db.all(
    `SELECT DISTINCT eq.bank_question_id AS id FROM examhub_examquestion eq JOIN examhub_examsection s ON s.id = eq.section_id
     WHERE s.exam_id IN (?) AND eq.bank_question_id IS NOT NULL`, [exams.map((e) => e.id)],
  );
  return rows.map((r) => r.id);
}

async function publishedExams(extraWhere = '', params = []) {
  const rows = await db.all(`SELECT * FROM examhub_exam WHERE is_published = 1 AND is_self_study = 0 ${extraWhere} ORDER BY created_at DESC`, params);
  return X.attachSubjectBundle(Exam.hydrateAll(rows));
}

/**
 * Published exams open for attempting right now that the student's active
 * subscription covers — powers the notification bell and the dashboard banner.
 */
async function liveSchoolItems(user) {
  if (!user.is_authenticated || !user.is_student) return { exams: [], tests: [] };
  const t = new Date();
  const profile = await AccessProfile.load(user);
  const exams = await publishedExams(
    'AND (available_from IS NULL OR available_from <= ?) AND (available_until IS NULL OR available_until >= ?)', [t, t],
  );
  const eligible = exams.filter((e) => profile.allows(e.subject, e.bundle, e.counts_as_ept));

  // One query for every attempt instead of two per exam (this runs on every page).
  const completed = new Map();
  const started = new Set();
  if (eligible.length) {
    for (const r of await db.all('SELECT exam_id, status FROM examhub_examattempt WHERE student_id = ? AND exam_id IN (?)', [user.id, eligible.map((e) => e.id)])) {
      if (DONE_STATUSES.includes(r.status)) completed.set(r.exam_id, (completed.get(r.exam_id) || 0) + 1);
      else if (r.status === 'in_progress') started.add(r.exam_id);
    }
  }

  const liveExams = [];
  const liveTests = [];
  for (const exam of eligible) {
    const limit = exam.effective_max_attempts();
    if (limit && (completed.get(exam.id) || 0) >= limit) continue;
    if (started.has(exam.id)) continue;
    (exam.mode === 'exam' ? liveExams : liveTests).push(exam);
  }
  return { exams: liveExams, tests: liveTests };
}

/** What the student has paid for (and what has lapsed) — for the dashboard and My Exams. */
async function accessSummary(user, profile) {
  const now = new Date();
  const programmes = [...profile.bundles.values()]
    .filter((b) => b.level === 'postgraduate')
    .map((b) => ({ bundle: b, until: profile.bundle_until.get(b.id) || null }))
    .sort((a, b) => a.bundle.name.toLowerCase().localeCompare(b.bundle.name.toLowerCase()));

  const expired = new Map();
  const lapsed = await db.all(
    "SELECT id, plan_id, ends_at FROM billing_subscription WHERE student_id = ? AND ends_at < ? AND status <> 'cancelled' ORDER BY ends_at DESC LIMIT 20",
    [user.id, now],
  );
  if (lapsed.length) {
    const links = await db.all('SELECT plan_id, bundle_id FROM billing_plan_bundles WHERE plan_id IN (?)', [[...new Set(lapsed.map((s) => s.plan_id))]]);
    const bundles = new Map((await loadBundles([...new Set(links.map((l) => l.bundle_id))])).map((b) => [b.id, b]));
    for (const sub of lapsed) {
      for (const l of links.filter((x) => x.plan_id === sub.plan_id)) {
        const b = bundles.get(l.bundle_id);
        if (b && b.level === 'postgraduate' && !profile.bundles.has(b.id) && !expired.has(b.id)) expired.set(b.id, { bundle: b, ended: sub.ends_at });
      }
    }
  }
  return {
    access_programmes: programmes,
    access_expired: [...expired.values()].sort((a, b) => a.bundle.name.toLowerCase().localeCompare(b.bundle.name.toLowerCase())),
    access_has_any: profile.has_any,
  };
}

async function checkExamAvailability(exam, user) {
  const t = new Date();
  if (exam.available_from && t < exam.available_from) return [false, `This exam opens on ${formatDate(exam.available_from, 'd M Y, H:i')}.`];
  if (exam.available_until && t > exam.available_until) return [false, 'This exam has closed.'];
  const limit = exam.effective_max_attempts();
  if (limit > 0 && await X.completedAttemptCount(exam.id, user.id) >= limit) return [false, `You have used all ${limit} attempt(s) for this exam.`];
  return [true, ''];
}

// ─────────────────────────────────────────── DASHBOARD ──

route(router, 'examhub:student_dashboard', async (req, res) => {
  if (!isStudent(req)) return denied(req, res);
  const { user } = req;
  const profile = await AccessProfile.load(user);
  const upcomingCount = (await publishedExams()).filter((e) => profile.allows(e.subject, e.bundle, e.counts_as_ept)).length;

  const attempts = await X.attachExams(ExamAttempt.hydrateAll(await db.all(
    `SELECT * FROM examhub_examattempt WHERE student_id = ? AND status IN ${DONE} ORDER BY completed_at IS NULL, completed_at DESC LIMIT 8`, [user.id],
  )));
  const stats = await db.one(`SELECT COUNT(*) AS total, AVG(score_pct) AS avg_score FROM examhub_examattempt WHERE student_id = ? AND status IN ${DONE}`, [user.id]);
  const recentScores = (await db.all(
    `SELECT score_pct FROM examhub_examattempt WHERE student_id = ? AND status IN ${DONE} ORDER BY completed_at IS NULL, completed_at DESC LIMIT 10`, [user.id],
  )).map((r) => Number(r.score_pct)).reverse();
  const trendSvg = recentScores.length >= 2 ? sparklineSvg(recentScores) : null;

  const subjectStats = (await db.all(
    `SELECT s.name AS exam__subject__name, s.icon AS exam__subject__icon, AVG(a.score_pct) AS avg, COUNT(a.id) AS n
     FROM examhub_examattempt a JOIN examhub_exam e ON e.id = a.exam_id JOIN catalog_subject s ON s.id = e.subject_id
     WHERE a.student_id = ? AND a.status IN ${DONE} GROUP BY s.name, s.icon ORDER BY avg DESC LIMIT 8`, [user.id],
  )).map((r) => ({ ...r, avg: Number(r.avg), n: Number(r.n) }));

  const live = await liveSchoolItems(user);
  return render(req, res, 'examhub/student/dashboard.html', {
    active: 'dashboard',
    trial: await trialState(user),
    upcoming_count: upcomingCount,
    attempts,
    total_attempts: Number(stats.total) || 0,
    avg_score: stats.avg_score === null ? null : Number(stats.avg_score),
    trend_svg: trendSvg ? safe(trendSvg) : null,
    latest_score: recentScores.length ? recentScores[recentScores.length - 1] : null,
    score_delta: recentScores.length >= 2 ? recentScores[recentScores.length - 1] - recentScores[recentScores.length - 2] : null,
    subject_stats: subjectStats,
    live_exams: live.exams,
    live_tests: live.tests,
    live_total_count: live.exams.length + live.tests.length,
    ...(await accessSummary(user, profile)),
  });
}, { login: true });

// ─────────────────────────────────────────── MY EXAMS ──

/** Newest year first; exams with no year last. */
function yearOrder(a, b) {
  const ea = a.exam;
  const eb = b.exam;
  const na = ea.year === null ? 1 : 0;
  const nb = eb.year === null ? 1 : 0;
  if (na !== nb) return na - nb;
  if ((eb.year || 0) !== (ea.year || 0)) return (eb.year || 0) - (ea.year || 0);
  return ea.title.toLowerCase().localeCompare(eb.title.toLowerCase());
}

/** One card: availability plus the student's tracked performance across attempts (oldest -> newest). */
function examCard(exam, attempts, now) {
  const done = attempts.filter((a) => DONE_STATUSES.includes(a.status));
  const inProgress = attempts.find((a) => a.status === 'in_progress') || null;
  let best = null;
  for (const a of done) if (!best || Number(a.score_pct) > Number(best.score_pct)) best = a;
  const last = done.length ? done[done.length - 1] : null;
  const available = !((exam.available_from && now < exam.available_from) || (exam.available_until && now > exam.available_until));
  const limit = exam.effective_max_attempts();
  const attemptsLeft = limit === 0 ? null : Math.max(0, limit - done.length);
  return {
    exam, attempt_count: done.length, best_attempt: best, last_attempt: last, in_progress: inProgress,
    attempts_left: attemptsLeft, can_attempt: available && (limit === 0 || (attemptsLeft || 0) > 0), available,
  };
}

/**
 * The applicant's exams: the shared EPT, then each of their programmes'
 * department exams, newest year first. Only what they're entitled to appears.
 */
route(router, 'examhub:exam_list', async (req, res) => {
  if (!isStudent(req)) return denied(req, res);
  const { user } = req;
  const now = new Date();
  const profile = await AccessProfile.load(user);
  const exams = (await publishedExams()).filter((e) => profile.allows(e.subject, e.bundle, e.counts_as_ept));

  const attemptsByExam = new Map();
  if (exams.length) {
    for (const a of ExamAttempt.hydrateAll(await db.all('SELECT * FROM examhub_examattempt WHERE student_id = ? AND exam_id IN (?) ORDER BY started_at', [user.id, exams.map((e) => e.id)]))) {
      if (!attemptsByExam.has(a.exam_id)) attemptsByExam.set(a.exam_id, []);
      attemptsByExam.get(a.exam_id).push(a);
    }
  }

  const eptItems = [];
  const otherItems = [];
  const programmes = new Map();
  for (const exam of exams) {
    const item = examCard(exam, attemptsByExam.get(exam.id) || [], now);
    if (exam.counts_as_ept) eptItems.push(item);
    else if (exam.bundle && exam.bundle.level === 'postgraduate') {
      if (!programmes.has(exam.bundle.id)) programmes.set(exam.bundle.id, { bundle: exam.bundle, items: [] });
      programmes.get(exam.bundle.id).items.push(item);
    } else otherItems.push(item);
  }
  // A paid-for programme still gets its section before any exam is uploaded.
  for (const [id, bundle] of profile.bundles) {
    if (bundle.level === 'postgraduate' && !programmes.has(id)) programmes.set(id, { bundle, items: [] });
  }
  for (const group of programmes.values()) {
    group.items.sort(yearOrder);
    group.until = profile.bundle_until.get(group.bundle.id) || null;
  }
  eptItems.sort(yearOrder);
  otherItems.sort(yearOrder);
  const programmeSections = [...programmes.values()].sort((a, b) => a.bundle.name.toLowerCase().localeCompare(b.bundle.name.toLowerCase()));

  return render(req, res, 'examhub/student/list.html', {
    active: 'exams', trial: await trialState(user), ept_items: eptItems, ept_allowed: profile.allows(null, null, true),
    programme_sections: programmeSections, other_items: otherItems, exam_total: exams.length,
    ...(await accessSummary(user, profile)),
  });
}, { login: true });

/** Every attempt, newest first, numbered per exam (Attempt 1, 2, 3…). */
route(router, 'examhub:student_results', async (req, res) => {
  if (!isStudent(req)) return denied(req, res);
  const { user } = req;
  let examFilter = null;
  let where = `student_id = ? AND status IN ${DONE}`;
  const params = [user.id];
  const examPk = req.GET.get('exam', '');
  if (/^\d+$/.test(examPk)) {
    examFilter = Exam.hydrate(await db.one('SELECT * FROM examhub_exam WHERE id = ?', [parseInt(examPk, 10)]));
    where += ' AND exam_id = ?';
    params.push(parseInt(examPk, 10));
  }
  const attempts = await X.attachExams(ExamAttempt.hydrateAll(await db.all(`SELECT * FROM examhub_examattempt WHERE ${where} ORDER BY started_at`, params)));
  const counters = new Map();
  for (const a of attempts) {
    counters.set(a.exam_id, (counters.get(a.exam_id) || 0) + 1);
    a.attempt_no = counters.get(a.exam_id);
  }
  attempts.reverse();
  return render(req, res, 'examhub/student/my_results.html', { active: 'results', attempts, exam_filter: examFilter });
}, { login: true });

route(router, 'examhub:exam_start', async (req, res, { pk }) => {
  if (!isStudent(req)) return denied(req, res);
  const exam = await getOr404(X.getExam(pk, 'AND is_published = 1'));
  const { user } = req;
  const [listUrlName, listLabel] = listNav(exam);

  let canStart;
  let reason;
  if (!exam.is_self_study && !await hasAccess(user, exam.subject, exam.bundle, exam.counts_as_ept)) {
    [canStart, reason] = [false, "This exam isn't included in your current subscription."];
  } else {
    [canStart, reason] = await checkExamAvailability(exam, user);
  }
  const inProgress = await X.inProgressAttempt(exam.id, user.id);

  if (req.method === 'POST') {
    if (inProgress && req.POST.get('resume') === '1') return redirect(res, 'examhub:exam_take', inProgress.id);
    if (!canStart && !inProgress) {
      messages.error(req, reason);
      return redirect(res, listUrlName);
    }
    const all = [];
    for (const section of await X.examSectionsWithQuestions(exam.id)) {
      let qs = [...section.questions];
      if (section.randomize_questions) shuffle(qs);
      if (section.questions_to_pick > 0) qs = qs.slice(0, section.questions_to_pick);
      all.push(...qs);
    }
    if (!all.length) {
      messages.error(req, 'This exam has no questions yet. Please check back later.');
      return redirect(res, listUrlName);
    }
    const attemptId = await X.createAttempt({
      exam_id: exam.id, student_id: user.id, question_order: all.map((q) => q.id), mode: exam.mode,
      max_score: round2(all.reduce((s, q) => s + Number(q.points), 0)),
    });
    return redirect(res, 'examhub:exam_take', attemptId);
  }

  const sections = await X.examSectionsWithQuestions(exam.id);
  return render(req, res, 'examhub/student/start.html', {
    active: 'exams', exam, sections,
    total_questions: sections.reduce((s, sec) => s + (sec.questions_to_pick > 0 ? sec.questions_to_pick : sec.question_count), 0),
    total_marks: await X.examTotalMarks(exam.id), can_start: canStart, reason, in_progress: inProgress,
    list_url_name: listUrlName, list_label: listLabel,
  });
}, { login: true });

route(router, 'examhub:free_trial', async (req, res) => {
  if (!isStudent(req)) return denied(req, res);
  const { user } = req;
  const trial = await trialState(user);
  if (trial.state === 'in_progress') return redirect(res, 'examhub:exam_take', trial.attempt_id);
  const profile = await AccessProfile.load(user);

  if (req.method === 'POST' && trial.state === 'none' && !profile.has_any) {
    const pool = await trialQuestionPool();
    if (pool.length) {
      const picked = shuffle(pool).slice(0, TRIAL_SIZE);
      const questions = shuffle(Question.hydrateAll(await db.all('SELECT * FROM examhub_question WHERE id IN (?)', [picked])));
      const attemptId = await db.transaction(async (tx) => {
        const examId = await X.createExam({
          title: TRIAL_TITLE, mode: 'practice', time_limit_minutes: TRIAL_MINUTES, pass_score: 50, max_attempts: 1,
          instructions: 'Free trial: answer each question to see instantly whether you were right.',
          require_fullscreen: false, detect_tab_switch: false, allow_calculator: false, allow_scratch_pad: true,
          is_published: true, is_self_study: true, owner_id: user.id, created_by_id: user.id,
        }, tx);
        const sectionId = await X.createSection({ exam_id: examId, title: 'Free Trial', order: 0 }, tx);
        const eqIds = [];
        let max = 0;
        for (let i = 0; i < questions.length; i++) {
          eqIds.push(await X.createExamQuestion({ section_id: sectionId, bank_question_id: questions[i].id, order: i, points: questions[i].default_points }, tx));
          max += Number(questions[i].default_points);
        }
        return X.createAttempt({ exam_id: examId, student_id: user.id, question_order: eqIds, mode: 'practice', max_score: round2(max) }, tx);
      });
      return redirect(res, 'examhub:exam_take', attemptId);
    }
    messages.error(req, "The free trial isn't available right now — please try again a little later.");
  }

  return render(req, res, 'examhub/student/trial.html', {
    active: 'dashboard', trial, has_access: profile.has_any, trial_size: TRIAL_SIZE, trial_minutes: TRIAL_MINUTES,
  });
});

// ─────────────────────────────────────────── SELF-STUDY PRACTICE ──

route(router, 'examhub:practice_setup', async (req, res) => {
  if (!isStudent(req)) return denied(req, res);
  const { user } = req;
  // Custom practice is part of full access: only questions from exams the subscription covers.
  const profile = await AccessProfile.load(user);
  if (!profile.has_any) {
    messages.info(req, 'Practice mode comes with a subscription. Try the free 10-question trial first.');
    return redirect(res, 'examhub:free_trial');
  }
  const allowedIds = await allowedQuestionIds(profile);
  const subjects = Subject.hydrateAll(await db.all('SELECT * FROM catalog_subject WHERE is_active = 1 ORDER BY name'));
  let error = null;

  if (req.method === 'POST') {
    const subjectId = intOrNull(req.POST.get('subject_id') || null);
    const topic = strip(req.POST.get('topic', ''));
    const difficulty = req.POST.get('difficulty', '') || null;
    const n = parseInt(req.POST.get('num_questions', 20) || 20, 10);
    const numQ = Math.max(1, Math.min(Number.isNaN(n) ? 20 : n, 100));
    const timed = req.POST.get('timed') === '1';

    const where = ['q.id IN (?)'];
    const params = [allowedIds.length ? allowedIds : [-1]];
    if (subjectId) { where.push('b.subject_id = ?'); params.push(subjectId); }
    if (topic) { where.push("(q.topic LIKE ? ESCAPE '\\\\' OR q.subtopic LIKE ? ESCAPE '\\\\')"); params.push(contains(topic), contains(topic)); }
    if (difficulty) { where.push('q.difficulty = ?'); params.push(difficulty); }
    const ids = (await db.all(`SELECT q.id FROM examhub_question q JOIN examhub_questionbank b ON b.id = q.bank_id WHERE ${where.join(' AND ')}`, params)).map((r) => r.id);

    if (!ids.length) {
      error = 'No questions match those filters — try a broader selection.';
    } else {
      const questions = shuffle(Question.hydrateAll(await db.all('SELECT * FROM examhub_question WHERE id IN (?)', [shuffle(ids).slice(0, numQ)])));
      const bank = QuestionBank.hydrate(await db.one('SELECT * FROM examhub_questionbank WHERE id = ?', [questions[0].bank_id]));
      const subj = bank.subject_id ? await db.one('SELECT name FROM catalog_subject WHERE id = ?', [bank.subject_id]) : null;
      const attemptId = await db.transaction(async (tx) => {
        const examId = await X.createExam({
          subject_id: subjectId, title: `Practice — ${subj ? subj.name : 'Mixed'}`, mode: 'practice',
          time_limit_minutes: timed ? questions.length * 2 : null, pass_score: 50, max_attempts: 0,
          require_fullscreen: false, detect_tab_switch: false, allow_calculator: true, allow_scratch_pad: true,
          is_published: true, is_self_study: true, owner_id: user.id, created_by_id: user.id,
        }, tx);
        const sectionId = await X.createSection({ exam_id: examId, title: 'Practice Set', order: 0 }, tx);
        const eqIds = [];
        let max = 0;
        for (let i = 0; i < questions.length; i++) {
          eqIds.push(await X.createExamQuestion({ section_id: sectionId, bank_question_id: questions[i].id, order: i, points: questions[i].default_points }, tx));
          max += Number(questions[i].default_points);
        }
        return X.createAttempt({ exam_id: examId, student_id: user.id, question_order: eqIds, mode: 'practice', max_score: round2(max) }, tx);
      });
      return redirect(res, 'examhub:exam_take', attemptId);
    }
  }

  return render(req, res, 'examhub/student/practice_setup.html', {
    active: 'practice', subjects, difficulty_choices: Question.DIFFICULTY_CHOICES, error,
  });
}, { login: true });

// ─────────────────────────────────────────── TAKE EXAM ──

async function studentAttempt(req, attemptPk, onlyInProgress = true) {
  const attempt = ExamAttempt.hydrate(await db.one(
    `SELECT * FROM examhub_examattempt WHERE id = ? AND student_id = ? ${onlyInProgress ? "AND status = 'in_progress'" : ''}`, [attemptPk, req.user.id],
  ));
  if (!attempt) throw new Http404();
  attempt.exam = await X.getExam(attempt.exam_id);
  return attempt;
}

route(router, 'examhub:exam_take', async (req, res, { attempt_pk }) => {
  if (!isStudent(req)) return denied(req, res);
  const attempt = await studentAttempt(req, attempt_pk);
  const { exam } = attempt;

  const qPks = attempt.question_order || [];
  if (!qPks.length) {
    await db.update('examhub_examattempt', attempt.id, { status: 'completed' });
    messages.error(req, 'This exam has no questions. Please contact support.');
    return redirect(res, listNav(exam)[0]);
  }

  const eqs = await X.hydrateExamQuestions(await db.all('SELECT * FROM examhub_examquestion WHERE id IN (?)', [qPks]));
  const sectionsById = await X.byIds(ExamSection, 'examhub_examsection', eqs.map((q) => q.section_id));
  for (const q of eqs) q.section = sectionsById.get(q.section_id);
  const qMap = new Map(eqs.map((q) => [q.id, q]));
  const ordered = qPks.map((pk) => qMap.get(Number(pk))).filter(Boolean);

  const sectionsData = [];
  let current = null;
  for (const q of ordered) {
    if (current === null || q.section_id !== current.section.id) {
      current = { section: q.section, questions: [] };
      sectionsData.push(current);
    }
    current.questions.push(q);
  }

  const answers = new Map(AttemptAnswer.hydrateAll(await db.all('SELECT * FROM examhub_attemptanswer WHERE attempt_id = ?', [attempt.id])).map((a) => [a.exam_question_id, a]));
  let timeRemaining = null;
  if (exam.time_limit_minutes) {
    timeRemaining = Math.max(0, exam.time_limit_minutes * 60 - Math.trunc((Date.now() - attempt.started_at.getTime()) / 1000));
  }

  // Everything here is visible in the page source, so it must never carry the
  // answers: no is_correct flags, true/false key, blank answers or explanations
  // (practice feedback comes from the server after each answer is saved).
  const questionsJson = ordered.map((q, i) => {
    const aa = answers.get(q.id);
    const data = {
      pk: q.id, index: i + 1, type: q.eff_type, stem: q.eff_stem, stem_image: q.eff_stem_image_url || null,
      points: Number(q.points), section_pk: q.section_id, section_title: q.section.title,
      flagged: aa ? aa.flagged : false,
      answered: Boolean(aa) && (pyTruthy(aa.selected_indices) || pyTruthy(aa.text_answer) || aa.numeric_answer !== null || pyTruthy(aa.answer_data)),
    };
    const qt = q.eff_type;
    if (qt === 'mcq_single' || qt === 'mcq_multi') {
      data.choices = (q.eff_choices_data || []).map(({ is_correct: _hidden, ...choice }) => choice);
    } else if (qt === 'fill_blank') data.blank_answers = (q.eff_blank_answers || []).map(() => ''); // only how many blanks
    else if (qt === 'numeric') { data.numeric_unit = q.eff_numeric_unit; data.numeric_tolerance = Number(q.eff_numeric_tolerance || 0); }
    else if (qt === 'theory') data.model_answer = '';
    else if (qt === 'match') { data.match_left = q.eff_match_left; data.match_right = q.eff_match_right; }
    else if (qt === 'order') {
      const items = q.eff_order_items || [];
      data.order_items = items;
      data.order_display = shuffle(items.map((item, idx) => [idx, item]));
    } else if (qt === 'category') {
      data.categories = q.eff_categories;
      data.category_items = (q.eff_category_items || []).map((pair) => pair[0]);
    }
    data.saved_selected = aa ? aa.selected_indices : [];
    data.saved_text = aa ? aa.text_answer : '';
    data.saved_numeric = aa && aa.numeric_answer !== null ? Number(aa.numeric_answer) : null;
    data.saved_data = aa ? aa.answer_data : null;
    return data;
  });

  return render(req, res, 'examhub/student/take.html', {
    exam, attempt, total_questions: ordered.length, time_remaining_seconds: timeRemaining,
    exam_data_json: {
      attempt_pk: attempt.id, mode: exam.mode, time_remaining: timeRemaining,
      allow_calculator: exam.allow_calculator, allow_scratch_pad: exam.allow_scratch_pad,
      require_fullscreen: exam.require_fullscreen, detect_tab_switch: exam.detect_tab_switch,
      max_tab_switches: exam.max_tab_switches, questions: questionsJson,
      sections: sectionsData.map((sd) => ({ pk: sd.section.id, title: sd.section.title, q_pks: sd.questions.map((q) => q.id) })),
    },
  });
}, { login: true });

function parseJsonBody(req) {
  try { return [JSON.parse(req.rawBody), null]; } catch (_) { return [null, true]; }
}

function applyAnswer(aa, type, value, forSubmit = false) {
  if (type === 'choice') {
    if (Array.isArray(value)) aa.selected_indices = value;
    else aa.selected_indices = forSubmit && (value === null || value === undefined) ? [] : [value];
  } else if (type === 'text') {
    aa.text_answer = pyTruthy(value) ? String(value) : ''; // str(value or "")
  } else if (type === 'numeric') {
    aa.numeric_answer = value === null || value === undefined || value === '' ? null : decimalOrNull(String(value));
  } else if (type === 'data') {
    aa.answer_data = value === undefined ? null : value;
  }
}

async function examQuestionFor(examId, qPk) {
  const id = intOrNull(qPk);
  if (id === null) return null;
  const rows = await db.all('SELECT q.* FROM examhub_examquestion q JOIN examhub_examsection s ON s.id = q.section_id WHERE q.id = ? AND s.exam_id = ?', [id, examId]);
  return rows.length ? (await X.hydrateExamQuestions(rows))[0] : null;
}

route(router, 'examhub:save_answer', async (req, res, { attempt_pk }) => {
  if (!isStudent(req)) return jsonResponse(res, { ok: false }, 403);
  const attempt = await studentAttempt(req, attempt_pk);
  const [data, bad] = parseJsonBody(req);
  if (bad || data === null || typeof data !== 'object') return jsonResponse(res, { ok: false, error: 'Invalid JSON' }, 400);
  const eq = await examQuestionFor(attempt.exam_id, data.question_pk);
  if (!eq) return jsonResponse(res, { ok: false, error: 'Question not found' }, 404);

  const aa = await X.getOrCreateAnswer(attempt.id, eq.id);
  applyAnswer(aa, data.type, data.value);
  if (data.flagged !== undefined && data.flagged !== null) aa.flagged = pyTruthy(data.flagged);
  aa.time_spent_seconds = Math.max(aa.time_spent_seconds, parseInt(data.time_spent || 0, 10) || 0);
  await X.saveAnswer(aa);

  if (attempt.exam.mode === 'practice') {
    const [isCorrect, correctDisplay] = gradeAnswer(eq, aa);
    return jsonResponse(res, { ok: true, practice_feedback: true, correct: isCorrect, explanation: eq.eff_explanation, correct_display: correctDisplay });
  }
  return jsonResponse(res, { ok: true });
}, { login: true, post: true });

route(router, 'examhub:flag', async (req, res, { attempt_pk }) => {
  if (!isStudent(req)) return jsonResponse(res, { ok: false }, 403);
  const attempt = await studentAttempt(req, attempt_pk);
  const [data, bad] = parseJsonBody(req);
  if (bad || data === null || typeof data !== 'object') return jsonResponse(res, { ok: false }, 400);
  const eq = await examQuestionFor(attempt.exam_id, data.question_pk);
  if (!eq) return jsonResponse(res, { ok: false }, 404);
  const aa = await X.getOrCreateAnswer(attempt.id, eq.id);
  await db.update('examhub_attemptanswer', aa.id, { flagged: !aa.flagged });
  return jsonResponse(res, { ok: true, flagged: !aa.flagged });
}, { login: true, post: true });

route(router, 'examhub:track_tab', async (req, res, { attempt_pk }) => {
  if (!isStudent(req)) return jsonResponse(res, { ok: false }, 403);
  const attempt = await studentAttempt(req, attempt_pk);
  await db.run('UPDATE examhub_examattempt SET tab_switches = tab_switches + 1 WHERE id = ?', [attempt.id]);
  const tabSwitches = Number(await db.value('SELECT tab_switches FROM examhub_examattempt WHERE id = ?', [attempt.id]));
  const { exam } = attempt;
  return jsonResponse(res, { ok: true, tab_switches: tabSwitches, auto_submit: exam.detect_tab_switch && exam.max_tab_switches > 0 && tabSwitches >= exam.max_tab_switches });
}, { login: true, post: true });

route(router, 'examhub:track_fullscreen', async (req, res, { attempt_pk }) => {
  const attempt = await studentAttempt(req, attempt_pk);
  const exits = (attempt.fullscreen_exits || 0) + 1;
  await db.update('examhub_examattempt', attempt.id, { fullscreen_exits: exits });
  return jsonResponse(res, { fullscreen_exits: exits });
}, { login: true, post: true });

route(router, 'examhub:check_timeout', async (req, res, { attempt_pk }) => {
  const attempt = await studentAttempt(req, attempt_pk, false);
  if (attempt.status !== 'in_progress') return jsonResponse(res, { timed_out: false, already_done: true });
  if (!attempt.exam.time_limit_minutes) return jsonResponse(res, { timed_out: false });
  const elapsed = (Date.now() - attempt.started_at.getTime()) / 1000;
  const limit = attempt.exam.time_limit_minutes * 60;
  if (elapsed >= limit) {
    await db.update('examhub_examattempt', attempt.id, { status: 'timed_out', completed_at: new Date(), time_taken_seconds: Math.trunc(elapsed) });
    return jsonResponse(res, { timed_out: true, redirect: reverse('examhub:exam_results', attempt.id) });
  }
  return jsonResponse(res, { timed_out: false, seconds_left: Math.trunc(limit - elapsed) });
}, { login: true });

route(router, 'examhub:submit', async (req, res, { attempt_pk }) => {
  if (!isStudent(req)) return jsonResponse(res, { ok: false }, 403);
  const attempt = await studentAttempt(req, attempt_pk);
  const { exam } = attempt;
  const [data] = parseJsonBody(req);
  const finalAnswers = data && typeof data === 'object' && data.answers && typeof data.answers === 'object' ? data.answers : {};

  for (const [qPkStr, ans] of Object.entries(finalAnswers)) {
    const eq = await examQuestionFor(exam.id, qPkStr);
    if (!eq || !ans || typeof ans !== 'object') continue;
    const aa = await X.getOrCreateAnswer(attempt.id, eq.id);
    applyAnswer(aa, ans.type, ans.value, true);
    await X.saveAnswer(aa);
  }

  let totalEarned = 0;
  let maxScore = 0;
  for (const aa of await X.attemptAnswers(attempt.id)) {
    const eq = aa.exam_question;
    const points = Number(eq.points);
    maxScore += points;
    if (eq.eff_type === 'theory') {
      const keywords = eq.eff_keywords || [];
      const text = String(aa.text_answer || '').toLowerCase();
      const matched = keywords.filter((kw) => text.includes(String(kw).toLowerCase()));
      aa.auto_score = keywords.length ? round2((matched.length / keywords.length) * points) : 0;
      aa.is_correct = aa.auto_score >= points;
      totalEarned += aa.auto_score;
    } else {
      const [isCorrect] = gradeAnswer(eq, aa);
      aa.is_correct = isCorrect;
      if (isCorrect) { aa.auto_score = points; totalEarned += points; } else if (exam.negative_marking && (pyTruthy(aa.selected_indices) || aa.numeric_answer !== null || pyTruthy(aa.answer_data))) {
        const penalty = points * (Number(exam.negative_marking_pct) / 100);
        totalEarned -= penalty;
        aa.auto_score = -round2(penalty);
      } else aa.auto_score = 0;
    }
    await db.update('examhub_attemptanswer', aa.id, { auto_score: aa.auto_score, is_correct: aa.is_correct });
  }

  totalEarned = Math.max(0, totalEarned);
  const scorePct = maxScore ? round2((totalEarned / maxScore) * 100) : 0;
  await db.update('examhub_examattempt', attempt.id, {
    raw_score: round2(totalEarned), max_score: round2(maxScore), score_pct: scorePct, passed: scorePct >= exam.pass_score,
    completed_at: new Date(), time_taken_seconds: Math.trunc((Date.now() - attempt.started_at.getTime()) / 1000), status: 'completed',
  });
  return jsonResponse(res, { ok: true, redirect: reverse('examhub:exam_results', attempt.id) });
}, { login: true, post: true });

route(router, 'examhub:exam_results', async (req, res, { attempt_pk }) => {
  if (!isStudent(req)) return denied(req, res);
  const attempt = await studentAttempt(req, attempt_pk, false);
  if (attempt.status === 'in_progress') return redirect(res, 'examhub:exam_take', attempt_pk);
  const { exam } = attempt;
  const answers = await X.attemptAnswers(attempt.id);

  const topicStats = new Map();
  const sectionStats = new Map();
  for (const aa of answers) {
    const topic = aa.exam_question.eff_topic || 'General';
    if (!topicStats.has(topic)) topicStats.set(topic, { correct: 0, total: 0, points_earned: 0, points_total: 0 });
    const t = topicStats.get(topic);
    t.total += 1;
    t.points_total += Number(aa.exam_question.points);
    if (aa.is_correct) t.correct += 1;
    t.points_earned += Number(aa.effective_score);

    const title = aa.exam_question.section.title;
    if (!sectionStats.has(title)) sectionStats.set(title, { correct: 0, total: 0, earned: 0, max: 0 });
    const s = sectionStats.get(title);
    s.total += 1;
    s.max += Number(aa.exam_question.points);
    s.earned += Number(aa.effective_score);
    if (aa.is_correct) s.correct += 1;
  }
  const secs = attempt.time_taken_seconds || 0;
  const p2 = (n) => String(n).padStart(2, '0');
  const elapsedFmt = secs >= 3600
    ? `${p2(Math.floor(secs / 3600))}h ${p2(Math.floor((secs % 3600) / 60))}m ${p2(secs % 60)}s`
    : `${p2(Math.floor(secs / 60))}m ${p2(secs % 60)}s`;

  attempt.has_ungraded_theory = await X.hasUngradedTheory(attempt.id);
  const [listUrlName, listLabel] = listNav(exam);
  return render(req, res, 'examhub/student/results.html', {
    active: 'exams', exam, attempt, answers,
    correct_count: answers.filter((a) => a.is_correct).length,
    wrong_count: answers.filter((a) => !a.is_correct && Number(a.effective_score) <= 0).length,
    skipped_count: Math.max(0, (attempt.question_order || []).length - answers.length),
    elapsed_fmt: elapsedFmt, topic_stats: [...topicStats], section_stats: [...sectionStats],
    show_review: exam.mode !== 'exam', list_url_name: listUrlName, list_label: listLabel,
    is_trial: isTrialExam(exam), trial_size: TRIAL_SIZE,
    has_access: isTrialExam(exam) ? (await AccessProfile.load(req.user)).has_any : true,
  });
}, { login: true });

route(router, 'examhub:exam_review', async (req, res, { attempt_pk }) => {
  if (!isStudent(req)) return denied(req, res);
  const attempt = await studentAttempt(req, attempt_pk, false);
  const { exam } = attempt;
  const [listUrlName, listLabel] = listNav(exam);
  if (exam.mode === 'exam' && attempt.status === 'in_progress') {
    messages.error(req, 'Exam mode: review not available.');
    return redirect(res, listUrlName);
  }
  return render(req, res, 'examhub/student/review.html', {
    active: 'exams', exam, attempt, answers: await X.attemptAnswers(attempt.id), list_url_name: listUrlName, list_label: listLabel,
  });
}, { login: true });

module.exports = { router, liveSchoolItems };
