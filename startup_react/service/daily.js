// The daily quiz: five questions drawn from the whole library each day, the
// same for everyone. Everything here is pure (no database), so the picker,
// the wrong-answer choices, and the streak rules can be tested directly.
//
// Two optional flags on a question shape what the picker may use:
//   followsPrevious: true  the question leans on the one before it ("Who was
//                          his queen?"), so that question and its answer are
//                          shown above it as a lead-in.
//   daily: false           never used in the daily quiz.
import { acceptedAnswers, normalize } from './answerMatch.js';

export const dailyTimeZone = 'America/Los_Angeles';

// Daily #1 is this date. Later numbers count the days since.
export const dailyEpoch = '2026-09-22';

// Three easy questions, then one medium and one hard, in that order.
export const dailyLevels = ['easy', 'easy', 'easy', 'medium', 'hard'];

// A day may take at most this many questions from one quiz.
const maxPerQuiz = 2;

// How many earlier questions a lead-in may show. A question whose chain of
// dependencies runs deeper than this is left out.
const maxLeads = 2;

// --- Dates, in Pacific time ---

const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: dailyTimeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const hourFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: dailyTimeZone,
  hour: 'numeric',
  hourCycle: 'h23',
});

// The Pacific calendar date as YYYY-MM-DD.
export function dailyDate(now = new Date()) {
  return dateFormat.format(now);
}

const dayMs = 24 * 60 * 60 * 1000;

function dateToUtc(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

export function addDays(dateKey, days) {
  return new Date(dateToUtc(dateKey) + days * dayMs).toISOString().slice(0, 10);
}

export function daysBetween(fromKey, toKey) {
  return Math.round((dateToUtc(toKey) - dateToUtc(fromKey)) / dayMs);
}

export function dailyNumber(dateKey) {
  return daysBetween(dailyEpoch, dateKey) + 1;
}

// How long after midnight a day's result is still accepted, for players who
// started before the reset and finished just after it.
export const gracePeriodMs = 60 * 60 * 1000;

// Whether `dateKey` is yesterday's quiz and midnight passed less than the
// grace period ago. Asking what the date was an hour ago handles daylight
// saving without any offset arithmetic.
export function isInGracePeriod(dateKey, now = new Date()) {
  if (typeof dateKey !== 'string' || dateKey === dailyDate(now)) {
    return false;
  }
  return dateKey === dailyDate(new Date(now.getTime() - gracePeriodMs));
}

// The instant of the next Pacific midnight. It starts from 08:00 UTC (midnight
// in PST) and steps back an hour when daylight saving puts that at 01:00.
export function nextResetAt(now = new Date()) {
  const tomorrow = addDays(dailyDate(now), 1);
  let instant = dateToUtc(tomorrow) + 8 * 60 * 60 * 1000;
  const hour = Number(hourFormat.format(new Date(instant)));
  if (hour !== 0) {
    instant -= (hour > 12 ? hour - 24 : hour) * 60 * 60 * 1000;
  }
  return instant;
}

// --- Seeded randomness, so a date always produces the same quiz ---

function hashString(text) {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

// mulberry32: small, fast, and good enough for picking questions.
export function seededRandom(seed) {
  let a = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// --- The pool of usable questions ---

// Identifies a question across days. Question text is part of it, so an edited
// question counts as a new one.
export function questionKey(slug, level, question) {
  return `${slug}|${level}|${question}`;
}

// The earlier questions a lead-in shows, oldest first, or null when the chain
// is too deep to show.
function leadsFor(entries, index) {
  const leads = [];
  let i = index;
  while (entries[i]?.followsPrevious) {
    if (leads.length === maxLeads || i === 0) {
      return null;
    }
    i -= 1;
    leads.unshift({ question: entries[i].question, answer: entries[i].answer });
  }
  return leads;
}

// Every question the daily quiz may use, in a stable order. A question also
// needs three believable wrong answers, since every question can be switched
// to multiple choice.
export function buildPool(quizzes, library = buildLibrary(quizzes)) {
  const pool = [];
  for (const quiz of quizzes) {
    for (const level of ['easy', 'medium', 'hard']) {
      const entries = quiz.difficulties?.[level] || [];
      entries.forEach((entry, index) => {
        if (entry.daily === false) {
          return;
        }
        const leads = leadsFor(entries, index);
        if (!leads) {
          return;
        }
        if (!hasChoices({ ...entry, slug: quiz.slug }, library)) {
          return;
        }
        const key = questionKey(quiz.slug, level, entry.question);
        pool.push({
          key,
          // A short stable id, so practice players can report what they've
          // seen without sending the full key.
          id: hashString(key).toString(36),
          slug: quiz.slug,
          title: quiz.title,
          level,
          index,
          question: entry.question,
          answer: entry.answer,
          accept: entry.accept || [],
          choices: entry.choices,
          leads,
        });
      });
    }
  }
  return pool.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// --- Wrong answers for the multiple-choice fallback ---

const numberWords = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty',
];

function ordinal(n) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

// Answers that are numbers get nearby numbers as wrong choices, written the
// same way as the real answer. Returns null for any other kind of answer.
function numericChoices(answer, random) {
  const pickNear = (value, spreads, min = 1) => {
    const out = new Set();
    for (const spread of shuffled(spreads, random)) {
      for (const sign of shuffled([1, -1], random)) {
        const candidate = value + sign * spread;
        if (candidate >= min && candidate !== value && out.size < 3) {
          out.add(candidate);
        }
      }
    }
    return [...out].slice(0, 3);
  };

  // Years such as 1789, 480 BC, or AD 9.
  let match = answer.match(/^(AD |c\. )?(\d{1,4})( BC| AD| BCE| CE)?$/i);
  if (match) {
    const [, prefix = '', digits, suffix = ''] = match;
    const value = Number(digits);
    const spreads = value >= 100 ? [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25] : [1, 2, 3, 4, 5, 6, 8, 10];
    return pickNear(value, spreads).map((n) => `${prefix}${n}${suffix}`);
  }

  // Centuries such as "The 14th century".
  match = answer.match(/^(the )?(\d{1,2})(st|nd|rd|th) century( BC)?$/i);
  if (match) {
    const [, the = '', digits, , bc = ''] = match;
    return pickNear(Number(digits), [1, 2, 3], 1).map((n) => `${the}${ordinal(n)} century${bc}`);
  }

  // Decades such as "The 1960s".
  match = answer.match(/^(the )?(\d{3})0s$/i);
  if (match) {
    const [, the = '', stem] = match;
    return pickNear(Number(stem), [1, 2, 3], 1).map((n) => `${the}${n}0s`);
  }

  // Numbers written as words, such as "Four" or "Nine".
  const word = numberWords.indexOf(answer.toLowerCase());
  if (word > 0) {
    const capital = answer[0] === answer[0].toUpperCase();
    return pickNear(word, [1, 2, 3, 4], 1)
      .filter((n) => n < numberWords.length)
      .map((n) => (capital ? numberWords[n][0].toUpperCase() + numberWords[n].slice(1) : numberWords[n]));
  }

  // Any other short number, including "27" and "13,200".
  match = answer.match(/^(\d{1,3}(,\d{3})*|\d+)$/);
  if (match) {
    const value = Number(answer.replace(/,/g, ''));
    const step = Math.max(1, Math.round(value / 10));
    return pickNear(value, [1, 2, 3, 4].map((m) => m * step), 1)
      .map((n) => (answer.includes(',') ? n.toLocaleString('en-US') : String(n)));
  }

  return null;
}

// Words that end the noun phrase after "which": verbs, auxiliaries, and
// prepositions. The last word before one of them is the thing being asked for.
const phraseStops = new Set([
  'did', 'does', 'do', 'was', 'were', 'is', 'are', 'had', 'has', 'have', 'could', 'would', 'will',
  'can', 'that', 'who', 'whose', 'which', 'to', 'of', 'in', 'on', 'at', 'for', 'from', 'with', 'by',
  'off', 'into', 'across', 'through', 'over', 'under', 'beside', 'near', 'along', 'against', 'after',
  'before', 'during', 'as', 'and', 'or', 'first', 'finally', 'also', 'still', 'then', 'once', 'most',
  'gave', 'made', 'won', 'led', 'took', 'became', 'began', 'fought', 'built', 'wrote', 'sent', 'broke',
  'held', 'left', 'lost', 'brought', 'drove', 'rose', 'fell', 'ran', 'set', 'saw', 'found', 'kept',
  'met', 'told', 'sold', 'bore', 'stood', 'struck', 'sank', 'came', 'went', 'got', 'shot', 'hid',
  'lies', 'lay', 'stands', 'runs', 'gives', 'makes', 'holds', 'marks', 'means', 'says', 'shows',
  // Irregular past tenses, which the "-ed" rule below doesn't catch.
  'grew', 'drew', 'threw', 'flew', 'knew', 'blew', 'slew', 'spoke', 'hung', 'sat', 'swept', 'split',
  'cut', 'hit', 'put', 'fed', 'fled', 'sought', 'taught', 'bought', 'thought', 'caught', 'spent',
  'lent', 'meant', 'dealt', 'felt', 'wept', 'spun', 'stuck', 'rode', 'froze', 'chose', 'woke', 'stole',
  'tore', 'wore', 'swore', 'sang', 'rang', 'swam', 'ate', 'shook', 'bound', 'heard', 'paid', 'said',
  'laid', 'withdrew', 'overthrew', 'undertook', 'forbade', 'underwent', 'overcame', 'withstood',
  'upheld', 'foresaw', 'begat', 'strove', 'arose', 'awoke', 'forgave', 'overran', 'outlived', 'fell',
]);

const leadingPrepositions = new Set([
  'in', 'at', 'on', 'from', 'to', 'off', 'along', 'near', 'into', 'across', 'through', 'over', 'under',
  'beside', 'by', 'for', 'with', 'against', 'outside', 'around', 'down', 'up', 'after', 'before',
  'during', 'within', 'beneath', 'behind', 'between', 'inside', 'towards', 'aboard',
]);

const singular = (word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);

// Groups questions by what kind of thing they ask for, so wrong choices match
// the right one: "Which battle...", "In which year...", "Who...".
export function questionKind(question) {
  const words = question.toLowerCase().replace(/[?,.;:"']/g, (c) => (c === "'" ? "'" : ' ')).split(/\s+/).filter(Boolean);
  if (['who', 'whom', 'whose'].includes(words[0])) {
    return 'person';
  }

  let i = leadingPrepositions.has(words[0]) ? 1 : 0;
  if (words[i] !== 'which' && words[i] !== 'what') {
    return 'other';
  }
  i += 1;

  // "What was the lightning-war tactic called?" names its kind at the end.
  if (['was', 'were', 'is', 'are'].includes(words[i])) {
    const called = question.match(/^what (?:was|were|is|are) (.+?) (?:called|known as|named|nicknamed)\b/i);
    if (!called) {
      return 'other';
    }
    // "the back end of a ship" asks for an end, not a ship.
    const tail = called[1].toLowerCase().split(/ of /)[0].split(/\s+/);
    return singular(tail[tail.length - 1].replace(/[^a-z-]/g, '')) || 'other';
  }

  let head = null;
  for (let n = 0; n < 5 && i < words.length; n++, i++) {
    const word = words[i];
    if (phraseStops.has(word) || (n > 0 && /[a-z]ed$/.test(word))) {
      break;
    }
    // "Which famous scientist's letter": the possessive is the thing asked for.
    if (/'s$/.test(word)) {
      head = word.slice(0, -2);
      break;
    }
    if (!/^\d+$/.test(word)) {
      head = word;
    }
  }
  return head ? singular(head.replace(/[^a-z-]/g, '')) || 'other' : 'other';
}

// Question kinds grouped into classes of things that make fair wrong answers
// for one another: a king can stand in for a general, but not for a city.
// Women get their own class so "Who was his queen?" never offers men.
const kindClasses = {
  person: ['person', 'president', 'king', 'general', 'emperor', 'leader', 'minister', 'commander', 'admiral',
    'son', 'officer', 'poet', 'prince', 'brother', 'ruler', 'secretary', 'marshal', 'captain', 'duke',
    'engineer', 'philosopher', 'pope', 'governor', 'senator', 'historian', 'sultan', 'painter', 'chancellor',
    'pharaoh', 'hero', 'explorer', 'reformer', 'architect', 'writer', 'friar', 'physicist', 'founder',
    'scholar', 'official', 'chief', 'statesman', 'navigator', 'mathematician', 'raider', 'archbishop',
    'cardinal', 'grandson', 'soldier', 'chieftain', 'physician', 'playwright', 'man', 'father', 'uncle',
    'nephew', 'husband', 'bishop', 'monk', 'priest', 'prophet', 'scientist', 'inventor', 'composer',
    'sculptor', 'novelist', 'author', 'journalist', 'lawyer', 'judge', 'khan', 'tsar', 'shah', 'caliph',
    'doge', 'regent', 'consul', 'dictator', 'tribune', 'successor', 'heir', 'rival', 'ally', 'lord',
    'baron', 'earl', 'vizier', 'shogun', 'samurai', 'warlord', 'rebel', 'pirate', 'aviator', 'astronaut',
    'pilot', 'activist', 'agent', 'spy', 'diplomat', 'ambassador', 'economist', 'theologian', 'astronomer',
    'chemist', 'biologist', 'doctor', 'surgeon', 'nurse', 'banker', 'merchant', 'magnate', 'tycoon'],
  woman: ['queen', 'woman', 'wife', 'daughter', 'princess', 'empress', 'sister', 'mother', 'widow',
    'mistress', 'duchess', 'countess', 'lady', 'nun', 'heroine', 'first-lady'],
  deity: ['god', 'goddess', 'deity', 'titan', 'spirit'],
  settlement: ['city', 'town', 'capital', 'port', 'village', 'city-state', 'harbour', 'harbor', 'suburb',
    'district', 'quarter', 'neighbourhood', 'neighborhood'],
  polity: ['country', 'state', 'kingdom', 'empire', 'colony', 'republic', 'territory', 'province',
    'region', 'nation', 'duchy', 'principality', 'realm', 'khanate', 'caliphate', 'sultanate', 'county'],
  conflict: ['battle', 'war', 'campaign', 'victory', 'defeat', 'siege', 'clash', 'offensive', 'operation',
    'attack', 'massacre', 'rising', 'revolt', 'uprising', 'crusade', 'raid', 'rebellion', 'revolution',
    'invasion', 'coup', 'mutiny', 'conflict', 'skirmish', 'engagement', 'ambush', 'expedition'],
  law: ['treaty', 'act', 'law', 'agreement', 'amendment', 'document', 'policy', 'decree', 'doctrine',
    'pact', 'charter', 'edict', 'statute', 'accord', 'convention', 'declaration', 'bill', 'code',
    'settlement', 'peace', 'proclamation', 'compromise', 'plan', 'programme', 'program'],
  water: ['river', 'sea', 'ocean', 'strait', 'lake', 'bay', 'channel', 'gulf', 'canal'],
  land: ['island', 'peninsula', 'mountain', 'range', 'valley', 'pass', 'desert', 'plain', 'plateau',
    'continent', 'hill', 'cape', 'coast', 'archipelago'],
  group: ['people', 'dynasty', 'house', 'family', 'party', 'group', 'organisation', 'organization',
    'movement', 'faction', 'order', 'society', 'league', 'company', 'agency', 'body', 'council',
    'assembly', 'institution', 'army', 'unit', 'force', 'tribe', 'clan', 'union', 'club', 'guild',
    'regiment', 'corps', 'squadron', 'navy', 'fleet', 'sect', 'church', 'denomination'],
  structure: ['fortress', 'fort', 'castle', 'palace', 'building', 'cathedral', 'temple', 'stronghold',
    'camp', 'monastery', 'abbey', 'mosque', 'tower', 'wall', 'bridge', 'prison', 'tomb', 'monument',
    'statue', 'estate', 'house', 'residence', 'museum', 'library', 'school', 'college', 'university'],
  work: ['book', 'novel', 'poem', 'play', 'epic', 'essay', 'pamphlet', 'speech', 'newspaper', 'painting',
    'opera', 'symphony', 'song', 'anthem', 'film', 'memoir', 'treatise', 'text', 'work', 'magazine'],
  vessel: ['ship', 'warship', 'vessel', 'boat', 'submarine', 'battleship', 'frigate', 'liner', 'flagship',
    'aircraft', 'plane', 'bomber', 'fighter', 'tank', 'rocket', 'spacecraft', 'probe', 'satellite'],
  title: ['title', 'nickname', 'epithet', 'rank'],
  faith: ['religion', 'faith', 'belief', 'philosophy', 'ideology'],
  language: ['language', 'script', 'alphabet', 'tongue'],
};

const classOfKind = new Map();
for (const [cls, kinds] of Object.entries(kindClasses)) {
  for (const kind of kinds) {
    if (!classOfKind.has(kind)) classOfKind.set(kind, cls);
  }
}

// The class of thing a question asks for, or its raw kind when no class
// covers it. Questions of kind 'other' have no usable class.
export function questionClass(question) {
  const kind = questionKind(question);
  return classOfKind.get(kind) || kind;
}

// How alike two answers look: the same leading article, a similar length, and
// the same capitalisation. Used to rank candidate wrong answers.
function shapeOf(text) {
  const words = text.split(/\s+/);
  const article = /^(the|a|an)$/i.test(words[0]) ? (words[0].toLowerCase() === 'the' ? 'the' : 'a') : '';
  const rest = article ? words.slice(1) : words;
  const capitalised = rest.filter((word) => /^[A-Z]/.test(word)).length >= Math.ceil(rest.length / 2);
  return { article, length: rest.length, capitalised };
}

function shapeScore(a, b) {
  return (a.article === b.article ? 2 : 0)
    + (a.capitalised === b.capitalised ? 2 : 0)
    + Math.max(0, 2 - Math.abs(a.length - b.length));
}

const looksNumeric = (text) => /^(AD |c\. )?\d/i.test(text) || /century$/i.test(text);
// "Alpha and Bravo" should only sit beside other pairs.
const isPair = (text) => /\band\b|&/i.test(text);

// Plausible wrong answers for a question, best first: answers to questions of
// the same class from the same topic (a quiz and its sequels), shaped like the
// real answer. Returns fewer than three when the topic can't supply them,
// which keeps the question out of the daily quiz. With `enough`, it stops
// ranking and returns as soon as it has found that many.
export function wrongAnswerCandidates(item, library, enough = Infinity) {
  const kind = questionKind(item.question);
  const cls = classOfKind.get(kind) || kind;
  // "What name is given to..." could be anything, so it has no usable class.
  if (cls === 'other' || kind === 'name') {
    return [];
  }
  const shape = shapeOf(item.answer);
  const pair = isPair(item.answer);
  const seen = new Set(acceptedAnswers(item));
  const out = [];
  for (const other of library.byBase.get(baseSlug(item.slug)) || []) {
    const { normalized } = other;
    if (other.cls !== cls || !normalized || seen.has(normalized)
      || other.numeric || other.pair !== pair) {
      continue;
    }
    seen.add(normalized);
    if (enough !== Infinity) {
      out.push({ answer: other.answer, score: 0 });
      if (out.length >= enough) break;
      continue;
    }
    // An answer to the very same kind of question (a president for a
    // president) beats one that only shares the class.
    out.push({ answer: other.answer, score: shapeScore(shape, shapeOf(other.answer)) + (other.kind === kind ? 3 : 0) });
  }
  // Stable order: best shape first, then alphabetical.
  return out
    .sort((a, b) => b.score - a.score || a.answer.localeCompare(b.answer))
    .map((entry) => entry.answer);
}

// Whether a question can be offered as multiple choice at all.
export function hasChoices(item, library) {
  if (Array.isArray(item.choices) && item.choices.length >= 3) return true;
  const numeric = numericChoices(item.answer, seededRandom(0));
  if (numeric && numeric.length === 3) return true;
  return wrongAnswerCandidates(item, library, 3).length >= 3;
}

// Four choices for a question: the answer and three wrong ones. Hand-written
// choices win; numbers get nearby numbers; everything else draws from the
// best-matched same-topic candidates, varied a little from day to day.
export function buildChoices(item, library, random) {
  if (Array.isArray(item.choices) && item.choices.length >= 3) {
    return shuffled([item.answer, ...item.choices.slice(0, 3)], random);
  }
  const numeric = numericChoices(item.answer, random);
  if (numeric && numeric.length === 3) {
    return shuffled([item.answer, ...numeric], random);
  }
  const candidates = wrongAnswerCandidates(item, library);
  const top = shuffled(candidates.slice(0, 6), random).slice(0, 3);
  return shuffled([item.answer, ...top], random);
}

const baseSlug = (slug) => slug.replace(/-\d+$/, '');

// Indexes every answer in the library by topic, for the wrong-answer choices.
export function buildLibrary(quizzes) {
  const byBase = new Map();
  for (const quiz of quizzes) {
    const base = baseSlug(quiz.slug);
    if (!byBase.has(base)) byBase.set(base, []);
    for (const level of ['easy', 'medium', 'hard']) {
      for (const entry of quiz.difficulties?.[level] || []) {
        const kind = questionKind(entry.question);
        // Normalized once here, since every question in the topic compares against it.
        byBase.get(base).push({
          answer: entry.answer,
          kind,
          cls: classOfKind.get(kind) || kind,
          normalized: normalize(entry.answer),
          numeric: looksNumeric(entry.answer),
          pair: isPair(entry.answer),
        });
      }
    }
  }
  return { byBase };
}

// --- Picking a day ---

// Two questions clash when one is shown as the other's lead-in, which would
// give its answer away.
function clashes(a, b) {
  const leadsTo = (x, y) => x.slug === y.slug && x.level === y.level && y.leads.some((lead) => lead.question === x.question);
  return leadsTo(a, b) || leadsTo(b, a);
}

// Picks one day's questions. `used` holds the keys of questions from earlier
// days, which are skipped until the pool for a level runs dry.
export function pickDay(pool, dateKey, used = new Set()) {
  return pickQuestions(pool, dailyLevels, seededRandom(`norhog-daily:${dateKey}`), used);
}

// Picks one question per entry of `levels` (such as easy, easy, medium),
// skipping questions in `used` until a level runs short of fresh ones. Returns
// null when the pool can't fill every slot.
export function pickQuestions(pool, levels, random, used = new Set()) {
  const byLevel = { easy: [], medium: [], hard: [] };
  for (const item of pool) {
    byLevel[item.level].push(item);
  }

  const picks = [];
  const perQuiz = new Map();
  for (const level of levels) {
    const needed = levels.filter((l) => l === level).length;
    const fresh = byLevel[level].filter((item) => !used.has(item.key) && !used.has(item.id));
    const candidates = fresh.length >= needed + 2 ? fresh : byLevel[level];
    const ok = (item) =>
      (perQuiz.get(item.slug) || 0) < maxPerQuiz && !picks.some((pick) => pick === item || clashes(pick, item));

    // Random probes are enough for a large pool, and a full scan backs them up
    // for a small one.
    let choice = null;
    for (let tries = 0; tries < 50 && !choice; tries++) {
      const item = candidates[Math.floor(random() * candidates.length)];
      if (item && ok(item)) choice = item;
    }
    if (!choice) {
      choice = shuffled(candidates, random).find(ok) || null;
    }
    if (!choice) {
      return null;
    }
    picks.push(choice);
    perQuiz.set(choice.slug, (perQuiz.get(choice.slug) || 0) + 1);
  }
  return picks;
}

// The library index and question pool for a set of quizzes. Building them is
// the slow part, so callers that build several days prepare them once.
export function prepare(quizzes) {
  const library = buildLibrary(quizzes);
  return { library, pool: buildPool(quizzes, library) };
}

// A picked question with its choices, in the form days and practice rounds use.
function withChoices(item, library, random) {
  return {
    key: item.key,
    id: item.id,
    slug: item.slug,
    title: item.title,
    level: item.level,
    index: item.index,
    question: item.question,
    answer: item.answer,
    accept: item.accept,
    leads: item.leads,
    choices: buildChoices(item, library, random),
    authoredChoices: Array.isArray(item.choices) && item.choices.length >= 3,
  };
}

// Builds the stored record for one day: the picked questions frozen as they
// were, with their wrong-answer choices, so later quiz edits can't change a
// day that people have already played.
export function buildDay(quizzes, dateKey, used = new Set(), prepared = prepare(quizzes)) {
  const { library, pool } = prepared;
  const picks = pickDay(pool, dateKey, used);
  if (!picks) {
    return null;
  }
  const random = seededRandom(`norhog-choices:${dateKey}`);
  return {
    date: dateKey,
    number: dailyNumber(dateKey),
    questions: picks.map((item) => withChoices(item, library, random)),
  };
}

// --- Practice rounds ---

// How many questions of each difficulty a practice round may ask for.
export const practiceLimits = { perLevel: 10, total: 20 };

// Reads and bounds a practice round's difficulty counts. Returns null when
// they don't add up to a playable round.
export function practiceCounts(body) {
  const counts = {};
  for (const level of ['easy', 'medium', 'hard']) {
    const value = body?.[level];
    if (!Number.isInteger(value) || value < 0 || value > practiceLimits.perLevel) {
      return null;
    }
    counts[level] = value;
  }
  const total = counts.easy + counts.medium + counts.hard;
  return total >= 1 && total <= practiceLimits.total ? counts : null;
}

// A fresh practice round: easy questions first, then medium, then hard.
// Questions in `seen` (ids of ones the player has had before) are avoided
// until a difficulty runs short of new ones. Practice shares the daily's pool.
export function buildPracticeRound(prepared, counts, seen = new Set(), random = Math.random) {
  const levels = ['easy', 'medium', 'hard'].flatMap((level) => Array(counts[level]).fill(level));
  const picks = pickQuestions(prepared.pool, levels, random, seen);
  if (!picks) {
    return null;
  }
  return picks.map((item) => withChoices(item, prepared.library, random));
}

// The day as sent to players.
export function publicDay(day) {
  return {
    date: day.date,
    number: day.number,
    questions: day.questions.map(publicQuestion),
  };
}

// One question as sent to players. Accepted spellings go out already
// normalized, so the page can match a guess without the roman-numeral rules.
export function publicQuestion(q) {
  return {
    id: q.id,
    slug: q.slug,
    title: q.title,
    level: q.level,
    question: q.question,
    answer: q.answer,
    accepted: [...acceptedAnswers(q)],
    leads: q.leads,
    choices: q.choices,
  };
}

// --- Results and streaks ---

// Each question ends one of three ways. Typing the answer is worth 2 points,
// getting it from the choices 1, and missing it 0, for 10 at most.
export const outcomes = { typed: 2, choice: 1, miss: 0 };

// Each result has to be one of the outcome names as a plain string. hasOwn
// alone would accept ["typed"] or an object, since it converts its key to a
// string first.
export function isValidResults(results) {
  return Array.isArray(results)
    && results.length === dailyLevels.length
    && results.every((result) => typeof result === 'string' && Object.hasOwn(outcomes, result));
}

// A YYYY-MM-DD date key, checked whole rather than cut to length.
export function isDateKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function scoreResults(results) {
  return results.reduce((sum, result) => sum + outcomes[result], 0);
}

// The current streak counts back from today, or from yesterday when today
// hasn't been played yet, so a streak isn't shown as broken before the player
// has had the chance to keep it.
export function streakFrom(dates, today) {
  const played = new Set(dates);
  let start = today;
  if (!played.has(today)) {
    start = addDays(today, -1);
  }
  let current = 0;
  while (played.has(addDays(start, -current))) {
    current += 1;
  }

  const sorted = [...played].sort();
  let best = 0;
  let run = 0;
  sorted.forEach((date, i) => {
    run = i > 0 && daysBetween(sorted[i - 1], date) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
  });
  return { current, best, playedToday: played.has(today) };
}
