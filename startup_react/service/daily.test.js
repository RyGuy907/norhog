import { describe, it, expect } from 'vitest';
import {
  addDays,
  buildChoices,
  buildDay,
  buildLibrary,
  buildPool,
  dailyDate,
  dailyNumber,
  dailyEpoch,
  buildPracticeRound,
  isInGracePeriod,
  isValidResults,
  nextResetAt,
  practiceCounts,
  prepare,
  pickDay,
  publicDay,
  questionKind,
  scoreResults,
  seededRandom,
  streakFrom,
} from './daily.js';

// A small library: each quiz has enough questions per level for the picker,
// and the first quiz has a chained pair and an excluded question.
// Answers are years, which always have multiple-choice options.
let nextYear = 1000;
function makeQuiz(slug, n = 4) {
  const level = (name) =>
    Array.from({ length: n }, (_, i) => ({
      question: `In which year did ${slug} ${name} event ${i} happen?`,
      answer: String(nextYear++),
      accept: [],
    }));
  return { slug, title: slug.toUpperCase(), difficulties: { easy: level('easy'), medium: level('medium'), hard: level('hard') } };
}

function library() {
  const quizzes = ['alpha', 'beta', 'gamma', 'delta'].map((slug) => makeQuiz(slug));
  quizzes[0].difficulties.easy[1].followsPrevious = true;
  quizzes[0].difficulties.easy[2].daily = false;
  return quizzes;
}

describe('daily dates', () => {
  it('uses the Pacific calendar date', () => {
    // 06:59 UTC on 23 September is still 22 September in Los Angeles (PDT).
    expect(dailyDate(new Date('2026-09-23T06:59:00Z'))).toBe('2026-09-22');
    expect(dailyDate(new Date('2026-09-23T07:00:00Z'))).toBe('2026-09-23');
    // In winter the offset is eight hours.
    expect(dailyDate(new Date('2026-12-02T07:59:00Z'))).toBe('2026-12-01');
    expect(dailyDate(new Date('2026-12-02T08:00:00Z'))).toBe('2026-12-02');
  });

  it('finds the next Pacific midnight in both daylight and standard time', () => {
    expect(new Date(nextResetAt(new Date('2026-09-22T20:00:00Z'))).toISOString()).toBe('2026-09-23T07:00:00.000Z');
    expect(new Date(nextResetAt(new Date('2026-12-01T20:00:00Z'))).toISOString()).toBe('2026-12-02T08:00:00.000Z');
    // The day the clocks go back: midnight on 1 November is still PDT.
    expect(new Date(nextResetAt(new Date('2026-10-31T20:00:00Z'))).toISOString()).toBe('2026-11-01T07:00:00.000Z');
  });

  it('allows yesterday for an hour after midnight, in both daylight and standard time', () => {
    expect(isInGracePeriod('2026-09-22', new Date('2026-09-23T07:59:00Z'))).toBe(true);
    expect(isInGracePeriod('2026-09-22', new Date('2026-09-23T08:01:00Z'))).toBe(false);
    expect(isInGracePeriod('2026-12-01', new Date('2026-12-02T08:30:00Z'))).toBe(true);
    expect(isInGracePeriod('2026-12-01', new Date('2026-12-02T09:01:00Z'))).toBe(false);
    // Today, older days, and junk are never "in grace".
    expect(isInGracePeriod('2026-09-23', new Date('2026-09-23T07:20:00Z'))).toBe(false);
    expect(isInGracePeriod('2026-09-20', new Date('2026-09-23T07:20:00Z'))).toBe(false);
    expect(isInGracePeriod(null, new Date('2026-09-23T07:20:00Z'))).toBe(false);
  });

  it('numbers days from the epoch', () => {
    expect(dailyNumber(dailyEpoch)).toBe(1);
    expect(dailyNumber(addDays(dailyEpoch, 9))).toBe(10);
  });
});

describe('daily pool', () => {
  it('skips excluded questions and attaches lead-ins', () => {
    const pool = buildPool(library());
    const alphaEasy = pool.filter((item) => item.slug === 'alpha' && item.level === 'easy');
    expect(alphaEasy.map((item) => item.index)).toEqual([0, 1, 3]);
    const chained = alphaEasy.find((item) => item.index === 1);
    const first = alphaEasy.find((item) => item.index === 0);
    expect(chained.leads).toEqual([{ question: first.question, answer: first.answer }]);
  });

  it('drops a question whose chain of lead-ins is too deep', () => {
    const quizzes = library();
    const easy = quizzes[1].difficulties.easy;
    easy[1].followsPrevious = true;
    easy[2].followsPrevious = true;
    easy[3].followsPrevious = true;
    const pool = buildPool(quizzes).filter((item) => item.slug === 'beta' && item.level === 'easy');
    expect(pool.map((item) => item.index)).toEqual([0, 1, 2]);
    expect(pool[2].leads).toHaveLength(2);
  });
});

describe('picking a day', () => {
  it('picks three easy, one medium and one hard question', () => {
    const picks = pickDay(buildPool(library()), '2026-09-22');
    expect(picks.map((item) => item.level)).toEqual(['easy', 'easy', 'easy', 'medium', 'hard']);
  });

  it('gives the same questions for the same date and different ones for another', () => {
    const pool = buildPool(library());
    const keys = (date) => pickDay(pool, date).map((item) => item.key);
    expect(keys('2026-09-22')).toEqual(keys('2026-09-22'));
    const differs = ['2026-09-23', '2026-09-24', '2026-09-25'].some(
      (date) => keys(date).join() !== keys('2026-09-22').join()
    );
    expect(differs).toBe(true);
  });

  it('takes at most two questions from one quiz', () => {
    const pool = buildPool(library());
    for (let i = 0; i < 30; i++) {
      const picks = pickDay(pool, addDays('2026-09-22', i));
      const counts = {};
      picks.forEach((item) => (counts[item.slug] = (counts[item.slug] || 0) + 1));
      expect(Math.max(...Object.values(counts))).toBeLessThanOrEqual(2);
    }
  });

  it('never pairs a question with its own lead-in', () => {
    const pool = buildPool(library());
    for (let i = 0; i < 60; i++) {
      const picks = pickDay(pool, addDays('2026-09-22', i));
      const chained = picks.find((item) => item.slug === 'alpha' && item.level === 'easy' && item.index === 1);
      if (chained) {
        expect(picks.some((item) => item.slug === 'alpha' && item.level === 'easy' && item.index === 0)).toBe(false);
      }
    }
  });

  it('avoids questions used on earlier days', () => {
    const quizzes = library();
    const first = buildDay(quizzes, '2026-09-22');
    const used = new Set(first.questions.map((q) => q.key));
    const second = buildDay(quizzes, '2026-09-23', used);
    expect(second.questions.some((q) => used.has(q.key))).toBe(false);
  });

  it('returns null when the library is too small', () => {
    expect(buildDay([makeQuiz('solo', 1)], '2026-09-22')).toBeNull();
  });
});

describe('choices', () => {
  it('always includes the right answer and three distinct wrong ones', () => {
    const day = buildDay(library(), '2026-09-22');
    for (const q of day.questions) {
      expect(q.choices).toHaveLength(4);
      expect(q.choices).toContain(q.answer);
      expect(new Set(q.choices).size).toBe(4);
    }
  });

  it('offers nearby years for a year answer, in the same style', () => {
    const lib = buildLibrary([]);
    const choices = buildChoices({ slug: 'x', question: 'When?', answer: '480 BC', accept: [] }, lib, seededRandom(1));
    expect(choices).toContain('480 BC');
    expect(choices.every((c) => /^\d+ BC$/.test(c))).toBe(true);
    expect(new Set(choices).size).toBe(4);
  });

  it('leaves out questions with no believable wrong answers', () => {
    const quiz = {
      slug: 'odd',
      title: 'Odd',
      difficulties: {
        easy: [
          { question: 'Which two phonetic letters named the checkpoints?', answer: 'Alpha and Bravo', accept: [] },
          { question: 'Which city was the capital?', answer: 'Bonn', accept: [] },
          { question: 'Which letter was sent?', answer: 'The Zimmermann Telegram', accept: [] },
        ],
      },
    };
    expect(buildPool([quiz])).toHaveLength(0);
  });

  it('draws wrong answers from the same topic and class of thing', () => {
    const quiz = {
      slug: 'cities',
      title: 'Cities',
      difficulties: {
        easy: [
          { question: 'Which city was the capital?', answer: 'Bonn', accept: [] },
          { question: 'Which port grew rich on trade?', answer: 'Hamburg', accept: [] },
          { question: 'Which town hosted the treaty?', answer: 'Potsdam', accept: [] },
          { question: 'In which city was the wall built?', answer: 'Berlin', accept: [] },
          { question: 'Which king ruled?', answer: 'Frederick the Great', accept: [] },
        ],
      },
    };
    const lib = buildLibrary([quiz]);
    const choices = buildChoices({ slug: 'cities', ...quiz.difficulties.easy[0] }, lib, seededRandom(5));
    expect([...choices].sort()).toEqual(['Berlin', 'Bonn', 'Hamburg', 'Potsdam']);
  });

  it('never offers an accepted spelling of the answer as a wrong choice', () => {
    const quiz = {
      slug: 'kings',
      title: 'Kings',
      difficulties: {
        easy: [
          { question: 'Which king lost at Hastings?', answer: 'Harold Godwinson', accept: ['Harold'] },
          { question: 'Which king won at Hastings?', answer: 'William the Conqueror', accept: [] },
          { question: 'Which king signed Magna Carta?', answer: 'King John', accept: [] },
          { question: 'Which king was called Harold?', answer: 'Harold', accept: [] },
          { question: 'Which king built the Tower?', answer: 'William I', accept: [] },
          { question: 'Which king lost Normandy?', answer: 'King Stephen', accept: [] },
        ],
      },
    };
    const lib = buildLibrary([quiz]);
    const choices = buildChoices({ slug: 'kings', ...quiz.difficulties.easy[0] }, lib, seededRandom(7));
    expect(choices).not.toContain('Harold');
  });

  it('uses authored choices when a question has them', () => {
    const choices = buildChoices(
      { slug: 'x', question: 'Q?', answer: 'Right', accept: [], choices: ['A', 'B', 'C'] },
      buildLibrary([]),
      seededRandom(3)
    );
    expect([...choices].sort()).toEqual(['A', 'B', 'C', 'Right']);
  });

  it('reads the kind of thing a question asks for', () => {
    expect(questionKind('Who was his queen?')).toBe('person');
    expect(questionKind('Which 1805 sea battle destroyed his fleet?')).toBe('battle');
    expect(questionKind('In which city did the revolution begin?')).toBe('city');
    expect(questionKind('Which British general died winning that battle?')).toBe('general');
    expect(questionKind("Which famous scientist's letter urged the president to act?")).toBe('scientist');
    expect(questionKind("What was Germany's lightning war tactic called?")).toBe('tactic');
    expect(questionKind('What is the back end of a ship called?')).toBe('end');
  });
});

describe('public day', () => {
  it('sends normalized accepted spellings, including numeral variants', () => {
    const day = {
      date: '2026-09-22',
      number: 1,
      questions: [{ key: 'k', slug: 's', title: 'T', level: 'easy', index: 0, question: 'Q?', answer: 'Louis XVI', accept: ['Louis'], leads: [], choices: [] }],
    };
    const [q] = publicDay(day).questions;
    expect(q.accepted).toEqual(expect.arrayContaining(['louis xvi', 'louis 16', 'louis']));
    expect(q.key).toBeUndefined();
  });
});

describe('results and streaks', () => {
  it('validates and scores results', () => {
    expect(isValidResults(['typed', 'typed', 'choice', 'miss', 'typed'])).toBe(true);
    expect(isValidResults(['typed', 'typed'])).toBe(false);
    expect(isValidResults(['typed', 'typed', 'choice', 'miss', 'cheat'])).toBe(false);
    // Values that only look like outcomes once converted to strings.
    expect(isValidResults([['typed'], 'typed', 'typed', 'typed', 'typed'])).toBe(false);
    expect(isValidResults([{ toString: 'typed' }, 'typed', 'typed', 'typed', 'typed'])).toBe(false);
    expect(isValidResults(['typed', 'typed', 'typed', 'typed', '__proto__'])).toBe(false);
    expect(scoreResults(['typed', 'typed', 'choice', 'miss', 'typed'])).toBe(7);
  });

  it('keeps a streak alive until the end of today', () => {
    expect(streakFrom(['2026-09-20', '2026-09-21'], '2026-09-22')).toEqual({ current: 2, best: 2, playedToday: false });
    expect(streakFrom(['2026-09-20', '2026-09-21', '2026-09-22'], '2026-09-22').current).toBe(3);
    expect(streakFrom(['2026-09-19', '2026-09-20'], '2026-09-22').current).toBe(0);
  });

  it('tracks the best run', () => {
    const dates = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-10', '2026-09-22'];
    expect(streakFrom(dates, '2026-09-22')).toEqual({ current: 1, best: 3, playedToday: true });
  });
});

describe('practice rounds', () => {
  it('accepts 1 to 20 questions with at most 10 per difficulty', () => {
    expect(practiceCounts({ easy: 3, medium: 1, hard: 1 })).toEqual({ easy: 3, medium: 1, hard: 1 });
    expect(practiceCounts({ easy: 0, medium: 0, hard: 1 })).toEqual({ easy: 0, medium: 0, hard: 1 });
    expect(practiceCounts({ easy: 0, medium: 0, hard: 0 })).toBeNull();
    expect(practiceCounts({ easy: 11, medium: 0, hard: 0 })).toBeNull();
    expect(practiceCounts({ easy: 10, medium: 10, hard: 1 })).toBeNull();
    expect(practiceCounts({ easy: '3', medium: 1, hard: 1 })).toBeNull();
    expect(practiceCounts(null)).toBeNull();
  });

  it('builds a round in difficulty order with the requested counts', () => {
    const round = buildPracticeRound(prepare(library()), { easy: 2, medium: 0, hard: 3 }, new Set(), seededRandom(9));
    expect(round.map((q) => q.level)).toEqual(['easy', 'easy', 'hard', 'hard', 'hard']);
    expect(round.every((q) => q.id && q.choices.length === 4 && q.choices.includes(q.answer))).toBe(true);
  });

  it('avoids questions already seen while there are new ones', () => {
    const prepared = prepare(library());
    const easy = prepared.pool.filter((item) => item.level === 'easy');
    const seen = new Set(easy.slice(0, easy.length - 5).map((item) => item.id));
    const round = buildPracticeRound(prepared, { easy: 3, medium: 0, hard: 0 }, seen, seededRandom(4));
    expect(round.some((q) => seen.has(q.id))).toBe(false);
  });
});
