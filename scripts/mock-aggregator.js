import { createMockAggregator } from '../src/providers/mock-server.js';

const port = process.env.MOCK_PORT === undefined ? 4007 : Number(process.env.MOCK_PORT);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError('MOCK_PORT inválida.');
const server = createMockAggregator();
server.listen(port, '127.0.0.1', () => console.log(`Agregador fictício: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
