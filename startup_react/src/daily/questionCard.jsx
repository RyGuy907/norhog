import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { normalize } from '../answerMatch';
import { outcomeLabels, outcomeMarks, outcomePoints } from './dailyShare';

const levelNames = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

// A check or cross, coloured by how the question was answered.
export function Mark({ outcome }) {
  return <span className={`daily-mark mark-${outcome}`} aria-hidden="true">{outcomeMarks[outcome]}</span>;
}

export function ProgressPips({ total, results, current }) {
  return (
    <ol className="daily-pips" aria-label="Progress">
      {Array.from({ length: total }, (_, i) => {
        const result = results[i];
        const state = result ? `pip-${result}` : i === current ? 'pip-current' : '';
        return (
          <li key={i} className={`daily-pip ${state}`}>
            {result ? <Mark outcome={result} /> : <span aria-hidden="true">{i + 1}</span>}
            <span className="visually-hidden">
              Question {i + 1}: {result ? outcomeLabels[result] : i === current ? 'current' : 'not yet played'}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// One question, answered by typing or from the choices. Used by the daily
// quiz and by practice rounds.
export function QuestionCard({ number, total, entry, results, choicesOpened, onOpenChoices, onResolve, onNext, isLast }) {
  const [guess, setGuess] = useState('');
  const showChoices = choicesOpened;
  const [picked, setPicked] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [hint, setHint] = useState('');
  const nextButton = useRef(null);

  const accepted = new Set(entry.accepted);

  const resolve = (result) => {
    setOutcome(result);
    onResolve(result);
  };

  useEffect(() => {
    if (outcome) {
      nextButton.current?.focus();
    }
  }, [outcome]);

  // Like the full quizzes, a typed answer counts the moment it matches.
  const onType = (value) => {
    setGuess(value);
    setHint('');
    if (!outcome && accepted.has(normalize(value))) {
      resolve('typed');
    }
  };

  const onSubmit = (event) => {
    event.preventDefault();
    if (!outcome && guess.trim()) {
      setHint('Not quite. Try another spelling, or show the choices.');
    }
  };

  const onPick = (choice) => {
    if (outcome) return;
    setPicked(choice);
    resolve(choice === entry.answer ? 'choice' : 'miss');
  };

  const currentResults = outcome ? [...results.slice(0, number - 1), outcome] : results;

  return (
    <section className="daily-card" aria-labelledby="daily-question-text">
      <ProgressPips total={total} results={currentResults} current={number - 1} />

      <div className="daily-meta">
        <span className="daily-source">{entry.title}</span>
        <span className={`daily-level level-${entry.level}`}>{levelNames[entry.level]}</span>
        {/* What the question is still worth: 2 typed, 1 once the choices are open. */}
        {!outcome && <span className="daily-worth">{showChoices ? '1 pt' : '2 pts'}</span>}
      </div>

      {entry.leads.length > 0 && (
        <div className="daily-leads">
          <p className="daily-leads-label">Context in this quiz</p>
          {entry.leads.map((lead, i) => (
            <p className="daily-lead" key={i}>
              {lead.question} <strong>{lead.answer}</strong>
            </p>
          ))}
        </div>
      )}

      <p className="daily-question" id="daily-question-text">
        <span className="daily-qnum">{number}.</span> {entry.question}
      </p>

      {!showChoices && !outcome && (
        <form className="daily-answer" onSubmit={onSubmit}>
          <input
            type="text"
            className="daily-input"
            aria-label="Your answer"
            placeholder="Type your answer..."
            value={guess}
            onChange={(e) => onType(e.target.value)}
            autoFocus
            autoComplete="off"
            autoCapitalize="off"
            spellCheck="false"
          />
          {hint && <p className="daily-hint" role="status">{hint}</p>}
          <div className="daily-actions">
            <button type="button" className="btn btn-outline-secondary" onClick={onOpenChoices}>
              Show choices <span className="daily-points">(1 pt)</span>
            </button>
          </div>
        </form>
      )}

      {(showChoices || (outcome && picked)) && (
        <div className="daily-choices" role="group" aria-label="Choices">
          {entry.choices.map((choice) => {
            let state = '';
            if (outcome) {
              if (choice === entry.answer) state = 'choice-correct';
              else if (choice === picked) state = 'choice-wrong';
            }
            return (
              <button
                key={choice}
                type="button"
                className={`daily-choice ${state}`}
                onClick={() => onPick(choice)}
                disabled={Boolean(outcome)}
                autoFocus={!outcome && choice === entry.choices[0]}
              >
                {choice}
              </button>
            );
          })}
        </div>
      )}

      {outcome && (
        <div className={`daily-feedback feedback-${outcome}`} role="status">
          <p className="daily-verdict">
            <Mark outcome={outcome} /> {outcome === 'miss' ? 'Incorrect' : 'Correct!'}
          </p>
          <p className="daily-reveal">
            The answer: <strong>{entry.answer}</strong>
          </p>
          <p className="daily-source-link">
            From <Link to={`/quiz/${entry.slug}`} target="_blank" rel="noopener">{entry.title}</Link>. Play the full quiz later.
          </p>
          <button ref={nextButton} className="quiz-btn" onClick={onNext}>
            {isLast ? 'See my results' : 'Next question'}
          </button>
        </div>
      )}
    </section>
  );
}

// The end-of-round list: each question, its answer, and the points it earned.
export function ResultRecap({ questions, results }) {
  return (
    <ol className="daily-recap">
      {questions.map((entry, i) => (
        <li key={i}>
          <Mark outcome={results[i]} />
          <span className="visually-hidden">{outcomeLabels[results[i]]}: </span>
          <span className="daily-recap-body">
            <span className="daily-recap-q">{entry.question}</span>
            <span className="daily-recap-a">
              {entry.answer} &middot; <Link to={`/quiz/${entry.slug}`}>{entry.title}</Link>
            </span>
          </span>
          <span className={`daily-recap-points points-${results[i]}`}>
            +{outcomePoints[results[i]]}
            <span className="visually-hidden"> {outcomePoints[results[i]] === 1 ? 'point' : 'points'}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
