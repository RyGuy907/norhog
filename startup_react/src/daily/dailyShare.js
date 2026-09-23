// Scoring and the share text for the daily quiz. The server scores the same
// way in service/daily.js.

// Typing the answer is worth 2 points, picking it from the choices 1, and
// missing it 0, for 10 at most.
export const outcomePoints = { typed: 2, choice: 1, miss: 0 };

// Plain text marks rather than emoji. On the page, a typed answer and a picked
// one are told apart by colour.
export const outcomeMarks = { typed: '✓', choice: '✓', miss: '✗' };

// Shared text has no colour, so an answer picked from the choices gets a
// single slash: one stroke of the cross, for its half points.
export const shareMarks = { typed: '✓', choice: '/', miss: '✗' };

export const outcomeLabels = {
  typed: 'Answered from memory',
  choice: 'Answered from the choices',
  miss: 'Missed',
};

export function scoreOf(results) {
  return results.reduce((sum, result) => sum + (outcomePoints[result] ?? 0), 0);
}

// The row of marks, one per question with a space between each, so a run of
// slashes can't blur together.
export function markRow(results) {
  return results.map((result) => shareMarks[result] || shareMarks.miss).join(' ');
}

export function shareText({ number, results, streak, url }) {
  const score = scoreOf(results);
  const lines = [
    `Norhog Daily #${number}`,
    markRow(results),
    `${score}/10${streak > 1 ? ` · ${streak}-day streak` : ''}`,
  ];
  if (url) {
    lines.push(url);
  }
  return lines.join('\n');
}
