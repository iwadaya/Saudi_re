// Global test setup for the client-side test suite.
// Wires @testing-library/jest-dom matchers so expect(el).toBeInTheDocument()
// works, and makes sure window.matchMedia + IntersectionObserver are
// available so components that defensively reach for them don't throw.
import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

vi.mock('react-router-dom', async () => {
  const React = await import('react');
  const RouterContext = React.createContext({
    location: { pathname: '/', state: null },
    navigate: vi.fn(),
  });
  return {
    MemoryRouter({ initialEntries, children }) {
    const first = Array.isArray(initialEntries) && initialEntries.length ? initialEntries[0] : '/';
    const location = typeof first === 'string'
      ? { pathname: first, state: null }
      : { pathname: first?.pathname || '/', state: first?.state || null };
    const navigate = vi.fn();
    return React.createElement(RouterContext.Provider, { value: { location, navigate } }, children);
    },
    useLocation() {
      return React.useContext(RouterContext).location;
    },
    useNavigate() {
      return React.useContext(RouterContext).navigate;
    },
    Link({ to, children, ...props }) {
      return React.createElement('a', { href: typeof to === 'string' ? to : '#', ...props }, children);
    },
    NavLink({ to, children, ...props }) {
      return React.createElement('a', { href: typeof to === 'string' ? to : '#', ...props }, typeof children === 'function' ? children({ isActive: false }) : children);
    },
  };
});

// matchMedia is not implemented in jsdom; stub a read-only shape
if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

// IntersectionObserver is also missing from jsdom
if (!globalThis.IntersectionObserver) {
  globalThis.IntersectionObserver = class IO {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}
