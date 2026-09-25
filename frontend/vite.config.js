import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/static/',
  build: {
    outDir: '../erd_celonis/static',
    emptyOutDir: true,
    assetsDir: 'assets',
    rollupOptions: {
      output: { manualChunks: id => /node_modules[\\/](@codemirror|@lezer)[\\/]/.test(id) ? 'editor' : undefined },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
});
