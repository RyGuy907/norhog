import { describe, it, expect } from 'vitest';
import { sanitizeRequest, asString, rateLimit } from './security.js';

const runMiddleware = (middleware, req) => {
  let called = false;
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
  };
  middleware(req, res, () => {
    called = true;
  });
  return { nextCalled: called, res };
};

describe('sanitizeRequest', () => {
  it('strips MongoDB operator keys from the body', () => {
    const req = { body: { email: { $gt: '' }, password: 'x' } };
    runMiddleware(sanitizeRequest, req);
    expect(req.body.email).toEqual({});
    expect(req.body.password).toBe('x');
  });

  it('strips operator keys from cookies (the j: cookie-parser vector)', () => {
    const req = { body: {}, cookies: { token: { $ne: null } } };
    runMiddleware(sanitizeRequest, req);
    expect(req.cookies.token).toEqual({});
  });

  it('strips prototype-polluting keys', () => {
    const req = { body: { __proto__: { confirm: true }, constructor: 'x', ok: 1 } };
    runMiddleware(sanitizeRequest, req);
    expect(req.body.confirm).toBeUndefined();
    expect(req.body.ok).toBe(1);
  });

  it('strips dotted keys used for nested field injection', () => {
    const req = { body: { 'user.role': 'admin', name: 'ok' } };
    runMiddleware(sanitizeRequest, req);
    expect(req.body['user.role']).toBeUndefined();
    expect(req.body.name).toBe('ok');
  });

  it('scrubs inside arrays and nested objects', () => {
    const req = { body: { list: [{ $gt: 1, keep: 2 }], deep: { inner: { $ne: 3, keep: 4 } } } };
    runMiddleware(sanitizeRequest, req);
    expect(req.body.list[0]).toEqual({ keep: 2 });
    expect(req.body.deep.inner).toEqual({ keep: 4 });
  });

  it('leaves ordinary values untouched and calls next', () => {
    const req = { body: { email: 'a@b.co', score: 7, flag: true, nothing: null } };
    const { nextCalled } = runMiddleware(sanitizeRequest, req);
    expect(req.body).toEqual({ email: 'a@b.co', score: 7, flag: true, nothing: null });
    expect(nextCalled).toBe(true);
  });
});

describe('asString', () => {
  it('returns trimmed strings', () => {
    expect(asString('  hello  ')).toBe('hello');
  });

  it('rejects non-strings rather than throwing', () => {
    expect(asString({ $gt: '' })).toBeNull();
    expect(asString(42)).toBeNull();
    expect(asString(null)).toBeNull();
    expect(asString(undefined)).toBeNull();
    expect(asString(['a'])).toBeNull();
  });

  it('caps length before trimming', () => {
    expect(asString('abcdefghij', 4)).toBe('abcd');
  });
});

describe('rateLimit', () => {
  it('allows requests up to the limit, then returns 429', () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 2 });
    const req = { ip: '1.2.3.4', baseUrl: '/api', path: '/login' };

    expect(runMiddleware(limiter, req).nextCalled).toBe(true);
    expect(runMiddleware(limiter, req).nextCalled).toBe(true);

    const third = runMiddleware(limiter, req);
    expect(third.nextCalled).toBe(false);
    expect(third.res.statusCode).toBe(429);
  });

  it('tracks callers separately by IP', () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 1 });
    const first = { ip: '1.1.1.1', baseUrl: '/api', path: '/login' };
    const second = { ip: '2.2.2.2', baseUrl: '/api', path: '/login' };

    runMiddleware(limiter, first);
    expect(runMiddleware(limiter, first).res.statusCode).toBe(429);
    expect(runMiddleware(limiter, second).nextCalled).toBe(true);
  });

  it('shares one counter across case and trailing-slash variants of a path', () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 1 });
    runMiddleware(limiter, { ip: '1.2.3.4', baseUrl: '/api', path: '/login' });

    for (const variant of [
      { baseUrl: '/api', path: '/LOGIN' },
      { baseUrl: '/API', path: '/Login/' },
    ]) {
      expect(runMiddleware(limiter, { ip: '1.2.3.4', ...variant }).res.statusCode).toBe(429);
    }
  });
});
