import { useState, useEffect } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { Main } from './main/main';
import { Gallery } from './gallery/gallery';
import { Leaderboard } from './leaderboard/leaderboard';
import { Quiz } from './quiz/quiz';
import { Daily } from './daily/daily';
import { Practice } from './practice/practice';
import { Profile } from './profile/profile';
import { Admin } from './admin/admin';
import { Cat } from './cat/cat';
import { About } from './about/about';
import { Suggest } from './suggest/suggest';
import { ErrorBoundary } from './errorBoundary';
import 'bootstrap/dist/css/bootstrap.min.css';
import './App.css';

function App() {
  const [isAdmin, setIsAdmin] = useState(false);

  // Tracks the session's role so the Admin nav item only shows for admins. The
  // profile page dispatches 'authChanged' after login and logout.
  useEffect(() => {
    const checkRole = async () => {
      try {
        const response = await fetch('/api/auth/me');
        if (response.ok) {
          const data = await response.json();
          setIsAdmin(data.role === 'admin');
        } else {
          setIsAdmin(false);
        }
      } catch {
        setIsAdmin(false);
      }
    };

    checkRole();
    window.addEventListener('authChanged', checkRole);
    return () => window.removeEventListener('authChanged', checkRole);
  }, []);

  return (
    <BrowserRouter>
      <div className="body">
        <header className="header">
          <div className="header-bar">
            <NavLink to="/" className="brand">
              {/* Empty alt because the wordmark next to it already names the link,
                  so screen readers would read it twice. The width and height
                  reserve space so the header doesn't shift while it loads. */}
              <img
                className="brand-mark"
                src="/norhog-logo.png"
                alt=""
                width="89"
                height="105"
              />
              <h1>Norhog<sup>&reg;</sup></h1>
            </NavLink>
            <nav>
              <menu className="menu">
                <li><NavLink to="/" end>Home</NavLink></li>
                <li><NavLink to="/quizzes">Quizzes</NavLink></li>
                <li><NavLink to="/daily">Daily</NavLink></li>
                <li><NavLink to="/leaderboard">Leaderboard</NavLink></li>
                <li><NavLink to="/profile">Profile</NavLink></li>
                {isAdmin && <li><NavLink to="/admin">Admin</NavLink></li>}
              </menu>
            </nav>
          </div>
        </header>

        <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Main />} />
          <Route path="/quizzes" element={<Gallery />} />
          <Route path="/quiz/:slug" element={<Quiz />} />
          <Route path="/quiz" element={<Navigate to="/quizzes" replace />} />
          <Route path="/daily" element={<Daily />} />
          <Route path="/practice" element={<Practice />} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/cat" element={<Cat />} />
          <Route path="/about" element={<About />} />
          <Route path="/suggest" element={<Suggest />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        </ErrorBoundary>

        <footer className="footer">
          <div className="footer-content">
            <span className="footer-links">
              <NavLink to="/about">Learn More</NavLink>
              <NavLink to="/suggest">Suggest a Quiz</NavLink>
            </span>
            <NavLink to="/cat" className="paw" aria-label="A secret" title="???">🐾</NavLink>
          </div>
        </footer>
      </div>
    </BrowserRouter>
  );
}

function NotFound() {
  return (
    <main className="container text-center">
      <h2>404 &mdash; Return to sender</h2>
      <p>Address unknown. That page isn&apos;t part of the historical record.</p>
      <NavLink className="btn btn-primary" to="/">Back to Norhog</NavLink>
    </main>
  );
}

export default App;
