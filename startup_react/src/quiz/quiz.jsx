import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { shuffle } from '../shuffle';
import { normalize } from '../answerMatch';
import { lookup } from '../answerLock';
import { RandomQuiz } from '../randomQuiz';
import { usePageTitle } from '../usePageTitle';
import './quiz.css';

const emptyTimes = { easy: [], medium: [], hard: [] };

export function Quiz() {
  const { slug } = useParams();
  const navigate = useNavigate();

  const [quiz, setQuiz] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState('');
  usePageTitle(quiz?.title);
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
  // Display answers keyed by question index. An answer is only known once a
  // guess unlocks it or the server reveals the key at the end of the run.
  const [revealed, setRevealed] = useState({});
  const [missed, setMissed] = useState({});
  // Stats for all three difficulties are fetched once per quiz, so switching
  // difficulty doesn't wait on a request.
  const [timesByDifficulty, setTimesByDifficulty] = useState(emptyTimes);
  const [bestsByDifficulty, setBestsByDifficulty] = useState(null);
  const [gameSummary, setGameSummary] = useState(null);
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);
  // Token from the server that records when this run started.
  const [attemptId, setAttemptId] = useState(null);

  const userName = localStorage.getItem('userName');
  const fmtTime = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const questions = useMemo(
    () => (quiz ? quiz.difficulties[difficulty] : []),
    [quiz, difficulty]
  );

  const scores = timesByDifficulty[difficulty] || [];
  const myBest = useMemo(() => {
    if (!bestsByDifficulty) {
      return null;
    }
    const best = bestsByDifficulty[difficulty] || {};
    if (best.score == null && !(bestsByDifficulty.quizPoints > 0)) {
      return null;
    }
    return { ...best, quizPoints: bestsByDifficulty.quizPoints };
  }, [bestsByDifficulty, difficulty]);

  useEffect(() => {
    const loadQuiz = async () => {
      setNotFound(false);
      setLoadError(false);
      setActionError('');
      setQuiz(null);
      setDifficulty('medium');
      setIsTimerRunning(false);
      setShowAnswers(false);
      setShowOptions(true);
      setGameInfo(false);
      setUserAnswer('');
      setScore(0);
      setRevealed({});
      setMissed({});
      setAttemptId(null);
      setGameSummary(null);
      setShowLoginPrompt(false);

      try {
        const response = await fetch(`/api/quiz/${slug}`);
        if (response.ok) {
          setQuiz(await response.json());
        } else {
          setNotFound(true);
        }
      } catch (error) {
        // Shows an error instead of leaving the page on "Loading..." forever.
        console.error('Failed to fetch quiz:', error);
        setLoadError(true);
      }
    };

    loadQuiz();
  }, [slug]);

  const fetchMyBests = () => {
    if (!userName) {
      return;
    }
    fetch(`/api/scores/best?quiz=${slug}`)
      .then((response) => (response.ok ? response.json() : null))
      .then(setBestsByDifficulty)
      .catch(() => {});
  };

  // Loads every difficulty's times board and personal bests up front.
  useEffect(() => {
    setTimesByDifficulty(emptyTimes);
    setBestsByDifficulty(null);

    fetch(`/api/scores?quiz=${slug}`)
      .then((response) => (response.ok ? response.json() : emptyTimes))
      .then(setTimesByDifficulty)
      .catch(() => {});
    fetchMyBests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, userName]);

  useEffect(() => {
    fetch('/api/quizzes')
      .then((response) => (response.ok ? response.json() : []))
      .then(setAllQuizzes)
      .catch(() => {});
  }, []);

  useEffect(() => {
    setRecommended(shuffle(allQuizzes.filter((entry) => entry.slug !== slug)).slice(0, 4));
  }, [allQuizzes, slug]);

  // Ends the run. The server checks the reported score against the attempt,
  // takes the elapsed time from its own clock, and returns the full answer key.
  const finishGame = async (runAttemptId, finalScore) => {
    if (!runAttemptId) {
      setShowLoginPrompt(true);
      return;
    }

    try {
      const response = await fetch('/api/attempt/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attemptId: runAttemptId, score: finalScore }),
      });

      if (response.ok) {
        const data = await response.json();
        setMissed(Object.fromEntries(data.answers.map((answer, i) => [i, answer])));
        setGameSummary((prev) => ({ ...prev, ...data.summary }));
        if (data.scores) {
          setTimesByDifficulty((prev) => ({ ...prev, [data.summary.difficulty]: data.scores }));
          fetchMyBests();
        } else {
          setShowLoginPrompt(true);
        }
      } else {
        setActionError("Your run couldn't be saved, so the answers stayed hidden.");
      }
    } catch (error) {
      console.error('Failed to finish attempt:', error);
      setActionError("Your run couldn't be saved, so the answers stayed hidden.");
    }
  };

  const resetRun = () => {
    setScore(0);
    setRevealed({});
    setMissed({});
    setAttemptId(null);
  };

  const DifficultyChange = (event) => {
    setDifficulty(event.target.value);
    setShowAnswers(false);
    setGameSummary(null);
    resetRun();
  };

  const PlayClick = async () => {
    if (isTimerRunning || !quiz) {
      return;
    }

    // Guests get an attempt too, but it isn't scored at the end.
    let runAttemptId = null;
    try {
      const response = await fetch('/api/attempt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quiz: slug, difficulty }),
      });
      if (response.ok) {
        runAttemptId = (await response.json()).attemptId;
      }
    } catch (error) {
      console.error('Failed to start attempt:', error);
    }
    // Shows an error so a failed start doesn't make Play look broken.
    if (!runAttemptId) {
      setActionError("Couldn't start the quiz. Check your connection and try again.");
      return;
    }

    setActionError('');
    resetRun();
    setAttemptId(runAttemptId);
    setIsTimerRunning(true);
    setTimeLeft(quiz.timeLimits[difficulty]);
    setShowOptions(false);
    setShowAnswers(false);
    setGameInfo(true);
    setGameSummary(null);
    setShowLoginPrompt(false);
  };

  const endGame = (finalTimeLeft, runAttemptId, finalScore) => {
    setIsTimerRunning(false);
    setShowAnswers(true);
    setShowOptions(true);
    setGameInfo(false);
    // A local placeholder until the server's response fills in the final values.
    setGameSummary({
      score: finalScore,
      total: questions.length,
      timeSpent: quiz.timeLimits[difficulty] - finalTimeLeft,
      timeLimit: quiz.timeLimits[difficulty],
    });
    finishGame(runAttemptId, finalScore);
  };

  const EndClick = () => {
    endGame(timeLeft, attemptId, score);
  };

  // Guesses are matched locally against the locked answers, so typing doesn't
  // send any network requests. A guess only decrypts the answer it matches.
  const AnswerChange = async (value) => {
    setUserAnswer(value);
    const guess = normalize(value);
    if (!guess || !quiz) {
      return;
    }

    const { id, decrypt } = await lookup(quiz.salt, guess);
    const index = questions.findIndex(
      (entry, i) => revealed[i] === undefined && entry.locks.some((lock) => lock.id === id)
    );
    if (index === -1) {
      return;
    }

    const lock = questions[index].locks.find((entry) => entry.id === id);
    const answer = await decrypt(lock.c);
    const newScore = score + 1;
    setRevealed((prev) => ({ ...prev, [index]: answer }));
    setScore(newScore);
    setUserAnswer((current) => (current === value ? '' : current));

    if (newScore === questions.length) {
      endGame(timeLeft, attemptId, newScore);
    }
  };

  // Marks the document during a run so the stylesheet can hide the site nav on
  // a phone. The class is also removed on unmount, so leaving mid-run doesn't
  // leave it behind.
  useEffect(() => {
    if (!gameInfo) {
      return undefined;
    }
    document.body.classList.add('quiz-running');
    return () => document.body.classList.remove('quiz-running');
  }, [gameInfo]);

  // On iOS, opening the keyboard shrinks the visual viewport but not the layout
  // viewport, and sticky positioning follows the layout viewport. The answer bar
  // would end up hidden behind the keyboard, so visualViewport.offsetTop (the
  // gap between the two) is fed into the bar's `top`. Android supports
  // interactive-widget=resizes-content instead, so the offset stays 0 there.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!gameInfo || !viewport) {
      return undefined;
    }
    const sync = () => {
      document.documentElement.style.setProperty('--keyboard-offset', `${Math.max(0, viewport.offsetTop)}px`);
    };
    sync();
    viewport.addEventListener('resize', sync);
    viewport.addEventListener('scroll', sync);
    return () => {
      viewport.removeEventListener('resize', sync);
      viewport.removeEventListener('scroll', sync);
      document.documentElement.style.removeProperty('--keyboard-offset');
    };
  }, [gameInfo]);

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
      endGame(0, attemptId, score);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeLeft]);

  // Correct guesses flash green and answers missed at the end flash red. The
  // check and cross marks show the same result, so it doesn't rely on color alone.
  const answerCell = (index) => {
    if (revealed[index] !== undefined) {
      return (
        <td className="answer revealed-correct">
          <span className="answer-mark" aria-hidden="true">&#10003;</span>
          <span className="visually-hidden">Correct: </span>
          {revealed[index]}
        </td>
      );
    }
    if (showAnswers && missed[index] !== undefined) {
      return (
        <td className="answer revealed-missed">
          <span className="answer-mark" aria-hidden="true">&#10007;</span>
          <span className="visually-hidden">Missed: </span>
          {missed[index]}
        </td>
      );
    }
    return <td className="answer"></td>;
  };

  if (notFound) {
    return (
      <main className="container text-center">
        <p>Quiz not found — <Link to="/quizzes">browse the available quizzes</Link>.</p>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="container text-center">
        <h2>Couldn&apos;t load this quiz</h2>
        <p>Something went wrong reaching the server.</p>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>
          Try again
        </button>
      </main>
    );
  }

  if (!quiz) {
    return <main className="container">Loading...</main>;
  }

  // Quizzes with more than ten questions are split into two tables at the
  // halfway point, which reads better than one long scroll. Shorter ones stay in one.
  const halfSize = Math.ceil(questions.length / 2);
  const questionColumns = questions.length > 10
    ? [questions.slice(0, halfSize), questions.slice(halfSize)]
    : [questions];

  return (
    <main className="container">
      <div className="row">
        <div className="col-md-8">
          <h2>{quiz.title}</h2>
          {quiz.image && <img src={quiz.image} alt={quiz.title} className="quiz-header-image" />}
          {quiz.image && quiz.imageCaption && (
            <p className="quiz-image-caption">{quiz.imageCaption}</p>
          )}
          {quiz.description && <p>{quiz.description}</p>}
          {quiz.instructions && <p>{quiz.instructions}</p>}
          <h4>Fastest Times <span className="difficulty-tag">({difficulty})</span></h4>
          {scores.length === 0 ? (
            <p className="no-times">No perfect runs yet — be the first to answer them all!</p>
          ) : (
            <ul className="top-scores">
              {scores.map((entry, index) => (
                <li key={index}>
                  <strong>{entry.name || 'Unknown'}</strong>: {entry.timeSpent}s
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
                  Best score <span className="difficulty-tag">({difficulty})</span>:{' '}
                  <strong>{myBest.score != null ? `${myBest.score}/${myBest.total}` : '—'}</strong>
                  {' '}&middot; Best time <span className="difficulty-tag">({difficulty})</span>:{' '}
                  <strong>{myBest.bestTime != null ? fmtTime(myBest.bestTime) : '—'}</strong>
                  {' '}&middot; Toward your total:{' '}
                  <strong>{myBest.quizPoints} pts</strong>
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
              <output id="timer" aria-label="Time remaining">{fmtTime(timeLeft)}</output>
              <output id="score" aria-label="Score" aria-live="polite">
                {score}/{questions.length}
              </output>
              <input
                type="text"
                id="answerbox"
                aria-label="Type your answer"
                placeholder="Type answers here..."
                value={userAnswer}
                onChange={(e) => AnswerChange(e.target.value)}
                autoFocus
              />
              <button className="quiz-btn" onClick={EndClick}>End</button>
            </div>
          )}

          {actionError && <p className="quiz-error" role="alert">{actionError}</p>}

          {gameSummary && (
            <div className="game-summary" role="status" aria-live="polite">
              <h5>{gameSummary.score === gameSummary.total ? 'Perfect run!' : 'Game over'}</h5>
              <ul>
                <li>
                  Score: <strong>{gameSummary.score}/{gameSummary.total}</strong>
                </li>
                <li>
                  Time: <strong>{fmtTime(gameSummary.timeSpent)} / {fmtTime(gameSummary.timeLimit)}</strong>
                </li>
                {gameSummary.bestTime !== undefined && (
                  <li>
                    Best time <span className="difficulty-tag">({difficulty})</span>:{' '}
                    <strong>{gameSummary.bestTime != null ? fmtTime(gameSummary.bestTime) : '—'}</strong>
                  </li>
                )}
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

          <div className="answer-tables">
            {questionColumns.map((column, columnIndex) => (
              <table className="answer-table" key={columnIndex}>
                <thead>
                  <tr>
                    <th className="question">Question</th>
                    <th className="answerhead">Answer</th>
                  </tr>
                </thead>
                <tbody>
                  {column.map((entry, i) => (
                    <tr key={columnIndex * halfSize + i}>
                      <td className="question">{entry.question}</td>
                      {answerCell(columnIndex * halfSize + i)}
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
          </div>

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
              <RandomQuiz quizzes={allQuizzes.filter((entry) => entry.slug !== slug)} />
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
