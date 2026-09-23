import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { usePageTitle } from '../usePageTitle';
import { scoreOf, shareText } from './dailyShare';
import { Mark, QuestionCard, ResultRecap } from './questionCard';
import './daily.css';

// Progress through today's quiz is kept in the browser, so a refresh picks up
// where the player left off instead of letting them start over. It records
// whose progress it is, so on a shared browser one player's answers are never
// picked up by another. Guests' past days are kept too, for their streak.
const progressKey = 'norhog-daily-progress';
const historyKey = 'norhog-daily-history';

function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be full or blocked; the quiz still works without it.
  }
}

function addDays(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
}

// Matches the server's rule: the streak runs back from today, or from
// yesterday if today hasn't been played yet.
function localStreak(dates, today) {
  const played = new Set(dates);
  const start = played.has(today) ? today : addDays(today, -1);
  let current = 0;
  while (played.has(addDays(start, -current))) {
    current += 1;
  }
  return current;
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDate(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function Daily() {
  usePageTitle('Daily Quiz');
  const [day, setDay] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [signedIn, setSignedIn] = useState(false);
  const [streak, setStreak] = useState(0);
  // null before starting, then the index of the current question, then 'done'.
  const [step, setStep] = useState(null);
  const [results, setResults] = useState([]);
  // Whether the current question's choices have been opened. It is saved with
  // the progress, so a refresh can't bring the text box back for full points.
  const [choicesOpened, setChoicesOpened] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    fetch('/api/daily')
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(data?.msg || "Couldn't load today's quiz.");
        }
        return data;
      })
      .then((data) => {
        setDay(data);
        const isSignedIn = data.streak !== undefined;
        setSignedIn(isSignedIn);
        const history = readJson(historyKey, []);

        if (data.played) {
          setResults(data.played.results);
          setStep('done');
          setStreak(data.streak.current);
          return;
        }

        const progress = readJson(progressKey, null);
        const mine = progress?.date === data.date && progress.player === (data.player ?? null);
        const known = (results) =>
          Array.isArray(results) && results.length <= data.questions.length
          && results.every((result) => ['typed', 'choice', 'miss'].includes(result));
        const saved = mine && known(progress.results) ? progress.results : [];
        setResults(saved);
        const opened = mine && progress.choicesOpenedAt === saved.length;
        setChoicesOpened(opened);
        setStreak(isSignedIn ? data.streak.current : localStreak(history, data.date));
        if (saved.length === data.questions.length) {
          // Finished, but the page closed before the result was recorded.
          finish(data, saved, isSignedIn);
        } else if (saved.length > 0 || opened) {
          setStep(saved.length);
        }
      })
      .catch((error) => setLoadError(error.message || "Couldn't load today's quiz."));
  }, []);

  const recordOutcome = (outcome) => {
    const next = [...results, outcome];
    setResults(next);
    setChoicesOpened(false);
    writeJson(progressKey, { date: day.date, player: day.player ?? null, results: next });
  };

  const openChoices = () => {
    setChoicesOpened(true);
    writeJson(progressKey, { date: day.date, player: day.player ?? null, results, choicesOpenedAt: results.length });
  };

  // Records a finished day: in the browser for guests, on the server for
  // signed-in players.
  async function finish(dayData, finalResults, isSignedIn) {
    setStep('done');
    if (!isSignedIn) {
      const history = readJson(historyKey, []);
      if (!history.includes(dayData.date)) {
        history.push(dayData.date);
        // A year of dates is plenty for a streak.
        writeJson(historyKey, history.slice(-400));
      }
      setStreak(localStreak(history, dayData.date));
      return;
    }
    try {
      const response = await fetch('/api/daily/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dayData.date, results: finalResults }),
      });
      const data = await response.json().catch(() => null);
      if (data?.streak) {
        setStreak(data.streak.current);
      }
      // Played already on another device: show the result that counted.
      if (response.status === 409 && data?.played) {
        setResults(data.played.results);
      } else if (!response.ok) {
        setSaveError(data?.msg ? `Your result wasn't saved: ${data.msg}.` : "Your result couldn't be saved.");
      }
    } catch (error) {
      console.error('Failed to save daily result:', error);
      setSaveError("Your result couldn't be saved. Check your connection.");
    }
  }

  if (loadError) {
    return (
      <main className="container text-center">
        <h2>Daily Quiz</h2>
        <p>{loadError}</p>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>Try again</button>
      </main>
    );
  }

  if (!day) {
    return <main className="container">Loading...</main>;
  }

  return (
    <main className="container daily-page">
      <header className="daily-header">
        <p className="daily-kicker">Norhog Daily #{day.number}</p>
        <h2>{formatDate(day.date)}</h2>
      </header>

      {step === null && (
        <DailyIntro day={day} streak={streak} signedIn={signedIn} onStart={() => setStep(0)} />
      )}

      {typeof step === 'number' && (
        <QuestionCard
          key={step}
          number={step + 1}
          total={day.questions.length}
          entry={day.questions[step]}
          results={results}
          choicesOpened={choicesOpened}
          onOpenChoices={openChoices}
          onResolve={recordOutcome}
          onNext={() => (step + 1 < day.questions.length ? setStep(step + 1) : finish(day, results, signedIn))}
          isLast={step + 1 === day.questions.length}
        />
      )}

      {step === 'done' && (
        <DailyResults day={day} results={results} streak={streak} signedIn={signedIn} saveError={saveError} />
      )}
    </main>
  );
}

function DailyIntro({ day, streak, signedIn, onStart }) {
  return (
    <section className="daily-card daily-intro">
      <p className="daily-lede">
        Five untimed questions from across Norhog&apos;s quizzes: three easy, one medium, one hard.
      </p>
      <ul className="daily-rules">
        <li><Mark outcome="typed" /> Type the answer for 2 points.</li>
        <li><Mark outcome="choice" /> Pick from multiple choices for 1 point.</li>
        <li><Mark outcome="miss" /> An incorrect guess is worth 0 points.</li>
      </ul>
      {streak > 0 && (
        <p className="daily-streak">{streak}-day streak. Keep it going!</p>
      )}
      {!signedIn && (
        <p className="daily-note">
          <Link to="/profile">Log in</Link> to keep your streak across devices.
        </p>
      )}
      <button className="quiz-btn daily-start" onClick={onStart} autoFocus>
        Start today&apos;s quiz
      </button>
      <p className="daily-count">{day.questions.length} questions</p>
    </section>
  );
}

function DailyResults({ day, results, streak, signedIn, saveError }) {
  const score = scoreOf(results);
  const [copied, setCopied] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const text = shareText({
    number: day.number,
    results,
    streak,
    url: `${window.location.origin}/daily`,
  });

  const share = async () => {
    try {
      if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ text });
        return;
      }
      await navigator.clipboard.writeText(text);
      setCopied('Copied to your clipboard!');
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setCopied("Couldn't copy automatically. Select the text above instead.");
      }
    }
  };

  const remaining = day.nextResetAt - now;

  return (
    <section className="daily-card daily-results" aria-live="polite">
      <p className="daily-score">
        <strong>{score}</strong>/10
      </p>
      {streak > 0 && <p className="daily-streak-inline">{streak}-day streak</p>}
      {saveError && <p className="daily-hint" role="alert">{saveError}</p>}

      <pre className="daily-share-preview" aria-label="Your shareable result">{text}</pre>
      <button className="quiz-btn" onClick={share}>Share my result</button>
      {copied && <p className="daily-note" role="status">{copied}</p>}

      <ResultRecap questions={day.questions} results={results} />

      <p className="daily-practice-link">
        Want more? <Link to="/practice">Keep practicing with unlimited rounds</Link>
      </p>

      <p className="daily-next">
        {remaining > 0 ? (
          <>Next daily quiz in <strong>{formatCountdown(remaining)}</strong></>
        ) : (
          <>A new quiz is ready. <button className="btn btn-link p-0" onClick={() => window.location.reload()}>Play it</button></>
        )}
      </p>
      {!signedIn && (
        <p className="daily-note">
          <Link to="/profile">Log in</Link> to keep your streak across devices.
        </p>
      )}
    </section>
  );
}
