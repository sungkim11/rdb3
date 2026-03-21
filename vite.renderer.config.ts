import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss()],
  root: '.',
  base: './',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          codemirror: [
            '@codemirror/commands',
            '@codemirror/lang-sql',
            '@codemirror/language',
            '@codemirror/state',
            '@codemirror/view',
          ],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
