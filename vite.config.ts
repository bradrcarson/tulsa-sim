import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: true,
    proxy: {
      // oktraffic.org's LoopBack API sends no CORS headers; proxy it in dev
      // so the cameras layer can refresh live. Static hosting falls back to
      // the baked snapshot in public/data/cameras.json.
      '/oktraffic-api': {
        target: 'https://oktraffic.org/api',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/oktraffic-api/, ''),
      },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
});
