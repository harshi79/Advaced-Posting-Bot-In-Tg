/**
 * src/health.js — the HTTP face of the bot.
 *
 * The bot itself is a long-polling **worker**: it only makes outbound HTTPS
 * calls to api.telegram.org.  Platforms that run "web services", however,
 * wait for a port to open before they declare a release healthy:
 *
 *     ==> Waiting for your service to be ready
 *     Deploy aborted - the new version was crash-looping.
 *
 * So this module serves a tiny, dependency-free HTTP server on $PORT:
 *
 *   GET /                 → 200  status page (HTML in a browser, text otherwise)
 *   GET /health /healthz  → 200  JSON liveness (up as soon as the socket is up)
 *   GET /live /liveness   → 200  alias
 *   GET /ready /readyz    → 200 JSON readiness (503 until the bot has logged in)
 *   GET /status           → 200  JSON, same body as /health
 *
 * Liveness and readiness are deliberately separate: /health answers 200 from
 * the instant the socket is bound (so a slow getMe round-trip can never be
 * mistaken for a crash loop) while /ready flips to 200 only once polling.
 *
 * Deliberately no X-Frame-Options / CSP headers: the status page is meant to
 * be embeddable in hosting dashboards (Veroa, Railway …) and previews.
 */

import http from 'node:http';
import os from 'node:os';
import { logger } from './logger.js';

const log = logger('health');

export const LIVE_PATHS = new Set(['/', '/health', '/healthz', '/live', '/liveness', '/status']);
export const READY_PATHS = new Set(['/ready', '/readyz', '/readiness']);

/** cliPort → $APB_PORT → $PORT → default. Returns null when disabled. */
export function resolvePort(cliPort = null, fallback = null) {
  const candidates = [cliPort, process.env.APB_PORT, process.env.PORT];
  for (const raw of candidates) {
    if (raw === null || raw === undefined || raw === '') continue;
    const value = String(raw).trim();
    if (/^\d+$/.test(value) && Number(value) > 0 && Number(value) < 65536) return Number(value);
    log.warn(`ignoring unusable port ${JSON.stringify(raw)}`);
  }
  return fallback;
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export class HealthServer {
  constructor({ port, host = '0.0.0.0', stats = null } = {}) {
    this.host = host;
    this.port = port;
    this.stats = stats;              // optional () => ({...extra})
    this.startedAt = Date.now();
    this.hits = 0;
    this.ready = false;
    this.readyDetail = 'starting';
    this.server = null;
    this.boundPort = port;
  }

  /** Start listening; resolves with `{ ok, port, error }`. */
  start() {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this.#handle(req, res));
      server.keepAliveTimeout = 65000;
      server.headersTimeout = 70000;
      const done = (ok, error = null) => resolve({ ok, port: this.boundPort, error });
      server.on('error', (err) => {
        log.error(`health server could not bind ${this.host}:${this.port} — ${err.message} `
          + '(the bot keeps running; a port-probing platform will see no port)');
        done(false, err);
      });
      server.listen(this.port, this.host, () => {
        this.server = server;
        this.boundPort = server.address().port;
        log.info(`listening on http://${this.host}:${this.boundPort}  (/health · /ready)`);
        done(true);
      });
      this.server = server;
    });
  }

  stop() {
    if (!this.server) return Promise.resolve();
    const server = this.server;
    this.server = null;
    return new Promise((resolve) => {
      try {
        server.close(() => resolve());
        server.closeAllConnections?.();
      } catch {
        resolve();
      }
      setTimeout(resolve, 1500).unref?.();
    });
  }

  markReady(detail = 'polling') {
    this.ready = true;
    this.readyDetail = detail;
    log.info(`ready (${detail})`);
  }

  markNotReady(detail = 'degraded') {
    this.ready = false;
    this.readyDetail = detail;
  }

  get url() {
    const host = ['0.0.0.0', '::'].includes(this.host) ? 'localhost' : this.host;
    return `http://${host}:${this.boundPort}/health`;
  }

  snapshot() {
    const out = {
      status: this.ready ? 'ok' : 'starting',
      service: 'advanced-posting-bot',
      runtime: 'node',
      node: process.version,
      ready: this.ready,
      detail: this.readyDetail,
      uptime_s: Math.round(((Date.now() - this.startedAt) / 1000) * 10) / 10,
      pid: process.pid,
      memory_mb: Math.round((process.memoryUsage().rss / 1048576) * 10) / 10,
      health_hits: this.hits,
      host: os.hostname(),
    };
    if (this.stats) {
      try {
        const extra = this.stats();
        if (extra && typeof extra === 'object') Object.assign(out, extra);
      } catch (err) {
        out.stats_error = String(err?.message || err);
      }
    }
    return out;
  }

  #statusPage(state) {
    const rows = Object.entries(state).map(([k, v]) => (
      `<tr><th>${esc(k)}</th><td>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`
    )).join('');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Advanced Posting Bot — status</title>
<style>
 :root{color-scheme:dark light}
 body{font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
      margin:0;padding:32px;background:#0f1115;color:#e8eaf0}
 .card{max-width:640px;margin:0 auto;background:#171a21;border:1px solid #262b36;
       border-radius:14px;padding:24px}
 h1{margin:0 0 4px;font-size:20px}
 .pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600}
 .ok{background:#10361f;color:#4ade80}.wait{background:#3a2a10;color:#fbbf24}
 table{width:100%;border-collapse:collapse;margin-top:18px;font-size:13.5px}
 th{text-align:left;color:#98a2b3;font-weight:500;white-space:nowrap;padding:5px 12px 5px 0}
 td{padding:5px 0;word-break:break-word}
 code{background:#0f1115;padding:2px 6px;border-radius:6px}
 a{color:#60a5fa}
</style></head><body><div class="card">
<h1>🤖 Advanced Posting Bot</h1>
<p><span class="pill ${state.ready ? 'ok' : 'wait'}">${state.ready ? 'ready' : 'starting / not logged in'}</span></p>
<p style="color:#98a2b3">${esc(state.detail || '')}</p>
<table>${rows}</table>
<p style="margin-top:18px;color:#98a2b3;font-size:13px">
 Health: <a href="/health"><code>/health</code></a> ·
 Readiness: <a href="/ready"><code>/ready</code></a> ·
 JSON: <a href="/status"><code>/status</code></a>
</p>
</div></body></html>`;
  }

  #handle(req, res) {
    try {
      this.hits += 1;
      const url = new URL(req.url || '/', 'http://localhost');
      let path = url.pathname.replace(/\/+$/, '');
      if (!path) path = '/';
      const state = this.snapshot();
      const headers = { 'cache-control': 'no-store', connection: 'close' };

      const send = (code, body, contentType) => {
        const payload = Buffer.from(body, 'utf8');
        res.writeHead(code, { ...headers, 'content-type': contentType, 'content-length': payload.length });
        res.end(req.method === 'HEAD' ? undefined : payload);
      };

      if (READY_PATHS.has(path)) {
        send(this.ready ? 200 : 503, `${JSON.stringify(state, null, 2)}\n`, 'application/json; charset=utf-8');
        return;
      }
      if (path === '/' || path === '/health' || path === '/healthz' || path === '/live' || path === '/liveness') {
        const wantsHtml = String(req.headers.accept || '').includes('text/html');
        if (path === '/' && wantsHtml) send(200, this.#statusPage(state), 'text/html; charset=utf-8');
        else send(200, `${JSON.stringify(state, null, 2)}\n`, 'application/json; charset=utf-8');
        return;
      }
      if (path === '/status') {
        send(200, `${JSON.stringify(state, null, 2)}\n`, 'application/json; charset=utf-8');
        return;
      }
      if (path === '/favicon.ico') {
        send(204, '', 'image/x-icon');
        return;
      }
      send(404, `${JSON.stringify({ status: 'not_found', path, hint: 'try /health or /ready' }, null, 2)}\n`, 'application/json; charset=utf-8');
    } catch (err) {
      log.warn(`health handler error: ${err?.message || err}`);
      try {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('error\n');
      } catch { /* socket already gone */ }
    }
  }
}

export default HealthServer;
