import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { shuffle } from '../shuffle';
import { normalize, acceptedAnswers } from '../answerMatch';
import './quiz.css';

export function Quiz() {
  const { slug } = useParams();
  const navigate = useNavigate();

  const [quiz, setQuiz] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [allQuizzes, setAllQuizzes] = useState([]);
  const [recommended, setRecommended] = useState([]);

  const [difficulty, setDifficulty] = useState('medium');
  const [timeLeft, setTimeLeft] = useState(0);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [showAnswers, setShowAnswers] = useState(false);
  const [showOptions, setShowOptions] = useState(true);
  const [gameInfo, setGameInfo] = useState(false);
  const [userAnswer, setUserAnswer] = useState('');
  const [score, setScore] = useState(0);
  const [answeredIndexes, setAnsweredIndexes] = useState([]);
  const [scores, setScores] = useState([]);
  const [myBest, setMyBest] = useState(null);
  const [gameSummary, setGameSummary] = useState(null);
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);

  const userName = localStorage.getItem('userName');
  const questions = useMemo(
    () => (quiz ? quiz.difficulties[difficulty] : []),
    [quiz, difficulty]
  );
  const acceptSets = useMemo(() => questions.map((entry) => acceptedAnswers(entry)), [questions]);

  useEffect(() => {
    const loadQuiz = async () => {
      setNotFound(false);
      setQuiz(null);
      setDifficulty('medium');
      setIsTimerRunning(false);
      setShowAnswers(false);
      setShowOptions(true);
      setGameInfo(false);
      setUserAnswer('');
      setScore(0);
      setAnsweredIndexes([]);
      setGameSummary(null);
      setShowLoginPrompt(false);

      try {
        const response = await fetch(`/api/quiz/${slug}`);
        if (response.ok) {
          const data = await response.json();
          setQuiz(data);
          setTimeLeft(data.timeLimit);
        } else {
          setNotFound(true);
        }
      } catch (error) {
        console.error('Failed to fetch quiz:', error);
      }
    };

    loadQuiz();
  }, [slug]);

  const fetchMyBest = () => {
    if (!userName) {
      return;
    }
    fetch(`/api/scores/best?quiz=${slug}&difficulty=${difficulty}`)
      .then((response) => (response.ok ? response.json() : {}))
      .then((data) => setMyBest(data.score != null ? data : null))
      .catch(() => {});
  };

  // The fastest-times board and personal best track the selected difficulty.
  useEffect(() => {
    setMyBest(null);
    fetch(`/api/scores?quiz=${slug}&difficulty=${difficulty}`)
      .then((response) => (response.ok ? response.json() : []))
      .then(setScores)
      .catch(() => {});
    fetchMyBest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, difficulty]);

  useEffect(() => {
    fetch('/api/quizzes')
      .then((response) => (response.ok ? response.json() : []))
      .then(setAllQuizzes)
      .catch(() => {});
  }, []);

  useEffect(() => {
    setRecommended(shuffle(allQuizzes.filter((entry) => entry.slug !== slug)).slice(0, 4));
  }, [allQuizzes, slug]);

  const submitScore = async (newScore) => {
    if (!userName) {
      setShowLoginPrompt(true);
      return;
    }

    try {
      const response = await fetch('/api/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newScore),
      });

      if (response.ok) {
        const data = await response.json();
        setScores(data.scores);
        setGameSummary((prev) => ({ ...prev, ...data.summary }));
        fetchMyBest();
      } else if (response.status === 401) {
        setShowLoginPrompt(true);
      }
    } catch (error) {
      console.error('Failed to submit score:', error);
    }
  };

  const DifficultyChange = (event) => {
    setDifficulty(event.target.value);
    setShowAnswers(false);
    setScore(0);
    setAnsweredIndexes([]);
    setGameSummary(null);
  };

  const PlayClick = () => {
    if (!isTimerRunning && quiz) {
      setIsTimerRunning(true);
      setTimeLeft(quiz.timeLimit);
      setShowOptions(false);
      setShowAnswers(false);
      setGameInfo(true);
      setScore(0);
      setAnsweredIndexes([]);
      setGameSummary(null);
      setShowLoginPrompt(false);
    }
  };

  const endGame = (finalScore, finalTimeLeft) => {
    setIsTimerRunning(false);
    setShowAnswers(true);
    setShowOptions(true);
    setGameInfo(false);
    // Local summary first; the server response adds points earned/gained.
    setGameSummary({
      score: finalScore,
      total: questions.length,
      timeSpent: quiz.timeLimit - finalTimeLeft,
    });
    submitScore({ quiz: slug, score: finalScore, difficulty, timeLeft: finalTimeLeft });
  };

  const EndClick = () => {
    endGame(score, timeLeft);
  };

  // Answers auto-submit: a correct guess is counted the moment it's typed.
  // Guesses are normalized, and each question accepts its full answer plus
  // any shortcuts (last names, roman/arabic numerals, etc.).
  const AnswerChange = (value) => {
    setUserAnswer(value);
    const guess = normalize(value);
    if (!guess) return;

    const index = acceptSets.findIndex(
      (accepted, i) => accepted.has(guess) && !answeredIndexes.includes(i)
    );

    if (index !== -1) {
      const newScore = score + 1;
      setScore(newScore);
      setAnsweredIndexes((prev) => [...prev, index]);
      setUserAnswer('');

      if (newScore === questions.length) {
        endGame(newScore, timeLeft);
      }
    }
  };

  useEffect(() => {
    if (!isTimerRunning) {
      return;
    }
    const timer = setInterval(() => {
      setTimeLeft((prevTime) => prevTime - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [isTimerRunning]);

  useEffect(() => {
    if (isTimerRunning && timeLeft === 0) {
      endGame(score, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeLeft]);

  // Guessed answers flash gold; unguessed ones flash brick red when revealed.
  const answerCell = (entry, index) => {
    if (answeredIndexes.includes(index)) {
      return <td className="answer revealed-correct">{entry.answer}</td>;
    }
    if (showAnswers) {
      return <td className="answer revealed-missed">{entry.answer}</td>;
    }
    return <td className="answer"></td>;
  };

  if (notFound) {
    return (
      <main className="container text-center">
        <p>Quiz not found — <Link to="/">browse the available quizzes</Link>.</p>
      </main>
    );
  }

  if (!quiz) {
    return <main className="container">Loading...</main>;
  }

  return (
    <main className="container">
      <div className="row">
        <div className="col-md-8">
          <h2>{quiz.title}</h2>
          {quiz.image && <img src={quiz.image} alt={quiz.title} className="quiz-header-image" />}
          {quiz.description && <p>{quiz.description}</p>}
          {quiz.instructions && <p>{quiz.instructions}</p>}
          <h4>Fastest Times <span className="difficulty-tag">({difficulty})</span></h4>
          {scores.length === 0 ? (
            <p className="no-times">No perfect runs yet — be the first to answer them all!</p>
          ) : (
            <ul className="top-scores">
              {scores.map((entry, index) => (
                <li key={index}>
                  <strong>{entry.user}</strong>: {entry.timeSpent}s
                </li>
              ))}
            </ul>
          )}
          {showLoginPrompt && (
            <p className="login-prompt">
              <Link to="/profile">Log in</Link> to save your score to the leaderboard.
            </p>
          )}
          {showOptions && (
            <>
              {myBest && (
                <p className="my-best">
                  Your best <span className="difficulty-tag">({difficulty})</span>:{' '}
                  <strong>{myBest.score}/{myBest.total}</strong> &middot; {myBest.points} points
                </p>
              )}
              <fieldset className="difficulty">
                {['easy', 'medium', 'hard'].map((level) => (
                  <span key={level}>
                    <input
                      type="radio"
                      id={`radio-${level}`}
                      name="varRadio"
                      value={level}
                      checked={difficulty === level}
                      onChange={DifficultyChange}
                    />
                    <label htmlFor={`radio-${level}`} className={difficulty === level ? 'selected' : ''}>
                      {level.charAt(0).toUpperCase() + level.slice(1)}
                    </label>
                  </span>
                ))}
              </fieldset>

              <button className="quiz-btn" onClick={PlayClick}>Play</button>
            </>
          )}
          {gameInfo && (
            <div className="game-bar">
              <input type="text" id="timer" value={`${Math.floor(timeLeft / 60)}:${String(timeLeft % 60).padStart(2, '0')}`} readOnly />
              <input type="text" id="score" value={`${score}/${questions.length}`} readOnly />
              <input
                type="text"
                id="answerbox"
                placeholder="Type answers here..."
                value={userAnswer}
                onChange={(e) => AnswerChange(e.target.value)}
                autoFocus
              />
              <button className="quiz-btn" onClick={EndClick}>End</button>
            </div>
          )}

          {gameSummary && (
            <div className="game-summary">
              <h5>{gameSummary.score === gameSummary.total ? 'Perfect run!' : 'Game over'}</h5>
              <ul>
                <li>
                  Score: <strong>{gameSummary.score}/{gameSummary.total}</strong>
                </li>
                <li>
                  Time: <strong>{gameSummary.timeSpent}s</strong>
                </li>
                {gameSummary.points != null && (
                  <li>
                    This run: <strong>{gameSummary.points} point{gameSummary.points === 1 ? '' : 's'}</strong>
                  </li>
                )}
                {gameSummary.pointsGained != null && (
                  <li>
                    Total points:{' '}
                    <strong>
                      {gameSummary.pointsGained > 0 ? `+${gameSummary.pointsGained}` : 'no change'}
                    </strong>
                  </li>
                )}
              </ul>
            </div>
          )}

          <table className="answer-table">
            <thead>
              <tr>
                <th className="question">Question</th>
                <th className="answerhead">Answer</th>
              </tr>
            </thead>
            <tbody>
              {questions.map((entry, index) => (
                <tr key={index}>
                  <td className="question">{entry.question}</td>
                  {answerCell(entry, index)}
                </tr>
              ))}
            </tbody>
          </table>

        </div>

        {recommended.length > 0 && (
          <div className="col-md-4">
            <div className="rec-box">
              <h4>Recommended Quizzes</h4>
              <ul className="recquiz list-group">
                {recommended.map((entry) => (
                  <li className="recquiz list-group-item" key={entry.slug}>
                    <button className="btn" onClick={() => navigate(`/quiz/${entry.slug}`)}>
                      {entry.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
