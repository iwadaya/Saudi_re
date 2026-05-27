// src/context/AppContext.jsx — Central application state
import React, { createContext, useContext, useReducer, useCallback, useRef } from 'react';
import { getSession } from '../utils/auth';

const AppContext = createContext(null);

const initialState = {
  user: null, // populated from getSession() on mount
  settings: { autosave: true },
  wizardMode: 'PROP', // 'PROP' | 'NP' | 'FAC'
  quoteMode: false,
  propTreatyDetail: {},
  npTreatyDetail: {},
  facRiskDetail: {}, // Facultative active risk; mirrors prop/np pattern
  triangleMeta: { source: 'TREATY_DETAIL', startYear: null, inceptionYear: null, renewalYear: null, version: 0 },
  trianglePages: {},
  treatyDocuments: { saved: false, files: [], filters: { type: 'ALL', status: 'ALL' } },
  pricing: {},
  // Per-screen state slices
  propLargeLossList: {},
  propCatLossList: {},
  nonPropLargeLossList: {},
  nonPropCatLossList: {},
  npStructureLayers: [], // [{limit, deductible, riskCover, catCover, ...}] — set by NpStructure
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET':
      return { ...state, ...action.payload };
    case 'SET_SLICE': {
      const { key, value } = action.payload;
      return { ...state, [key]: { ...(state[key] || {}), ...value } };
    }
    case 'REPLACE_SLICE': {
      const { key, value } = action.payload;
      return { ...state, [key]: value };
    }
    case 'RESET_FLOW': {
      const { quote, mode } = action.payload || {};
      return {
        ...state,
        wizardMode: mode || state.wizardMode,
        quoteMode: !!quote,
        propTreatyDetail: {},
        npTreatyDetail: {},
        facRiskDetail: {},
        propLargeLossList: {},
        propCatLossList: {},
        nonPropLargeLossList: {},
        nonPropCatLossList: {},
        trianglePages: {},
        triangleMeta: { source: 'TREATY_DETAIL', startYear: null, inceptionYear: null, renewalYear: null, version: 0 },
        treatyDocuments: { saved: false, files: [], filters: { type: 'ALL', status: 'ALL' } },
        pricing: {},
        npStructureLayers: [],
      };
    }
    default:
      return state;
  }
}

export function AppProvider({ children }) {
  const sessionUser = getSession();
  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    user: sessionUser || null,
  });

  const set = useCallback((payload) => dispatch({ type: 'SET', payload }), []);
  const setSlice = useCallback((key, value) => dispatch({ type: 'SET_SLICE', payload: { key, value } }), []);
  const replaceSlice = useCallback((key, value) => dispatch({ type: 'REPLACE_SLICE', payload: { key, value } }), []);
  const resetFlow = useCallback((opts) => dispatch({ type: 'RESET_FLOW', payload: opts }), []);

  const structRefsMap = useRef({});

  const value = React.useMemo(
    () => ({ state, dispatch, set, setSlice, replaceSlice, resetFlow, structRefsMap }),
    [state, set, setSlice, replaceSlice, resetFlow]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppState() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppState must be used within AppProvider');
  return ctx;
}

export default AppContext;
