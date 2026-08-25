import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Main build config. The vanilla app (index.html + style.css + script.js)
// remains the build entry until todo 10. The React + Tailwind plugins are
// inert for the vanilla entry (no TSX, no @import "tailwindcss"), so they
// don't disturb the vanilla dist output — they simply prepare the pipeline
// for the React cutover.
export default defineConfig({
  // GitHub Pages serves under /coarse-grid/ (set via VITE_BASE in
  // .github/workflows/pages.yml); the default build stays root-relative so
  // the Playwright preview contract (baseURL http://127.0.0.1:4173) holds.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
});
