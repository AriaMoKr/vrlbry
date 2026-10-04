#!/usr/bin/env node
/**
 * vrlbry CLI (SPEC §3.7): scans a directory for ZIM files and serves the library over HTTP(S).
 *
 *   node server/index.js [--dir <path>] [--port 8080] [--host 0.0.0.0] [--https]
 *                        [--cert <file> --key <file>] [--max-generic 2000] [--no-watch] [--quiet]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createApp } from './http.js';
import { Library } from './library.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Where the generated self-signed certificate is cached. */
export const CERT_DIR = path.join(PROJECT_ROOT, '.cert');
const PORT_ATTEMPTS = 11; // the requested port + the next 10
const CERT_DAYS = 365;
const CERT_RENEW_MS = 24 * 60 * 60 * 1000; // regenerate when less than a day is left

export const USAGE = `Usage: node server/index.js [options]

Serves the books of every *.zim file in a directory as a WebXR library.

Options:
  --dir <path>         directory with .zim files (default: current directory)
  --port <n>           port (default 8080; if busy, the next 10 ports are tried)
  --host <addr>        address to listen on (default: all interfaces)
  --https              serve HTTPS (needed by a VR headset on the LAN); uses --cert/--key,
                       else a self-signed certificate cached in .cert/
  --cert <file>        PEM certificate for --https
  --key <file>         PEM private key for --https
  --max-generic <n>    max books listed from a non-Gutenberg ZIM (default 2000)
  --no-watch           do not pick up added/removed .zim files while running
  --quiet              only print problems and the server URL
  -h, --help           show this help
`;

/**
 * Parses CLI arguments.
 * @param {string[]} argv arguments without node and script (process.argv.slice(2))
 * @returns {{ dir: string, port: number, host: string|undefined, https: boolean,
 *   cert: string|null, key: string|null, maxGeneric: number, watch: boolean, quiet: boolean, help: boolean }}
 * @throws {Error} with a user-facing message on invalid arguments
 */
export function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      https: { type: 'boolean', default: false },
      cert: { type: 'string' },
      key: { type: 'string' },
      'max-generic': { type: 'string' },
      'no-watch': { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (positionals.length) throw new Error(`unexpected argument: ${positionals[0]}`);
  const int = (name, v, min, max) => {
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) {
      throw new Error(`--${name} must be an integer between ${min} and ${max} (got ${JSON.stringify(v)})`);
    }
    return Number(v);
  };
  const opts = {
    dir: path.resolve(values.dir ?? process.cwd()),
    port: values.port === undefined ? 8080 : int('port', values.port, 0, 65535),
    host: values.host || undefined,
    https: values.https || !!(values.cert || values.key),
    cert: values.cert ?? null,
    key: values.key ?? null,
    maxGeneric: values['max-generic'] === undefined ? 2000 : int('max-generic', values['max-generic'], 1, 10_000_000),
    watch: !values['no-watch'],
    quiet: values.quiet,
    help: values.help,
  };
  if (!!opts.cert !== !!opts.key) throw new Error('--cert and --key must be given together');
  return opts;
}

/**
 * Non-internal IPv4 addresses of this machine.
 * @returns {string[]}
 */
export function localIPv4s() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      // `family` is a number in some Node 18 releases.
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !out.includes(a.address)) out.push(a.address);
    }
  }
  return out;
}

/** Names the self-signed certificate must cover. */
function certNames() {
  const dns = ['localhost'];
  const host = os.hostname();
  // Only proper DNS labels: Windows machine names may contain characters a SAN cannot.
  if (/^[A-Za-z0-9-]{1,63}$/.test(host)) dns.push(host.toLowerCase(), `${host.toLowerCase()}.local`);
  const ips = ['127.0.0.1', ...localIPv4s()];
  return { dns: [...new Set(dns)], ips: [...new Set(ips)] };
}

/** The SAN set of a PEM certificate as normalized strings ('DNS:x', 'IP:y'), or null. */
function certSan(pem) {
  try {
    const x509 = new crypto.X509Certificate(pem);
    const san = (x509.subjectAltName ?? '').split(/,\s*/).filter(Boolean)
      .map((s) => s.replace(/^IP Address:/, 'IP:').toLowerCase());
    return { san: new Set(san), validTo: Date.parse(x509.validTo), validFrom: Date.parse(x509.validFrom) };
  } catch {
    return null;
  }
}

/**
 * Returns a key + certificate for --https: the given files, or a self-signed certificate for
 * localhost, 127.0.0.1 and every local IPv4 address, cached in `certDir` and regenerated when it
 * expires or the address set changes.
 * @param {object} [opts]
 * @param {string|null} [opts.certFile]
 * @param {string|null} [opts.keyFile]
 * @param {string} [opts.certDir=<project>/.cert]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ key: string, cert: string, generated: boolean, cached: boolean,
 *   names: { dns: string[], ips: string[] } | null }>} `cached`: the certificate is (now) stored in certDir
 */
export async function loadCertificate({ certFile = null, keyFile = null, certDir = CERT_DIR, log = () => {} } = {}) {
  if (certFile && keyFile) {
    return {
      cert: fs.readFileSync(certFile, 'utf8'),
      key: fs.readFileSync(keyFile, 'utf8'),
      generated: false,
      cached: false,
      names: null,
    };
  }
  const names = certNames();
  const want = new Set([...names.dns.map((d) => `dns:${d}`), ...names.ips.map((ip) => `ip:${ip}`)]);
  const certPath = path.join(certDir, 'cert.pem');
  const keyPath = path.join(certDir, 'key.pem');
  try {
    const cert = fs.readFileSync(certPath, 'utf8');
    const key = fs.readFileSync(keyPath, 'utf8');
    const info = certSan(cert);
    const now = Date.now();
    const sameNames = info && info.san.size === want.size && [...want].every((n) => info.san.has(n));
    if (info && sameNames && info.validFrom <= now && info.validTo - now > CERT_RENEW_MS) {
      // The key must belong to the certificate (a half-written cache would fail at TLS time).
      if (new crypto.X509Certificate(cert).checkPrivateKey(crypto.createPrivateKey(key))) {
        return { cert, key, generated: false, cached: true, names };
      }
    }
    log(info && !sameNames ? 'Network addresses changed: regenerating the HTTPS certificate…' :
      'HTTPS certificate expired or invalid: regenerating…');
  } catch {
    // no cached certificate yet
  }

  // selfsigned v5 is promise-based (WebCrypto + @peculiar/x509); loaded only when needed.
  const { default: selfsigned } = await import('selfsigned');
  const notBeforeDate = new Date(Date.now() - 60 * 60 * 1000); // tolerate small clock skew
  const notAfterDate = new Date(notBeforeDate.getTime() + CERT_DAYS * 24 * 60 * 60 * 1000);
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'vrlbry local server' }, { name: 'organizationName', value: 'vrlbry' }],
    {
      keyType: 'rsa',
      keySize: 2048,
      algorithm: 'sha256', // the default (sha1) is rejected by browsers
      notBeforeDate,
      notAfterDate,
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        {
          name: 'subjectAltName',
          altNames: [...names.dns.map((value) => ({ type: 2, value })), ...names.ips.map((ip) => ({ type: 7, ip }))],
        },
      ],
    },
  );
  let cached = true;
  try {
    fs.mkdirSync(certDir, { recursive: true });
    fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
    fs.writeFileSync(certPath, pems.cert);
  } catch (e) {
    // A read-only install can still serve HTTPS; it just regenerates the certificate next start
    // (and browsers will ask to accept it again).
    log(`Cannot cache the HTTPS certificate in ${certDir} (${e.message}); using it for this run only.`);
    cached = false;
  }
  return { cert: pems.cert, key: pems.private, generated: true, cached, names };
}

/** Listens on `port`, or on one of the next ports when it is taken. Resolves to the port used. */
async function listenWithFallback(server, port, host, log) {
  for (let i = 0; i < PORT_ATTEMPTS; i++) {
    const p = port === 0 ? 0 : port + i;
    if (p > 65535) break;
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(p, host);
      });
      return server.address().port;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || port === 0) throw err;
      log(`Port ${p} is in use, trying ${p + 1}…`);
    }
  }
  throw new Error(`ports ${port}–${Math.min(65535, port + PORT_ATTEMPTS - 1)} are all in use (choose another with --port)`);
}

/**
 * Runs the server. Resolves once listening, with a `close()` for tests and shutdown.
 * @param {string[]} [argv=process.argv.slice(2)]
 * @param {object} [io]
 * @param {(msg: string) => void} [io.out=console.log]
 * @param {(msg: string) => void} [io.err=console.error]
 * @param {boolean} [io.handleSignals=true] install SIGINT/SIGTERM handlers
 * @returns {Promise<{ server: import('node:http').Server, library: Library, port: number,
 *   urls: string[], close: () => Promise<void> } | null>} null after --help
 */
export async function main(argv = process.argv.slice(2), { out = console.log, err = console.error, handleSignals = true } = {}) {
  const opts = parseCliArgs(argv);
  if (opts.help) {
    out(USAGE);
    return null;
  }
  const info = opts.quiet ? () => {} : out;

  if (!fs.existsSync(opts.dir) || !fs.statSync(opts.dir).isDirectory()) {
    throw new Error(`--dir ${opts.dir} is not a directory`);
  }
  info(`Scanning ${opts.dir} for .zim files…`);
  // Skipped files and broken archives go to stderr even with --quiet.
  const library = await Library.scan(opts.dir, { maxGenericBooks: opts.maxGeneric, log: info, warn: err });
  const app = createApp(library, { log: err });

  let tls = null;
  if (opts.https) {
    tls = await loadCertificate({ certFile: opts.cert, keyFile: opts.key, log: info });
    if (tls.generated && tls.cached) info(`Generated a self-signed HTTPS certificate in ${CERT_DIR}`);
  }
  const server = tls ? https.createServer({ key: tls.key, cert: tls.cert }, app) : http.createServer(app);
  // Malformed requests and TLS handshake failures (e.g. a browser rejecting the self-signed
  // certificate) end up here; they must never take the server down.
  server.on('clientError', (e, socket) => {
    if (socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  if (tls) server.on('tlsClientError', () => {});

  let port;
  try {
    port = await listenWithFallback(server, opts.port, opts.host, info);
  } catch (e) {
    await library.close();
    throw e;
  }

  const scheme = tls ? 'https' : 'http';
  const anyHost = !opts.host || opts.host === '0.0.0.0' || opts.host === '::';
  const hostForUrl = (h) => (h.includes(':') ? `[${h}]` : h);
  const urls = anyHost ?
    [`${scheme}://localhost:${port}`, ...localIPv4s().map((ip) => `${scheme}://${ip}:${port}`)] :
    [`${scheme}://${hostForUrl(opts.host)}:${port}`];

  const libs = library.list();
  if (!opts.quiet) {
    out('');
    out(`vrlbry — ${libs.length} librar${libs.length === 1 ? 'y' : 'ies'} in ${library.dir}`);
    if (!libs.length) out(opts.watch ? '  (no readable .zim files found yet; add some and they are picked up automatically)' : '  (no readable .zim files found; add some and restart)');
    for (const lib of libs) {
      const i = await lib.info();
      out(`  ${lib.file}  —  ${i.title}  (${i.bookCount} book${i.bookCount === 1 ? '' : 's'}, ${lib.kind})`);
    }
    out('');
    out('Open in a browser:');
    for (const u of urls) out(`  ${u}`);
    out('');
    if (tls) {
      if (tls.generated || !opts.cert) {
        out('The certificate is self-signed: accept the browser warning once per device.');
      }
    } else {
      out(`WebXR needs a secure context: http://localhost works on this machine, but a VR headset on`);
      out(`your LAN needs HTTPS. Restart with --https, or connect the headset by USB and run`);
      out(`"adb reverse tcp:${port} tcp:${port}", then open http://localhost:${port} on it.`);
    }
    out('Press Ctrl+C to stop.');
  } else {
    out(`vrlbry listening on ${urls[0]}`);
  }

  // New or removed .zim files are picked up while running (clients re-shelve on their own).
  if (opts.watch) library.watch();

  let closing = null;
  const close = () => {
    closing ??= (async () => {
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        // Keep-alive clients (browsers) would hold the server open: cut them after a grace period.
        setTimeout(() => server.closeAllConnections?.(), 1000).unref();
      });
      await library.close();
    })();
    return closing;
  };

  if (handleSignals) {
    let signalled = false;
    const onSignal = (signal) => {
      if (signalled) process.exit(130); // second Ctrl+C: stop now
      signalled = true;
      info(`\n${signal}: shutting down…`);
      setTimeout(() => process.exit(0), 5000).unref();
      close().then(() => process.exit(0), (e) => {
        err(`shutdown: ${e.message}`);
        process.exit(1);
      });
    };
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
      try {
        process.on(sig, onSignal);
      } catch {
        // signal not supported on this platform
      }
    }
  }
  return { server, library, port, urls, close };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  // A stray rejection somewhere must not take the whole server down.
  process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));
  main().catch((e) => {
    console.error(`vrlbry: ${e.message}`);
    if (e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' ||
        /^(--|unexpected argument)/.test(e.message)) {
      console.error('\n' + USAGE);
      process.exit(2);
    }
    process.exit(1);
  });
}
