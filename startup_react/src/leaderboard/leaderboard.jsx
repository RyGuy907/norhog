import { useEffect, useState } from 'react';
import { usePageTitle } from '../usePageTitle';
import './leaderboard.css';

export function Leaderboard() {
  usePageTitle('Leaderboard');
  const [scores, setScores] = useState([]);

  useEffect(() => {
    fetch('/api/scores')
      .then((response) => (response.ok ? response.json() : []))
      .then(setScores)
      .catch((error) => console.error('Error fetching scores:', error));
  }, []);

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
  }, []);

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
      <div className="table-responsive">
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
    </main>
  );
}

export default Leaderboard;
