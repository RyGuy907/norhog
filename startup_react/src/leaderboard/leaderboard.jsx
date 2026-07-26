import { useEffect, useState } from 'react';
import './leaderboard.css';

export function Leaderboard() {
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

    const connect = () => {
      socket = new WebSocket(`${window.location.origin.replace(/^http/, 'ws')}/ws`);

      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'updateScores') {
          setScores(message.allScores);
        }
      };

      socket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      // Reconnect if the connection drops (e.g. service restart).
      socket.onclose = () => {
        if (!cancelled) {
          setTimeout(connect, 3000);
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      socket.close();
    };
  }, []);

  const scoreRows = scores.length
    ? scores.map((score, index) => (
        <tr key={index}>
          <td>{index + 1}</td>
          <td>{score.user || 'Unknown'}</td>
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
      <table className="table table-striped">
        <thead className="table-dark">
          <tr>
            <th>#</th>
            <th>Name</th>
            <th>Total Points</th>
            <th>Quizzes Played</th>
          </tr>
        </thead>
        <tbody>{scoreRows}</tbody>
      </table>
    </main>
  );
}

export default Leaderboard;
