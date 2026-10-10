#!/usr/bin/env node
// Runs the edge proxy (worker.js) on this machine, for trying it without Cloudflare: a page on
// http://localhost reads through it with ?zimproxy=http://localhost:8090/ (zim-url.js zimProxyOf).
//
//   node tools/zim-proxy/serve.mjs [--port 8090] [--continent NA]
//
// --continent stands in for Cloudflare's guess of where the visitor is (which mirrors go first).

import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { handle } from './worker.js';

/**
 * Serves `handler` (a Worker's fetch: Request → Response) over HTTP on this machine.
 * @returns {Promise<http.Server>}
 */
export async function serveWorker(handler, { port = 8090, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const headers = {};
      for (const h of ['range', 'origin', 'access-control-request-method', 'access-control-request-headers']) {
        if (req.headers[h]) headers[h] = req.headers[h];
      }
      const answer = await handler(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers }));
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      if (answer.body && req.method !== 'HEAD') Readable.fromWeb(answer.body).on('error', () => res.destroy()).pipe(res);
      else res.end();
    } catch (err) {
      res.writeHead(500, { 'access-control-allow-origin': '*' });
      res.end(`${err.message}\n`);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); // the port taken, or reserved (Windows keeps ranges such as 8754-8953)
    server.listen(port, host, resolve);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '8090' }, continent: { type: 'string', default: 'NA' } } });
  const server = await serveWorker((request) => {
    const t = performance.now();
    return handle(request, { continent: values.continent }).then((res) => {
      console.log(`${request.method} ${new URL(request.url).pathname} ${request.headers.get('range') ?? ''} → ${res.status} ${res.headers.get('x-mirror') ?? ''} ${(performance.now() - t).toFixed(0)} ms`);
      return res;
    });
  }, { port: Number(values.port) });
  console.log(`The ZIM proxy on http://127.0.0.1:${server.address().port}/ (mirrors for ${values.continent} first)`);
}
