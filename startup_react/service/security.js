// Request hardening: input sanitization, type-checked field readers, and
// simple in-memory rate limiting.

// MongoDB treats object values like {$ne: null} as query operators. JSON
// bodies and Express's query parser can both produce objects where a string
// is expected, so operator-like keys are removed before anything reaches the
// database.
const blockedKeys = new Set(['__proto__', 'constructor', 'prototype']);

function scrub(value, depth = 0) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  // Very deep input is dropped instead of being passed through unscrubbed.
  if (depth > 20) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => scrub(entry, depth + 1));
  }
  // A null-prototype target means a "__proto__" key can't change the object's prototype.
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
  // cookie-parser turns a `j:`-prefixed cookie into a parsed object, so cookies
  // need scrubbing too.
  if (req.cookies) {
    req.cookies = scrub(req.cookies);
  }
  if (req.signedCookies) {
    req.signedCookies = scrub(req.signedCookies);
  }
  if (req.query) {
    // req.query is a getter in Express 5 and can't be reassigned, so its keys
    // are replaced in place.
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

// Returns the trimmed string, or null when the value isn't a string. Routes use
// it for every text field so an object or number can't crash a handler that
// expects to call string methods.
export function asString(value, maxLength = 1000) {
  if (typeof value !== 'string') {
    return null;
  }
  return value.slice(0, maxLength).trim();
}

// Wraps an async route handler so a rejected promise becomes a 500 response
// instead of an unhandled rejection.
export function route(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// Express matches routes regardless of case or a trailing slash, so the key
// uses the matched route pattern, lowercased and without a trailing slash.
// Keying on the raw path would give /api/auth/LOGIN its own fresh counter.
function routeKey(req) {
  return `${req.baseUrl}${req.route?.path ?? req.path}`.toLowerCase().replace(/\/+$/, '');
}

// Fixed-window rate limiter keyed by IP and route. Keeping the counts in memory
// works because the service runs as a single instance.
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
    const key = `${req.ip}:${routeKey(req)}`;
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

  // Clears the counters between tests. A suite that shares one app instance
  // would otherwise carry limiter state from one case into the next. The
  // running service never calls it.
  middleware.reset = () => hits.clear();

  return middleware;
}
