// src/components/ToastProvider.jsx
// App-wide toast bus. Single <Toast/> host mounted at the root so any
// screen — wizard-wrapped or not — can call useGlobalToast(msg).
//
// Signature:
//   show(msg)
//   show(msg, durationMs)
//   show(msg, { duration?, onClick? })
//
// The object-form second argument supports actionable toasts (a click
// handler attached to the toast button) without rolling another host.
//
// Kept deliberately tiny: ids generated locally, setTimeout cleanup,
// no priority/error-level bells. If we need severity later (success
// vs error), add a `variant` parameter and a class map; don't spawn
// a second host.

import { createContext, useState, useCallback } from 'react';
import Toast from './Toast';

export const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const show = useCallback((msg, opts) => {
    if (!msg) return;
    const id = Date.now() + Math.random();
    let duration = 2200;
    let onClick;
    if (typeof opts === 'number') {
      duration = opts;
    } else if (opts && typeof opts === 'object') {
      if (typeof opts.duration === 'number') duration = opts.duration;
      if (typeof opts.onClick === 'function') onClick = opts.onClick;
    }
    setToasts((prev) => [...prev, { id, msg: String(msg), onClick }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, duration);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <Toast toasts={toasts} />
    </ToastContext.Provider>
  );
}
