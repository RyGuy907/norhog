import { useEffect } from 'react';

// Per-route document titles: better browser history, bookmarks, and search
// results than one static title for the whole SPA.
export function usePageTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} — Norhog` : 'Norhog — Timed History Quizzes';
    return () => {
      document.title = 'Norhog — Timed History Quizzes';
    };
  }, [title]);
}
