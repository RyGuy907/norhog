import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';

// Upcoming daily quizzes, as the picker would build them from today's library.
// Excluding a question takes it out of the pool, and the days after it are
// rebuilt around the change. Today's quiz is fixed once anyone has loaded it.
export function DailyPreview() {
  const [days, setDays] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  // The question whose choices are being edited, and the draft wrong answers.
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(['', '', '']);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/daily/preview?days=14');
      if (!response.ok) {
        throw new Error();
      }
      setDays(await response.json());
      setError('');
    } catch {
      setError("Couldn't load the daily preview.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const exclude = async (q) => {
    if (!window.confirm(`Take this question out of the daily quiz?\n\n${q.question}`)) {
      return;
    }
    setBusy(q.key);
    try {
      const response = await fetch('/api/daily/exclude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: q.slug, level: q.level, index: q.index, question: q.question }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.msg || "Couldn't exclude that question.");
      }
      await load();
    } finally {
      setBusy('');
    }
  };

  const startEdit = (q) => {
    setEditing(q.key);
    setDraft(q.choices.filter((choice) => choice !== q.answer));
    setError('');
  };

  // Saves hand-written wrong answers, or clears them (an empty list) so the
  // automatic ones come back.
  const saveChoices = async (q, choices) => {
    setBusy(q.key);
    try {
      const response = await fetch('/api/daily/choices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: q.slug, level: q.level, index: q.index, question: q.question, choices }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(data?.msg || "Couldn't save those choices.");
        return;
      }
      setEditing(null);
      await load();
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="daily-preview">
      <h2>Upcoming Daily Quizzes</h2>
      <p className="review-note">
        The next two weeks as they stand. Excluding a question rebuilds the days after it, and
        edited choices apply from the next day built. A day that has already been served stays
        as it is.
      </p>
      {error && <div className="alert alert-danger">{error}</div>}
      {!days ? (
        <p>Loading...</p>
      ) : (
        days.map((day) => (
          <details className="daily-preview-day" key={day.date} open={day === days[0]}>
            <summary>
              <strong>#{day.number}</strong> {day.date}
              {day.stored && <span className="daily-preview-live"> · live</span>}
            </summary>
            <ol>
              {day.questions.map((q) => (
                <li key={q.key}>
                  <div className="daily-preview-source">
                    <Link to={`/quiz/${q.slug}`}>{q.title}</Link> · {q.level} #{q.index + 1}
                  </div>
                  {q.leads.map((lead, i) => (
                    <div className="daily-preview-lead" key={i}>
                      {lead.question} <strong>{lead.answer}</strong>
                    </div>
                  ))}
                  <div className="daily-preview-question">{q.question}</div>
                  {editing === q.key ? (
                    <div className="daily-preview-edit">
                      <span className="is-answer">{q.answer}</span>
                      {draft.map((choice, i) => (
                        <input
                          key={i}
                          className="form-control form-control-sm"
                          aria-label={`Wrong answer ${i + 1}`}
                          value={choice}
                          onChange={(e) => setDraft(draft.map((c, j) => (j === i ? e.target.value : c)))}
                        />
                      ))}
                      <div className="daily-preview-actions">
                        <button className="btn btn-sm btn-primary" disabled={busy === q.key} onClick={() => saveChoices(q, draft)}>
                          Save choices
                        </button>
                        {q.authoredChoices && (
                          <button className="btn btn-sm btn-outline-secondary" disabled={busy === q.key} onClick={() => saveChoices(q, [])}>
                            Use automatic choices
                          </button>
                        )}
                        <button className="btn btn-sm btn-link" onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="daily-preview-choices">
                        {q.choices.map((choice) => (
                          <span key={choice} className={choice === q.answer ? 'is-answer' : ''}>{choice}</span>
                        ))}
                        {q.authoredChoices && <em className="daily-preview-tag">hand-written</em>}
                      </div>
                      <div className="daily-preview-actions">
                        <button className="btn btn-sm btn-outline-secondary" onClick={() => startEdit(q)}>
                          Edit choices
                        </button>
                        <button
                          className="btn btn-sm btn-outline-danger"
                          disabled={busy === q.key}
                          onClick={() => exclude(q)}
                        >
                          Exclude from daily
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ol>
          </details>
        ))
      )}
    </section>
  );
}
