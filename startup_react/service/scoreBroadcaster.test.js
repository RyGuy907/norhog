import { describe, it, expect } from 'vitest';
import { sameOrigin } from './scoreBroadcaster.js';

const upgrade = (headers) => ({ headers: { host: 'norhog.com', ...headers } });

describe('sameOrigin', () => {
  it('accepts a page on the same host', () => {
    expect(sameOrigin(upgrade({ origin: 'https://norhog.com' }))).toBe(true);
  });

  it('accepts the Vite dev proxy, which keeps the original host', () => {
    expect(sameOrigin({ headers: { host: 'localhost:5173', origin: 'http://localhost:5173' } })).toBe(true);
  });

  it('rejects a page on another site', () => {
    expect(sameOrigin(upgrade({ origin: 'https://evil.example' }))).toBe(false);
  });

  it('rejects a malformed origin', () => {
    expect(sameOrigin(upgrade({ origin: 'not a url' }))).toBe(false);
  });

  it('allows clients that send no origin', () => {
    expect(sameOrigin(upgrade({}))).toBe(true);
  });
});
