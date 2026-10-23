import { port as readPort } from './config.ts';
import { createClientServer } from './gateway.ts';
const server = createClientServer({
  apiUrl: process.env.CLIENT_API_URL ?? 'http://127.0.0.1:3210',
});
const port = readPort(process.env.CLIENT_PORT, 8080),
  host = process.env.CLIENT_HOST ?? '127.0.0.1';
server.listen(port, host, () =>
  console.log(`Multimodal RAG Knowledge Base client: http://${host}:${port}`),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    server.closeAllConnections();
    server.close();
  });
