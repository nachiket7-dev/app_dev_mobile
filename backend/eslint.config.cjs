const js = require('@eslint/js');
const ts = require('typescript-eslint');
const globals = require('globals');

module.exports = ts.config(
  { ignores: ['node_modules/**', 'dist/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-control-regex': 'off',
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
);
