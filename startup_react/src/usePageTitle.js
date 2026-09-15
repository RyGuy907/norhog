import { useEffect } from 'react';

// Sets a document title for each route, which gives clearer browser history,
// bookmarks, and search results than one title for the whole app.
export function usePageTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} — Norhog` : 'Norhog — Timed History Quizzes';
    return () => {
      document.title = 'Norhog — Timed History Quizzes';
    };
  }, [title]);
}
