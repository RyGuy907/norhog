import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { QuizCard } from '../quizCard';
import { RandomQuiz } from '../randomQuiz';
import { shuffle } from '../shuffle';
import { usePageTitle } from '../usePageTitle';
import './profile.css';

const AuthState = {
  Authenticated: 'Authenticated',
  Unauthenticated: 'Unauthenticated',
};

export function Profile() {
  usePageTitle('Profile');
  const navigate = useNavigate();
  const [userName, setUserName] = useState(localStorage.getItem('userName') || '');
  const [authState, setAuthState] = useState(userName ? AuthState.Authenticated : AuthState.Unauthenticated);
  const [authTab, setAuthTab] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [creationDate, setCreationDate] = useState('');
  const [totalPoints, setTotalPoints] = useState(0);
  const [myScores, setMyScores] = useState([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [quizzes, setQuizzes] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [dangerOpen, setDangerOpen] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteText, setDeleteText] = useState('');

  const clearUserData = () => {
    localStorage.removeItem('userName');
    setUserName('');
    setAuthState(AuthState.Unauthenticated);
    setTotalPoints(0);
    setMyScores([]);
    // Someone else may log in on this browser; don't leave the previous
    // account's play history on screen.
    setFavorites([]);
    setCreationDate('');
    setDangerOpen(false);
    setShowDeleteConfirm(false);
    setDeleteText('');
  };

  const toggleDangerZone = () => {
    setDangerOpen((open) => !open);
    setShowDeleteConfirm(false);
    setDeleteText('');
  };

  const deleteAccount = async () => {
    try {
      const response = await fetch('/api/user', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      if (response.ok) {
        clearUserData();
        window.dispatchEvent(new Event('authChanged'));
        navigate('/');
      } else {
        const data = await response.json().catch(() => null);
        setErrorMsg(data?.msg || 'Failed to delete account');
      }
    } catch (error) {
      console.error('Error deleting account:', error);
      setErrorMsg('Failed to delete account');
    }
  };

  const setLoggedIn = (data) => {
    const shownName = data.displayName || data.email;
    localStorage.setItem('userName', shownName);
    setUserName(shownName);
    setCreationDate(data.creationDate ? new Date(data.creationDate).toLocaleDateString() : 'N/A');
    setAuthState(AuthState.Authenticated);
    setErrorMsg('');
    window.dispatchEvent(new Event('authChanged'));
  };

  const fetchScores = async () => {
    try {
      const response = await fetch('/api/scores/me');
      if (response.ok) {
        const data = await response.json();
        setTotalPoints(data.total);
        setMyScores(data.scores);
      }
    } catch (error) {
      console.error('Error fetching scores:', error);
    }
  };

  const login = async (email, password) => {
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (response.ok) {
        const data = await response.json();
        setLoggedIn(data);
      } else {
        const data = await response.json().catch(() => null);
        setErrorMsg(data?.msg || 'Invalid email or password');
      }
    } catch (error) {
      console.error('Error logging in:', error);
    }
  };

  const createAccount = async (email, password) => {
    try {
      const response = await fetch('/api/auth/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, displayName }),
      });

      if (response.ok) {
        const data = await response.json();
        setLoggedIn(data);
      } else {
        const data = await response.json().catch(() => null);
        setErrorMsg(data?.msg || 'Failed to create account. Please try again.');
      }
    } catch (error) {
      console.error('Error creating account:', error);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (error) {
      console.error('Error logging out:', error);
    }
    clearUserData();
    window.dispatchEvent(new Event('authChanged'));
    navigate('/');
  };

  // Restore the session from the auth cookie on mount.
  useEffect(() => {
    const restoreSession = async () => {
      try {
        const response = await fetch('/api/auth/me');
        if (response.ok) {
          const data = await response.json();
          setLoggedIn(data);
          fetchScores(data.email);
        } else {
          clearUserData();
        }
      } catch (error) {
        console.error('Error restoring session:', error);
      }
    };
    restoreSession();

    fetch('/api/quizzes')
      .then((response) => (response.ok ? response.json() : []))
      .then((data) => setQuizzes(shuffle(data)))
      .catch(() => {});
  }, []);

  // The server derives the account from the session cookie, so this needs no
  // argument — and one user can't request another's history.
  const fetchFavorites = async () => {
    try {
      const response = await fetch('/api/quizzes/favorites');
      setFavorites(response.ok ? await response.json() : []);
    } catch {
      // Supplementary board; a failure here shouldn't disturb the profile.
    }
  };

  useEffect(() => {
    if (authState === AuthState.Authenticated && userName) {
      fetchScores(userName);
      fetchFavorites();
    }
  }, [authState, userName]);

  return (
    <main className="container">
      <div className="row">
        <div className="col-md-8">
          {authState === AuthState.Unauthenticated ? (
            <div className="profile-card">
              <div className="auth-tabs">
                <button
                  type="button"
                  className={`auth-tab${authTab === 'login' ? ' active' : ''}`}
                  onClick={() => { setAuthTab('login'); setErrorMsg(''); }}
                >
                  Login
                </button>
                <button
                  type="button"
                  className={`auth-tab${authTab === 'create' ? ' active' : ''}`}
                  onClick={() => { setAuthTab('create'); setErrorMsg(''); }}
                >
                  Create Account
                </button>
              </div>
              {errorMsg && <div className="alert alert-danger">{errorMsg}</div>}
              <div className="mb-3">
                <label htmlFor="email" className="label">E-mail:</label>
                <input
                  type="email"
                  id="email"
                  name="email"
                  placeholder="Email"
                  className="form-control"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="mb-3">
                <label htmlFor="password" className="label">Password:</label>
                <input
                  type="password"
                  id="password"
                  name="password"
                  placeholder="Password (8+ characters)"
                  className="form-control"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              {authTab === 'create' && (
                <div className="mb-3">
                  <label htmlFor="displayName" className="label">Display name <span className="label-hint">(shown publicly)</span>:</label>
                  <input
                    type="text"
                    id="displayName"
                    name="displayName"
                    placeholder="3-20 characters, must be unique"
                    className="form-control"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </div>
              )}
              {authTab === 'login' ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => login(email, password)}
                >
                  Login
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => createAccount(email, password)}
                >
                  Create Account
                </button>
              )}
            </div>
          ) : (
            <>
              <h2>Your Profile</h2>
              <table className="styled-table">
                <thead>
                  <tr>
                    <th>Username</th>
                    <th>Total Points</th>
                    <th>Account Created</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{userName}</td>
                    <td>{totalPoints}</td>
                    <td>{creationDate || 'N/A'}</td>
                  </tr>
                </tbody>
              </table>

              <h4>Your Quizzes</h4>
              {myScores.length === 0 ? (
                <p>No quizzes played yet — every quiz is worth up to 10 points!</p>
              ) : (
                <div className="scroll-table">
                  <table className="styled-table">
                    <thead>
                      <tr>
                        <th>Quiz</th>
                        <th>Best Points</th>
                      </tr>
                    </thead>
                    <tbody>
                      {myScores.map((entry) => (
                        <tr key={entry.quiz}>
                          <td>{quizzes.find((quiz) => quiz.slug === entry.quiz)?.title || entry.quiz}</td>
                          <td>{entry.points} / 10</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <button className="btn btn-danger" onClick={handleLogout}>
                Logout
              </button>

              <div className="danger-zone">
                <button type="button" className="danger-zone-header" onClick={toggleDangerZone}>
                  Danger Zone <span className="danger-chevron">{dangerOpen ? '▾' : '▸'}</span>
                </button>
                {dangerOpen && (
                <div className="danger-zone-body">
                {errorMsg && <div className="alert alert-danger">{errorMsg}</div>}
                {!showDeleteConfirm ? (
                  <button className="btn btn-danger" onClick={() => setShowDeleteConfirm(true)}>
                    Delete Account
                  </button>
                ) : (
                  <>
                    <p>
                      This permanently deletes your account, all of your scores and leaderboard
                      entries, and any pending quiz suggestions. <strong>This cannot be undone.</strong>
                    </p>
                    <label htmlFor="delete-confirm" className="label">
                      Type <strong>confirm</strong> to enable deletion:
                    </label>
                    <input
                      id="delete-confirm"
                      className="form-control delete-confirm-input"
                      placeholder="confirm"
                      value={deleteText}
                      onChange={(e) => setDeleteText(e.target.value)}
                    />
                    <button
                      className="btn btn-danger me-2"
                      disabled={deleteText.trim().toLowerCase() !== 'confirm'}
                      onClick={deleteAccount}
                    >
                      Permanently Delete My Account
                    </button>
                    <button
                      className="btn btn-secondary"
                      onClick={() => { setShowDeleteConfirm(false); setDeleteText(''); }}
                    >
                      Cancel
                    </button>
                  </>
                )}
                </div>
                )}
              </div>
            </>
          )}
        </div>
        <div className="col-md-4">
          {authState === AuthState.Authenticated && (
            <aside className="quiz-board profile-favorites">
              <h2 className="quiz-board-heading">Your Favorites</h2>
              {favorites.length === 0 ? (
                <p className="quiz-board-empty">
                  Play a quiz and the ones you come back to will show up here.
                </p>
              ) : (
                <div className="quiz-board-grid">
                  {favorites.map((quiz) => (
                    <QuizCard
                      key={quiz.slug}
                      quiz={quiz}
                      meta={`${quiz.plays} ${quiz.plays === 1 ? 'play' : 'plays'}`}
                    />
                  ))}
                </div>
              )}
            </aside>
          )}
          <div className="rec-box">
            <h4>Recommended Quizzes</h4>
            <ul className="recquiz list-group">
              {quizzes.slice(0, 4).map((quiz) => (
                <li className="recquiz list-group-item" key={quiz.slug}>
                  <button className="btn" onClick={() => navigate(`/quiz/${quiz.slug}`)}>
                    {quiz.title}
                  </button>
                </li>
              ))}
            </ul>
            <RandomQuiz quizzes={quizzes} />
          </div>
        </div>
      </div>
    </main>
  );
}

export default Profile;
