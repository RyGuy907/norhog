import { useState } from 'react';
import { Link } from 'react-router-dom';

// A quiz tile. status = {points, perfectCount} from /api/scores/me (or undefined).
// Completed (best possible 10 points) tiles grey out; a star marks perfect
// runs on all three difficulties.
// meta is optional supporting text shown beneath the title in the same overlay
// (the leaderboard's Most Played board uses it for the play count).
export function QuizCard({ quiz, status, meta }) {
  const completed = status?.points === 10;
  const starred = status?.perfectCount === 3;
  // Tall images are cropped from the top so the subject's head stays in
  // frame; measured on load so any uploaded image is handled automatically.
  // A quiz can override that with imagePosition (a CSS object-position) when
  // the automatic crop puts the subject behind the title band or off-frame.
  const [portrait, setPortrait] = useState(false);
  const focal = quiz.imagePosition || '';

  return (
    <Link to={`/quiz/${quiz.slug}`} className={`quiz-card${completed ? ' completed' : ''}`}>
      {completed && <span className="completed-badge">Completed!</span>}
      {starred && <span className="quiz-star" title="Perfect on every difficulty">&#9733;</span>}
      {quiz.image && (
        <img
          src={quiz.image}
          alt=""
          loading="lazy"
          className={`quiz-card-image${!focal && portrait ? ' portrait' : ''}`}
          style={focal ? { objectPosition: focal } : undefined}
          onLoad={(e) => setPortrait(e.target.naturalHeight > e.target.naturalWidth)}
        />
      )}
      <div className="quiz-card-body">
        <h3>{quiz.title}</h3>
        {meta && <span className="quiz-card-meta">{meta}</span>}
      </div>
    </Link>
  );
}

// Fetches the logged-in user's per-quiz status as a {slug: status} map.
// eslint-disable-next-line react-refresh/only-export-components
export async function fetchQuizStatuses() {
  if (!localStorage.getItem('userName')) {
    return {};
  }
  try {
    const response = await fetch('/api/scores/me');
    if (!response.ok) {
      return {};
    }
    const data = await response.json();
    const map = {};
    for (const entry of data.scores) {
      map[entry.quiz] = entry;
    }
    return map;
  } catch {
    return {};
  }
}
