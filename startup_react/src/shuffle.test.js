import { describe, it, expect } from 'vitest';
import { shuffle } from './shuffle';

describe('shuffle', () => {
  it('does not mutate the original array', () => {
    const original = [1, 2, 3, 4, 5];
    const copy = [...original];
    shuffle(original);
    expect(original).toEqual(copy);
  });

  it('keeps every element exactly once', () => {
    const input = ['a', 'b', 'c', 'd', 'e'];
    expect(shuffle(input).sort()).toEqual([...input].sort());
  });

  it('handles empty and single-item arrays', () => {
    expect(shuffle([])).toEqual([]);
    expect(shuffle(['only'])).toEqual(['only']);
  });

  it('actually reorders over repeated runs', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const reordered = Array.from({ length: 20 }, () => shuffle(input)).some(
      (result) => result.join() !== input.join()
    );
    expect(reordered).toBe(true);
  });
});
