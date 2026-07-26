import { useState, useEffect } from 'react';
import { QuizCard, fetchQuizStatuses } from '../quizCard';
import '../main/main.css';

export function Gallery() {
  const [quizzes, setQuizzes] = useState([]);
  const [statuses, setStatuses] = useState({});

  useEffect(() => {
    fetch('/api/quizzes')
      .then((response) => (response.ok ? response.json() : []))
      .then(setQuizzes)
      .catch(() => {});

    fetchQuizStatuses().then(setStatuses);
  }, []);

  return (
    <main className="container">
      <h2>All Quizzes</h2>
      <p>
        Every quiz is worth up to 10 points — finish a quiz at its best to mark it completed,
        and earn a star with a perfect run on all three difficulties.
      </p>
      <div className="quiz-grid gallery-grid">
        {quizzes.map((quiz) => (
          <QuizCard quiz={quiz} status={statuses[quiz.slug]} key={quiz.slug} />
        ))}
      </div>
    </main>
  );
}

export default Gallery;
