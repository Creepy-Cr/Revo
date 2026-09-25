import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

// Optional, local development only. When the API runs on another port, set
// API_PROXY_TARGET (for example http://localhost:8080) and the dev server
// forwards /api there so the browser stays same-origin and the session cookie
// works. Replit's router does this itself, so the variable is unset there.
const apiProxyTarget = process.env.API_PROXY_TARGET;

export default defineConfig(async ({ command }) => {
  const rawPort = process.env.PORT;
  if (command === 'serve' && !rawPort) {
    throw new Error('PORT environment variable is required for the dev server.');
  }
  const port = Number(rawPort ?? 5173);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }
  const basePath = process.env.BASE_PATH ?? (command === 'build' ? '/' : undefined);
  if (!basePath) {
    throw new Error('BASE_PATH environment variable is required for the dev server.');
  }

  return {
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
    ...(apiProxyTarget
      ? { proxy: { '/api': { target: apiProxyTarget, changeOrigin: false } } }
      : {}),
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
  };
});
