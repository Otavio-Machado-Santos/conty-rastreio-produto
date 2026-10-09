import { AggregatorHttpClient } from './providers/aggregator-http-client.js';
import { TrackingService } from './domain/tracking-service.js';
import { createApi } from './http-api.js';

function positiveInteger(value, fallback, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${name} deve ser inteiro positivo.`);
  return number;
}

const port = positiveInteger(process.env.PORT, 3007, 'PORT');
if (port > 65535) throw new TypeError('PORT deve ser no máximo 65535.');
const hours = positiveInteger(process.env.TRANSIT_LIMIT_HOURS, 72, 'TRANSIT_LIMIT_HOURS');
const provider = new AggregatorHttpClient({
  baseUrl: process.env.AGGREGATOR_URL ?? 'http://127.0.0.1:4007',
  timeoutMs: positiveInteger(process.env.AGGREGATOR_TIMEOUT_MS, 2000, 'AGGREGATOR_TIMEOUT_MS'),
});
const service = new TrackingService({ provider, transitLimitMs: hours * 60 * 60 * 1000 });
const server = createApi(service);
server.listen(port, '127.0.0.1', () => console.log(`API de rastreio: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
