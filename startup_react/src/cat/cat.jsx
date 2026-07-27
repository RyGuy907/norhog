import { useState, useEffect, useCallback } from 'react';
import { usePageTitle } from '../usePageTitle';
import './cat.css';

export function Cat() {
  usePageTitle('A Secret');
  const [cat, setCat] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchCat = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('https://api.thecatapi.com/v1/images/search?limit=1');
      const data = await response.json();
      setCat(data[0]);
    } catch (error) {
      console.error('The cat could not be summoned:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCat();
  }, [fetchCat]);

  return (
    <main className="container cat-page">
      <h2>You found the cat.</h2>
      <p>Congratulations on discovering Norhog&apos;s most historically significant page.</p>
      {loading && <p className="cat-loading">Summoning cat...</p>}
      {cat && !loading && <img className="cat-image" src={cat.url} alt="A historically significant cat" />}
      <div>
        <button className="btn btn-primary" onClick={fetchCat} disabled={loading}>
          Another cat, please
        </button>
      </div>
    </main>
  );
}

export default Cat;
