import { useState, useEffect, useMemo } from 'react';
import { QuizCard, fetchQuizStatuses } from '../quizCard';
import { usePageTitle } from '../usePageTitle';
import '../main/main.css';
import { RandomQuiz } from '../randomQuiz';
import { PracticeBox } from './practiceBox';
import './gallery.css';

const sorts = {
  title: { label: 'A–Z', compare: (a, b) => a.title.localeCompare(b.title) },
  completed: {
    label: 'Not completed first',
    compare: (a, b) => (a.points || 0) - (b.points || 0) || a.title.localeCompare(b.title),
  },
};

export function Gallery() {
  usePageTitle('All Quizzes');
  const [quizzes, setQuizzes] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('title');

  useEffect(() => {
    fetch('/api/quizzes')
      .then((response) => {
        if (!response.ok) throw new Error('Request failed');
        return response.json();
      })
      .then(setQuizzes)
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));

    fetchQuizStatuses().then(setStatuses);
  }, []);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matched = term
      ? quizzes.filter(
          (quiz) =>
            quiz.title.toLowerCase().includes(term) ||
            (quiz.description || '').toLowerCase().includes(term)
        )
      : [...quizzes];
    return matched
      .map((quiz) => ({ ...quiz, points: statuses[quiz.slug]?.points }))
      .sort(sorts[sortBy].compare);
  }, [quizzes, statuses, search, sortBy]);

  return (
    <main className="container">
      <h2>All Quizzes</h2>
      <p>
        Every quiz is worth up to 10 points — finish a quiz at its best to mark it completed,
        and earn a star with a perfect run on all three difficulties.
      </p>

      <div className="gallery-controls">
        <input
          type="search"
          className="form-control gallery-search"
          placeholder="Search quizzes..."
          aria-label="Search quizzes"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="form-select gallery-sort"
          aria-label="Sort quizzes"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
        >
          {Object.entries(sorts).map(([key, { label }]) => (
            <option value={key} key={key}>{label}</option>
          ))}
        </select>
        {/* Picks from every quiz instead of the filtered list, so it behaves
            the same as in the Recommended boxes. */}
        <RandomQuiz quizzes={quizzes} className="gallery-random" />
        {/* Sits at the right end of the toolbar so it doesn't push the grid down. */}
        <PracticeBox />
      </div>

      {loading && <p>Loading quizzes...</p>}
      {failed && (
        <p className="gallery-message">
          Couldn&apos;t load the quiz list. Please refresh to try again.
        </p>
      )}
      {!loading && !failed && (
        <>
          <p className="gallery-count" aria-live="polite">
            {visible.length === quizzes.length
              ? `${quizzes.length} quizzes`
              : `${visible.length} of ${quizzes.length} quizzes`}
          </p>
          {visible.length === 0 ? (
            <p className="gallery-message">
              No quizzes match &ldquo;{search}&rdquo;. Try a different search.
            </p>
          ) : (
            <div className="quiz-grid gallery-grid">
              {visible.map((quiz) => (
                <QuizCard quiz={quiz} status={statuses[quiz.slug]} key={quiz.slug} />
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}

export default Gallery;
