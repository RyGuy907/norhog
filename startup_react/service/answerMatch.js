// Flexible answer matching. Answers are stored in display form ("George
// Washington") and matched against normalized guesses, such as "washington"
// from the question's accept list or "louis 16" from roman numeral conversion.

const romanValues = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

function romanToInt(token) {
  let total = 0;
  for (let i = 0; i < token.length; i++) {
    const value = romanValues[token[i]];
    const next = romanValues[token[i + 1]] || 0;
    if (!value) return null;
    total += value < next ? -value : value;
  }
  return total;
}

function intToRoman(num) {
  const table = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'],
    [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'],
    [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let out = '';
  for (const [value, glyph] of table) {
    while (num >= value) {
      out += glyph;
      num -= value;
    }
  }
  return out;
}

// Lowercases the text, strips accents and apostrophes, turns other punctuation
// into spaces, and drops a leading "the".
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

// "louis xvi" -> "louis 16" (only for tokens that are strictly valid numerals).
function romanVariant(normalized) {
  let changed = false;
  const tokens = normalized.split(' ').map((token) => {
    if (/^[ivxlcdm]+$/.test(token)) {
      const value = romanToInt(token);
      if (value !== null && intToRoman(value) === token) {
        changed = true;
        return String(value);
      }
    }
    return token;
  });
  return changed ? tokens.join(' ') : null;
}

// Every normalized string that counts as correct for one question.
export function acceptedAnswers(entry) {
  const accepted = new Set();
  const add = (text) => {
    const normalized = normalize(text);
    if (!normalized) return;
    accepted.add(normalized);
    const variant = romanVariant(normalized);
    if (variant) accepted.add(variant);
  };
  add(entry.answer);
  (entry.accept || []).forEach(add);
  return accepted;
}
