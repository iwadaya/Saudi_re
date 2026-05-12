// src/components/ScreenErrorBoundary.jsx
// Per-route error boundary so a single screen failing doesn't take down
// the whole SPA. ChunkErrorBoundary (in AppShell) still handles stale-chunk
// reloads at the top level; this sits inside and catches runtime errors.
//
// Errors are reported to the server via utils/errorReporter — rate-limited
// + deduped, fire-and-forget — so we get a searchable log line for
// anything that reaches this boundary in production.
import React from 'react';
import { reportError } from '../utils/errorReporter.js';

export default class ScreenErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }

  static getDerivedStateFromError(err) {
    return { err };
  }

  componentDidCatch(err, info) {
    console.error('[ScreenErrorBoundary]', err, info?.componentStack);
    reportError('boundary', err, { componentStack: info?.componentStack });
  }

  reset = () => this.setState({ err: null });

  render() {
    if (!this.state.err) return this.props.children;

    const msg = this.state.err?.message || 'Unknown error';
    return (
      <div style={{
        padding: '2rem', color: '#f87171',
        fontFamily: 'Inter, system-ui, sans-serif',
        maxWidth: 720, margin: '3rem auto',
      }}>
        <h2 style={{ color: '#f87171', marginTop: 0 }}>This screen failed to render</h2>
        <p style={{ color: '#d7dceb', lineHeight: 1.5 }}>
          {msg}
        </p>
        <p style={{ color: '#9aa3bf', fontSize: 13 }}>
          Other parts of the app still work — go back or reload to try again.
        </p>
        <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
          <button
            onClick={this.reset}
            style={{
              padding: '8px 16px', background: '#334155', color: '#e2e8f0',
              border: 'none', borderRadius: 6, cursor: 'pointer',
            }}
          >Retry</button>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 16px', background: '#1e40af', color: '#fff',
              border: 'none', borderRadius: 6, cursor: 'pointer',
            }}
          >Reload page</button>
        </div>
      </div>
    );
  }
}
