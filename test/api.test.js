import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { TrackingService } from '../src/domain/tracking-service.js';
import { AggregatorHttpClient } from '../src/providers/aggregator-http-client.js';
import { createMockAggregator } from '../src/providers/mock-server.js';
import { createApi } from '../src/http-api.js';
import { ProviderError } from '../src/errors.js';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close(); server.closeAllConnections(); await closed;
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function post(body) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

test('API e agregador HTTP reais: cadastrar, sincronizar, repetir, ler entrega e desconhecido', async t => {
  const clock = () => new Date('2026-10-10T08:00:00.000Z');
  const aggregatorUrl = await listen(t, createMockAggregator({ clock }));
  const provider = new AggregatorHttpClient({ baseUrl: aggregatorUrl });
  const url = await listen(t, createApi(new TrackingService({ provider, clock })));
  let response = await fetch(`${url}/shipments`, post({ code: ' cty123 ' }));
  assert.equal(response.status, 201);
  assert.equal((await response.json()).status, 'sem_eventos');
  response = await fetch(`${url}/shipments`, post({ code: 'CTY123' }));
  assert.equal(response.status, 200);
  response = await fetch(`${url}/shipments/CTY123/sync`, { method: 'POST' });
  const first = await response.json();
  assert.equal(response.status, 200);
  assert.equal(first.status, 'entregue');
  assert.equal(first.history.length, 5);
  assert.equal(first.history.at(-1).status, 'desconhecido');
  assert.equal(first.alert.active, false);
  assert.equal(first.alert.elapsedMs, 8 * 3600_000);
  response = await fetch(`${url}/shipments/CTY123/sync`, { method: 'POST' });
  assert.deepEqual(await response.json(), first);
  assert.deepEqual(await (await fetch(`${url}/shipments/CTY123`)).json(), first);
  await fetch(`${url}/shipments`, post({ code: 'CTYUNKNOWN' }));
  const unknown = await (await fetch(`${url}/shipments/CTYUNKNOWN/sync`, { method: 'POST' })).json();
  assert.equal(unknown.status, 'desconhecido');
  assert.equal(unknown.alert.active, false);
  await fetch(`${url}/shipments`, post({ code: 'CTYLATE' }));
  const late = await (await fetch(`${url}/shipments/CTYLATE/sync`, { method: 'POST' })).json();
  assert.equal(late.status, 'em_transito');
  assert.equal(late.alert.active, true);
  assert.equal(late.alert.elapsedMs, 96 * 3600_000);
  assert.deepEqual(await (await fetch(`${url}/shipments/CTYLATE/sync`, { method: 'POST' })).json(), late);
});

test('API diferencia entrada inválida, rota/código ausente e método incorreto', async t => {
  let registrations = 0;
  const provider = { async register() { registrations += 1; }, async getEvents() { return []; } };
  const url = await listen(t, createApi(new TrackingService({ provider })));
  for (const body of [{ code: '../test' }, {}, { code: 123 }, null, []]) {
    const response = await fetch(`${url}/shipments`, post(body));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_request');
  }
  assert.equal(registrations, 0);
  const badJson = await fetch(`${url}/shipments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(badJson.status, 400);
  assert.equal((await fetch(`${url}/shipments`, { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await fetch(`${url}/shipments/CTYMISSING`)).status, 404);
  assert.equal((await fetch(`${url}/shipments/CTYMISSING/sync`, { method: 'POST' })).status, 404);
  const wrongMethod = await fetch(`${url}/shipments/CTY123/sync`);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  assert.equal((await fetch(`${url}/unknown`)).status, 404);
  assert.equal((await fetch(`${url}/shipments/%ZZ`)).status, 400);
});

test('indisponibilidade do agregador retorna 502 preservando cadastro e histórico', async t => {
  const provider = {
    async register() {},
    async getEvents() { throw new ProviderError('Agregador indisponível.'); },
  };
  const url = await listen(t, createApi(new TrackingService({ provider })));
  await fetch(`${url}/shipments`, post({ code: 'CTY123' }));
  const response = await fetch(`${url}/shipments/CTY123/sync`, { method: 'POST' });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'provider_failure');
  const saved = await (await fetch(`${url}/shipments/CTY123`)).json();
  assert.equal(saved.status, 'sem_eventos');
  assert.equal(saved.history.length, 0);
});

test('demonstração visual é servida localmente com identificação clara dos dados sintéticos', async t => {
  const provider = { async register() {}, async getEvents() { return []; } };
  const url = await listen(t, createApi(new TrackingService({ provider })));
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Dados sintéticos/);
  const health = await (await fetch(`${url}/health`)).json();
  assert.deepEqual(health, { status: 'ok', storage: 'memory' });
});
