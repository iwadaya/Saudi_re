// Global test setup for the client-side test suite.
// Wires @testing-library/jest-dom matchers so expect(el).toBeInTheDocument()
// works, and makes sure window.matchMedia + IntersectionObserver are
// available so components that defensively reach for them don't throw.
import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

vi.mock('react-router-dom', async () => {
  const React = await import('react');
  const RouterContext = React.createContext({
    location: { pathname: '/', search: '', state: null },
    navigate: vi.fn(),
  });
  // Split a "/path?a=b" entry into { pathname, search } so useSearchParams works.
  const splitEntry = (s) => {
    const i = s.indexOf('?');
    return i === -1 ? { pathname: s, search: '' } : { pathname: s.slice(0, i), search: s.slice(i) };
  };
  return {
    MemoryRouter({ initialEntries, children }) {
    const first = Array.isArray(initialEntries) && initialEntries.length ? initialEntries[0] : '/';
    const location = typeof first === 'string'
      ? { ...splitEntry(first), state: null }
      : { pathname: first?.pathname || '/', search: first?.search || '', state: first?.state || null };
    const navigate = vi.fn();
    return React.createElement(RouterContext.Provider, { value: { location, navigate } }, children);
    },
    useLocation() {
      return React.useContext(RouterContext).location;
    },
    useNavigate() {
      return React.useContext(RouterContext).navigate;
    },
    useSearchParams() {
      const loc = React.useContext(RouterContext).location;
      return [new URLSearchParams(loc?.search || ''), vi.fn()];
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

// jsdom doesn't implement navigation, so any component that reaches for
// window.location.reload() — e.g. the stale-write refresh path in
// handleStaleWrite.js → onRefresh — prints a noisy
// "Error: Not implemented: navigation (except hash changes)" to stderr
// even though the test passes. `reload` is a non-configurable own property
// of Location, so it can't be redefined directly; instead front the whole
// (configurable) window.location with a Proxy that forwards every real
// property and only swaps reload for a spy. Tests can assert a reload was
// requested via window.location.reload; nothing relies on real navigation.
const realLocation = window.location;
const reloadSpy = vi.fn();
// Proxy over an empty target (not realLocation) so the Proxy get-invariant
// for reload's non-configurable data property doesn't apply — every read is
// forwarded to the real location except reload, which returns the spy.
const locationProxy = new Proxy({}, {
  get(_target, prop) {
    if (prop === 'reload') return reloadSpy;
    const value = realLocation[prop];
    return typeof value === 'function' ? value.bind(realLocation) : value;
  },
  set(_target, prop, value) {
    realLocation[prop] = value;
    return true;
  },
});
Object.defineProperty(window, 'location', {
  configurable: true,
  get() { return locationProxy; },
});

// IntersectionObserver is also missing from jsdom
if (!globalThis.IntersectionObserver) {
  globalThis.IntersectionObserver = class IO {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}
