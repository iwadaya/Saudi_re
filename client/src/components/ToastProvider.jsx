// src/components/ToastProvider.jsx
// App-wide toast bus. Single <Toast/> host mounted at the root so any
// screen — wizard-wrapped or not — can call useGlobalToast(msg).
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

  const show = useCallback((msg, duration = 2200) => {
    if (!msg) return;
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, msg: String(msg) }]);
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
