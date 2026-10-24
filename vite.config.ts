import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Songsterr's API has no CORS headers, so search and metadata go through a
// same-origin proxy (here in dev, a rewrite in vercel.json in production).
// Tab JSON comes straight from their CDN, which allows any origin.
const proxy = {
  '/songsterr': {
    target: 'https://www.songsterr.com',
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/songsterr/, '/api'),
  },
};

export default defineConfig({
  plugins: [tailwindcss()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
  server: { port: 5207, host: true, proxy },
  preview: { port: 5207, proxy },
});
