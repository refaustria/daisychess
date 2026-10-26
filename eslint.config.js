import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/dist-e2e/**', '**/dist-mobile/**', 'apps/mobile/android/**', 'apps/mobile/ios/**', '**/coverage/**', '**/test-results/**', '**/playwright-report/**', '**/node_modules/**', 'engines/**', 'deploy/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}', 'apps/portal/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['apps/site/src/**/*.ts', 'apps/site/tools/**/*.ts', 'apps/site/e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
);
