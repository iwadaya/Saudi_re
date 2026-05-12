import { useCallback, useMemo, useRef, useState } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AppContext from '../context/AppContext.jsx';
import { ToastProvider } from '../components/ToastProvider.jsx';
import { ACTIVE_CONTRACT_ID, ACTIVE_QUOTE_ID } from '../constants/storageKeys.js';
import { setSession } from '../utils/auth.js';

const baseState = {
  user: { userId: 'cu-bind-test', roleCode: 'CU', hierarchyLevel: 2 },
  settings: { autosave: true },
  wizardMode: 'PROP',
  quoteMode: false,
  propTreatyDetail: {},
  npTreatyDetail: {},
  facRiskDetail: {},
  triangleMeta: { source: 'TREATY_DETAIL', startYear: 2021, renewalYear: 2026, version: 0 },
  trianglePages: {},
  treatyDocuments: { saved: false, files: [], filters: { type: 'ALL', status: 'ALL' } },
  pricing: {},
  propLargeLossList: {},
  propCatLossList: {},
  nonPropLargeLossList: {},
  nonPropCatLossList: {},
  npStructureLayers: [],
};

function TestAppProvider({ children, initialState }) {
  const [state, setState] = useState({ ...baseState, ...(initialState || {}) });
  const structRefsMap = useRef({});

  const set = useCallback((payload) => {
    setState(prev => ({ ...prev, ...(payload || {}) }));
  }, []);
  const setSlice = useCallback((key, value) => {
    setState(prev => ({ ...prev, [key]: { ...(prev[key] || {}), ...(value || {}) } }));
  }, []);
  const replaceSlice = useCallback((key, value) => {
    setState(prev => ({ ...prev, [key]: value }));
  }, []);
  const resetFlow = useCallback((opts = {}) => {
    setState(prev => ({
      ...prev,
      wizardMode: opts.mode || prev.wizardMode,
      quoteMode: !!opts.quote,
      propTreatyDetail: {},
      npTreatyDetail: {},
      facRiskDetail: {},
      propLargeLossList: {},
      propCatLossList: {},
      nonPropLargeLossList: {},
      nonPropCatLossList: {},
      trianglePages: {},
      pricing: {},
      npStructureLayers: [],
    }));
  }, []);

  const value = useMemo(
    () => ({ state, dispatch: () => {}, set, setSlice, replaceSlice, resetFlow, structRefsMap }),
    [replaceSlice, resetFlow, set, setSlice, state],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function renderBindScreen(ui, {
  route = '/',
  contractId = 'contract-bind-001',
  quoteMode = false,
  appState = {},
  forceActiveQuoteId = null,
} = {}) {
  localStorage.clear();
  setSession({ userId: 'cu-bind-test', roleCode: 'CU', hierarchyLevel: 2, displayName: 'Chief Underwriter' });
  localStorage.setItem(quoteMode ? ACTIVE_QUOTE_ID : ACTIVE_CONTRACT_ID, contractId);
  if (forceActiveQuoteId) {
    localStorage.setItem(ACTIVE_QUOTE_ID, forceActiveQuoteId);
  }

  return render(
    <MemoryRouter initialEntries={[{ pathname: route, state: { contractId } }]}>
      <ToastProvider>
        <TestAppProvider initialState={{ ...appState, quoteMode }}>
          {ui}
        </TestAppProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

export function makeHttpError({ status = 500, code, message = 'Server error', body = {} } = {}) {
  const error = new Error(message);
  error.name = 'HttpError';
  error.status = status;
  error.body = { error: message, ...(code ? { code } : {}), ...body };
  return error;
}
