"""apb.health — a zero-dependency HTTP health endpoint for PaaS deploys.

The bot itself is a long-polling **worker**: it never listens on a socket, it
only makes *outbound* HTTPS calls to ``api.telegram.org``.  That is a problem
for platforms that deploy "web services" and wait for a port to open before
declaring a release healthy::

    ==> Waiting for your service to be ready
    Deploy aborted - the new version was crash-looping.

This module runs a tiny threaded :mod:`http.server` on a background daemon
thread so those platforms have something to probe:

    GET /          → 200  short human-readable "ok"
    GET /health    → 200  JSON liveness  (up as soon as the process is up)
    GET /healthz   → 200  alias
    GET /live      → 200  alias
    GET /ready     → 200  JSON readiness (503 until the bot has logged in)
    GET /readyz    → 200/503 alias

Liveness and readiness are deliberately separate: ``/health`` answers 200 from
the moment the socket is bound (so a slow ``getMe`` round-trip to Telegram can
never be mistaken for a crash loop), while ``/ready`` flips to 200 only once
the bot is actually polling.

Nothing here is required to run the bot on your own machine — pass
``--no-health`` (or simply don't set ``PORT``/``APB_PORT``) and no socket is
opened at all.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

log = logging.getLogger(__name__)

LIVE_PATHS = frozenset(("/", "/health", "/healthz", "/live", "/liveness"))
READY_PATHS = frozenset(("/ready", "/readyz", "/readiness"))
DEFAULT_HOST = "0.0.0.0"          # PaaS health checks come from outside the box
DEFAULT_PORT = 8080


def resolve_port(cli_port=None):
    """Pick the health-check port.

    Order: ``--port`` → ``$APB_PORT`` → ``$PORT`` (injected by Heroku, Railway,
    Render, Fly, Koyeb, Google Cloud Run …) → ``None`` (no health server).
    """
    for raw in (cli_port, os.environ.get("APB_PORT"), os.environ.get("PORT")):
        if raw is None:
            continue
        raw = str(raw).strip()
        if raw.isdigit() and 0 < int(raw) < 65536:
            return int(raw)
        if raw:
            log.warning("ignoring unusable port %r", raw)
    return None


class _Handler(BaseHTTPRequestHandler):
    """Minimal GET/HEAD handler — always sends Content-Length (HTTP/1.1)."""

    protocol_version = "HTTP/1.1"
    server_version = "AdvancedPostingBot/1.0"
    health = None                                   # set by HealthServer

    # ------------------------------------------------------------ plumbing
    def log_message(self, fmt, *args):              # keep the bot's log clean
        log.debug("health %s", fmt % args)

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, payload):
        self._send(code, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")

    # -------------------------------------------------------------- routes
    def do_GET(self):
        self._route()

    def do_HEAD(self):
        self._route()

    def _route(self):
        path = (self.path or "/").split("?", 1)[0].rstrip("/") or "/"
        hs = self.health
        if hs is not None:
            hs.hits += 1
        state = hs.snapshot() if hs else {"status": "unknown"}

        if path in LIVE_PATHS:
            if path == "/":
                self._send(200, "Advanced Posting Bot — ok\n"
                                "  liveness : /health\n"
                                "  readiness: /ready\n",
                           ctype="text/plain; charset=utf-8")
            else:
                self._json(200, state)
        elif path in READY_PATHS:
            ready = bool(state.get("ready"))
            self._json(200 if ready else 503, state)
        else:
            self._json(404, {"status": "not_found", "path": path,
                             "hint": "try /health or /ready"})


class HealthServer(threading.Thread):
    """Background daemon thread serving the health endpoints above."""

    def __init__(self, port=None, host=DEFAULT_HOST, stats=None):
        super().__init__(daemon=True, name="apb-health")
        self.host = host
        self.port = port if port is not None else DEFAULT_PORT
        self.stats = stats                  # optional callable → dict of extras
        self.started_at = time.time()
        self.hits = 0
        self._ready = False
        self._ready_detail = "starting"
        self._lock = threading.Lock()
        self._httpd = None
        self._bound = False
        self._bound_evt = threading.Event()

    # ------------------------------------------------------------- lifecycle
    def start(self, wait=5.0):
        """Start the thread and block until the port is actually listening.

        Platforms begin probing the moment the container starts, and the caller
        wants to know whether the bind worked before printing the banner — so
        this waits for the socket (or for the bind to fail) instead of
        returning the instant the thread is spawned.
        """
        super().start()
        self._bound_evt.wait(wait)
        return self._bound

    def run(self):
        _Handler.health = self
        try:
            self._httpd = ThreadingHTTPServer((self.host, self.port), _Handler)
        except OSError as exc:
            log.error("health server could not bind %s:%s — %s "
                      "(the bot keeps running; deploy platforms will see no port)",
                      self.host, self.port, exc)
            self._bound_evt.set()
            return
        self._httpd.daemon_threads = True
        self._bound = True
        self._bound_evt.set()
        log.info("health server listening on http://%s:%s/health",
                 self.host, self.bound_port)
        try:
            self._httpd.serve_forever(poll_interval=0.5)
        finally:
            try:
                self._httpd.server_close()
            except OSError:
                pass

    def stop(self):
        if self._httpd is not None:
            self._httpd.shutdown()
            self._httpd.server_close()
            self._httpd = None
        self._bound = False

    def mark_ready(self, detail="polling"):
        with self._lock:
            self._ready = True
            self._ready_detail = detail
        log.info("health: ready (%s)", detail)

    def mark_not_ready(self, detail="degraded"):
        with self._lock:
            self._ready = False
            self._ready_detail = detail

    @property
    def bound(self):
        return self._bound

    @property
    def bound_port(self):
        """Actual listening port (``port=0`` → whatever the OS assigned)."""
        if self._httpd is not None:
            try:
                return self._httpd.server_address[1]
            except (AttributeError, IndexError):
                pass
        return self.port

    @property
    def url(self):
        shown = "localhost" if self.host in ("0.0.0.0", "::") else self.host
        return "http://{}:{}/health".format(shown, self.bound_port)

    # ---------------------------------------------------------------- status
    def snapshot(self):
        with self._lock:
            ready, detail = self._ready, self._ready_detail
        out = {
            "status": "ok" if ready else "starting",
            "service": "advanced-posting-bot",
            "runtime": "python",
            "ready": ready,
            "detail": detail,
            "uptime_s": round(time.time() - self.started_at, 1),
            "pid": os.getpid(),
            "health_hits": self.hits,
        }
        if self.stats:
            try:
                extra = self.stats()
                if isinstance(extra, dict):
                    out.update(extra)
            except Exception as exc:                       # never break /health
                out["stats_error"] = str(exc)
        return out
