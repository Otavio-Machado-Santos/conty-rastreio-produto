import { once } from 'node:events';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createMockAggregator } from '../src/providers/mock-server.js';
import { AggregatorHttpClient } from '../src/providers/aggregator-http-client.js';
import { TrackingService } from '../src/domain/tracking-service.js';
import { createApi } from '../src/http-api.js';

// O comando executa tráfego real por dois servidores TCP em portas efêmeras.
const clock = () => new Date('2026-10-10T08:00:00.000Z');
const mock = createMockAggregator({ clock });
const apiServers = [mock];
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
const transcript = { runtime: process.version, clock: clock().toISOString(), transport: 'HTTP real em loopback', requests: [] };
try {
  const provider = new AggregatorHttpClient({ baseUrl: await listen(mock) });
  const api = createApi(new TrackingService({ provider, clock }));
  apiServers.push(api);
  const url = await listen(api);
  async function request(method, path, body) {
    const response = await fetch(`${url}${path}`, {
      method,
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    transcript.requests.push({ method, path, ...(body ? { body } : {}), status: response.status, response: result });
    assert.equal(response.ok, true);
    return result;
  }
  await request('POST', '/shipments', { code: 'CTY123' });
  const first = await request('POST', '/shipments/CTY123/sync');
  const again = await request('POST', '/shipments/CTY123/sync');
  assert.deepEqual(again, first);
  assert.equal(first.status, 'entregue');
  assert.equal(first.history.length, 5);
  assert.equal(first.alert.active, false);
  await request('POST', '/shipments', { code: 'CTYUNKNOWN' });
  assert.equal((await request('POST', '/shipments/CTYUNKNOWN/sync')).status, 'desconhecido');
  await request('POST', '/shipments', { code: 'CTYLATE' });
  assert.equal((await request('POST', '/shipments/CTYLATE/sync')).alert.active, true);
  await request('GET', '/shipments/CTY123');
  transcript.result = 'PASSOU';
  await mkdir(new URL('../docs/evidence/', import.meta.url), { recursive: true });
  await writeFile(new URL('../docs/evidence/http-flow.json', import.meta.url), `${JSON.stringify(transcript, null, 2)}\n`);
  await writeFile(new URL('../docs/example-normalized.json', import.meta.url), `${JSON.stringify(first, null, 2)}\n`);
  const raw = JSON.parse(await readFile(new URL('../fixtures/aggregator-raw.json', import.meta.url), 'utf8'));
  assert.equal(raw.checkpoints.length, 6);
  console.log(`PASSOU: ${transcript.requests.length} requisições HTTP reais, entrega sem alerta, repetição sem duplicar, desconhecido e atraso.`);
} finally {
  await Promise.all(apiServers.map(async server => {
    if (!server.listening) return;
    const closed = once(server, 'close');
    server.close(); server.closeAllConnections(); await closed;
  }));
}
