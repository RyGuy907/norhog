import { describe, it, expect } from 'vitest';
import { normalize, acceptedAnswers } from './answerMatch.js';

describe('acceptedAnswers', () => {
  const accepts = (entry, guess) => acceptedAnswers(entry).has(normalize(guess));

  it('accepts the answer itself', () => {
    expect(accepts({ answer: 'Bastille' }, 'Bastille')).toBe(true);
  });

  it('ignores case, punctuation, and a leading "the"', () => {
    const entry = { answer: 'The Treaty of Paris' };
    expect(accepts(entry, 'treaty of paris')).toBe(true);
    expect(accepts(entry, 'The Treaty of Paris')).toBe(true);
  });

  it('accepts listed shortcuts such as last names', () => {
    const entry = { answer: 'George Washington', accept: ['Washington'] };
    expect(accepts(entry, 'washington')).toBe(true);
    expect(accepts(entry, 'George Washington')).toBe(true);
  });

  it('converts roman numerals to arabic', () => {
    const entry = { answer: 'Louis XVI' };
    expect(accepts(entry, 'louis xvi')).toBe(true);
    expect(accepts(entry, 'louis 16')).toBe(true);
  });

  it('handles roman numerals inside accept entries too', () => {
    const entry = { answer: 'Ivan the Terrible', accept: ['Ivan IV'] };
    expect(accepts(entry, 'ivan 4')).toBe(true);
  });

  it('does not treat roman-lettered words as numerals unless they are valid', () => {
    // "civic" is all roman-numeral letters but not a valid numeral spelling,
    // so it must not gain a numeric variant.
    expect([...acceptedAnswers({ answer: 'Civic' })]).toEqual(['civic']);
  });

  it('does expand words that really are valid numerals', () => {
    // "MIX" really is 1009, so both spellings are accepted. This is expected
    // behavior, not a bug in the round-trip check.
    expect([...acceptedAnswers({ answer: 'Mix' })]).toEqual(['mix', '1009']);
  });

  it('rejects a wrong guess', () => {
    expect(accepts({ answer: 'Bastille' }, 'Versailles')).toBe(false);
  });

  it('ignores empty accept entries', () => {
    const variants = acceptedAnswers({ answer: 'Debt', accept: ['', '  '] });
    expect([...variants]).toEqual(['debt']);
  });
});
