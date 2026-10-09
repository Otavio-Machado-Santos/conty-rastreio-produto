import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const rawExample = JSON.parse(await readFile(new URL('../../fixtures/aggregator-raw.json', import.meta.url), 'utf8'));

export function createMockAggregator({ clock = () => new Date() } = {}) {
  const registered = new Map();
  function fixture(code) {
    const now = clock();
    if (code === 'CTY123') return rawExample.checkpoints;
    if (code === 'CTYUNKNOWN') return [
      { event_uuid: 'unknown-1', created_at: now.toISOString(), state: 'SOMETHING_NEW_FROM_CARRIER' },
    ];
    if (code === 'CTYLATE') return [
      { event_uuid: 'late-posted', created_at: new Date(now.getTime() - 96 * 3600_000).toISOString(), state: 'PACKAGE_ACCEPTED' },
      { event_uuid: 'late-transit', created_at: new Date(now.getTime() - 90 * 3600_000).toISOString(), state: 'MOVING_BETWEEN_HUBS' },
    ];
    return [];
  }
  return createServer(async (request, response) => {
    function reply(status, value) {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    }
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method === 'POST' && pathname === '/api/tracking') {
      let bytes = 0;
      const chunks = [];
      try {
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 64 * 1024) { reply(413, { error: 'body_too_large' }); return; }
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof body?.tracking_code !== 'string' || !/^[A-Z0-9][A-Z0-9-]{2,39}$/.test(body.tracking_code)) {
          reply(400, { error: 'invalid_code' }); return;
        }
        if (!registered.has(body.tracking_code)) registered.set(body.tracking_code, fixture(body.tracking_code));
        reply(201, { accepted: true, tracking_code: body.tracking_code });
      } catch { reply(400, { error: 'invalid_json' }); }
      return;
    }
    const route = pathname.match(/^\/api\/tracking\/([A-Z0-9-]+)\/events$/);
    if (request.method === 'GET' && route) {
      const code = route[1];
      if (!registered.has(code)) { reply(404, { error: 'unregistered_code' }); return; }
      reply(200, { tracking_code: code, checkpoints: registered.get(code) });
      return;
    }
    reply(404, { error: 'route_not_found' });
  });
}
