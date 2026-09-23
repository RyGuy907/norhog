import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePageTitle } from '../usePageTitle';
import { outcomePoints, scoreOf } from '../daily/dailyShare';
import { Mark, QuestionCard, ResultRecap } from '../daily/questionCard';
import '../daily/daily.css';
import './practice.css';

// Practice rounds use the daily quiz's format as often as a player likes.
// Nothing is scored or saved on the server. The browser remembers the
// player's chosen mix of difficulties and which questions they've seen, so
// new rounds keep bringing new questions.
const settingsKey = 'norhog-practice-settings';
const seenKey = 'norhog-practice-seen';

const defaultCounts = { easy: 3, medium: 1, hard: 1 };
// Matches the server's limits in service/daily.js.
const maxPerLevel = 10;
const maxTotal = 20;
// Enough to cover a long run of rounds without the list growing forever.
const maxSeen = 3000;

const levels = [
  { key: 'easy', label: 'Easy' },
  { key: 'medium', label: 'Medium' },
  { key: 'hard', label: 'Hard' },
];

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be full or blocked; practice still works without it.
  }
}

const totalOf = (counts) => counts.easy + counts.medium + counts.hard;

// Saved settings are checked on read, since localStorage can hold anything.
function loadCounts() {
  const saved = readJson(settingsKey, null);
  const valid = saved && levels.every(({ key }) => Number.isInteger(saved[key]) && saved[key] >= 0 && saved[key] <= maxPerLevel);
  return valid && totalOf(saved) >= 1 && totalOf(saved) <= maxTotal ? saved : defaultCounts;
}

export function Practice() {
  usePageTitle('Practice');
  const [counts, setCounts] = useState(loadCounts);
  // 'setup', then 'playing', then 'done'.
  const [phase, setPhase] = useState('setup');
  const [questions, setQuestions] = useState([]);
  const [results, setResults] = useState([]);
  const [step, setStep] = useState(0);
  const [choicesOpened, setChoicesOpened] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const changeCount = (level, delta) => {
    setCounts((prev) => {
      const next = { ...prev, [level]: Math.min(maxPerLevel, Math.max(0, prev[level] + delta)) };
      if (totalOf(next) < 1 || totalOf(next) > maxTotal) {
        return prev;
      }
      writeJson(settingsKey, next);
      return next;
    });
  };

  const resetCounts = () => {
    setCounts(defaultCounts);
    writeJson(settingsKey, defaultCounts);
  };

  const startRound = async () => {
    setLoading(true);
    setError('');
    try {
      const seen = readJson(seenKey, []);
      const response = await fetch('/api/practice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...counts, seen: Array.isArray(seen) ? seen : [] }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.msg || "Couldn't start a round.");
      }
      const ids = data.questions.map((q) => q.id).filter(Boolean);
      writeJson(seenKey, [...(Array.isArray(seen) ? seen : []), ...ids].slice(-maxSeen));
      setQuestions(data.questions);
      setResults([]);
      setStep(0);
      setChoicesOpened(false);
      setPhase('playing');
      window.scrollTo(0, 0);
    } catch (err) {
      setError(err.message || "Couldn't start a round.");
    } finally {
      setLoading(false);
    }
  };

  const recordOutcome = (outcome) => {
    setResults((prev) => [...prev, outcome]);
    setChoicesOpened(false);
  };

  return (
    <main className="container daily-page">
      <header className="daily-header">
        <p className="daily-kicker">Norhog Practice</p>
        <h2>Practice Rounds</h2>
      </header>

      {phase === 'setup' && (
        <section className="daily-card">
          <p className="daily-lede">
            Unlimited rounds in the daily quiz&apos;s format, drawn from across Norhog&apos;s quizzes.
          </p>
          <ul className="daily-rules">
            <li><Mark outcome="typed" /> Type the answer for 2 points.</li>
            <li><Mark outcome="choice" /> Pick from multiple choices for 1 point.</li>
            <li><Mark outcome="miss" /> An incorrect guess is worth 0 points.</li>
          </ul>

          {/* Collapsed by default: most players will keep the 3 / 1 / 1 mix. */}
          <details className="practice-more">
            <summary>More settings</summary>
            <fieldset className="practice-settings">
              <legend>Questions per round</legend>
              {levels.map(({ key, label }) => (
                <div className="practice-level" key={key}>
                  <span className={`daily-level level-${key}`}>{label}</span>
                  <div className="practice-stepper">
                    <button
                      type="button"
                      className="btn btn-outline-secondary btn-sm"
                      aria-label={`Fewer ${label.toLowerCase()} questions`}
                      onClick={() => changeCount(key, -1)}
                      disabled={counts[key] === 0 || totalOf(counts) === 1}
                    >
                      &minus;
                    </button>
                    <output aria-live="polite" aria-label={`${label} questions`}>{counts[key]}</output>
                    <button
                      type="button"
                      className="btn btn-outline-secondary btn-sm"
                      aria-label={`More ${label.toLowerCase()} questions`}
                      onClick={() => changeCount(key, 1)}
                      disabled={counts[key] === maxPerLevel || totalOf(counts) === maxTotal}
                    >
                      +
                    </button>
                  </div>
                </div>
              ))}
              <p className="practice-total">
                {totalOf(counts)} question{totalOf(counts) === 1 ? '' : 's'} per round
                {(counts.easy !== defaultCounts.easy || counts.medium !== defaultCounts.medium || counts.hard !== defaultCounts.hard) && (
                  <> &middot; <button type="button" className="btn btn-link p-0 practice-reset" onClick={resetCounts}>Reset to default</button></>
                )}
              </p>
            </fieldset>
          </details>

          {error && <p className="daily-hint" role="alert">{error}</p>}
          <button className="quiz-btn daily-start" onClick={startRound} disabled={loading} autoFocus>
            {loading ? 'Loading...' : 'Start a round'}
          </button>
        </section>
      )}

      {phase === 'playing' && questions[step] && (
        <QuestionCard
          key={step}
          number={step + 1}
          total={questions.length}
          entry={questions[step]}
          results={results}
          choicesOpened={choicesOpened}
          onOpenChoices={() => setChoicesOpened(true)}
          onResolve={recordOutcome}
          onNext={() => (step + 1 < questions.length ? setStep(step + 1) : setPhase('done'))}
          isLast={step + 1 === questions.length}
        />
      )}

      {phase === 'done' && (
        <section className="daily-card daily-results" aria-live="polite">
          <p className="daily-score">
            <strong>{scoreOf(results)}</strong>/{questions.length * outcomePoints.typed}
          </p>
          <div className="practice-actions">
            <button className="quiz-btn" onClick={startRound} disabled={loading}>
              {loading ? 'Loading...' : 'Next round'}
            </button>
            <button className="btn btn-outline-secondary" onClick={() => setPhase('setup')}>
              Change settings
            </button>
          </div>
          {error && <p className="daily-hint" role="alert">{error}</p>}
          <ResultRecap questions={questions} results={results} />
          <p className="daily-note">
            <Link to="/daily">Today&apos;s daily quiz</Link> &middot; <Link to="/quizzes">All quizzes</Link>
          </p>
        </section>
      )}
    </main>
  );
}
