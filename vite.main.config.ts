import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  build: {
    outDir: 'dist/main',
    lib: {
      entry: path.resolve(__dirname, 'src/main/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: ['electron', 'pg', 'node:crypto', 'node:fs', 'node:path'],
    },
    emptyOutDir: true,
    minify: false,
  },
  resolve: {
    conditions: ['node'],
  },
});
