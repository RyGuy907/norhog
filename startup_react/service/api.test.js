import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

// Integration tests: real Express app, real middleware chain (sanitization,
// rate limiting, auth, validation) — only the database is swapped for an
// in-memory stand-in so tests don't touch Atlas.
const store = vi.hoisted(() => ({
  users: [],
  quizzes: [],
  scores: [],
  suggestions: [],
  // Records every key the routes hand to the data layer, so tests can prove
  // operator objects never make it that far.
  keysSeen: [],
}));

vi.mock('./database.js', () => {
  // Mirrors the real asKey guard in database.js: a non-string lookup must
  // return nothing rather than matching (a null token would otherwise match
  // every logged-out user).
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
      if (found) found.token = user.token;
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
    deleteScoresForQuiz: async () => {},
    // Mirrors the real aggregation: count score docs per quiz, join the quiz for
    // its display fields, drop any whose quiz no longer exists.
    getPopularQuizzes: async (limit = 5) => rankByPlays(store.scores, limit),
    getUserFavoriteQuizzes: async (user, limit = 4) => {
      const k = key(user);
      return k ? rankByPlays(store.scores.filter((s) => s.user === k), limit) : [];
    },
    getSuggestions: async () => store.suggestions,
    addSuggestion: async (s) => void store.suggestions.push(s),
    getSuggestion: async () => null,
    deleteSuggestion: async () => {},
    getQuizzes: async () => store.quizzes.map(({ slug, title, image, description }) => ({ slug, title, image, description })),
    getQuiz: async (slug) => {
      const k = key(slug);
      return k ? store.quizzes.find((q) => q.slug === k) || null : null;
    },
    addQuiz: async (quiz) => void store.quizzes.push(quiz),
    updateQuiz: async () => {},
    deleteQuiz: async () => {},
  };
});

const { app, resetRateLimits } = await import('./index.js');

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
  // The rate limiters keep per-process counters, so without this an earlier
  // test's registrations push a later one over the limit and it fails for a
  // reason that has nothing to do with what it is testing.
  resetRateLimits();
  store.users = [];
  store.quizzes = [structuredClone(testQuiz)];
  store.scores = [];
  store.suggestions = [];
  store.keysSeen = [];
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
      // Someone else hammering a quiz must not appear in this user's favourites.
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

// The sanitizer cannot reassign req.query — it is a getter — so it empties and
// refills the object in place. That is a load-bearing detail: if it ever stops
// working, query parameters silently vanish and every board returns global
// totals instead of the quiz's. Nothing else here exercises a query string.
describe('query string handling', () => {
  it('passes a normal query parameter through sanitization to the route', async () => {
    const res = await request(app).get('/api/scores?quiz=test-quiz').expect(200);
    // The three-board shape proves req.query.quiz survived; without it the
    // route falls through to the global totals array.
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
    // Express 4 parses this into { $gt: '' }; Express 5's simpler default parser
    // keeps it a flat string key. Either way no operator may reach the database.
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
});
