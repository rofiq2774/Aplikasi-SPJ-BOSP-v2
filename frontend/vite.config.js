import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Backend FastAPI TIDAK lagi berjalan di port statis 8000 — ia di-spawn
// Electron sebagai child_process pada port DINAMIS, dan renderer selalu
// memakai URL absolut http://127.0.0.1:<port>/api (lihat app.js: API_BASE).
// Proxy lama yang menunjuk ke 127.0.0.1:8000 justru berbahaya: setiap URL
// relatif "/api/..." yang sempat terbentuk sebelum origin backend tersedia
// (race saat startup) tertangkap proxy ini dan menjawab 500 — persis bug
// "FETCH <- 500 GET /api/identitas-periode" + "Failed to load resource ...
// :5173/api/identitas-periode". Target kini bisa dioverride lewat env
// VITE_BACKEND_PORT bila suatu saat perlu; tanpa itu, permintaan /api di dev
// gagal cepat dengan pesan jelas alih-alih 500 membingungkan dari port mati.
const BACKEND_PROXY_TARGET = process.env.VITE_BACKEND_PORT
  ? `http://127.0.0.1:${process.env.VITE_BACKEND_PORT}`
  : null;

function devApiProxy() {
  if (!BACKEND_PROXY_TARGET) {
    // Tidak ada target statis — biarkan respons 404/502 lokal yang menjelaskan
    // bahwa backend child_process tidak pernah dipatok di port tetap.
    return {
      '/api': ({ req, res }) => {
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          status: 'error',
          detail:
            'Vite TIDAK mem-proxy /api — backend berjalan sebagai child_process ' +
            'Electron pada port dinamis. Gunakan URL absolut ' +
            'http://127.0.0.1:<port>/api (API_BASE di app.js), atau set ' +
            'VITE_BACKEND_PORT=<port> saat menjalankan vite untuk debugging.',
        }));
      },
    };
  }
  return {
    '/api': { target: BACKEND_PROXY_TARGET, changeOrigin: true },
    '/uploads': { target: BACKEND_PROXY_TARGET, changeOrigin: true },
  };
}

export default defineConfig({
  plugins: [react()],
  base: './', // SANGAT PENTING: Gunakan titik dan garis miring
  server: {
    proxy: devApiProxy(),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
  },
})
