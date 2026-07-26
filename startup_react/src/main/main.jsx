import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { shuffle } from '../shuffle';
import { QuizCard, fetchQuizStatuses } from '../quizCard';
import './main.css';

export function Main() {
  const navigate = useNavigate();
  const [quizzes, setQuizzes] = useState([]);
  const [recommended, setRecommended] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [featured, setFeatured] = useState([]);
  const [galleryImage, setGalleryImage] = useState('');

  useEffect(() => {
    fetch('/api/quizzes')
      .then((response) => (response.ok ? response.json() : []))
      .then((data) => {
        setQuizzes(data);
        setFeatured(shuffle(data).slice(0, 8));
        setRecommended(shuffle(data).slice(0, 4));
        const images = data.filter((quiz) => quiz.image);
        if (images.length) {
          setGalleryImage(images[Math.floor(Math.random() * images.length)].image);
        }
      })
      .catch(() => {});

    fetchQuizStatuses().then(setStatuses);
  }, []);

  return (
    <main className="container">
      <div className="hero">
        <h1>Welcome to Norhog</h1>
        <p className="tagline">Race the clock. Know your history. Climb the leaderboard.</p>
      </div>

      <div className="row">
        <div className="col-md-8">
          <h2>Quizzes</h2>
          <div className="quiz-grid">
            {featured.map((quiz) => (
              <QuizCard quiz={quiz} status={statuses[quiz.slug]} key={quiz.slug} />
            ))}
            <Link
              to="/quizzes"
              className="quiz-card view-all-card"
              style={
                galleryImage
                  ? { backgroundImage: `linear-gradient(160deg, rgba(29, 58, 87, 0.82), rgba(18, 38, 58, 0.92)), url(${galleryImage})` }
                  : undefined
              }
            >
              <span className="view-all-count">{quizzes.length}</span>
              <h3>View All Quizzes</h3>
              <p>Browse the full gallery &rarr;</p>
            </Link>
          </div>
        </div>

        <div className="col-md-4">
          <div className="rec-box">
            <h4>Recommended Quizzes</h4>
            <ul className="recquiz list-group">
              {recommended.map((quiz) => (
                <li className="recquiz list-group-item" key={quiz.slug}>
                  <button className="btn" onClick={() => navigate(`/quiz/${quiz.slug}`)}>
                    {quiz.title}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="suggest-box">
            <h4>Have a quiz idea?</h4>
            <p>
              Anyone can write a quiz for Norhog — submit your questions and an admin will
              review them for the site.
            </p>
            <Link to="/suggest" className="btn btn-primary">Suggest a Quiz</Link>
          </div>

          <div className="suggest-box learn-box">
            <h4>New to Norhog?</h4>
            <p>
              See how scoring works, what the leaderboard tracks, and how the site is built.
            </p>
            <Link to="/about" className="btn btn-primary">Learn More</Link>
          </div>
        </div>
      </div>
    </main>
  );
}
