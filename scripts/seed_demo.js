/**
 * `npm run seed` — port of CBT_UI's `manage.py seed_demo`: placeholder
 * branding, admin/teacher/student accounts, subjects, faculties, departments,
 * Post-UTME + postgraduate programmes, sample question banks, sample exams
 * (incl. two years of EPT) and postgraduate plans. Prints one-time credentials.
 */
const db = require('../src/db');
const { migrate } = require('./migrate');
const accounts = require('../src/services/accounts');
const { generatePassword } = require('../src/services/passwords');
const X = require('../src/services/exams');

const SUBJECT_DEFS = [['English Language', '📖'], ['Mathematics', '🧮'], ['Chemistry', '🧪'], ['Physics', '🔭'], ['Biology', '🧬']];
const DEPARTMENT_DEFS = [['Computer Science', '💻'], ['Law', '⚖️'], ['Medicine & Surgery', '🩺'], ['Accounting', '📊'], ['Mass Communication', '📡']];
const FACULTY_DEFS = [['Faculty of Science', '🔬'], ['Faculty of Law', '⚖️'], ['College of Medicine', '🩺'], ['Faculty of Management Sciences', '📊'], ['Faculty of Arts & Social Sciences', '📡']];
const DEPARTMENT_FACULTY_MAP = {
  'Computer Science': 'Faculty of Science', Law: 'Faculty of Law', 'Medicine & Surgery': 'College of Medicine',
  Accounting: 'Faculty of Management Sciences', 'Mass Communication': 'Faculty of Arts & Social Sciences',
};
const POST_UTME_PROGRAM_DEFS = [
  ['Computer Science', 'Computer Science', ['English Language', 'Mathematics', 'Physics']],
  ['Law', 'Law', ['English Language', 'Mathematics', 'Biology']],
  ['Medicine & Surgery', 'Medicine & Surgery', ['English Language', 'Biology', 'Chemistry', 'Physics']],
  ['Accounting', 'Accounting', ['English Language', 'Mathematics']],
];
const POSTGRADUATE_PROGRAM_DEFS = [['MSc Computer Science', 'Computer Science', ['Mathematics']]];
const SAMPLE_QUESTIONS = {
  'English Language': [
    ['Choose the correctly spelled word.', ['Recieve', 'Receive', 'Receeve', 'Receve'], 1, 'Spelling'],
    ["Identify the noun in the sentence: 'The dog barked loudly.'", ['Dog', 'Barked', 'Loudly', 'The'], 0, 'Grammar'],
    ["What is a synonym for 'happy'?", ['Sad', 'Joyful', 'Angry', 'Tired'], 1, 'Vocabulary'],
    ['Which sentence is grammatically correct?', ['She go to school.', 'She goes to school.', 'She going to school.', 'She gone to school.'], 1, 'Grammar'],
    ["What is the antonym of 'ancient'?", ['Old', 'Modern', 'Historic', 'Aged'], 1, 'Vocabulary'],
  ],
  Mathematics: [
    ['Simplify: 3(2x - 4)', ['6x - 12', '6x - 4', '6x + 12', '3x - 12'], 0, 'Algebra'],
    ['What is 12% of 250?', ['25', '30', '35', '40'], 1, 'Percentages'],
    ['What is the value of 7 squared?', ['14', '42', '49', '56'], 2, 'Arithmetic'],
    ['Solve for x: 2x + 3 = 11', ['3', '4', '5', '6'], 1, 'Algebra'],
    ['A right angle measures how many degrees?', ['45', '90', '180', '360'], 1, 'Geometry'],
  ],
  Chemistry: [
    ['What is the chemical symbol for water?', ['H2O', 'O2', 'CO2', 'HO2'], 0, 'Compounds'],
    ['What is the atomic number of Hydrogen?', ['0', '1', '2', '3'], 1, 'Atomic Structure'],
    ['Which of these is a noble gas?', ['Oxygen', 'Nitrogen', 'Argon', 'Hydrogen'], 2, 'Periodic Table'],
    ['What is the pH of a neutral solution?', ['0', '7', '14', '10'], 1, 'Acids & Bases'],
    ['Table salt is chemically known as?', ['Sodium Chloride', 'Sodium Hydroxide', 'Calcium Carbonate', 'Potassium Nitrate'], 0, 'Compounds'],
  ],
  Physics: [
    ['What is the SI unit of force?', ['Joule', 'Newton', 'Watt', 'Pascal'], 1, 'Mechanics'],
    ['Which of these is a vector quantity?', ['Speed', 'Mass', 'Velocity', 'Time'], 2, 'Mechanics'],
    ['What is the speed of light approximately?', ['3x10^8 m/s', '3x10^6 m/s', '3x10^5 m/s', '3x10^10 m/s'], 0, 'Optics'],
    ['What force keeps planets in orbit?', ['Magnetism', 'Gravity', 'Friction', 'Tension'], 1, 'Gravitation'],
    ['What instrument measures electric current?', ['Voltmeter', 'Ammeter', 'Barometer', 'Thermometer'], 1, 'Electricity'],
  ],
  Biology: [
    ['What is the basic unit of life?', ['Tissue', 'Cell', 'Organ', 'Organism'], 1, 'Cell Biology'],
    ['Which organelle is known as the powerhouse of the cell?', ['Nucleus', 'Ribosome', 'Mitochondria', 'Golgi Body'], 2, 'Cell Biology'],
    ['Photosynthesis occurs mainly in which part of the plant?', ['Roots', 'Stem', 'Leaves', 'Flowers'], 2, 'Plant Biology'],
    ['What gas do plants absorb for photosynthesis?', ['Oxygen', 'Carbon dioxide', 'Nitrogen', 'Hydrogen'], 1, 'Plant Biology'],
    ['Humans have how many chromosomes?', ['23', '46', '44', '48'], 1, 'Genetics'],
  ],
};
const DAY_MS = 24 * 60 * 60 * 1000;

async function getOrCreate(table, where, defaults) {
  const keys = Object.keys(where);
  const row = await db.one(`SELECT * FROM \`${table}\` WHERE ${keys.map((k) => `\`${k}\` = ?`).join(' AND ')} LIMIT 1`, keys.map((k) => where[k]));
  if (row) return [row, false];
  const id = await db.insert(table, { ...where, ...defaults });
  return [await db.one(`SELECT * FROM \`${table}\` WHERE id = ?`, [id]), true];
}

async function sectionsExist(examId) {
  return Number(await db.value('SELECT COUNT(*) FROM examhub_examsection WHERE exam_id = ?', [examId])) > 0;
}

async function main() {
  await migrate({ quiet: true });
  const created = [];

  // ── Branding placeholder (the real admin edits this at /staff/settings/) ──
  const site = await accounts.getSiteSettings();
  if (site.school_name === 'Your University') {
    await db.update('branding_sitesettings', site.id, { school_name: 'Delta State University', short_name: 'DELSU', updated_at: new Date() });
  }

  // ── Accounts ──
  for (const [label, username, fields] of [
    ['Admin', 'admin', { first_name: 'Site', last_name: 'Admin', email: 'admin@example.com', role: 'admin', is_staff: true, is_superuser: true }],
    ['Staff', 'teacher', { first_name: 'Demo', last_name: 'Teacher', email: 'teacher@example.com', role: 'staff' }],
    ['Student', 'student', { first_name: 'Demo', last_name: 'Student', email: 'student@example.com', role: 'student' }],
  ]) {
    if (await db.value('SELECT COUNT(*) FROM accounts_user WHERE username = ?', [username])) continue;
    const password = generatePassword();
    await accounts.createUser({ username, ...fields, must_change_password: true }, password);
    created.push([label, username, password]);
  }
  const creator = await db.one("SELECT id FROM accounts_user WHERE username = 'teacher'") || await db.one('SELECT id FROM accounts_user WHERE is_superuser = 1 LIMIT 1');
  const creatorId = creator ? creator.id : null;

  // ── Demo all-access subscription for every student ──
  const [demoPlan] = await getOrCreate('billing_plan', { name: 'Full Access (Demo)' }, {
    description: 'Grants access to every subject and program — seeded for demo purposes.', price: 0, duration_days: 365,
    is_all_access: true, is_active: true, is_order_snapshot: false, created_at: new Date(),
  });
  for (const s of await db.all("SELECT id FROM accounts_user WHERE role = 'student'")) {
    if (!await db.value("SELECT COUNT(*) FROM billing_subscription WHERE student_id = ? AND plan_id = ? AND status = 'active'", [s.id, demoPlan.id])) {
      const now = new Date();
      await db.insert('billing_subscription', {
        student_id: s.id, plan_id: demoPlan.id, status: 'active', starts_at: now, ends_at: new Date(now.getTime() + 365 * DAY_MS),
        notes: 'Seeded demo subscription', created_by_id: creatorId, created_at: now,
      });
    }
  }

  // ── Catalog ──
  const subjects = {};
  for (const [name, icon] of SUBJECT_DEFS) [subjects[name]] = await getOrCreate('catalog_subject', { name }, { icon, is_active: true });
  const faculties = {};
  for (const [order, [name, icon]] of FACULTY_DEFS.entries()) {
    [faculties[name]] = await getOrCreate('catalog_faculty', { name }, { icon, order, is_active: true, slug: await accounts.uniqueSlug('catalog_faculty', name, 'faculty') });
  }
  const departments = {};
  for (const [order, [name, icon]] of DEPARTMENT_DEFS.entries()) {
    const [dept] = await getOrCreate('catalog_department', { name }, {
      icon, order, is_active: true, description: '', slug: await accounts.uniqueSlug('catalog_department', name, 'department'),
    });
    if (!dept.faculty_id) { await db.update('catalog_department', dept.id, { faculty_id: faculties[DEPARTMENT_FACULTY_MAP[name]].id }); }
    departments[name] = dept;
  }
  const programs = {};
  for (const [level, defs, descr] of [['post_utme', POST_UTME_PROGRAM_DEFS, (n) => `Post-UTME screening for ${n}.`], ['postgraduate', POSTGRADUATE_PROGRAM_DEFS, (n) => `Postgraduate entrance exam for ${n}.`]]) {
    for (const [order, [name, deptName, subjNames]] of defs.entries()) {
      const [prog] = await getOrCreate('catalog_bundle', { name }, {
        department_id: departments[deptName].id, level, order, icon: departments[deptName].icon, description: descr(name),
        is_active: true, slug: await accounts.uniqueSlug('catalog_bundle', name, 'bundle'),
      });
      if (!prog.department_id) await db.update('catalog_bundle', prog.id, { department_id: departments[deptName].id, level });
      await db.run('DELETE FROM catalog_bundle_subjects WHERE bundle_id = ?', [prog.id]);
      await db.insertMany('catalog_bundle_subjects', subjNames.map((n) => ({ bundle_id: prog.id, subject_id: subjects[n].id })));
      programs[name] = prog;
    }
  }

  // ── Question banks + sample questions ──
  const bankQuestions = {};
  for (const name of Object.keys(subjects)) {
    const [bank] = await getOrCreate('examhub_questionbank', { name: `${name} — Sample Bank` }, {
      subject_id: subjects[name].id, description: '', created_by_id: creatorId, created_at: new Date(),
    });
    if (!bank.subject_id) await db.update('examhub_questionbank', bank.id, { subject_id: subjects[name].id });
    let qs = await db.all('SELECT * FROM examhub_question WHERE bank_id = ? ORDER BY id', [bank.id]);
    if (!qs.length) {
      for (const [stem, choices, correct, topic] of SAMPLE_QUESTIONS[name]) {
        await X.createQuestion({
          bank_id: bank.id, question_type: 'mcq_single', stem, topic, difficulty: 'medium', created_by_id: creatorId,
          choices_data: choices.map((c, i) => ({ text: c, is_correct: i === correct })),
        });
      }
      qs = await db.all('SELECT * FROM examhub_question WHERE bank_id = ? ORDER BY id', [bank.id]);
    }
    bankQuestions[name] = qs;
  }

  async function seedExam(title, fields, sections) {
    const [exam, isNew] = await getOrCreate('examhub_exam', { title }, {
      subject_id: null, bundle_id: null, year: null, is_ept: false, instructions: '', mode: 'test', pass_score: 50, is_published: true,
      negative_marking: false, negative_marking_pct: 25, max_attempts: 0, require_fullscreen: false, detect_tab_switch: true,
      max_tab_switches: 3, allow_calculator: false, allow_scratch_pad: true, is_self_study: false, created_by_id: creatorId,
      created_at: new Date(), ...fields,
    });
    if (isNew || !await sectionsExist(exam.id)) {
      for (const [i, [secTitle, subjectName, qs]] of sections.entries()) {
        const sid = await X.createSection({ exam_id: exam.id, title: secTitle, order: i, subject_id: subjectName ? subjects[subjectName].id : null });
        for (const [j, q] of qs.entries()) await X.createExamQuestion({ section_id: sid, bank_question_id: q.id, order: j, points: q.default_points });
      }
    }
  }

  await seedExam('Mathematics — Mid-Term Test', { subject_id: subjects.Mathematics.id, time_limit_minutes: 20 }, [['Section A', null, bankQuestions.Mathematics]]);
  await seedExam('Computer Science — Post-UTME Practice Sitting', { bundle_id: programs['Computer Science'].id, time_limit_minutes: 60 },
    ['English Language', 'Mathematics', 'Physics'].map((n) => [n, n, bankQuestions[n]]));
  for (const year of [2023, 2024]) {
    await seedExam(`EPT — English Proficiency Test ${year}`, { subject_id: subjects['English Language'].id, year, is_ept: true, time_limit_minutes: 45 },
      [['Section A', null, bankQuestions['English Language']]]);
  }
  const msc = programs['MSc Computer Science'];
  await seedExam('MSc Computer Science — Department Exam 2023', { bundle_id: msc.id, year: 2023, time_limit_minutes: 60 }, [['Section A', null, bankQuestions.Mathematics]]);

  // Duration-tiered plans for the postgraduate programme.
  for (const [label, days, price] of [['1 Month', 30, 5000], ['2 Months', 60, 8500], ['3 Months', 90, 12000]]) {
    const [plan] = await getOrCreate('billing_plan', { name: `MSc Computer Science — ${label}` }, {
      description: 'EPT English Test (all years) + MSc Computer Science department exams (all years).', price, duration_days: days,
      is_all_access: false, is_active: true, is_order_snapshot: false, created_at: new Date(),
    });
    await db.run('DELETE FROM billing_plan_bundles WHERE plan_id = ?', [plan.id]);
    await db.insert('billing_plan_bundles', { plan_id: plan.id, bundle_id: msc.id });
  }

  const s2 = await accounts.getSiteSettings();
  console.log('Demo data ready.');
  if (created.length) {
    console.log('\nSave these credentials now — they are shown only once:');
    for (const [label, username, password] of created) console.log(`  ${label.padEnd(10)} username=${username.padEnd(10)} password=${password}`);
  }
  console.log(`\n5 subjects, 5 faculties, 5 departments, 5 programs (4 Post-UTME + 1 postgraduate), sample question banks, 'Mathematics — Mid-Term Test', 'Computer Science — Post-UTME Practice Sitting', 2 years of EPT, and 'MSc Computer Science — Department Exam 2023' published, plus a postgraduate subscription Plan for it. Placeholder branding: ${s2.school_name} (${s2.short_name}) — change this at /staff/settings/.`);
}

main().then(() => db.close()).catch(async (err) => { console.error(err); await db.close(); process.exit(1); });
