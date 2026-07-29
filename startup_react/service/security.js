// Request hardening: input sanitization, type-safe field readers, and
// simple in-memory rate limiting.

// MongoDB treats object values like {$ne: null} as query operators. JSON
// bodies and Express's extended query parser can both produce objects where
// a string is expected, so strip operator-ish keys before anything reaches
// the database.
const blockedKeys = new Set(['__proto__', 'constructor', 'prototype']);

function scrub(value, depth = 0) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  // Drop anything absurdly deep rather than passing it through unscrubbed.
  if (depth > 20) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => scrub(entry, depth + 1));
  }
  // Null-prototype target so a "__proto__" key can't re-parent the object.
  const clean = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (key.startsWith('$') || key.includes('.') || blockedKeys.has(key)) {
      continue;
    }
    clean[key] = scrub(entry, depth + 1);
  }
  return Object.assign({}, clean);
}

export function sanitizeRequest(req, _res, next) {
  if (req.body) {
    req.body = scrub(req.body);
  }
  // cookie-parser turns a `j:`-prefixed cookie into a parsed object, so
  // cookies are an injection vector too.
  if (req.cookies) {
    req.cookies = scrub(req.cookies);
  }
  if (req.signedCookies) {
    req.signedCookies = scrub(req.signedCookies);
  }
  if (req.query) {
    // req.query is a getter in Express 5 / read-only in some setups.
    const cleaned = scrub(req.query);
    for (const key of Object.keys(req.query)) {
      delete req.query[key];
    }
    Object.assign(req.query, cleaned);
  }
  if (req.params) {
    req.params = scrub(req.params);
  }
  next();
}

// Returns the trimmed string, or null when the value isn't a plain string.
// Guards every route against type-confusion crashes (a non-string reaching
// .trim() used to take the whole process down).
export function asString(value, maxLength = 1000) {
  if (typeof value !== 'string') {
    return null;
  }
  return value.slice(0, maxLength).trim();
}

// Wraps an async route handler so a rejected promise becomes a 500 response
// instead of an unhandled rejection that kills the process.
export function route(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// Fixed-window rate limiter, per IP + route key. In-memory is fine for a
// single-instance deployment.
export function rateLimit({ windowMs, max, message }) {
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.expires <= now) {
        hits.delete(key);
      }
    }
  }, windowMs).unref();

  const middleware = (req, res, next) => {
    const key = `${req.ip}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.expires <= now) {
      hits.set(key, { count: 1, expires: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).send({ msg: message || 'Too many requests, please try again later' });
    }
    next();
  };

  // The counters are module-level and outlive a single test. A suite that shares
  // one app instance therefore leaks limiter state between cases, so adding an
  // auth test can push an unrelated one over the limit. Nothing in the running
  // service calls this.
  middleware.reset = () => hits.clear();

  return middleware;
}
