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
      external: ['electron', 'pg', 'ssh2', 'node:crypto', 'node:fs', 'node:path', 'node:net', 'node:child_process', 'node:util'],
    },
    emptyOutDir: true,
    minify: false,
  },
  resolve: {
    conditions: ['node'],
  },
});
