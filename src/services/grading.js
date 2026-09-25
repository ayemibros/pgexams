/** Auto-grading logic shared by the answer-autosave and final-submit routes (port of examhub/grading.py). */

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** Python-style str() of a Decimal-ish number for display ("30.000000" -> "30.000000" kept as stored). */
function displayNumber(v) {
  if (v === null || v === undefined) return 'None';
  return String(v);
}

/**
 * Return [isCorrect, correctDisplay] for one AttemptAnswer against its
 * ExamQuestion, across all nine supported question types.
 */
function gradeAnswer(eq, aa) {
  const qt = eq.eff_type;

  if (qt === 'mcq_single') {
    const choices = eq.eff_choices_data || [];
    const selected = aa.selected_indices && aa.selected_indices.length ? Number(aa.selected_indices[0]) : -1;
    const isCorrect = selected >= 0 && selected < choices.length && Boolean(choices[selected] && choices[selected].is_correct);
    const hit = choices.find((c) => c && c.is_correct);
    return [isCorrect, hit ? hit.text : ''];
  }

  if (qt === 'mcq_multi') {
    const choices = eq.eff_choices_data || [];
    const correct = choices.map((c, i) => (c && c.is_correct ? i : null)).filter((i) => i !== null);
    const selected = new Set((aa.selected_indices || []).map(Number));
    const isCorrect = selected.size === correct.length && correct.every((i) => selected.has(i));
    const display = correct.filter((i) => i < choices.length).map((i) => choices[i].text).join(', ');
    return [isCorrect, display];
  }

  if (qt === 'true_false') {
    const correct = eq.eff_tf_answer;
    const selected = aa.answer_data ? aa.answer_data.tf : null;
    const isCorrect = selected !== null && selected !== undefined && Boolean(selected) === Boolean(correct);
    return [isCorrect, correct ? 'True' : 'False'];
  }

  if (qt === 'fill_blank') {
    const blankAnswers = eq.eff_blank_answers || [];
    const studentAnswers = (aa.answer_data || {}).blanks || [];
    let correctCount = 0;
    blankAnswers.forEach((accepted, i) => {
      const list = Array.isArray(accepted) ? accepted : [accepted];
      if (i < studentAnswers.length && list.map((a) => String(a).toLowerCase()).includes(String(studentAnswers[i] ?? '').trim().toLowerCase())) {
        correctCount++;
      }
    });
    const total = blankAnswers.length;
    const isCorrect = total ? correctCount === total : false;
    const display = blankAnswers.filter((acc) => acc && acc.length).map((acc) => (Array.isArray(acc) ? acc[0] : acc)).join(' | ');
    return [isCorrect, display];
  }

  if (qt === 'numeric') {
    const correct = num(eq.eff_numeric_answer);
    const tolerance = num(eq.eff_numeric_tolerance) || 0;
    const given = num(aa.numeric_answer);
    if (given === null || correct === null) return [false, displayNumber(eq.eff_numeric_answer)];
    // Compare at the stored precision (6 dp) to avoid float noise, like Decimal did.
    const diff = Math.abs(Math.round((given - correct) * 1e6) / 1e6);
    const isCorrect = diff <= tolerance + 1e-12;
    const unit = eq.eff_numeric_unit;
    const display = unit ? `${displayNumber(eq.eff_numeric_answer)} ${unit}`.trim() : displayNumber(eq.eff_numeric_answer);
    return [isCorrect, display];
  }

  if (qt === 'theory') {
    const keywords = eq.eff_keywords || [];
    const text = String(aa.text_answer || '').toLowerCase();
    const matched = keywords.filter((kw) => text.includes(String(kw).toLowerCase()));
    const isCorrect = keywords.length ? matched.length === keywords.length : false;
    const display = keywords.length ? `Keywords: ${keywords.join(', ')}` : '(Manual grading required)';
    return [isCorrect, display];
  }

  if (qt === 'match') {
    const key = (p) => `${Number(p[0])}|${Number(p[1])}`;
    const correctPairs = (eq.eff_correct_pairs || []).filter(Array.isArray);
    const studentPairs = ((aa.answer_data || {}).pairs || []).filter(Array.isArray);
    const a = new Set(correctPairs.map(key));
    const b = new Set(studentPairs.map(key));
    const isCorrect = a.size === b.size && [...a].every((k) => b.has(k));
    const left = eq.eff_match_left || [];
    const right = eq.eff_match_right || [];
    const display = correctPairs
      .filter(([l, r]) => l < left.length && r < right.length)
      .map(([l, r]) => `${left[l]} → ${right[r]}`)
      .join('; ');
    return [isCorrect, display];
  }

  if (qt === 'order') {
    const items = eq.eff_order_items || [];
    const studentOrder = (aa.answer_data || {}).order || [];
    const isCorrect = studentOrder.length
      ? studentOrder.length === items.length && studentOrder.every((x, i) => parseInt(x, 10) === i)
      : false;
    return [isCorrect, items.join(' → ')];
  }

  if (qt === 'category') {
    const catItems = eq.eff_category_items || [];
    const correctMap = new Map(catItems.map((pair, i) => [i, parseInt(pair[1], 10)]));
    const studentMap = new Map(((aa.answer_data || {}).categories || []).map(([ii, ci]) => [parseInt(ii, 10), parseInt(ci, 10)]));
    const isCorrect = correctMap.size === studentMap.size && [...correctMap].every(([k, v]) => studentMap.get(k) === v);
    const cats = eq.eff_categories || [];
    const display = catItems.map(([item, catIdx]) => `${item} → ${catIdx < cats.length ? cats[catIdx] : '?'}`).join('; ');
    return [isCorrect, display];
  }

  return [false, ''];
}

module.exports = { gradeAnswer };
