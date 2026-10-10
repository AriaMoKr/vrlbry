// A local HTTP server that serves files with range requests, as Kiwix's mirror does, for tests of
// ZIMs read over HTTP (core/zim/http-source.js, the local library's web addresses). Per file it
// can also refuse ranges, hide Content-Range (as a page sees a server that does not expose it),
// fail for a while, or change its Last-Modified (a new edition).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/**
 * Starts a server on a free port.
 * @returns {Promise<{ base: string, requests: Array<{ method: string, url: string, range: string|null }>,
 *   serve: (file: string, opts?: { mode?: 'ranges'|'no-ranges'|'no-content-range', failures?: number, lastModified?: string }) => { url: string, route: object },
 *   close: () => Promise<void> }>}
 */
export async function startRangeServer() {
  const routes = new Map();
  const requests = [];
  const server = http.createServer((req, res) => {
    const route = routes.get(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    requests.push({ method: req.method, url: req.url, range: req.headers.range ?? null });
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length' };
    if (!route) {
      res.writeHead(404, cors);
      return res.end();
    }
    if (route.failures > 0) { // a server busy for a while
      route.failures--;
      res.writeHead(503, cors);
      return res.end();
    }
    const data = fs.readFileSync(route.file);
    const headers = { ...cors, 'Last-Modified': route.lastModified, 'Accept-Ranges': 'bytes' };
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...headers, 'Content-Length': data.length });
      return res.end();
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (!m || route.mode === 'no-ranges') {
      res.writeHead(200, { ...headers, 'Content-Length': data.length });
      return res.end(data);
    }
    const start = Number(m[1]);
    const end = Math.min(data.length - 1, Number(m[2]));
    const part = data.subarray(start, end + 1);
    res.writeHead(206, {
      ...headers,
      'Content-Length': part.length,
      ...(route.mode === 'no-content-range' ? {} : { 'Content-Range': `bytes ${start}-${end}/${data.length}` }),
    });
    res.end(part);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let n = 0;
  return {
    base,
    requests,
    /** Serves a file at a new path (named as the file): its URL and its route, to change later. */
    serve(file, opts = {}) {
      const p = `/zim/${++n}/${path.basename(file)}`;
      routes.set(p, { file, mode: 'ranges', failures: 0, lastModified: 'Sat, 10 Oct 2026 00:00:00 GMT', ...opts });
      return { url: base + p.split('/').map(encodeURIComponent).join('/'), route: routes.get(p) };
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
