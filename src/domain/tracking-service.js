import { ProviderError, ShipmentNotFoundError, ValidationError } from '../errors.js';

// Contrato do provedor: register(code), getEvents(code) => NormalizedEvent[].
// Cada evento tem id, occurredAt, status e carrierStatus; nenhum campo do vendor.
export const STATUSES = Object.freeze([
  'postado', 'em_transito', 'saiu_para_entrega', 'entregue', 'excecao', 'desconhecido',
]);
const tiedStatusPriority = new Map([
  ['desconhecido', 0], ['postado', 1], ['em_transito', 2],
  ['saiu_para_entrega', 3], ['excecao', 4], ['entregue', 5],
]);
const transitStatuses = new Set(['postado', 'em_transito', 'saiu_para_entrega']);
const compareStrings = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function normalizeCode(value) {
  if (typeof value !== 'string') throw new ValidationError('O código deve ser um texto.');
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{2,39}$/.test(code)) {
    throw new ValidationError('O código deve ter 3 a 40 caracteres: letras, números ou hífen.');
  }
  return code;
}

function canonicalEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.id !== 'string' || !input.id || input.id.length > 200
      || typeof input.carrierStatus !== 'string' || !input.carrierStatus || input.carrierStatus.length > 200
      || !STATUSES.includes(input.status)
      || typeof input.occurredAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.occurredAt)
      || !Number.isFinite(Date.parse(input.occurredAt))) {
    throw new ProviderError('O provedor retornou um evento inválido.');
  }
  const [year, month, day] = input.occurredAt.slice(0, 10).split('-').map(Number);
  const firstDay = new Date(`${input.occurredAt.slice(0, 7)}-01T00:00:00.000Z`);
  firstDay.setUTCMonth(firstDay.getUTCMonth() + 1);
  firstDay.setUTCDate(0);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > firstDay.getUTCDate()) {
    throw new ProviderError('O provedor retornou uma data inexistente.');
  }
  return {
    id: input.id,
    occurredAt: new Date(input.occurredAt).toISOString(),
    status: input.status,
    carrierStatus: input.carrierStatus,
  };
}

// A transportadora pode reemitir a mesma ocorrência com outro id.
function fingerprint(event) {
  return JSON.stringify([event.occurredAt, event.status, event.carrierStatus]);
}

function compareEvents(a, b) {
  return Date.parse(a.occurredAt) - Date.parse(b.occurredAt)
    || tiedStatusPriority.get(a.status) - tiedStatusPriority.get(b.status)
    || compareStrings(a.carrierStatus, b.carrierStatus)
    || compareStrings(a.id, b.id);
}

export class TrackingService {
  #shipments = new Map();
  #registrations = new Map();

  constructor({ provider, clock = () => new Date(), transitLimitMs = 72 * 60 * 60 * 1000 }) {
    if (!provider || typeof provider.register !== 'function' || typeof provider.getEvents !== 'function') {
      throw new TypeError('O provedor deve implementar register e getEvents.');
    }
    if (!Number.isSafeInteger(transitLimitMs) || transitLimitMs <= 0) {
      throw new TypeError('O limite de trânsito deve ser um número inteiro positivo de milissegundos.');
    }
    this.provider = provider;
    this.clock = clock;
    this.transitLimitMs = transitLimitMs;
  }

  #now() {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('Relógio inválido.');
    return now;
  }

  async register(value) {
    const code = normalizeCode(value);
    if (this.#shipments.has(code)) return { created: false, shipment: this.get(code) };
    if (this.#registrations.has(code)) {
      await this.#registrations.get(code);
      return { created: false, shipment: this.get(code) };
    }
    const registration = (async () => {
      await this.provider.register(code);
      this.#shipments.set(code, { code, registeredAt: this.#now().toISOString(), events: [], ids: new Map() });
    })();
    this.#registrations.set(code, registration);
    try {
      await registration;
      return { created: true, shipment: this.get(code) };
    } finally {
      this.#registrations.delete(code);
    }
  }

  #find(value) {
    const code = normalizeCode(value);
    const shipment = this.#shipments.get(code);
    if (!shipment) throw new ShipmentNotFoundError(`O código ${code} ainda não foi cadastrado.`);
    return shipment;
  }

  async sync(value) {
    const shipment = this.#find(value);
    const batch = await this.provider.getEvents(shipment.code);
    if (!Array.isArray(batch)) throw new ProviderError('O provedor deve retornar uma lista de eventos.');

    // Toda a resposta é validada antes do commit: falhas não deixam metade do histórico.
    const ids = new Map(shipment.ids);
    const events = new Map(shipment.events.map(event => [fingerprint(event), event]));
    for (const item of batch) {
      const event = canonicalEvent(item);
      const key = fingerprint(event);
      if (ids.has(event.id) && ids.get(event.id) !== key) {
        throw new ProviderError('O provedor reutilizou um id de evento com conteúdo diferente.');
      }
      ids.set(event.id, key);
      const previous = events.get(key);
      // O representante de uma ocorrência depende dos dados, nunca da ordem de chegada.
      if (!previous || compareStrings(event.id, previous.id) < 0) events.set(key, event);
    }
    shipment.events = [...events.values()].sort(compareEvents);
    shipment.ids = ids;
    return this.get(shipment.code);
  }

  get(value) {
    const shipment = this.#find(value);
    const now = this.#now();
    const delivered = shipment.events.findLast(event => event.status === 'entregue');
    const recognized = shipment.events.filter(event => event.status !== 'desconhecido');
    // Entregue é terminal para o pacote; devolução é outro fluxo, fora deste contrato.
    const current = delivered ?? recognized.at(-1) ?? shipment.events.at(-1);
    const transitStart = shipment.events.find(event => transitStatuses.has(event.status));
    const transitEnd = delivered ? Date.parse(delivered.occurredAt) : now.getTime();
    const elapsedMs = transitStart ? Math.max(0, transitEnd - Date.parse(transitStart.occurredAt)) : null;
    let reason;
    if (delivered) reason = 'entrega_concluida';
    else if (!transitStart) reason = 'sem_inicio_de_transito';
    else if (elapsedMs > this.transitLimitMs) reason = 'limite_de_transito_excedido';
    else reason = 'dentro_do_limite';
    return {
      code: shipment.code,
      registeredAt: shipment.registeredAt,
      status: current?.status ?? 'sem_eventos',
      statusAt: current?.occurredAt ?? null,
      lastEventAt: shipment.events.at(-1)?.occurredAt ?? null,
      transitStartedAt: transitStart?.occurredAt ?? null,
      alert: {
        active: reason === 'limite_de_transito_excedido',
        reason,
        elapsedMs,
        thresholdMs: this.transitLimitMs,
        evaluatedAt: now.toISOString(),
      },
      history: shipment.events.map(event => ({ ...event })),
    };
  }
}
