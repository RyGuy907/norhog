import { describe, it, expect } from 'vitest';
import { markRow, scoreOf, shareText } from './dailyShare';

describe('daily share', () => {
  it('scores typed answers above picked ones', () => {
    expect(scoreOf(['typed', 'typed', 'typed', 'typed', 'typed'])).toBe(10);
    expect(scoreOf(['typed', 'choice', 'miss', 'choice', 'typed'])).toBe(6);
  });

  it('spaces every mark apart', () => {
    expect(markRow(['typed', 'choice', 'typed', 'miss', 'typed'])).toBe('✓ / ✓ ✗ ✓');
    expect(markRow(['choice', 'choice', 'choice', 'choice', 'typed'])).toBe('/ / / / ✓');
  });

  it('builds the share text with the streak only once it is going', () => {
    const results = ['typed', 'typed', 'choice', 'typed', 'miss'];
    expect(shareText({ number: 12, results, streak: 1, url: 'https://norhog.com/daily' })).toBe(
      'Norhog Daily #12\n✓ ✓ / ✓ ✗\n7/10\nhttps://norhog.com/daily'
    );
    expect(shareText({ number: 12, results, streak: 4 })).toContain('7/10 · 4-day streak');
  });
});
