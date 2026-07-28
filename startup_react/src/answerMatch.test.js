import { describe, it, expect } from 'vitest';
import { normalize } from './answerMatch';

describe('normalize', () => {
  it('lowercases and trims', () => {
    expect(normalize('  Bastille  ')).toBe('bastille');
  });

  it('drops a leading "the" so answers match either way', () => {
    expect(normalize('The Bastille')).toBe('bastille');
    expect(normalize('the treaty of paris')).toBe('treaty of paris');
  });

  it('keeps "the" when it is not the leading word', () => {
    expect(normalize('Ivan the Terrible')).toBe('ivan the terrible');
  });

  it('strips accents so unaccented typing still matches', () => {
    expect(normalize('Vendée')).toBe('vendee');
  });

  it('strips apostrophes rather than turning them into spaces', () => {
    expect(normalize("The People's Will")).toBe('peoples will');
    expect(normalize('Peoples Will')).toBe('peoples will');
  });

  it('collapses punctuation to single spaces', () => {
    expect(normalize('Plessy v. Ferguson')).toBe('plessy v ferguson');
    expect(normalize('Jean-Paul Marat')).toBe('jean paul marat');
    expect(normalize('J.P. Morgan')).toBe('j p morgan');
  });

  it('preserves digits for year answers', () => {
    expect(normalize('1789')).toBe('1789');
  });

  it('returns an empty string for input with nothing usable', () => {
    expect(normalize('   ')).toBe('');
    expect(normalize('!!!')).toBe('');
  });
});
