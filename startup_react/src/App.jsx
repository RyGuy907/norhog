import { useState, useEffect } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { Main } from './main/main';
import { Gallery } from './gallery/gallery';
import { Leaderboard } from './leaderboard/leaderboard';
import { Quiz } from './quiz/quiz';
import { Profile } from './profile/profile';
import { Admin } from './admin/admin';
import { Cat } from './cat/cat';
import { About } from './about/about';
import { Suggest } from './suggest/suggest';
import 'bootstrap/dist/css/bootstrap.min.css';
import './App.css';

function App() {
  const [isAdmin, setIsAdmin] = useState(false);

  // Track the session's role so the Admin nav item only shows for admins.
  // Profile dispatches 'authChanged' after login/logout.
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
              <h1>Norhog<sup>&reg;</sup></h1>
            </NavLink>
            <nav>
              <menu className="menu">
                <li><NavLink to="/" end>Home</NavLink></li>
                <li><NavLink to="/quizzes">Quizzes</NavLink></li>
                <li><NavLink to="/leaderboard">Leaderboard</NavLink></li>
                <li><NavLink to="/profile">Profile</NavLink></li>
                {isAdmin && <li><NavLink to="/admin">Admin</NavLink></li>}
              </menu>
            </nav>
          </div>
        </header>

        <Routes>
          <Route path="/" element={<Main />} />
          <Route path="/quizzes" element={<Gallery />} />
          <Route path="/quiz/:slug" element={<Quiz />} />
          <Route path="/quiz" element={<Navigate to="/quizzes" replace />} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/cat" element={<Cat />} />
          <Route path="/about" element={<About />} />
          <Route path="/suggest" element={<Suggest />} />
          <Route path="*" element={<NotFound />} />
        </Routes>

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
  return <main className="container text-center">404: Return to sender. Address unknown.</main>;
}

export default App;
