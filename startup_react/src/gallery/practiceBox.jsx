import { Link } from 'react-router-dom';

// Practice rounds in the quizzes toolbar, built like the home page's
// collapsible sidebar boxes (.suggest-box): a title with an arrow, and the
// description and start button inside. Its contents open over the grid, so
// opening it doesn't shift the toolbar or the quizzes.
export function PracticeBox() {
  return (
    <details className="suggest-box gallery-practice">
      <summary><h4>Practice quizzes</h4></summary>
      <div className="gallery-practice-panel">
        <p>Untimed questions from every quiz with optional multiple choice</p>
        <Link to="/practice" className="btn btn-primary">Start practicing</Link>
      </div>
    </details>
  );
}
