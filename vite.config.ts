import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const core = fileURLToPath(new URL('./src/core', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@core$/, replacement: `${core}/index.ts` },
      { find: /^@core\//, replacement: `${core}/` },
    ],
  },
  server: { port: 5173, strictPort: true },
  worker: { format: 'es' },
  test: {
    // Node by default. A test that needs a DOM (URDF parsing) opts in with a
    // `// @vitest-environment jsdom` comment at the top of the file.
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
