import { Link } from 'react-router-dom';
import './about.css';

export function About() {
  return (
    <main className="container about-page">
      <h2>About Norhog</h2>
      <p>
        Norhog is a timed history quiz site. Pick a quiz, pick a difficulty, and race the clock —
        type an answer and press enter, and if it&apos;s right it&apos;s revealed instantly.
      </p>

      <h4>Scoring</h4>
      <p>
        Every quiz is worth up to <strong>10 points</strong> toward your total: easy runs max out at
        6 points, medium at 8, and hard at 10, scaled by how many questions you get right. Each quiz
        only counts once — retake it as often as you like and your best run is the one that counts.
        The <Link to="/leaderboard">leaderboard</Link> ranks players by total points across all quizzes.
      </p>

      <h4>Want to add a quiz?</h4>
      <p>
        Anyone with an account can <Link to="/suggest">suggest a quiz</Link> — write the questions,
        answers, and description, and it goes to the review queue. Approved suggestions become real
        quizzes on the site.
      </p>

      <h4>How it&apos;s built</h4>
      <p>
        React and Vite on the front, Node.js and Express behind a REST API, MongoDB Atlas for
        storage, WebSockets for live leaderboard updates, and bcrypt-hashed credentials with
        httpOnly session cookies. Hosted on AWS.
      </p>
    </main>
  );
}

export default About;
