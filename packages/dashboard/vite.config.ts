import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
    proxy: {
      '/tasks': 'http://localhost:3927',
      '/tools': 'http://localhost:3927',
      '/health': 'http://localhost:3927',
    },
  },
});
