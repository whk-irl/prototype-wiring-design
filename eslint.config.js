import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'public/**', '.venv/**', 'tools/out/**'] },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts', 'tools/**/*.ts'],
    extends: [tseslint.configs.recommended],
  },
);
