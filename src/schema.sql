-- CBT UI (Node.js/MySQL port) schema.
-- Table and column names mirror the original Django CBT_UI project's tables,
-- so data copies across 1:1 (scripts/import_from_django.js). All DATETIME
-- columns are UTC; the app converts to TIME_ZONE (default Africa/Lagos).

CREATE TABLE IF NOT EXISTS accounts_user (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  password VARCHAR(128) NOT NULL,
  last_login DATETIME(6) NULL,
  is_superuser TINYINT(1) NOT NULL DEFAULT 0,
  username VARCHAR(150) COLLATE utf8mb4_bin NOT NULL,
  first_name VARCHAR(150) NOT NULL DEFAULT '',
  last_name VARCHAR(150) NOT NULL DEFAULT '',
  email VARCHAR(254) NOT NULL DEFAULT '',
  is_staff TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  date_joined DATETIME(6) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'student',
  registration_number VARCHAR(50) NOT NULL DEFAULT '',
  phone VARCHAR(30) NOT NULL DEFAULT '',
  avatar VARCHAR(100) NULL,
  date_of_birth DATE NULL,
  must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  created_by_id BIGINT NULL,
  created_at DATETIME(6) NOT NULL,
  UNIQUE KEY accounts_user_username_uniq (username),
  KEY accounts_user_email_idx (email),
  KEY accounts_user_registration_number_idx (registration_number),
  CONSTRAINT accounts_user_created_by_fk FOREIGN KEY (created_by_id) REFERENCES accounts_user (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catalog_subject (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  icon VARCHAR(10) NOT NULL DEFAULT '📚',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY catalog_subject_name_uniq (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catalog_faculty (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  slug VARCHAR(170) NOT NULL,
  icon VARCHAR(10) NOT NULL DEFAULT '🎓',
  `order` INT UNSIGNED NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY catalog_faculty_name_uniq (name),
  UNIQUE KEY catalog_faculty_slug_uniq (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catalog_department (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  faculty_id BIGINT NULL,
  name VARCHAR(150) NOT NULL,
  slug VARCHAR(170) NOT NULL,
  icon VARCHAR(10) NOT NULL DEFAULT '🏛️',
  description LONGTEXT NOT NULL,
  `order` INT UNSIGNED NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY catalog_department_name_uniq (name),
  UNIQUE KEY catalog_department_slug_uniq (slug),
  CONSTRAINT catalog_department_faculty_fk FOREIGN KEY (faculty_id) REFERENCES catalog_faculty (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catalog_bundle (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  slug VARCHAR(170) NOT NULL,
  description LONGTEXT NOT NULL,
  icon VARCHAR(10) NOT NULL DEFAULT '🎯',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  department_id BIGINT NULL,
  level VARCHAR(20) NOT NULL DEFAULT 'post_utme',
  `order` INT UNSIGNED NOT NULL DEFAULT 0,
  UNIQUE KEY catalog_bundle_slug_uniq (slug),
  CONSTRAINT catalog_bundle_department_fk FOREIGN KEY (department_id) REFERENCES catalog_department (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catalog_bundle_subjects (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bundle_id BIGINT NOT NULL,
  subject_id BIGINT NOT NULL,
  UNIQUE KEY catalog_bundle_subjects_uniq (bundle_id, subject_id),
  CONSTRAINT catalog_bundle_subjects_bundle_fk FOREIGN KEY (bundle_id) REFERENCES catalog_bundle (id) ON DELETE CASCADE,
  CONSTRAINT catalog_bundle_subjects_subject_fk FOREIGN KEY (subject_id) REFERENCES catalog_subject (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS branding_sitesettings (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  school_name VARCHAR(200) NOT NULL DEFAULT 'Your University',
  short_name VARCHAR(8) NOT NULL DEFAULT 'EDU',
  logo VARCHAR(100) NULL,
  logo_url VARCHAR(200) NOT NULL DEFAULT '',
  primary_color VARCHAR(7) NOT NULL DEFAULT '#e11d48',
  secondary_color VARCHAR(7) NOT NULL DEFAULT '#111827',
  tagline VARCHAR(200) NOT NULL DEFAULT 'Undergraduate POST-UTME and Postgraduate Entrance Examinations',
  target_institution_name VARCHAR(200) NOT NULL DEFAULT 'University of Ibadan',
  shared_exam_name VARCHAR(100) NOT NULL DEFAULT 'English Proficiency Test',
  shared_exam_short_name VARCHAR(20) NOT NULL DEFAULT 'EPT',
  hero_headline VARCHAR(200) NOT NULL DEFAULT 'Your Gateway to University Admission',
  trust_line VARCHAR(200) NOT NULL DEFAULT 'Secure, timed, official-style computer-based testing.',
  footer_note VARCHAR(200) NOT NULL DEFAULT 'Admissions Screening Portal',
  contact_email VARCHAR(254) NOT NULL DEFAULT '',
  contact_phone VARCHAR(30) NOT NULL DEFAULT '',
  whatsapp_number VARCHAR(30) NOT NULL DEFAULT '',
  updated_at DATETIME(6) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_plan (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  description LONGTEXT NOT NULL,
  price DECIMAL(10,2) NOT NULL DEFAULT 0,
  duration_days INT UNSIGNED NOT NULL DEFAULT 30,
  is_all_access TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_order_snapshot TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_plan_subjects (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  plan_id BIGINT NOT NULL,
  subject_id BIGINT NOT NULL,
  UNIQUE KEY billing_plan_subjects_uniq (plan_id, subject_id),
  CONSTRAINT billing_plan_subjects_plan_fk FOREIGN KEY (plan_id) REFERENCES billing_plan (id) ON DELETE CASCADE,
  CONSTRAINT billing_plan_subjects_subject_fk FOREIGN KEY (subject_id) REFERENCES catalog_subject (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_plan_bundles (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  plan_id BIGINT NOT NULL,
  bundle_id BIGINT NOT NULL,
  UNIQUE KEY billing_plan_bundles_uniq (plan_id, bundle_id),
  CONSTRAINT billing_plan_bundles_plan_fk FOREIGN KEY (plan_id) REFERENCES billing_plan (id) ON DELETE CASCADE,
  CONSTRAINT billing_plan_bundles_bundle_fk FOREIGN KEY (bundle_id) REFERENCES catalog_bundle (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_pricingtier (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  months INT UNSIGNED NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY billing_pricingtier_months_uniq (months)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- plan_id is PROTECT in Django: a plan with subscriptions/payments can't be deleted.
CREATE TABLE IF NOT EXISTS billing_subscription (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  plan_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  starts_at DATETIME(6) NOT NULL,
  ends_at DATETIME(6) NOT NULL,
  notes VARCHAR(255) NOT NULL DEFAULT '',
  created_by_id BIGINT NULL,
  created_at DATETIME(6) NOT NULL,
  CONSTRAINT billing_subscription_student_fk FOREIGN KEY (student_id) REFERENCES accounts_user (id) ON DELETE CASCADE,
  CONSTRAINT billing_subscription_plan_fk FOREIGN KEY (plan_id) REFERENCES billing_plan (id) ON DELETE RESTRICT,
  CONSTRAINT billing_subscription_created_by_fk FOREIGN KEY (created_by_id) REFERENCES accounts_user (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_payment (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  plan_id BIGINT NOT NULL,
  reference VARCHAR(100) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  subscription_id BIGINT NULL,
  raw_response LONGTEXT NOT NULL,
  created_at DATETIME(6) NOT NULL,
  verified_at DATETIME(6) NULL,
  UNIQUE KEY billing_payment_reference_uniq (reference),
  CONSTRAINT billing_payment_student_fk FOREIGN KEY (student_id) REFERENCES accounts_user (id) ON DELETE CASCADE,
  CONSTRAINT billing_payment_plan_fk FOREIGN KEY (plan_id) REFERENCES billing_plan (id) ON DELETE RESTRICT,
  CONSTRAINT billing_payment_subscription_fk FOREIGN KEY (subscription_id) REFERENCES billing_subscription (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS examhub_questionbank (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  subject_id BIGINT NULL,
  name VARCHAR(200) NOT NULL,
  description LONGTEXT NOT NULL,
  created_by_id BIGINT NULL,
  created_at DATETIME(6) NOT NULL,
  CONSTRAINT examhub_questionbank_subject_fk FOREIGN KEY (subject_id) REFERENCES catalog_subject (id) ON DELETE SET NULL,
  CONSTRAINT examhub_questionbank_created_by_fk FOREIGN KEY (created_by_id) REFERENCES accounts_user (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS examhub_questiontag (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  UNIQUE KEY examhub_questiontag_name_uniq (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS examhub_question (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bank_id BIGINT NOT NULL,
  question_type VARCHAR(20) NOT NULL,
  stem LONGTEXT NOT NULL,
  stem_image_url VARCHAR(200) NOT NULL DEFAULT '',
  choices_data LONGTEXT NOT NULL,
  tf_answer TINYINT(1) NULL,
  blank_answers LONGTEXT NOT NULL,
  numeric_answer DECIMAL(20,6) NULL,
  numeric_tolerance DECIMAL(10,4) NOT NULL DEFAULT 0,
  numeric_unit VARCHAR(50) NOT NULL DEFAULT '',
  model_answer LONGTEXT NOT NULL,
  keywords LONGTEXT NOT NULL,
  match_left LONGTEXT NOT NULL,
  match_right LONGTEXT NOT NULL,
  correct_pairs LONGTEXT NOT NULL,
  order_items LONGTEXT NOT NULL,
  categories LONGTEXT NOT NULL,
  category_items LONGTEXT NOT NULL,
  explanation LONGTEXT NOT NULL,
  explanation_image_url VARCHAR(200) NOT NULL DEFAULT '',
  default_points DECIMAL(6,2) NOT NULL DEFAULT 1,
  topic VARCHAR(200) NOT NULL DEFAULT '',
  subtopic VARCHAR(200) NOT NULL DEFAULT '',
  difficulty VARCHAR(10) NOT NULL DEFAULT 'medium',
  bloom_level VARCHAR(15) NOT NULL DEFAULT '',
  year_asked INT UNSIGNED NULL,
  is_verified TINYINT(1) NOT NULL DEFAULT 0,
  created_by_id BIGINT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  CONSTRAINT examhub_question_bank_fk FOREIGN KEY (bank_id) REFERENCES examhub_questionbank (id) ON DELETE CASCADE,
  CONSTRAINT examhub_question_created_by_fk FOREIGN KEY (created_by_id) REFERENCES accounts_user (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS examhub_question_tags (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  question_id BIGINT NOT NULL,
  questiontag_id BIGINT NOT NULL,
  UNIQUE KEY examhub_question_tags_uniq (question_id, questiontag_id),
  CONSTRAINT examhub_question_tags_question_fk FOREIGN KEY (question_id) REFERENCES examhub_question (id) ON DELETE CASCADE,
  CONSTRAINT examhub_question_tags_tag_fk FOREIGN KEY (questiontag_id) REFERENCES examhub_questiontag (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS examhub_exam (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  subject_id BIGINT NULL,
  bundle_id BIGINT NULL,
  year INT UNSIGNED NULL,
  is_ept TINYINT(1) NOT NULL DEFAULT 0,
  title VARCHAR(200) NOT NULL,
  instructions LONGTEXT NOT NULL,
  mode VARCHAR(20) NOT NULL DEFAULT 'test',
  time_limit_minutes INT UNSIGNED NULL,
  pass_score INT UNSIGNED NOT NULL DEFAULT 50,
  negative_marking TINYINT(1) NOT NULL DEFAULT 0,
  negative_marking_pct DECIMAL(5,2) NOT NULL DEFAULT 25,
  max_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  require_fullscreen TINYINT(1) NOT NULL DEFAULT 0,
  detect_tab_switch TINYINT(1) NOT NULL DEFAULT 1,
  max_tab_switches INT UNSIGNED NOT NULL DEFAULT 3,
  allow_calculator TINYINT(1) NOT NULL DEFAULT 0,
  allow_scratch_pad TINYINT(1) NOT NULL DEFAULT 1,
  is_published TINYINT(1) NOT NULL DEFAULT 0,
  available_from DATETIME(6) NULL,
  available_until DATETIME(6) NULL,
  is_self_study TINYINT(1) NOT NULL DEFAULT 0,
  owner_id BIGINT NULL,
  created_by_id BIGINT NULL,
  created_at DATETIME(6) NOT NULL,
  CONSTRAINT examhub_exam_subject_fk FOREIGN KEY (subject_id) REFERENCES catalog_subject (id) ON DELETE SET NULL,
  CONSTRAINT examhub_exam_bundle_fk FOREIGN KEY (bundle_id) REFERENCES catalog_bundle (id) ON DELETE SET NULL,
  CONSTRAINT examhub_exam_owner_fk FOREIGN KEY (owner_id) REFERENCES accounts_user (id) ON DELETE SET NULL,
  CONSTRAINT examhub_exam_created_by_fk FOREIGN KEY (created_by_id) REFERENCES accounts_user (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS examhub_examsection (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  exam_id BIGINT NOT NULL,
  subject_id BIGINT NULL,
  title VARCHAR(200) NOT NULL,
  instructions LONGTEXT NOT NULL,
  `order` INT UNSIGNED NOT NULL DEFAULT 0,
  time_limit_minutes INT UNSIGNED NULL,
  randomize_questions TINYINT(1) NOT NULL DEFAULT 0,
  randomize_choices TINYINT(1) NOT NULL DEFAULT 0,
  questions_to_pick INT UNSIGNED NOT NULL DEFAULT 0,
  CONSTRAINT examhub_examsection_exam_fk FOREIGN KEY (exam_id) REFERENCES examhub_exam (id) ON DELETE CASCADE,
  CONSTRAINT examhub_examsection_subject_fk FOREIGN KEY (subject_id) REFERENCES catalog_subject (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS examhub_examquestion (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  section_id BIGINT NOT NULL,
  bank_question_id BIGINT NULL,
  `order` INT UNSIGNED NOT NULL DEFAULT 0,
  points DECIMAL(6,2) NOT NULL DEFAULT 1,
  question_type VARCHAR(20) NOT NULL DEFAULT '',
  stem LONGTEXT NOT NULL,
  stem_image_url VARCHAR(200) NOT NULL DEFAULT '',
  choices_data LONGTEXT NOT NULL,
  tf_answer TINYINT(1) NULL,
  blank_answers LONGTEXT NOT NULL,
  numeric_answer DECIMAL(20,6) NULL,
  numeric_tolerance DECIMAL(10,4) NOT NULL DEFAULT 0,
  numeric_unit VARCHAR(50) NOT NULL DEFAULT '',
  model_answer LONGTEXT NOT NULL,
  keywords LONGTEXT NOT NULL,
  match_left LONGTEXT NOT NULL,
  match_right LONGTEXT NOT NULL,
  correct_pairs LONGTEXT NOT NULL,
  order_items LONGTEXT NOT NULL,
  categories LONGTEXT NOT NULL,
  category_items LONGTEXT NOT NULL,
  explanation LONGTEXT NOT NULL,
  CONSTRAINT examhub_examquestion_section_fk FOREIGN KEY (section_id) REFERENCES examhub_examsection (id) ON DELETE CASCADE,
  CONSTRAINT examhub_examquestion_bank_question_fk FOREIGN KEY (bank_question_id) REFERENCES examhub_question (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS examhub_examattempt (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  exam_id BIGINT NOT NULL,
  student_id BIGINT NOT NULL,
  started_at DATETIME(6) NOT NULL,
  completed_at DATETIME(6) NULL,
  time_taken_seconds INT UNSIGNED NULL,
  question_order LONGTEXT NOT NULL,
  raw_score DECIMAL(8,2) NOT NULL DEFAULT 0,
  max_score DECIMAL(8,2) NOT NULL DEFAULT 0,
  score_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  passed TINYINT(1) NOT NULL DEFAULT 0,
  tab_switches INT UNSIGNED NOT NULL DEFAULT 0,
  fullscreen_exits INT UNSIGNED NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'in_progress',
  mode VARCHAR(20) NOT NULL,
  CONSTRAINT examhub_examattempt_exam_fk FOREIGN KEY (exam_id) REFERENCES examhub_exam (id) ON DELETE CASCADE,
  CONSTRAINT examhub_examattempt_student_fk FOREIGN KEY (student_id) REFERENCES accounts_user (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS examhub_attemptanswer (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  attempt_id BIGINT NOT NULL,
  exam_question_id BIGINT NOT NULL,
  selected_indices LONGTEXT NOT NULL,
  text_answer LONGTEXT NOT NULL,
  numeric_answer DECIMAL(20,6) NULL,
  answer_data LONGTEXT NULL,
  auto_score DECIMAL(6,2) NOT NULL DEFAULT 0,
  is_correct TINYINT(1) NOT NULL DEFAULT 0,
  manual_score DECIMAL(6,2) NULL,
  graded_by_id BIGINT NULL,
  graded_at DATETIME(6) NULL,
  instructor_feedback LONGTEXT NOT NULL,
  flagged TINYINT(1) NOT NULL DEFAULT 0,
  time_spent_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  UNIQUE KEY examhub_attemptanswer_attempt_question_uniq (attempt_id, exam_question_id),
  CONSTRAINT examhub_attemptanswer_attempt_fk FOREIGN KEY (attempt_id) REFERENCES examhub_examattempt (id) ON DELETE CASCADE,
  CONSTRAINT examhub_attemptanswer_question_fk FOREIGN KEY (exam_question_id) REFERENCES examhub_examquestion (id) ON DELETE CASCADE,
  CONSTRAINT examhub_attemptanswer_graded_by_fk FOREIGN KEY (graded_by_id) REFERENCES accounts_user (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
