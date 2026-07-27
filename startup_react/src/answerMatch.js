// Normalizes a typed guess so it can be matched regardless of case,
// punctuation, accents, or a leading "the". The server applies the same
// normalization (service/answerMatch.js) when locking accepted answers, and
// also pre-expands roman/arabic numeral variants there — so the client only
// needs to normalize.
export function normalize(text) {
  let t = String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.startsWith('the ')) {
    t = t.slice(4);
  }
  return t;
}
