# 🚀 Deploying the Advanced Posting Bot (Node.js)

The bot is a **long-polling worker** — it only makes *outbound* HTTPS calls to
`api.telegram.org` — that *also* serves a tiny HTTP status page on `$PORT`. That
combination runs unchanged on any web-service OR worker platform: Veroa, Render,
Railway, Heroku, Koyeb, Fly.io, Google Cloud Run, a bare VPS, Docker…

```
runtime      : Node.js 20 (or Docker)
install      : npm install          ← installs nothing, zero dependencies
start        : npm start            ← node src/index.js
health check : /health              ← 200 the moment the port is bound
required env : APB_TOKEN
```

---

## ⚡ Fixing “Deploy aborted - the new version was crash-looping”

If you saw this on Veroa (or anywhere else):

```
==> Cloning from https://github.com/… (branch main)
==> Using Node.js 20
==> Building
==> Build successful in 18s
==> Preparing image
==> Deploying
==> Waiting for your service to be ready
Deploy aborted - the new version was crash-looping.
==> Deployment failed
```

…it happened because the repository used to be a **Python** app
(`bot.py`, `apb/*.py`, `.python-version`) while the platform had already
committed to a **Node.js 20** runtime. The image boots Node, Node looks for a
`package.json`/`npm start`, finds a `python bot.py` world, and the service exits
instantly — a crash loop. Two extra traps made it worse:

1. **No port was opened**, so “Waiting for your service to be ready” could never
   succeed even when the process ran.
2. Any missing token / rejected token / DNS hiccup **exited** the process, which
   the platform books as another crash.

All three are fixed in this repo:

| Before | Now |
| :- | :- |
| Python app on a Node runtime | real Node app: `package.json`, `npm start`, `src/*.js` |
| No listening port | HTTP status server on `$PORT` **before** the first Telegram call |
| Exits on missing/rejected token or network error | logs the exact fix and **retries forever**, `/health` stays 200 |
| Fatal error → process dies | fatal error → loud log, process stays alive (never “crash-looping”) |

**What to set on the service (Veroa dashboard → your service → Settings):**

```
Runtime / Build : Node.js 20            (Docker also fine — Dockerfile included)
Install command : npm install
Start command   : npm start
Port            : from the PORT env var the platform injects (default 8080)
Health check    : /health
```

Then add the environment variables below and redeploy.

Open the service URL in a browser afterwards: you should get the status page,
a green **ready** pill and `"bot": "@your_bot"` in the table.

---

## 🔑 Environment variables

| Variable | Required | Meaning |
| :- | :- | :- |
| `APB_TOKEN` | ✅ | bot token from @BotFather (`123456789:AA…`). Also accepts `BOT_TOKEN`, `TELEGRAM_TOKEN`, `TG_BOT_TOKEN`. |
| `APB_ADMINS` | – | comma-separated Telegram **user ids** allowed to post (`123456789,987654321`). If unset, the first `/post` in a private chat claims ownership. |
| `APB_NVIDIA_KEY` | – | free NVIDIA NIM key (`nvapi-…`) for the AI features. `NVIDIA_API_KEY` also works. |
| `APB_AI_MODEL` | – | override the AI model (default `nvidia/nemotron-3-super-120b-a12b`). |
| `APB_DATA_DIR` | – | where `apb.json` lives (default `./data` in the repo). Point it at a mounted disk for persistence. |
| `PORT` / `APB_PORT` | – | HTTP port. Injected by most platforms; default `8080`. |
| `APB_LOG_LEVEL` | – | `debug` \| `info` \| `warn` \| `error` \| `silent`. |

Never commit the token to the repo — set it in the dashboard.

---

## 🩺 Health & readiness

| Route | Response |
| :- | :- |
| `GET /` | HTML status page in a browser, JSON for probes |
| `GET /health`, `/healthz`, `/live`, `/liveness` | **200** JSON — bound socket, bot alive |
| `GET /ready`, `/readyz`, `/readiness` | **200** once logged in, **503** while starting |
| `GET /status` | raw JSON stats (chats, channels, drafts, scheduled, sent, failed, AI) |

Liveness is deliberately green *before* the Telegram login finishes, so a slow
`getMe` (or an unreachable API) can never be mistaken for a crash loop. Watch
`/ready` to know when the bot is actually polling.

---

## 🧱 Platform recipes

### Veroa (web service)

1. Connect the repo, branch `main`.
2. Build: `npm install` · Start: `npm start` · Port: from `PORT`.
3. Health check path: `/health`.
4. Add `APB_TOKEN` (+ `APB_ADMINS`, `APB_NVIDIA_KEY`) as environment variables.
5. Deploy, then open the URL — the status page should say **ready**.

### Render

`render.yaml` in this repo is a Node blueprint: runtime `node`, build
`npm install --omit=dev`, start `npm start`, health check `/health`, plus an
optional 1 GB disk mounted at `/var/data` with `APB_DATA_DIR=/var/data`.
Or do it by hand: **New → Web Service → Runtime Node**, same commands.

### Railway / Koyeb / Heroku

Let the platform detect Node (or use the included `Dockerfile`). Start command
`npm start`; the `Procfile` in the repo also defines `web: npm start` and
`worker: node src/index.js --no-health`.

### Fly.io / Cloud Run / VPS

```bash
docker build -t apb .
docker run -d --restart unless-stopped \
  -e APB_TOKEN="123:ABC" -e APB_ADMINS="123456789" \
  -p 8080:8080 -v apb-data:/data apb
```

Behind a reverse proxy, terminate TLS in front of port 8080 and point the
health check at `/health`.

---

## 💾 Persistent state

Everything (chats, drafts, schedules, channels, templates, settings, counters)
lives in one JSON file: `$APB_DATA_DIR/apb.json` (default `./data/apb.json`).
Writes are atomic (temp file + rename), so a crash mid-write cannot corrupt it.

* Platforms with **ephemeral disks** (Veroa, Render's default fs, Railway,
  Cloud Run): the file survives restarts of the same instance, but a redeploy
  starts clean. Mount a disk/volume and set `APB_DATA_DIR` to keep it.
* If the directory is not writable, the bot logs a warning and falls back to
  `/tmp/apb-data` instead of crash-looping.
* A corrupt file is moved aside (`apb.json.corrupt-<ts>`) and the bot starts
  fresh rather than refusing to boot.

No database, no migrations, no external services.

---

## 🧯 Troubleshooting

| Symptom | Cause & fix |
| :- | :- |
| `Deploy aborted - the new version was crash-looping` right after “Using Node.js 20” | The service is still building a **Python** repo or running `python bot.py`. Point it at this branch (it is Node-only now): start `npm start`. |
| Log says `NO BOT TOKEN SET` but the deploy succeeded | Working as designed — the bot stays up and waits. Set `APB_TOKEN` on the service, then restart. `/ready` flips to 200 once it logs in. |
| `Could not log in to Telegram: Not Found (404)` / `Unauthorized (401)` | The token is wrong/revoked or has stray quotes/spaces. Copy the full `123456789:AA…` string from @BotFather into `APB_TOKEN`. |
| `cannot reach api.telegram.org` | Outbound HTTPS is blocked (egress firewall/proxy) or DNS fails. Allow `api.telegram.org:443`, or set `HTTPS_PROXY`. |
| Deploy succeeds, browser URL shows “starting / not logged in” forever | `/ready` only turns green after a successful `getMe`. Check the log lines above for the token/network hints. |
| Service URL returns 502 | The platform expects a port; something set `--no-health` or `PORT` to a busy port. Remove `--no-health` and use `npm start`. |
| Bot answers but forgets everything after a redeploy | No persistent disk. Set `APB_DATA_DIR` to a mounted volume. |
| `⚠️ Telegram said no: Bad Request: chat not found` when publishing to a channel | The bot is not an admin in that channel, or the `@username`/id is wrong. Add it via `/channels` as an admin there. |
| AI buttons say `AI is off` | `APB_NVIDIA_KEY` is missing. Grab a free key at build.nvidia.com and restart. |
| Nothing in logs at all | Set `APB_LOG_LEVEL=debug` and redeploy; the bot prints the token source, data dir, port and every API error. |

---

## 🧪 Verify without deploying

```bash
npm test                 # 265 offline checks — no token, no network
npm start                # run locally; open http://localhost:8080
curl -s localhost:8080/health | head -20
```

`npm test` exercises the parsers, rich-message builders, the store, the
debounced editor, the API client (mocked `fetch`), the NVIDIA client (mocked
SSE), the composer flow, all Posto features, the scheduler and the HTTP server.
