import { httpOrigin, port } from './scripts/config.ts';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('./', import.meta.url)), '');
  const target = httpOrigin(
    process.env.RAG_API_PROXY ?? env.RAG_API_PROXY ?? 'http://127.0.0.1:3210',
    'RAG_API_PROXY',
  );
  // Preserve browser Host/Origin so the server's same-origin CSRF check stays active.
  const proxy: ProxyOptions = {
    target,
    changeOrigin: false,
    timeout: 0,
    proxyTimeout: 0,
    configure(server) {
      server.on('proxyReq', (outgoing, incoming) => {
        for (const key of Object.keys(incoming.headers))
          if (key.startsWith('x-forwarded-')) outgoing.removeHeader(key);
        const peer = incoming.socket.remoteAddress ?? '';
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer))
          outgoing.setHeader('X-Forwarded-For', peer);
      });
    },
  };
  return {
    plugins: [react()],
    server: {
      host: process.env.CLIENT_DEV_HOST ?? env.CLIENT_DEV_HOST ?? '127.0.0.1',
      port: port(process.env.CLIENT_DEV_PORT ?? env.CLIENT_DEV_PORT, 5173),
      strictPort: true,
      proxy: { '/api': proxy, '/health': proxy },
    },
    preview: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: true,
      proxy: { '/api': proxy, '/health': proxy },
    },
    build: { sourcemap: false },
  };
});
