// eslint.a11y.config.js — accessibility audit for the screens layer
// (docs/frontend-hardening.md Phase 5). Run with:
//
//   npm run lint:a11y
//
// Deliberately a SEPARATE config from eslint.config.js: the main lint
// gates CI at --max-warnings=0, so these rules can't ride there until
// the violation count reaches zero. The drive-to-zero is tracked by
// this script plus the budget gate's onClickNonInteractive ratchet.
// When `npm run lint:a11y` reports 0 problems, fold this block into
// eslint.config.js as errors and delete this file.

import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  {
    files: ['client/src/screens/**/*.{js,jsx}', 'client/src/components/**/*.{js,jsx}'],
    ignores: ['**/*.test.{js,jsx}'],
    // react-hooks is registered (no rules enabled) so the
    // `eslint-disable-next-line react-hooks/exhaustive-deps` directives the
    // main lint gate requires resolve here instead of erroring with
    // "Definition for rule ... was not found". Unused-directive reporting is
    // off because directives for main-config rules are expectedly unused in
    // this audit, which only runs jsx-a11y.
    plugins: { 'jsx-a11y': jsxA11y, 'react-hooks': reactHooks },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...jsxA11y.configs.recommended.rules,
      // The two rules that drive the Phase-5 keyboard work directly:
      'jsx-a11y/click-events-have-key-events': 'warn',
      'jsx-a11y/no-static-element-interactions': 'warn',
    },
  },
];
