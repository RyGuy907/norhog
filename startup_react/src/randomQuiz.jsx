import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchQuizStatuses } from './quizCard';

// A "Random" button and a selector for which quizzes it picks from, shown at
// the bottom of every Recommended Quizzes box.
//
// `quizzes` is the pool to choose from, so each page decides what is eligible.
// The quiz page, for example, passes every quiz except the current one.
const MODES = ['any', 'unplayed', 'played'];
const MODE_KEY = 'norhog.randomMode';

// The mode is saved because each press navigates away and remounts this
// component, which would otherwise reset the selector to "any" every time.
// It is checked on read since localStorage can hold anything, and an unknown
// value would filter the pool down to nothing.
const storedMode = () => {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    return MODES.includes(saved) ? saved : 'any';
  } catch {
    return 'any';
  }
};

export function RandomQuiz({ quizzes, className = '' }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState(storedMode);
  // Slugs the signed-in user has finished. Guests get an empty set, so for them
  // "unplayed" works the same as "any".
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
        ? "You haven't finished a quiz yet. Play one and it'll show up here."
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
    <div className={`rec-random${className ? ` ${className}` : ''}`}>
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
            // Private browsing can refuse the write. The picker still works but
            // won't remember the choice.
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
