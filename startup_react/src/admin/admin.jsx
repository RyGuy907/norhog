import { useState, useEffect } from 'react';
import { QuizForm, emptyQuizForm } from '../quizForm/quizForm';
import { usePageTitle } from '../usePageTitle';
import './admin.css';

export function Admin() {
  usePageTitle('Admin');
  const [isAdmin, setIsAdmin] = useState(null); // null = checking
  const [quizzes, setQuizzes] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [formInitial, setFormInitial] = useState(null); // null = list view
  const [editingSlug, setEditingSlug] = useState(null);
  const [reviewingId, setReviewingId] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');

  const loadQuizzes = async () => {
    try {
      const response = await fetch('/api/quizzes');
      if (response.ok) {
        setQuizzes(await response.json());
      }
    } catch (error) {
      console.error('Failed to fetch quizzes:', error);
    }
  };

  const loadSuggestions = async () => {
    try {
      const response = await fetch('/api/suggestions');
      if (response.ok) {
        setSuggestions(await response.json());
      }
    } catch (error) {
      console.error('Failed to fetch suggestions:', error);
    }
  };

  useEffect(() => {
    const checkRole = async () => {
      try {
        const response = await fetch('/api/auth/me');
        if (response.ok) {
          const data = await response.json();
          const admin = data.role === 'admin';
          setIsAdmin(admin);
          if (admin) {
            loadQuizzes();
            loadSuggestions();
          }
        } else {
          setIsAdmin(false);
        }
      } catch {
        setIsAdmin(false);
      }
    };
    checkRole();
  }, []);

  const backToList = () => {
    setFormInitial(null);
    setEditingSlug(null);
    setReviewingId(null);
    setErrorMsg('');
  };

  const startCreate = () => {
    setFormInitial(emptyQuizForm());
    setEditingSlug(null);
    setReviewingId(null);
    setErrorMsg('');
  };

  const startEdit = async (slug) => {
    try {
      // The public quiz payload omits answers, so editing loads the full one.
      const response = await fetch(`/api/quiz/${slug}/full`);
      if (response.ok) {
        setFormInitial(await response.json());
        setEditingSlug(slug);
        setReviewingId(null);
        setErrorMsg('');
      }
    } catch (error) {
      console.error('Failed to fetch quiz:', error);
    }
  };

  const startReview = (suggestion) => {
    setFormInitial({
      slug: suggestion.slug || '',
      title: suggestion.title || '',
      image: suggestion.image || '',
      description: suggestion.description || '',
      instructions: suggestion.instructions || '',
      timeLimits: suggestion.timeLimits,
      difficulties: suggestion.difficulties,
    });
    setEditingSlug(null);
    setReviewingId(suggestion._id);
    setErrorMsg('');
  };

  const rejectSuggestion = async (suggestion) => {
    if (!window.confirm(`Reject the "${suggestion.title}" suggestion from ${suggestion.suggestedBy}?`)) {
      return;
    }
    try {
      const response = await fetch(`/api/suggestions/${suggestion._id}`, { method: 'DELETE' });
      if (response.ok) {
        loadSuggestions();
      }
    } catch (error) {
      console.error('Failed to reject suggestion:', error);
    }
  };

  const handleDelete = async (slug) => {
    if (!window.confirm(`Delete the "${slug}" quiz and all of its scores? This cannot be undone.`)) {
      return;
    }
    try {
      const response = await fetch(`/api/quiz/${slug}`, { method: 'DELETE' });
      if (response.ok) {
        loadQuizzes();
      } else {
        const data = await response.json().catch(() => null);
        setErrorMsg(data?.msg || 'Failed to delete quiz');
      }
    } catch (error) {
      console.error('Failed to delete quiz:', error);
    }
  };

  const save = async (payload) => {
    setErrorMsg('');
    const url = editingSlug ? `/api/quiz/${editingSlug}` : '/api/quiz';
    const method = editingSlug ? 'PUT' : 'POST';

    try {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        if (reviewingId) {
          await fetch(`/api/suggestions/${reviewingId}`, { method: 'DELETE' });
          loadSuggestions();
        }
        backToList();
        loadQuizzes();
      } else {
        const data = await response.json().catch(() => null);
        setErrorMsg(data?.msg || 'Failed to save quiz');
      }
    } catch (error) {
      console.error('Failed to save quiz:', error);
      setErrorMsg('Failed to save quiz');
    }
  };

  if (isAdmin === null) {
    return <main className="container">Loading...</main>;
  }

  if (!isAdmin) {
    return (
      <main className="container text-center">
        <p>This page is for administrators only.</p>
      </main>
    );
  }

  if (formInitial) {
    return (
      <main className="container">
        <h2>
          {editingSlug ? `Edit: ${editingSlug}` : reviewingId ? 'Review Suggestion' : 'New Quiz'}
        </h2>
        {reviewingId && (
          <p className="review-note">
            Approving publishes this suggestion as a quiz (edit anything first). Cancel keeps it in the queue.
          </p>
        )}
        <QuizForm
          key={editingSlug || reviewingId || 'new'}
          initial={formInitial}
          slugLocked={Boolean(editingSlug)}
          allowUpload
          submitLabel={editingSlug ? 'Save Changes' : reviewingId ? 'Approve & Publish' : 'Create Quiz'}
          errorMsg={errorMsg}
          onSave={save}
          onCancel={backToList}
        />
      </main>
    );
  }

  return (
    <main className="container">
      <div className="admin-header">
        <h2>Quiz Manager</h2>
        <button className="btn btn-primary" onClick={startCreate}>
          New Quiz
        </button>
      </div>
      {errorMsg && <div className="alert alert-danger">{errorMsg}</div>}
      <div className="scroll-table scroll-table-quizzes">
        <table className="styled-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Slug</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {quizzes.map((quiz) => (
              <tr key={quiz.slug}>
                <td>{quiz.title}</td>
                <td>{quiz.slug}</td>
                <td>
                  <button className="btn btn-sm btn-secondary me-2" onClick={() => startEdit(quiz.slug)}>
                    Edit
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(quiz.slug)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Pending Suggestions</h2>
      {suggestions.length === 0 ? (
        <p>No suggestions waiting for review.</p>
      ) : (
        <table className="styled-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Suggested By</th>
              <th>Date</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {suggestions.map((suggestion) => (
              <tr key={suggestion._id}>
                <td>{suggestion.title}</td>
                <td>{suggestion.suggestedByName || suggestion.suggestedBy}</td>
                <td>{suggestion.date ? new Date(suggestion.date).toLocaleDateString() : ''}</td>
                <td>
                  <button className="btn btn-sm btn-secondary me-2" onClick={() => startReview(suggestion)}>
                    Review
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => rejectSuggestion(suggestion)}>
                    Reject
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

export default Admin;
