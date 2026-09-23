import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

// Integration tests that run the real Express app and middleware (sanitization,
// rate limiting, auth, and validation). Only the database is replaced, with an
// in-memory stand-in, so the tests never touch Atlas.
const store = vi.hoisted(() => ({
  users: [],
  quizzes: [],
  scores: [],
  suggestions: [],
  daily: [],
  dailyPlays: [],
  // Records every key the routes pass to the data layer, so tests can check that
  // operator objects never get that far.
  keysSeen: [],
}));

vi.mock('./database.js', () => {
  // Matches the asKey guard in database.js. A non-string lookup returns nothing,
  // since a null token would otherwise match every logged-out user.
  const key = (value) => {
    store.keysSeen.push(value);
    return typeof value === 'string' && value !== '' ? value : null;
  };
  const findBy = (field, value) => {
    const k = key(value);
    return k ? store.users.find((u) => u[field] === k) || null : null;
  };
  // Shared by the site-wide and per-user boards, matching the real pipeline.
  const rankByPlays = (scores, limit) => {
    const counts = new Map();
    for (const s of scores) counts.set(s.quiz, (counts.get(s.quiz) || 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([slug, plays]) => {
        const quiz = store.quizzes.find((q) => q.slug === slug);
        return quiz ? { slug, plays, title: quiz.title, image: quiz.image } : null;
      })
      .filter(Boolean);
  };
  return {
    getUser: async (email) => findBy('email', email),
    getUserByName: async (name) => findBy('nameLower', name),
    getUserByToken: async (token) => findBy('token', token),
    addUser: async (user) => void store.users.push(user),
    updateUser: async (user) => {
      const found = store.users.find((u) => u.email === user.email);
      if (found) Object.assign(found, { token: user.token, tokenIssuedAt: user.tokenIssuedAt ?? null });
    },
    deleteUser: async (email) => {
      store.users = store.users.filter((u) => u.email !== email);
      store.scores = store.scores.filter((s) => s.user !== email);
    },
    addScore: async (score) => void store.scores.push(score),
    getQuizTimes: async () => [],
    getUserTotals: async () => [],
    getQuizBestPoints: async () => 0,
    getUserBest: async () => null,
    getUserBestTime: async () => null,
    getUserScores: async () => [],
    deleteScoresForQuiz: async (quiz) => {
      const k = key(quiz);
      store.scores = store.scores.filter((s) => s.quiz !== k);
    },
    // Matches the real aggregation, which counts score documents per quiz, joins
    // the quiz's display fields, and drops scores whose quiz no longer exists.
    getPopularQuizzes: async (limit = 5) => rankByPlays(store.scores, limit),
    getUserFavoriteQuizzes: async (user, limit = 4) => {
      const k = key(user);
      return k ? rankByPlays(store.scores.filter((s) => s.user === k), limit) : [];
    },
    getSuggestions: async () => store.suggestions,
    addSuggestion: async (s) => void store.suggestions.push(s),
    deleteSuggestion: async (id) => {
      store.suggestions = store.suggestions.filter((s) => s.slug !== id);
    },
    getQuizzes: async () => store.quizzes.map(({ slug, title, image, description }) => ({ slug, title, image, description })),
    getQuiz: async (slug) => {
      const k = key(slug);
      return k ? store.quizzes.find((q) => q.slug === k) || null : null;
    },
    addQuiz: async (quiz) => void store.quizzes.push(quiz),
    updateQuiz: async (slug, quiz) => {
      const i = store.quizzes.findIndex((q) => q.slug === key(slug));
      if (i !== -1) store.quizzes[i] = quiz;
    },
    deleteQuiz: async (slug) => {
      store.quizzes = store.quizzes.filter((q) => q.slug !== key(slug));
    },
    getQuizzesForDaily: async () => structuredClone(store.quizzes),
    setQuestionDaily: async (slug, level, index, question, allowed) => {
      const entry = store.quizzes.find((q) => q.slug === key(slug))?.difficulties?.[level]?.[index];
      if (!entry || entry.question !== question) return false;
      if (allowed) delete entry.daily;
      else entry.daily = false;
      return true;
    },
    setQuestionChoices: async (slug, level, index, question, choices) => {
      const entry = store.quizzes.find((q) => q.slug === key(slug))?.difficulties?.[level]?.[index];
      if (!entry || entry.question !== question) return false;
      if (choices) entry.choices = choices;
      else delete entry.choices;
      return true;
    },
    getDaily: async (date) => structuredClone(store.daily.find((d) => d.date === key(date)) || null),
    getUsedDailyKeys: async (before) =>
      new Set(store.daily.filter((d) => d.date < before).flatMap((d) => d.questions.map((q) => q.key))),
    addDaily: async (day) => {
      const existing = store.daily.find((d) => d.date === day.date);
      if (existing) return structuredClone(existing);
      store.daily.push(structuredClone(day));
      return day;
    },
    getDailyPlay: async (user, date) => {
      const play = store.dailyPlays.find((p) => p.user === key(user) && p.date === key(date));
      if (!play) return null;
      const rest = { ...play };
      delete rest.user;
      return rest;
    },
    addDailyPlay: async (play) => {
      if (store.dailyPlays.some((p) => p.user === play.user && p.date === play.date)) return false;
      store.dailyPlays.push(play);
      return true;
    },
    getDailyPlayDates: async (user) => store.dailyPlays.filter((p) => p.user === key(user)).map((p) => p.date),
  };
});

const { app, resetRateLimits, resetDailyCache } = await import('./index.js');
const Daily = await import('./daily.js');

const testQuiz = {
  slug: 'test-quiz',
  title: 'Test Quiz',
  image: '',
  description: 'A quiz for tests',
  instructions: '',
  timeLimits: { easy: 120, medium: 180, hard: 240 },
  difficulties: {
    easy: [
      { question: 'Capital of France?', answer: 'Paris', accept: [] },
      { question: 'Largest ocean?', answer: 'Pacific', accept: [] },
    ],
    medium: [{ question: 'Medium q', answer: 'Medium a', accept: [] }],
    hard: [{ question: 'Hard q', answer: 'Hard a', accept: [] }],
  },
};

const credentials = { email: 'player@example.com', password: 'testpassword123', displayName: 'Player One' };

beforeEach(() => {
  // The rate limiters keep counters for the whole process. Without this, earlier
  // registrations can push a later test over the limit and fail it for an
  // unrelated reason.
  resetRateLimits();
  store.users = [];
  store.quizzes = [structuredClone(testQuiz)];
  store.scores = [];
  store.suggestions = [];
  store.daily = [];
  store.dailyPlays = [];
  store.keysSeen = [];
  resetDailyCache();
});

// Registers a user and returns an agent carrying their session cookie.
async function signedInAgent(overrides = {}) {
  const agent = request.agent(app);
  await agent.post('/api/auth/create').send({ ...credentials, ...overrides }).expect(201);
  return agent;
}

describe('quiz endpoints', () => {
  it('lists quizzes', async () => {
    const res = await request(app).get('/api/quizzes').expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].slug).toBe('test-quiz');
  });

  it('never sends answers in the public quiz payload', async () => {
    const res = await request(app).get('/api/quiz/test-quiz').expect(200);
    const entries = Object.values(res.body.difficulties).flat();
    expect(entries.every((e) => e.answer === undefined && e.accept === undefined)).toBe(true);
    expect(entries.every((e) => Array.isArray(e.locks))).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('Paris');
  });

  it('404s an unknown quiz', async () => {
    await request(app).get('/api/quiz/does-not-exist').expect(404);
  });

  it('requires admin for the full quiz including answers', async () => {
    await request(app).get('/api/quiz/test-quiz/full').expect(401);
    const agent = await signedInAgent();
    await agent.get('/api/quiz/test-quiz/full').expect(403);
  });

  it('returns a JSON 404 for unknown API routes', async () => {
    const res = await request(app).get('/api/not-a-real-route').expect(404);
    expect(res.body.msg).toBe('Not found');
  });

  it('sends basic security headers', async () => {
    const res = await request(app).get('/api/quizzes').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('session and rate limit hardening', () => {
  it('rejects a session token older than seven days', async () => {
    const agent = await signedInAgent();
    await agent.get('/api/auth/me').expect(200);

    store.users[0].tokenIssuedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await agent.get('/api/auth/me').expect(401);
  });

  it('rejects a token with no issue time', async () => {
    const agent = await signedInAgent();
    delete store.users[0].tokenIssuedAt;
    await agent.get('/api/auth/me').expect(401);
  });

  it('counts case and trailing-slash variants of the login path together', async () => {
    const login = { email: 'nobody@example.com', password: 'wrongpassword1' };
    for (let i = 0; i < 20; i += 1) {
      await request(app).post('/api/auth/login').send(login).expect(401);
    }
    await request(app).post('/api/auth/LOGIN').send(login).expect(429);
    await request(app).post('/API/Auth/login/').send(login).expect(429);
  });

  it('measures the password limit in bytes', async () => {
    // 40 characters, but 80 bytes in UTF-8.
    await request(app)
      .post('/api/auth/create')
      .send({ ...credentials, password: 'é'.repeat(40) })
      .expect(400);
  });
});

describe('popular quizzes', () => {
  it('is empty before anything has been played', async () => {
    const res = await request(app).get('/api/quizzes/popular').expect(200);
    expect(res.body).toEqual([]);
  });

  it('ranks quizzes by play count and includes title and image', async () => {
    store.quizzes.push({ ...structuredClone(testQuiz), slug: 'second-quiz', title: 'Second Quiz', image: 'https://example.com/two.png' });
    store.scores.push(
      { user: 'a@example.com', quiz: 'second-quiz' },
      { user: 'b@example.com', quiz: 'second-quiz' },
      { user: 'c@example.com', quiz: 'test-quiz' }
    );

    const res = await request(app).get('/api/quizzes/popular').expect(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ slug: 'second-quiz', plays: 2, title: 'Second Quiz' });
    expect(res.body[1]).toMatchObject({ slug: 'test-quiz', plays: 1 });
    expect(res.body[0].image).toBe('https://example.com/two.png');
  });

  it('counts repeat plays by the same user', async () => {
    store.scores.push(
      { user: 'a@example.com', quiz: 'test-quiz' },
      { user: 'a@example.com', quiz: 'test-quiz' }
    );
    const res = await request(app).get('/api/quizzes/popular').expect(200);
    expect(res.body[0]).toMatchObject({ slug: 'test-quiz', plays: 2 });
  });

  it('never leaks answers or player identities', async () => {
    store.scores.push({ user: 'player@example.com', quiz: 'test-quiz', name: 'Player One' });
    const res = await request(app).get('/api/quizzes/popular').expect(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('Paris');
    expect(body).not.toContain('player@example.com');
    expect(body).not.toContain('Player One');
    expect(Object.keys(res.body[0]).sort()).toEqual(['image', 'plays', 'slug', 'title']);
  });

  it('requires a session for the personal favourites board', async () => {
    await request(app).get('/api/quizzes/favorites').expect(401);
  });

  it('counts only the signed-in user\'s own plays', async () => {
    const agent = await signedInAgent();
    store.quizzes.push({ ...structuredClone(testQuiz), slug: 'other-quiz', title: 'Other Quiz' });
    store.scores.push(
      // Another player's many plays shouldn't show up in this user's favorites.
      { user: 'stranger@example.com', quiz: 'other-quiz' },
      { user: 'stranger@example.com', quiz: 'other-quiz' },
      { user: 'stranger@example.com', quiz: 'other-quiz' },
      { user: 'player@example.com', quiz: 'test-quiz' }
    );

    const res = await agent.get('/api/quizzes/favorites').expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ slug: 'test-quiz', plays: 1 });
  });

  it('ranks a user\'s own quizzes by how often they replayed them', async () => {
    const agent = await signedInAgent();
    store.quizzes.push({ ...structuredClone(testQuiz), slug: 'other-quiz', title: 'Other Quiz' });
    store.scores.push(
      { user: 'player@example.com', quiz: 'test-quiz' },
      { user: 'player@example.com', quiz: 'other-quiz' },
      { user: 'player@example.com', quiz: 'other-quiz' }
    );

    const res = await agent.get('/api/quizzes/favorites').expect(200);
    expect(res.body[0]).toMatchObject({ slug: 'other-quiz', plays: 2 });
    expect(res.body[1]).toMatchObject({ slug: 'test-quiz', plays: 1 });
  });

  it('caps the list at five', async () => {
    for (let i = 0; i < 8; i += 1) {
      store.quizzes.push({ ...structuredClone(testQuiz), slug: `q${i}`, title: `Quiz ${i}` });
      for (let n = 0; n <= i; n += 1) store.scores.push({ user: 'a@example.com', quiz: `q${i}` });
    }
    const res = await request(app).get('/api/quizzes/popular').expect(200);
    expect(res.body).toHaveLength(5);
    expect(res.body[0].slug).toBe('q7');
  });
});

// The sanitizer can't reassign req.query because it is a getter, so it empties
// and refills the object in place. If that ever breaks, query parameters vanish
// and every board returns global totals instead of the quiz's. Nothing else in
// this file sends a query string.
describe('query string handling', () => {
  it('passes a normal query parameter through sanitization to the route', async () => {
    const res = await request(app).get('/api/scores?quiz=test-quiz').expect(200);
    // Getting three boards back shows req.query.quiz survived. Without it the
    // route would return the global totals array.
    expect(res.body).toHaveProperty('easy');
    expect(res.body).toHaveProperty('medium');
    expect(res.body).toHaveProperty('hard');
    expect(Array.isArray(res.body)).toBe(false);
  });

  it('passes multiple query parameters through', async () => {
    const res = await request(app).get('/api/scores?quiz=test-quiz&difficulty=easy').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('never lets a query-smuggled operator object reach the data layer', async () => {
    // Express 4 parses this into { $gt: '' }, while Express 5's default parser
    // keeps it as a flat string key. Either way no operator should reach the database.
    await request(app).get('/api/scores?quiz[$gt]=');
    const leaked = store.keysSeen.filter((k) => k !== null && typeof k !== 'string');
    expect(leaked).toEqual([]);
  });
});

describe('registration and login', () => {
  it('rejects an invalid email', async () => {
    const res = await request(app)
      .post('/api/auth/create')
      .send({ ...credentials, email: 'not-an-email' })
      .expect(400);
    expect(res.body.msg).toMatch(/email/i);
  });

  it('rejects a short password', async () => {
    await request(app).post('/api/auth/create').send({ ...credentials, password: 'short' }).expect(400);
  });

  it('rejects a display name that is too short', async () => {
    await request(app).post('/api/auth/create').send({ ...credentials, displayName: 'ab' }).expect(400);
  });

  it('creates an account and sets an httpOnly session cookie', async () => {
    const res = await request(app).post('/api/auth/create').send(credentials).expect(201);
    expect(res.body).toMatchObject({ email: credentials.email, displayName: credentials.displayName });
    expect(res.body.password).toBeUndefined();
    expect(res.body.token).toBeUndefined();
    expect(res.headers['set-cookie'].join(';')).toMatch(/HttpOnly/i);
  });

  it('rejects a duplicate display name', async () => {
    await request(app).post('/api/auth/create').send(credentials).expect(201);
    await request(app)
      .post('/api/auth/create')
      .send({ ...credentials, email: 'other@example.com' })
      .expect(409);
  });

  it('rejects a wrong password without revealing the account', async () => {
    await request(app).post('/api/auth/create').send(credentials).expect(201);
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: credentials.email, password: 'wrongpassword1' })
      .expect(401);
    expect(res.body.msg).toBe('Invalid email or password');
  });

  it('restores a session from the cookie and drops it on logout', async () => {
    const agent = await signedInAgent();
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.displayName).toBe(credentials.displayName);

    await agent.post('/api/auth/logout').expect(200);
    await agent.get('/api/auth/me').expect(401);
  });

  it('rejects an unauthenticated request to a protected route', async () => {
    await request(app).get('/api/auth/me').expect(401);
    await request(app).get('/api/scores/me').expect(401);
  });
});

describe('injection defences', () => {
  it('blocks a NoSQL operator in the login email', async () => {
    await request(app).post('/api/auth/create').send(credentials).expect(201);
    await request(app)
      .post('/api/auth/login')
      .send({ email: { $gt: '' }, password: credentials.password })
      .expect(401);
    expect(store.keysSeen.some((k) => k && typeof k === 'object')).toBe(false);
  });

  it('blocks an operator object smuggled through the auth cookie', async () => {
    await request(app).post('/api/auth/create').send(credentials).expect(201);
    store.keysSeen = [];
    // cookie-parser expands a `j:` prefixed cookie into a real object.
    await request(app)
      .get('/api/auth/me')
      .set('Cookie', `token=${encodeURIComponent('j:{"$gt":""}')}`)
      .expect(401);
    expect(store.keysSeen.some((k) => k && typeof k === 'object')).toBe(false);
  });

  it('does not let a client assign itself the admin role', async () => {
    const res = await request(app)
      .post('/api/auth/create')
      .send({ ...credentials, role: 'admin' })
      .expect(201);
    expect(res.body.role).toBeNull();
  });

  it('survives non-string fields instead of crashing', async () => {
    await request(app)
      .post('/api/auth/create')
      .send({ ...credentials, displayName: { $ne: null } })
      .expect(400);
    // The process is still up and serving.
    await request(app).get('/api/quizzes').expect(200);
  });
});

describe('admin authorization', () => {
  it('forbids non-admins from creating, editing, or deleting quizzes', async () => {
    const agent = await signedInAgent();
    await agent.post('/api/quiz').send(testQuiz).expect(403);
    await agent.put('/api/quiz/test-quiz').send(testQuiz).expect(403);
    await agent.delete('/api/quiz/test-quiz').expect(403);
    await agent.get('/api/suggestions').expect(403);
  });

  it('lets an admin create a quiz and rejects an invalid payload', async () => {
    const agent = await signedInAgent();
    store.users[0].role = 'admin';

    await agent
      .post('/api/quiz')
      .send({ ...testQuiz, slug: 'Not A Valid Slug' })
      .expect(400);

    await agent.post('/api/quiz').send({ ...testQuiz, slug: 'brand-new' }).expect(201);
    expect(store.quizzes.some((q) => q.slug === 'brand-new')).toBe(true);
  });
});

describe('playing a quiz', () => {
  it('runs an attempt end to end and reveals answers only at the finish', async () => {
    const agent = await signedInAgent();

    const started = await agent
      .post('/api/attempt')
      .send({ quiz: 'test-quiz', difficulty: 'easy' })
      .expect(201);
    expect(started.body.attemptId).toBeTruthy();
    expect(started.body.timeLimit).toBe(120);

    const finished = await agent
      .post('/api/attempt/finish')
      .send({ attemptId: started.body.attemptId, score: 0 })
      .expect(200);
    expect(finished.body.answers).toEqual(['Paris', 'Pacific']);
    expect(finished.body.summary).toMatchObject({ score: 0, total: 2, difficulty: 'easy' });
  });

  it('rejects a score higher than the number of questions', async () => {
    const agent = await signedInAgent();
    const started = await agent
      .post('/api/attempt')
      .send({ quiz: 'test-quiz', difficulty: 'easy' })
      .expect(201);

    await agent
      .post('/api/attempt/finish')
      .send({ attemptId: started.body.attemptId, score: 99 })
      .expect(400);
  });

  it('rejects a finish with no valid attempt', async () => {
    const agent = await signedInAgent();
    await agent
      .post('/api/attempt/finish')
      .send({ attemptId: 'made-up-attempt-id', score: 2 })
      .expect(400);
  });

  it('rejects an unknown quiz or difficulty when starting', async () => {
    const agent = await signedInAgent();
    await agent.post('/api/attempt').send({ quiz: 'nope', difficulty: 'easy' }).expect(400);
    await agent.post('/api/attempt').send({ quiz: 'test-quiz', difficulty: 'constructor' }).expect(400);
  });

  it('reveals the answers to a guest but records no score', async () => {
    const started = await request(app)
      .post('/api/attempt')
      .send({ quiz: 'test-quiz', difficulty: 'easy' })
      .expect(201);

    const finished = await request(app)
      .post('/api/attempt/finish')
      .send({ attemptId: started.body.attemptId, score: 0 })
      .expect(200);

    expect(finished.body.answers).toEqual(['Paris', 'Pacific']);
    expect(finished.body.scores).toBeUndefined();
    expect(store.scores).toHaveLength(0);
  });
});

// The score itself comes from the browser, so these rules are what stop a
// modified client from posting a run it never played.
describe('attempt integrity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Moves the server's clock forward without touching timers, so the elapsed
  // time a route computes can be controlled from a test.
  const skipAhead = (seconds) => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now + seconds * 1000);
  };

  const startRun = async (agent, difficulty = 'easy') => {
    const res = await agent.post('/api/attempt').send({ quiz: 'test-quiz', difficulty }).expect(201);
    return res.body.attemptId;
  };

  it('rejects a perfect score claimed faster than a person could type', async () => {
    const agent = await signedInAgent();
    const attemptId = await startRun(agent);

    // Both answers within milliseconds of starting, under the 0.4s per answer floor.
    const res = await agent.post('/api/attempt/finish').send({ attemptId, score: 2 }).expect(400);
    expect(res.body.msg).toBe('Submission rejected');
    expect(store.scores).toHaveLength(0);
  });

  it('accepts the same score once enough time has passed', async () => {
    const agent = await signedInAgent();
    const attemptId = await startRun(agent);
    skipAhead(30);

    const res = await agent.post('/api/attempt/finish').send({ attemptId, score: 2 }).expect(200);
    expect(res.body.summary).toMatchObject({ score: 2, total: 2, points: 6, timeSpent: 30 });
    expect(store.scores).toHaveLength(1);
  });

  it('takes the elapsed time from its own clock, not the client', async () => {
    const agent = await signedInAgent();
    const attemptId = await startRun(agent);
    skipAhead(45);

    const res = await agent
      .post('/api/attempt/finish')
      .send({ attemptId, score: 2, timeSpent: 1, elapsed: 1 })
      .expect(200);
    expect(res.body.summary.timeSpent).toBe(45);
  });

  it('rejects a run submitted after the time limit has passed', async () => {
    const agent = await signedInAgent();
    const attemptId = await startRun(agent);
    skipAhead(120 + 16); // the easy limit plus more than the 15s grace

    const res = await agent.post('/api/attempt/finish').send({ attemptId, score: 2 }).expect(400);
    expect(res.body.msg).toMatch(/time expired/i);
    expect(store.scores).toHaveLength(0);
  });

  it('will not let one attempt be submitted twice', async () => {
    const agent = await signedInAgent();
    const attemptId = await startRun(agent);
    skipAhead(30);

    await agent.post('/api/attempt/finish').send({ attemptId, score: 2 }).expect(200);
    await agent.post('/api/attempt/finish').send({ attemptId, score: 2 }).expect(400);
    expect(store.scores).toHaveLength(1);
  });

  it('will not let another account finish someone else\'s attempt', async () => {
    const owner = await signedInAgent();
    const attemptId = await startRun(owner);

    const stranger = await signedInAgent({ email: 'stranger@example.com', displayName: 'Stranger' });
    skipAhead(30);

    await stranger.post('/api/attempt/finish').send({ attemptId, score: 2 }).expect(400);
    // A guest holding the id cannot claim it either.
    await request(app).post('/api/attempt/finish').send({ attemptId, score: 2 }).expect(400);
    expect(store.scores).toHaveLength(0);
  });

  it('scores the run under the signed-in account, not one named by the client', async () => {
    const agent = await signedInAgent();
    const attemptId = await startRun(agent);
    skipAhead(30);

    await agent
      .post('/api/attempt/finish')
      .send({ attemptId, score: 1, user: 'stranger@example.com', name: 'Someone Else' })
      .expect(200);

    expect(store.scores[0]).toMatchObject({
      user: credentials.email,
      name: credentials.displayName,
      quiz: 'test-quiz',
      difficulty: 'easy',
    });
  });
});

describe('admin quiz management', () => {
  const asAdmin = async () => {
    const agent = await signedInAgent();
    store.users[0].role = 'admin';
    return agent;
  };

  it('updates a quiz in place', async () => {
    const agent = await asAdmin();
    await agent
      .put('/api/quiz/test-quiz')
      .send({ ...testQuiz, title: 'Renamed Quiz' })
      .expect(200);

    expect(store.quizzes.find((q) => q.slug === 'test-quiz').title).toBe('Renamed Quiz');
  });

  it('404s when updating or deleting a quiz that does not exist', async () => {
    const agent = await asAdmin();
    await agent.put('/api/quiz/ghost-quiz').send(testQuiz).expect(404);
    await agent.delete('/api/quiz/ghost-quiz').expect(404);
  });

  it('deletes a quiz and the scores that belong to it', async () => {
    const agent = await asAdmin();
    store.scores.push(
      { user: 'a@example.com', quiz: 'test-quiz' },
      { user: 'a@example.com', quiz: 'other-quiz' }
    );

    await agent.delete('/api/quiz/test-quiz').expect(200);

    expect(store.quizzes.some((q) => q.slug === 'test-quiz')).toBe(false);
    expect(store.scores.map((s) => s.quiz)).toEqual(['other-quiz']);
  });

  it('rejects a quiz whose time limit is out of range', async () => {
    const agent = await asAdmin();
    await agent
      .post('/api/quiz')
      .send({ ...testQuiz, slug: 'bad-limits', timeLimits: { easy: 5, medium: 480, hard: 600 } })
      .expect(400);
  });

  it('strips a javascript: image URL rather than storing it', async () => {
    const agent = await asAdmin();
    await agent
      .post('/api/quiz')
      .send({ ...testQuiz, slug: 'image-test', image: 'javascript:alert(1)' })
      .expect(201);

    expect(store.quizzes.find((q) => q.slug === 'image-test').image).toBe('');
  });

  it('reports image uploads as unconfigured instead of failing', async () => {
    const agent = await asAdmin();
    // No dbConfig.json in the test environment, so no bucket is configured.
    await agent.post('/api/quiz-image-url').send({ contentType: 'image/png' }).expect(501);
  });
});

describe('suggestions and account deletion', () => {
  it('takes a suggestion from a signed-in player and records who sent it', async () => {
    const agent = await signedInAgent();
    await agent.post('/api/suggestion').send({ ...testQuiz, slug: 'suggested-quiz' }).expect(201);

    expect(store.suggestions).toHaveLength(1);
    expect(store.suggestions[0]).toMatchObject({
      slug: 'suggested-quiz',
      suggestedBy: credentials.email,
      suggestedByName: credentials.displayName,
    });
    // A suggestion is not a quiz until an admin approves it.
    expect(store.quizzes.some((q) => q.slug === 'suggested-quiz')).toBe(false);
  });

  it('requires a session to suggest and admin rights to review', async () => {
    await request(app).post('/api/suggestion').send(testQuiz).expect(401);

    const agent = await signedInAgent();
    await agent.get('/api/suggestions').expect(403);
    await agent.delete('/api/suggestions/anything').expect(403);

    store.users[0].role = 'admin';
    await agent.get('/api/suggestions').expect(200);
  });

  it('deletes the account, its scores, and the session, but only when confirmed', async () => {
    const agent = await signedInAgent();
    store.scores.push({ user: credentials.email, quiz: 'test-quiz' }, { user: 'a@example.com', quiz: 'test-quiz' });

    await agent.delete('/api/user').send({}).expect(400);
    expect(store.users).toHaveLength(1);

    await agent.delete('/api/user').send({ confirm: true }).expect(200);
    expect(store.users).toHaveLength(0);
    expect(store.scores.map((s) => s.user)).toEqual(['a@example.com']);
    await agent.get('/api/auth/me').expect(401);
  });
});

describe('daily quiz', () => {
  // A day takes five questions and at most two from one quiz, and every
  // question needs multiple-choice options, so the daily tests add three
  // quizzes whose answers are years.
  beforeEach(() => {
    let year = 1500;
    const q = (name) => ({ question: `In which year did ${name} happen?`, answer: String(year++), accept: [] });
    for (const name of ['second', 'third', 'fourth']) {
      store.quizzes.push({
        ...structuredClone(testQuiz),
        slug: `${name}-quiz`,
        title: `${name} quiz`,
        difficulties: {
          easy: [q(`${name} easy one`), q(`${name} easy two`), q(`${name} easy three`)],
          medium: [q(`${name} medium`)],
          hard: [q(`${name} hard`)],
        },
      });
    }
  });

  const results = ['typed', 'typed', 'choice', 'miss', 'typed'];

  it('serves five questions and stores the day so everyone gets the same one', async () => {
    const first = await request(app).get('/api/daily').expect(200);
    expect(first.body.questions.map((q) => q.level)).toEqual(['easy', 'easy', 'easy', 'medium', 'hard']);
    expect(first.body.date).toBe(Daily.dailyDate());
    expect(first.body.nextResetAt).toBeGreaterThan(Date.now());
    expect(store.daily).toHaveLength(1);

    // Edits to the library after a day is stored don't change it.
    store.quizzes = store.quizzes.slice(0, 1);
    resetDailyCache();
    const second = await request(app).get('/api/daily').expect(200);
    expect(second.body.questions).toEqual(first.body.questions);
  });

  it('lets guests finish without saving anything', async () => {
    const res = await request(app).post('/api/daily/result').send({ date: Daily.dailyDate(), results }).expect(200);
    expect(res.body.saved).toBe(false);
    expect(store.dailyPlays).toHaveLength(0);
  });

  it('saves one result per player per day and reports the streak', async () => {
    const agent = await signedInAgent();
    const today = Daily.dailyDate();
    store.dailyPlays.push({ user: credentials.email, date: Daily.addDays(today, -1), results });

    const saved = await agent.post('/api/daily/result').send({ date: today, results }).expect(201);
    expect(saved.body.streak.current).toBe(2);
    expect(store.dailyPlays.at(-1)).toMatchObject({ user: credentials.email, date: today, score: 7 });

    const again = await agent.post('/api/daily/result').send({ date: today, results: Array(5).fill('typed') }).expect(409);
    expect(again.body.played.results).toEqual(results);

    const daily = await agent.get('/api/daily').expect(200);
    expect(daily.body.played.results).toEqual(results);
    expect(daily.body.streak.current).toBe(2);
  });

  it('rejects results smuggled in as arrays or objects, and dates with extra text', async () => {
    const agent = await signedInAgent();
    const date = Daily.dailyDate();
    await agent.post('/api/daily/result').send({ date, results: [['typed'], 'typed', 'typed', 'typed', 'typed'] }).expect(400);
    await agent.post('/api/daily/result').send({ date, results: [{ toString: 'typed' }, 'typed', 'typed', 'typed', 'typed'] }).expect(400);
    await agent.post('/api/daily/result').send({ date: `${date}' || '1'=='1`, results }).expect(400);
    expect(store.dailyPlays).toHaveLength(0);
  });

  it('answers malformed and oversized bodies with 400 and 413, not 500', async () => {
    await request(app).post('/api/practice').set('content-type', 'application/json').send('{"easy":3,').expect(400);
    const huge = JSON.stringify({ easy: 3, medium: 1, hard: 1, seen: Array(40000).fill('abcdefgh') });
    await request(app).post('/api/practice').set('content-type', 'application/json').send(huge).expect(413);
  });

  it('rejects results for another day or in the wrong shape', async () => {
    const agent = await signedInAgent();
    await agent.post('/api/daily/result').send({ date: '2000-01-01', results }).expect(400);
    await agent.post('/api/daily/result').send({ date: Daily.dailyDate(), results: ['typed'] }).expect(400);
    await agent.post('/api/daily/result').send({ date: Daily.dailyDate(), results: { $gt: '' } }).expect(400);
  });

  it('keeps the preview and exclusions to admins', async () => {
    await request(app).get('/api/daily/preview').expect(401);
    const agent = await signedInAgent();
    await agent.get('/api/daily/preview').expect(403);
    await agent.post('/api/daily/exclude').send({}).expect(403);

    store.users[0].role = 'admin';
    const preview = await agent.get('/api/daily/preview?days=3').expect(200);
    expect(preview.body).toHaveLength(3);
    expect(preview.body[0].questions[0].choices).toHaveLength(4);
  });

  it('excludes a question only when its text still matches', async () => {
    const agent = await signedInAgent();
    store.users[0].role = 'admin';

    await agent
      .post('/api/daily/exclude')
      .send({ slug: 'second-quiz', level: 'easy', index: 0, question: 'Some other text' })
      .expect(404);
    await agent
      .post('/api/daily/exclude')
      .send({ slug: 'second-quiz', level: 'easy', index: 0, question: 'In which year did second easy one happen?' })
      .expect(200);
    expect(store.quizzes[1].difficulties.easy[0].daily).toBe(false);
  });

  it('keeps daily flags through an admin edit', async () => {
    const agent = await signedInAgent();
    store.users[0].role = 'admin';
    const edited = structuredClone(testQuiz);
    edited.difficulties.easy[1].followsPrevious = true;
    edited.difficulties.easy[0].daily = false;
    await agent.put('/api/quiz/test-quiz').send(edited).expect(200);
    const saved = store.quizzes.find((q) => q.slug === 'test-quiz');
    expect(saved.difficulties.easy[1].followsPrevious).toBe(true);
    expect(saved.difficulties.easy[0].daily).toBe(false);
  });

  it('keeps three hand-written wrong answers through an admin edit', async () => {
    const agent = await signedInAgent();
    store.users[0].role = 'admin';
    const edited = structuredClone(testQuiz);
    edited.difficulties.easy[0].choices = ['Lyon', 'Marseille', 'Nice'];
    await agent.put('/api/quiz/test-quiz').send(edited).expect(200);
    const saved = store.quizzes.find((q) => q.slug === 'test-quiz');
    expect(saved.difficulties.easy[0].choices).toEqual(['Lyon', 'Marseille', 'Nice']);
  });

  it('refuses an admin edit whose wrong answers are incomplete or include a correct one', async () => {
    const agent = await signedInAgent();
    store.users[0].role = 'admin';
    const bad = [
      ['Atlantic', 'Pacific', 'Indian'], // Pacific is the answer
      ['Atlantic', 'Indian', ''], // only two
      ['Atlantic', 'atlantic', 'Indian'], // a repeat
    ];
    for (const choices of bad) {
      const edited = structuredClone(testQuiz);
      edited.difficulties.easy[1].choices = choices;
      const res = await agent.put('/api/quiz/test-quiz').send(edited).expect(400);
      expect(res.body.msg).toMatch(/wrong answers/);
    }
    // An accepted spelling counts as correct too.
    const edited = structuredClone(testQuiz);
    edited.difficulties.easy[0].accept = ['City of Light'];
    edited.difficulties.easy[0].choices = ['Lyon', 'city of light', 'Nice'];
    await agent.put('/api/quiz/test-quiz').send(edited).expect(400);
  });

  it('drops a lead-in flag from a first question', async () => {
    const agent = await signedInAgent();
    store.users[0].role = 'admin';
    const edited = structuredClone(testQuiz);
    edited.difficulties.easy[0].followsPrevious = true;
    edited.difficulties.easy[1].followsPrevious = true;
    await agent.put('/api/quiz/test-quiz').send(edited).expect(200);
    const saved = store.quizzes.find((q) => q.slug === 'test-quiz');
    expect(saved.difficulties.easy[0].followsPrevious).toBeUndefined();
    expect(saved.difficulties.easy[1].followsPrevious).toBe(true);
  });

  it('accepts yesterday\'s result for an hour after midnight, then not', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 00:20 Pacific (PDT) on 23 September: yesterday's quiz is still in its grace period.
      vi.setSystemTime(new Date('2026-09-23T07:20:00Z'));
      // Signed in on the fake clock. A session issued on the real clock would look
      // like it came from the future once real time passes these dates, and be refused.
      const agent = await signedInAgent();
      const saved = await agent.post('/api/daily/result').send({ date: '2026-09-22', results }).expect(201);
      expect(store.dailyPlays.at(-1)).toMatchObject({ date: '2026-09-22', number: Daily.dailyNumber('2026-09-22') });
      expect(saved.body.streak.current).toBe(1);

      // 01:30 Pacific: too late for the day before.
      vi.setSystemTime(new Date('2026-09-24T08:30:00Z'));
      await agent.post('/api/daily/result').send({ date: '2026-09-23', results }).expect(400);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the page whose day it is, so saved progress can be matched to a player', async () => {
    const anon = await request(app).get('/api/daily').expect(200);
    expect(anon.body.player).toBeUndefined();
    const agent = await signedInAgent();
    const res = await agent.get('/api/daily').expect(200);
    expect(res.body.player).toBe(credentials.displayName);
  });

  it('lets admins set and clear a question\'s choices from the preview', async () => {
    const body = { slug: 'second-quiz', level: 'easy', index: 0, question: 'In which year did second easy one happen?' };
    const anon = await signedInAgent();
    await anon.post('/api/daily/choices').send({ ...body, choices: ['a', 'b', 'c'] }).expect(403);

    store.users[0].role = 'admin';
    await anon.post('/api/daily/choices').send({ ...body, choices: ['a', 'b'] }).expect(400);
    await anon.post('/api/daily/choices').send({ ...body, question: 'stale' , choices: ['a', 'b', 'c'] }).expect(404);
    await anon.post('/api/daily/choices').send({ ...body, index: '0', choices: ['a', 'b', 'c'] }).expect(404);
    await anon.post('/api/daily/choices').send({ ...body, choices: ['1400', '1450', '1600'] }).expect(200);
    expect(store.quizzes[1].difficulties.easy[0].choices).toEqual(['1400', '1450', '1600']);

    const preview = await anon.get('/api/daily/preview?days=30').expect(200);
    const used = preview.body.flatMap((d) => d.questions).find((q) => q.question === body.question);
    if (used) {
      expect(used.authoredChoices).toBe(true);
      expect([...used.choices].sort()).toEqual(['1400', '1450', '1500', '1600']);
    }

    await anon.post('/api/daily/choices').send({ ...body, choices: [] }).expect(200);
    expect(store.quizzes[1].difficulties.easy[0].choices).toBeUndefined();
  });

  it('serves practice rounds to anyone, in the requested mix', async () => {
    const res = await request(app).post('/api/practice').send({ easy: 2, medium: 1, hard: 1 }).expect(200);
    expect(res.body.questions.map((q) => q.level)).toEqual(['easy', 'easy', 'medium', 'hard']);
    expect(res.body.questions.every((q) => q.id && q.choices.length === 4 && q.accepted.length)).toBe(true);
    // Nothing about a practice round is stored.
    expect(store.dailyPlays).toHaveLength(0);
  });

  it('rejects practice settings outside the limits', async () => {
    await request(app).post('/api/practice').send({ easy: 0, medium: 0, hard: 0 }).expect(400);
    await request(app).post('/api/practice').send({ easy: 11, medium: 0, hard: 0 }).expect(400);
    await request(app).post('/api/practice').send({ easy: 'lots', medium: 1, hard: 1 }).expect(400);
  });

  it('steers practice away from questions the player has seen', async () => {
    const first = await request(app).post('/api/practice').send({ easy: 3, medium: 0, hard: 0 }).expect(200);
    const seen = first.body.questions.map((q) => q.id);
    const next = await request(app).post('/api/practice').send({ easy: 3, medium: 0, hard: 0, seen }).expect(200);
    expect(next.body.questions.some((q) => seen.includes(q.id))).toBe(false);
  });
});
