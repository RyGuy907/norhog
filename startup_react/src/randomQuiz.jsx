import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchQuizStatuses } from './quizCard';

// "Random" button plus a selector for what it should draw from, shown at the
// bottom of every Recommended Quizzes box.
//
// `quizzes` is the pool to choose from, so each page can decide what is eligible
// — the quiz page passes everything except the one you are already on.
const MODES = ['any', 'unplayed', 'played'];
const MODE_KEY = 'norhog.randomMode';

// Persisted because every press navigates away and remounts this component —
// without it the selector reset to "any" after each use, so choosing "unplayed"
// twice in a row meant re-picking it every time.
// Validated on read: localStorage is user-writable, and an unrecognised value
// would otherwise filter the pool down to nothing.
const storedMode = () => {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    return MODES.includes(saved) ? saved : 'any';
  } catch {
    return 'any';
  }
};

export function RandomQuiz({ quizzes }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState(storedMode);
  // Slugs the signed-in user has finished. Guests get an empty set, which makes
  // "unplayed" behave as "any" for them — accurate, since they have played none.
  const [played, setPlayed] = useState(new Set());
  const [message, setMessage] = useState('');
  const signedIn = Boolean(localStorage.getItem('userName'));

  useEffect(() => {
    let cancelled = false;
    fetchQuizStatuses().then((statuses) => {
      if (!cancelled) {
        setPlayed(new Set(Object.keys(statuses)));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const eligible = () => {
    if (mode === 'unplayed') {
      return quizzes.filter((quiz) => !played.has(quiz.slug));
    }
    if (mode === 'played') {
      return quizzes.filter((quiz) => played.has(quiz.slug));
    }
    return quizzes;
  };

  const emptyMessage = () => {
    if (mode === 'played') {
      return signedIn
        ? "You haven't finished a quiz yet — play one and it'll show up here."
        : 'Sign in and Norhog will keep track of the quizzes you have played.';
    }
    if (mode === 'unplayed') {
      return "You've played every quiz. Try a harder difficulty!";
    }
    return 'No quizzes available.';
  };

  const goRandom = () => {
    const pool = eligible();
    if (!pool.length) {
      setMessage(emptyMessage());
      return;
    }
    setMessage('');
    navigate(`/quiz/${pool[Math.floor(Math.random() * pool.length)].slug}`);
  };

  return (
    <div className="rec-random">
      <button type="button" className="rec-random-btn" onClick={goRandom}>
        Random
      </button>
      <select
        className="form-select rec-random-select"
        aria-label="Which quizzes the random button picks from"
        value={mode}
        onChange={(event) => {
          setMode(event.target.value);
          setMessage('');
          try {
            localStorage.setItem(MODE_KEY, event.target.value);
          } catch {
            // Private browsing can refuse writes; the picker still works, it
            // just will not remember the choice.
          }
        }}
      >
        <option value="any">Any quiz</option>
        <option value="unplayed">Unplayed</option>
        <option value="played">Played</option>
      </select>
      {message && (
        <p className="rec-random-msg" role="status">
          {message}
        </p>
      )}
    </div>
  );
}

export default RandomQuiz;
