import { useState } from 'react';
import { Link } from 'react-router-dom';

// A quiz tile. `status` is {points, perfectCount} from /api/scores/me, or
// undefined for guests. Tiles with the full 10 points are greyed out as
// completed, and a star marks perfect runs on all three difficulties. `meta` is
// optional text under the title, which the Most Played board uses for play counts.
export function QuizCard({ quiz, status, meta }) {
  const completed = status?.points === 10;
  const starred = status?.perfectCount === 3;
  // Tall images are cropped from the top so the subject's face stays in frame.
  // The shape is measured on load, so uploaded images are handled too. A quiz
  // can set imagePosition (a CSS object-position) when that crop doesn't work.
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
