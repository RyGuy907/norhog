import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { QuizForm, emptyQuizForm } from '../quizForm/quizForm';
import { usePageTitle } from '../usePageTitle';

export function Suggest() {
  usePageTitle('Suggest a Quiz');
  const [loggedIn, setLoggedIn] = useState(null); // null = checking
  const [submitted, setSubmitted] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    fetch('/api/auth/me')
      .then((response) => setLoggedIn(response.ok))
      .catch(() => setLoggedIn(false));
  }, []);

  const save = async (payload) => {
    setErrorMsg('');
    try {
      const response = await fetch('/api/suggestion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        setSubmitted(true);
      } else {
        const data = await response.json().catch(() => null);
        setErrorMsg(data?.msg || 'Failed to submit suggestion');
      }
    } catch (error) {
      console.error('Failed to submit suggestion:', error);
      setErrorMsg('Failed to submit suggestion');
    }
  };

  if (loggedIn === null) {
    return <main className="container">Loading...</main>;
  }

  if (!loggedIn) {
    return (
      <main className="container text-center">
        <h2>Suggest a Quiz</h2>
        <p>
          You need an account to suggest a quiz — <Link to="/profile">log in or sign up</Link> first.
        </p>
      </main>
    );
  }

  if (submitted) {
    return (
      <main className="container text-center">
        <h2>Thanks!</h2>
        <p>Your quiz suggestion is in the review queue. If an admin approves it, it will appear on the site.</p>
        <p>
          <button className="btn btn-primary" onClick={() => setSubmitted(false)}>
            Suggest another
          </button>
        </p>
      </main>
    );
  }

  return (
    <main className="container">
      <h2>Suggest a Quiz</h2>
      <p>
        Build your quiz below — a short URL name, a title, and questions with answers for each difficulty.
        An admin will review it before it goes live.
      </p>
      <QuizForm
        key={submitted ? 'again' : 'first'}
        initial={emptyQuizForm()}
        slugLocked={false}
        allowUpload={false}
        submitLabel="Submit Suggestion"
        errorMsg={errorMsg}
        onSave={save}
        onCancel={() => window.history.back()}
      />
    </main>
  );
}

export default Suggest;
