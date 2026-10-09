import { ProviderError } from '../errors.js';

// Somente este adaptador conhece o dialeto do agregador fictício.
const statusMap = new Map([
  ['PACKAGE_ACCEPTED', 'postado'],
  ['MOVING_BETWEEN_HUBS', 'em_transito'],
  ['DRIVER_ROUTE', 'saiu_para_entrega'],
  ['DELIVERY_CONFIRMED', 'entregue'],
  ['DELIVERY_PROBLEM', 'excecao'],
]);

export function normalizeProviderEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || typeof raw.event_uuid !== 'string' || !raw.event_uuid || raw.event_uuid.length > 200
      || typeof raw.state !== 'string' || !raw.state || raw.state.length > 200
      || typeof raw.created_at !== 'string') {
    throw new ProviderError('O agregador retornou um evento malformado.');
  }
  return {
    id: raw.event_uuid,
    occurredAt: raw.created_at,
    status: statusMap.get(raw.state) ?? 'desconhecido',
    carrierStatus: raw.state,
  };
}

export class AggregatorHttpClient {
  constructor({ baseUrl, timeoutMs = 2000, fetchImpl = globalThis.fetch }) {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.search || parsed.hash) {
      throw new TypeError('A URL do agregador deve usar HTTP ou HTTPS e não conter query ou fragmento.');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('Timeout inválido.');
    this.baseUrl = `${parsed.href.replace(/\/+$/, '')}/`;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async #request(path, options = {}) {
    try {
      const response = await this.fetch(new URL(path, this.baseUrl), {
        ...options,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: 'application/json', ...options.headers },
        redirect: 'error',
      });
      if (!response.ok) throw new ProviderError(`O agregador respondeu HTTP ${response.status}.`);
      return await response.json();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw new ProviderError('A consulta ao agregador excedeu o timeout.');
      }
      throw new ProviderError('Não foi possível ler uma resposta JSON do agregador.', { cause: error });
    }
  }

  async register(code) {
    const result = await this.#request('api/tracking', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tracking_code: code }),
    });
    if (!result || result.tracking_code !== code || result.accepted !== true) {
      throw new ProviderError('O agregador não confirmou o cadastro do código solicitado.');
    }
  }

  async getEvents(code) {
    const result = await this.#request(`api/tracking/${encodeURIComponent(code)}/events`);
    if (!result || result.tracking_code !== code || !Array.isArray(result.checkpoints)) {
      throw new ProviderError('O agregador retornou rastreio de outro código ou sem eventos.');
    }
    return result.checkpoints.map(normalizeProviderEvent);
  }
}
