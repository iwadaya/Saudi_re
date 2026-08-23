// eslint.config.js — flat config (ESLint 9+).
// Baseline is intentionally lenient (catches real bugs without fighting the
// team's style); the screens layer carries stricter "ratchet" rules so the
// frontend-hardening effort (docs/frontend-hardening.md) can't regress. Run:
//   npm run lint
//   npm run lint:fix
//   npm run lint:screens

import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

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

      // Debug logging must not ship; warn/error stay available for the
      // exceptional paths that errorReporter/logger mirror. CLI surfaces
      // where console IS the product get a targeted override below.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
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

  // ─── Screens layer ratchet (docs/frontend-hardening.md) ────────────
  // Stricter rules for client/src/screens/** so hardening gains lock in.
  {
    files: ['client/src/screens/**/*.{js,jsx}'],
    ignores: ['client/src/screens/**/*.test.{js,jsx}'],
    rules: {
      // A console call in a screen is either dead debug noise or an error
      // that belongs in the toast/errorReporter path.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // New screens stay under 800 lines ("warn" is effectively an error in
      // CI because lint runs with --max-warnings=0).
      'max-lines': ['warn', { max: 800, skipBlankLines: false, skipComments: false }],
      // Stale-closure bugs in pricing screens are silent money bugs.
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  // ─── Accessibility (Phase 5 — driven to zero, now gated) ──────────
  // The screens + components layers are keyboard/screen-reader clean;
  // jsx-a11y recommended keeps them that way. Patterns in use: real
  // <button> (or role="button" + tabIndex + Enter/Space onKeyDown) for
  // every click target, role="presentation" for pointer-only backdrop
  // dismissal, htmlFor/useId label association.
  {
    files: ['client/src/screens/**/*.{js,jsx}', 'client/src/components/**/*.{js,jsx}'],
    ignores: ['**/*.test.{js,jsx}'],
    plugins: { 'jsx-a11y': jsxA11y },
    rules: {
      ...jsxA11y.configs.recommended.rules,
    },
  },

  // ─── CLI / tooling surfaces where console IS the output channel ────
  {
    files: [
      'scripts/**',
      'server/scripts/**', // ops CLIs (fixture generation, cleanup)
      'test/**', // standalone actuarial verification CLIs
      'server/src/lib/logger.js', // console.log is the log transport itself
      'server/src/observability/**', // startup/shutdown notices
      'server/src/db/seeds/**', // seed CLIs report progress to the operator
    ],
    rules: {
      'no-console': 'off',
    },
  },

  // ─── Tests + test harness ──────────────────────────────────────────
  {
    files: ['**/*.test.{js,jsx}', 'client/src/test/**'],
    rules: {
      'no-console': 'off',
      'max-lines': 'off',
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
