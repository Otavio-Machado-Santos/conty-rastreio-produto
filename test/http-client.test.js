import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { AggregatorHttpClient, normalizeProviderEvent } from '../src/providers/aggregator-http-client.js';
import { ProviderError } from '../src/errors.js';
import { createMockAggregator } from '../src/providers/mock-server.js';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('o adaptador mapeia os cinco status e preserva estado inventado como desconhecido', () => {
  const pairs = [
    ['PACKAGE_ACCEPTED', 'postado'], ['MOVING_BETWEEN_HUBS', 'em_transito'],
    ['DRIVER_ROUTE', 'saiu_para_entrega'], ['DELIVERY_CONFIRMED', 'entregue'],
    ['DELIVERY_PROBLEM', 'excecao'], ['DELIVERED_BUT_NOT_REALLY', 'desconhecido'],
  ];
  for (const [raw, status] of pairs) {
    assert.deepEqual(normalizeProviderEvent({ event_uuid: 'id', created_at: '2026-10-08T08:00:00Z', state: raw }), {
      id: 'id', occurredAt: '2026-10-08T08:00:00Z', status, carrierStatus: raw,
    });
  }
  assert.throws(() => normalizeProviderEvent({ event_uuid: 'id', state: null }), ProviderError);
});

test('cadastro e consulta usam HTTP real no dialeto do vendor', async t => {
  const raw = JSON.parse(await readFile(new URL('../fixtures/aggregator-raw.json', import.meta.url), 'utf8'));
  const baseUrl = await listen(t, createMockAggregator());
  const client = new AggregatorHttpClient({ baseUrl });
  await client.register('CTY123');
  assert.deepEqual(await client.getEvents('CTY123'), raw.checkpoints.map(normalizeProviderEvent));
  assert.deepEqual(await client.getEvents('CTY123'), raw.checkpoints.map(normalizeProviderEvent));
});

test('fixtures com relógio relativo permanecem estáveis em consultas e recadastros', async t => {
  let now = new Date('2026-10-10T08:00:00Z');
  const baseUrl = await listen(t, createMockAggregator({ clock: () => now }));
  const client = new AggregatorHttpClient({ baseUrl });
  for (const code of ['CTYLATE', 'CTYUNKNOWN']) {
    await client.register(code);
    const first = await client.getEvents(code);
    now = new Date(now.getTime() + 3600_000);
    await client.register(code);
    assert.deepEqual(await client.getEvents(code), first);
  }
});

test('HTTP 503 é erro explícito e não gera status de entrega', async t => {
  const baseUrl = await listen(t, createServer((request, response) => {
    response.writeHead(503); response.end('down');
  }));
  const client = new AggregatorHttpClient({ baseUrl });
  await assert.rejects(client.getEvents('CTY123'), error => error instanceof ProviderError && /503/.test(error.message));
});

test('timeout aborta consulta HTTP real e retorna falha limitada', async t => {
  const baseUrl = await listen(t, createServer(() => {}));
  const client = new AggregatorHttpClient({ baseUrl, timeoutMs: 40 });
  await assert.rejects(client.getEvents('CTY123'), error => error instanceof ProviderError && /timeout/.test(error.message));
});

test('respostas JSON inválidas, rastreio de outro pacote e estruturas malformadas são recusadas', async t => {
  let body = '<html>oops</html>';
  const baseUrl = await listen(t, createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(body);
  }));
  const client = new AggregatorHttpClient({ baseUrl });
  for (const next of [
    '<html>oops</html>', 'null',
    JSON.stringify({ tracking_code: 'WRONG', checkpoints: [] }),
    JSON.stringify({ tracking_code: 'CTY123', checkpoints: {} }),
    JSON.stringify({ tracking_code: 'CTY123', checkpoints: [null] }),
  ]) {
    body = next;
    await assert.rejects(client.getEvents('CTY123'), ProviderError);
  }
  body = JSON.stringify({ accepted: true, tracking_code: 'WRONG' });
  await assert.rejects(client.register('CTY123'), ProviderError);
});

test('redirect HTTP não muda silenciosamente o destino do cadastro', async t => {
  const baseUrl = await listen(t, createServer((request, response) => {
    response.writeHead(307, { location: '/other-vendor' }); response.end();
  }));
  await assert.rejects(new AggregatorHttpClient({ baseUrl }).register('CTY123'), ProviderError);
});

test('configuração do cliente recusa protocolos ou timeouts inválidos', () => {
  for (const baseUrl of ['file:///tmp/x', 'https://example.com/?token=x', 'http://x/#fragment']) {
    assert.throws(() => new AggregatorHttpClient({ baseUrl }), TypeError);
  }
  assert.throws(() => new AggregatorHttpClient({ baseUrl: 'http://127.0.0.1', timeoutMs: 0 }), TypeError);
});
