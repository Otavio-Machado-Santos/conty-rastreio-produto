import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackingService } from '../src/domain/tracking-service.js';
import { ProviderError, ShipmentNotFoundError, ValidationError } from '../src/errors.js';

const baseTime = Date.parse('2026-10-08T08:00:00.000Z');
const hour = 3600_000;
const event = (id, hours, status, carrierStatus = status) => ({
  id, occurredAt: new Date(baseTime + hours * hour).toISOString(), status, carrierStatus,
});
function setup(options = {}) {
  let time = baseTime;
  let batch = [];
  let registrations = 0;
  const provider = {
    async register() { registrations += 1; },
    async getEvents() { return batch; },
    ...options.provider,
  };
  const service = new TrackingService({ provider, clock: () => new Date(time), transitLimitMs: 72 * hour, ...options });
  return {
    service, provider,
    setTime(value) { time = value; },
    setBatch(value) { batch = value; },
    registrations: () => registrations,
  };
}

test('cadastro idempotente normaliza código e chama o provedor uma vez inclusive em concorrência', async () => {
  const { service, registrations } = setup();
  const results = await Promise.all([service.register(' cty123 '), service.register('CTY123')]);
  assert.deepEqual(results.map(result => result.created), [true, false]);
  assert.equal(registrations(), 1);
  assert.equal(results[0].shipment.code, 'CTY123');
  assert.equal(results[0].shipment.status, 'sem_eventos');
  assert.equal((await service.register('CTY123')).created, false);
  assert.equal(registrations(), 1);
});

test('códigos inválidos são recusados antes de acessar o agregador', async () => {
  const { service, registrations } = setup();
  for (const code of [null, 'ab', '../test', 'a b c', 'x'.repeat(41), '-CTY']) {
    await assert.rejects(service.register(code), ValidationError);
  }
  assert.equal(registrations(), 0);
  assert.throws(() => service.get('CTY123'), ShipmentNotFoundError);
  await assert.rejects(service.sync('CTY123'), ShipmentNotFoundError);
});

test('falha no cadastro não cadastra localmente e permite uma nova tentativa', async () => {
  let fail = true;
  const { service } = setup({ provider: {
    async register() { if (fail) throw new ProviderError('falhou'); },
    async getEvents() { return []; },
  } });
  await assert.rejects(service.register('CTY123'), ProviderError);
  assert.throws(() => service.get('CTY123'), ShipmentNotFoundError);
  fail = false;
  assert.equal((await service.register('CTY123')).created, true);
});

test('histórico cronológico deduplica repetidos e evento antigo recebido depois não regride status', async () => {
  const ctx = setup();
  await ctx.service.register('CTY123');
  ctx.setBatch([event('moving', 4, 'em_transito'), event('moving', 4, 'em_transito')]);
  assert.equal((await ctx.service.sync('CTY123')).history.length, 1);
  ctx.setBatch([event('posted', 0, 'postado')]);
  const state = await ctx.service.sync('CTY123');
  assert.equal(state.status, 'em_transito');
  assert.deepEqual(state.history.map(item => item.id), ['posted', 'moving']);
  assert.equal(state.transitStartedAt, event('posted', 0, 'postado').occurredAt);
  assert.equal((await ctx.service.sync('CTY123')).history.length, 2);
});

test('ocorrência igual com ids diferentes é única e representante é determinístico', async () => {
  const ctx = setup();
  await ctx.service.register('CTY123');
  ctx.setBatch([event('z', 1, 'postado'), event('a', 1, 'postado')]);
  const first = await ctx.service.sync('CTY123');
  assert.equal(first.history.length, 1);
  assert.equal(first.history[0].id, 'a');
  ctx.setBatch([event('z', 1, 'postado')]);
  assert.deepEqual((await ctx.service.sync('CTY123')).history, first.history);
});

test('empates usam prioridade explícita e histórico igual independentemente da ordem', async () => {
  const sequence = ['desconhecido', 'postado', 'em_transito', 'saiu_para_entrega', 'excecao', 'entregue']
    .map((status, index) => event(String(index), 2, status));
  const one = setup();
  const two = setup();
  await one.service.register('CTY123');
  await two.service.register('CTY123');
  one.setBatch(sequence);
  two.setBatch([...sequence].reverse());
  assert.deepEqual(await one.service.sync('CTY123'), await two.service.sync('CTY123'));
  assert.equal(one.service.get('CTY123').status, 'entregue');
});

test('desconhecido fica auditável, não vira entregue e não substitui o estado conhecido', async () => {
  const ctx = setup();
  await ctx.service.register('CTY123');
  ctx.setBatch([event('invented', 10, 'desconhecido', 'HYPERSPACE_TRANSFER')]);
  const unknown = await ctx.service.sync('CTY123');
  assert.equal(unknown.status, 'desconhecido');
  assert.equal(unknown.alert.active, false);
  assert.equal(unknown.alert.reason, 'sem_inicio_de_transito');
  ctx.setBatch([event('known', 5, 'em_transito')]);
  const known = await ctx.service.sync('CTY123');
  assert.equal(known.status, 'em_transito');
  assert.equal(known.statusAt, event('known', 5, 'em_transito').occurredAt);
  assert.equal(known.lastEventAt, event('invented', 10, 'desconhecido').occurredAt);
  assert.equal(known.history.at(-1).carrierStatus, 'HYPERSPACE_TRANSFER');
});

test('limite é configurável e só ativa depois dele: instante exato e primeiro milissegundo', async () => {
  const ctx = setup({ transitLimitMs: 2 * hour });
  await ctx.service.register('CTY123');
  ctx.setBatch([event('posted', 0, 'postado'), event('transit', 1, 'em_transito')]);
  await ctx.service.sync('CTY123');
  ctx.setTime(baseTime + 2 * hour);
  assert.equal(ctx.service.get('CTY123').alert.active, false);
  ctx.setTime(baseTime + 2 * hour + 1);
  assert.deepEqual(ctx.service.get('CTY123').alert, {
    active: true, reason: 'limite_de_transito_excedido', elapsedMs: 2 * hour + 1,
    thresholdMs: 2 * hour, evaluatedAt: new Date(baseTime + 2 * hour + 1).toISOString(),
  });
});

test('entrega concluída desativa alerta e congela duração, mesmo consultada muitos dias depois', async () => {
  const ctx = setup();
  await ctx.service.register('CTY123');
  ctx.setTime(baseTime + 200 * hour);
  ctx.setBatch([event('delivered', 6, 'entregue'), event('posted', 0, 'postado'), event('transit', 2, 'em_transito')]);
  const delivered = await ctx.service.sync('CTY123');
  assert.equal(delivered.status, 'entregue');
  assert.equal(delivered.alert.active, false);
  assert.equal(delivered.alert.reason, 'entrega_concluida');
  assert.equal(delivered.alert.elapsedMs, 6 * hour);
  ctx.setBatch([event('unexpected-later', 10, 'excecao'), event('invented', 20, 'desconhecido')]);
  const later = await ctx.service.sync('CTY123');
  assert.equal(later.status, 'entregue');
  assert.equal(later.alert.active, false);
  ctx.setBatch([event('old-posted', -1, 'postado')]);
  assert.equal((await ctx.service.sync('CTY123')).status, 'entregue');
});

test('exceção não apaga o início do trânsito e mantém alerta quando o limite já passou', async () => {
  const ctx = setup();
  await ctx.service.register('CTY123');
  ctx.setTime(baseTime + 73 * hour);
  ctx.setBatch([event('posted', 0, 'postado'), event('problem', 72, 'excecao')]);
  const state = await ctx.service.sync('CTY123');
  assert.equal(state.status, 'excecao');
  assert.equal(state.alert.active, true);
});

test('falha do provedor, lote inválido ou colisão de id não altera parcialmente o histórico', async () => {
  const ctx = setup();
  await ctx.service.register('CTY123');
  ctx.setBatch([event('posted', 0, 'postado')]);
  const before = await ctx.service.sync('CTY123');
  const invalidBatches = [
    null,
    [event('new', 2, 'em_transito'), { ...event('bad', 3, 'entregue'), occurredAt: 'yesterday' }],
    [event('new', 2, 'em_transito'), { ...event('bad', 3, 'entregue'), occurredAt: '2026-02-30T00:00:00Z' }],
    [event('new', 2, 'em_transito'), event('posted', 4, 'entregue')],
    [event('new', 2, 'em_transito'), event('bad', 3, 'vendor_raw_status')],
  ];
  for (const batch of invalidBatches) {
    ctx.setBatch(batch);
    await assert.rejects(ctx.service.sync('CTY123'), ProviderError);
    assert.deepEqual(ctx.service.get('CTY123'), before);
  }
  ctx.provider.getEvents = async () => { throw new ProviderError('offline'); };
  await assert.rejects(ctx.service.sync('CTY123'), ProviderError);
  assert.deepEqual(ctx.service.get('CTY123'), before);
});

test('fusos explícitos do mesmo instante são canônicos e deduplicam', async () => {
  const ctx = setup();
  await ctx.service.register('CTY123');
  ctx.setBatch([
    event('same', 0, 'postado'),
    { ...event('same', 0, 'postado'), occurredAt: '2026-10-08T05:00:00-03:00' },
  ]);
  const state = await ctx.service.sync('CTY123');
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].occurredAt, '2026-10-08T08:00:00.000Z');
});

test('ano UTC expandido por offset mantém ordem numérica e evento antigo não regride estado', async () => {
  const ctx = setup({ clock: () => new Date('+010000-01-01T03:00:00.000Z') });
  await ctx.service.register('CTY123');
  const newer = {
    id: 'newer-moving', occurredAt: '9999-12-31T23:30:00-03:00',
    status: 'em_transito', carrierStatus: 'MOVING_BETWEEN_HUBS',
  };
  const older = {
    id: 'older-posted', occurredAt: '9999-12-31T22:00:00Z',
    status: 'postado', carrierStatus: 'PACKAGE_ACCEPTED',
  };
  ctx.setBatch([newer]);
  assert.equal((await ctx.service.sync('CTY123')).status, 'em_transito');
  ctx.setBatch([older]);
  const state = await ctx.service.sync('CTY123');
  assert.equal(state.status, 'em_transito');
  assert.equal(state.statusAt, '+010000-01-01T02:30:00.000Z');
  assert.equal(state.lastEventAt, state.statusAt);
  assert.equal(state.transitStartedAt, '9999-12-31T22:00:00.000Z');
  assert.equal(state.alert.elapsedMs, 5 * hour);
  assert.deepEqual(state.history.map(item => item.id), ['older-posted', 'newer-moving']);
  ctx.setBatch([newer, older, newer]);
  assert.deepEqual(await ctx.service.sync('CTY123'), state);
});

test('consultas concorrentes com resposta antiga concluída depois preservam eventos e estado', async () => {
  let firstResolve;
  let calls = 0;
  const ctx = setup({ provider: {
    async register() {},
    async getEvents() {
      calls += 1;
      if (calls === 1) return new Promise(resolve => { firstResolve = resolve; });
      return [event('newer', 5, 'saiu_para_entrega')];
    },
  } });
  await ctx.service.register('CTY123');
  const first = ctx.service.sync('CTY123');
  await ctx.service.sync('CTY123');
  firstResolve([event('older', 0, 'postado')]);
  const final = await first;
  assert.equal(final.status, 'saiu_para_entrega');
  assert.deepEqual(final.history.map(item => item.id), ['older', 'newer']);
});

test('leituras devolvem cópias e o relógio anterior ao evento não gera atraso negativo', async () => {
  const ctx = setup();
  await ctx.service.register('CTY123');
  ctx.setBatch([event('future', 1, 'postado')]);
  const state = await ctx.service.sync('CTY123');
  assert.equal(state.alert.elapsedMs, 0);
  state.history[0].status = 'entregue';
  state.history.push(event('injected', 2, 'entregue'));
  assert.equal(ctx.service.get('CTY123').status, 'postado');
  assert.equal(ctx.service.get('CTY123').history.length, 1);
});

test('configuração inválida não inicia serviço', () => {
  for (const value of [0, -1, NaN, 0.5, Infinity]) assert.throws(() => setup({ transitLimitMs: value }), TypeError);
  assert.throws(() => new TrackingService({ provider: {} }), TypeError);
  const ctx = setup({ clock: () => new Date('invalid') });
  return assert.rejects(ctx.service.register('CTY123'), TypeError);
});
