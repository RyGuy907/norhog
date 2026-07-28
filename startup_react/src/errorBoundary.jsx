import { Component } from 'react';

// Without this, a render error anywhere blanks the whole site.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error('Unexpected error:', error);
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="container text-center">
          <h2>Something went wrong</h2>
          <p>Sorry — that page hit an unexpected error.</p>
          <a className="btn btn-primary" href="/">Back to Norhog</a>
        </main>
      );
    }
    return this.props.children;
  }
}
