import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QuizCard } from './quizCard';

const quiz = {
  slug: 'punic-wars',
  title: 'The Punic Wars',
  description: 'Rome versus Carthage',
  image: 'https://example.com/punic.jpg',
};

const renderCard = (status) =>
  render(
    <MemoryRouter>
      <QuizCard quiz={quiz} status={status} />
    </MemoryRouter>
  );

describe('QuizCard', () => {
  it('renders the title and a link to the quiz', () => {
    renderCard(undefined);
    expect(screen.getByText('The Punic Wars')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/quiz/punic-wars');
  });

  it('shows the image and keeps the description off the tile', () => {
    const { container } = renderCard(undefined);
    expect(container.querySelector('.quiz-card-image')).toHaveAttribute('src', quiz.image);
    expect(screen.queryByText('Rome versus Carthage')).not.toBeInTheDocument();
  });

  it('shows no completion badge for an unplayed quiz', () => {
    renderCard(undefined);
    expect(screen.queryByText('Completed!')).not.toBeInTheDocument();
  });

  it('shows no completion badge when the best is short of full points', () => {
    renderCard({ points: 8, perfectCount: 1 });
    expect(screen.queryByText('Completed!')).not.toBeInTheDocument();
  });

  it('marks a quiz completed at full points', () => {
    renderCard({ points: 10, perfectCount: 1 });
    expect(screen.getByText('Completed!')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveClass('completed');
  });

  it('adds a star only after a perfect run on all three difficulties', () => {
    const { container: withoutStar } = renderCard({ points: 10, perfectCount: 2 });
    expect(withoutStar.querySelector('.quiz-star')).toBeNull();

    const { container: withStar } = renderCard({ points: 10, perfectCount: 3 });
    expect(withStar.querySelector('.quiz-star')).not.toBeNull();
  });
});
