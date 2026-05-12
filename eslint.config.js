// eslint.config.js — flat config (ESLint 9+).
// Intentionally lenient: catches real bugs (undefined vars, stale imports,
// broken hooks) without fighting the team's existing code style. Run:
//   npm run lint
//   npm run lint:fix

import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      'client/dist/**',
      'server/uploads/**',
      '**/*.min.js',
      // k6 scripts use their own runtime (globals __VU/__ENV, jslib https imports);
      // linting against Node/browser configs produces false positives.
      'load-test/**',
    ],
  },

  // ─── Shared baseline for all JS/JSX ────────────────────────────────
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2024,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // Catch real bugs
      'no-undef': 'error',
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none', // try { ... } catch(e) { ... } with unused e is fine
      }],
      'no-duplicate-imports': 'error',
      'no-var': 'error',
      'prefer-const': ['warn', { destructuring: 'all' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],

      // Don't fight intentional patterns
      'no-console': 'off',
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-prototype-builtins': 'off',
      'no-useless-escape': 'warn',
      'no-control-regex': 'off',

      // Let the dev-only gate pass (import.meta.env.DEV checks etc.)
      'no-unreachable': 'warn',
    },
  },

  // ─── Client (React) ────────────────────────────────────────────────
  {
    files: ['client/src/**/*.{js,jsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: '18.3' },
    },
    rules: {
      // React-specific sanity checks
      'react/jsx-uses-react': 'off', // JSX transform handles this
      'react/react-in-jsx-scope': 'off',
      'react/jsx-uses-vars': 'error',
      'react/jsx-no-undef': 'error',
      'react/no-unknown-property': 'warn',
      'react/jsx-key': 'warn',
      'react/no-direct-mutation-state': 'error',
      'react/jsx-no-duplicate-props': 'error',

      // Hooks — most valuable rule, especially for stale-closure bugs
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // ─── Server (Node + ESM) ───────────────────────────────────────────
  {
    files: ['server/src/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Node code should not reach for browser globals
      'no-restricted-globals': ['warn', 'window', 'document', 'localStorage'],
    },
  },
];
