import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { ProviderError, ShipmentNotFoundError, ValidationError } from './errors.js';

const page = await readFile(new URL('../public/index.html', import.meta.url));
const BODY_LIMIT = 64 * 1024;

function json(response, status, data, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ValidationError('Envie o corpo com Content-Type: application/json.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new ValidationError('O corpo excede o limite de 64 KiB.');
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ValidationError('O corpo deve ser JSON válido.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new ValidationError('O corpo deve ser um objeto JSON.');
  }
  return result;
}

export function createApi(service) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      if (pathname === '/' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(page);
        return;
      }
      if (pathname === '/health' && request.method === 'GET') {
        json(response, 200, { status: 'ok', storage: 'memory' });
        return;
      }
      if (pathname === '/shipments') {
        if (request.method !== 'POST') {
          json(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
          return;
        }
        const body = await readJson(request);
        const result = await service.register(body.code);
        json(response, result.created ? 201 : 200, result.shipment);
        return;
      }
      const route = pathname.match(/^\/shipments\/([^/]+)(\/sync)?$/);
      if (route) {
        let code;
        try { code = decodeURIComponent(route[1]); }
        catch { throw new ValidationError('O código da URL é inválido.'); }
        const expectedMethod = route[2] ? 'POST' : 'GET';
        if (request.method !== expectedMethod) {
          json(response, 405, { error: 'method_not_allowed' }, { allow: expectedMethod });
          return;
        }
        const shipment = route[2] ? await service.sync(code) : service.get(code);
        json(response, 200, shipment);
        return;
      }
      json(response, 404, { error: 'route_not_found' });
    } catch (error) {
      if (error instanceof ValidationError) json(response, 400, { error: 'invalid_request', message: error.message });
      else if (error instanceof ShipmentNotFoundError) json(response, 404, { error: 'shipment_not_found', message: error.message });
      else if (error instanceof ProviderError) json(response, 502, { error: 'provider_failure', message: error.message });
      else {
        console.error('Erro interno na API de rastreio:', error.name);
        json(response, 500, { error: 'internal_error', message: 'Falha interna ao processar o rastreio.' });
      }
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}
