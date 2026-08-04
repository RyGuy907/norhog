import { useCallback, useEffect, useState } from 'react';
import { QuizCard } from '../quizCard';
import { usePageTitle } from '../usePageTitle';
import './leaderboard.css';

export function Leaderboard() {
  usePageTitle('Leaderboard');
  const [scores, setScores] = useState([]);
  const [popular, setPopular] = useState([]);

  // Refetched whenever a score lands, so the sidebar stays in step with the
  // board beside it rather than going stale until a reload.
  const loadPopular = useCallback(() => {
    fetch('/api/quizzes/popular')
      .then((response) => (response.ok ? response.json() : []))
      .then(setPopular)
      .catch(() => {
        // A failed sidebar shouldn't disturb the leaderboard itself.
      });
  }, []);

  useEffect(() => {
    fetch('/api/scores')
      .then((response) => (response.ok ? response.json() : []))
      .then(setScores)
      .catch((error) => console.error('Error fetching scores:', error));
  }, []);

  useEffect(() => {
    loadPopular();
  }, [loadPopular]);

  useEffect(() => {
    let socket;
    let cancelled = false;
    let retry;

    const connect = () => {
      socket = new WebSocket(`${window.location.origin.replace(/^http/, 'ws')}/ws`);

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'updateScores') {
            setScores(message.allScores);
            loadPopular();
          }
        } catch {
          // A malformed frame shouldn't take the page down.
        }
      };

      socket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      // Reconnect if the connection drops (e.g. service restart).
      socket.onclose = () => {
        if (!cancelled) {
          retry = setTimeout(connect, 3000);
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      // Without clearing this, unmounting mid-backoff opens a stray socket.
      clearTimeout(retry);
      socket.close();
    };
    // loadPopular is stable (useCallback with no deps), so this still only
    // connects once — it is listed to keep the dependency check honest.
  }, [loadPopular]);

  const scoreRows = scores.length
    ? scores.map((score, index) => (
        <tr key={index}>
          <td>{index + 1}</td>
          <td>{score.name || 'Unknown'}</td>
          <td>{score.points}</td>
          <td>{score.quizzes}</td>
        </tr>
      ))
    : [
        <tr key="0">
          <td colSpan="4">Be the first to score!</td>
        </tr>,
      ];

  return (
    <main className="leaderboard-page text-center">
      <h1>Leaderboard</h1>
      <div className="row g-4">
        <div className="col-lg-7">
          <div className="table-responsive leaderboard-scroll">
            <table className="table table-striped">
              <thead className="table-dark">
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Name</th>
                  <th scope="col">Total Points</th>
                  <th scope="col">Quizzes Played</th>
                </tr>
              </thead>
              <tbody>{scoreRows}</tbody>
            </table>
          </div>
        </div>

        <div className="col-lg-5">
          <aside className="quiz-board text-start">
            <h2 className="quiz-board-heading">Most Played</h2>
            {popular.length === 0 ? (
              <p className="quiz-board-empty">No quizzes have been played yet.</p>
            ) : (
              <div className="quiz-board-grid quiz-board-grid-featured">
                {popular.map((quiz) => (
                  <QuizCard
                    key={quiz.slug}
                    quiz={quiz}
                    meta={`${quiz.plays} ${quiz.plays === 1 ? 'play' : 'plays'}`}
                  />
                ))}
              </div>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}

export default Leaderboard;
