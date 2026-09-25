# ☁️ Deploying Advanced Posting Bot

> **TL;DR** — this repo is **pure Python**. It contains no `package.json`, no
> JavaScript and no TypeScript (in *any* commit of its history), so a Node.js
> runtime can only crash-loop it. Deploy it on a **Python** or **Docker**
> runtime with the start command `python bot.py`.

```
==> Using Node.js 20          ← wrong runtime for this repo
==> Building                  ← "succeeds": there is nothing for Node to build
==> Waiting for your service to be ready
Deploy aborted - the new version was crash-looping.
```

Those two lines describe two separate problems, and both are fixed below.

---

## 1. Why it crash-looped

| # | Cause | Detail |
| :- | :- | :- |
| 1 | **Wrong runtime** | The service was configured as Node.js. The start command is `python bot.py` (see [`Procfile`](Procfile)) — there is no Python interpreter in a Node image, so the process exits instantly and the platform restarts it forever. |
| 2 | **A poller opens no port** | Even on a Python runtime, this bot is a **long-polling worker**: it only makes *outbound* HTTPS calls to `api.telegram.org`. "Web service" platforms wait for a listening TCP port (`==> Waiting for your service to be ready`) and abort when none appears. |
| 3 | **Missing/blank `APB_TOKEN`** | If the token env var is not set *on the service* (only on your laptop), the bot exits with a message. Some platforms report that as a crash loop too. |

**Fixes now in the repo**

* `apb/health.py` — a stdlib HTTP server on `$PORT` (see §4) so port-probing
  platforms have something to hit. Enabled automatically when `PORT` /
  `APB_PORT` is set, off otherwise.
* [`Dockerfile`](Dockerfile) — pins `python:3.12-slim`; works on every platform
  that can build an image and removes all runtime guessing.
* [`.python-version`](.python-version) (`3.12.10`) + [`nixpacks.toml`](nixpacks.toml)
  + [`render.yaml`](render.yaml) — language markers for auto-detecting builders.
* [`Procfile`](Procfile) — now declares **both** `web:` and `worker:`.
* `bot.py` — readable failure messages (bad token → exit 3), `APB_DATA_DIR`
  support, and a fallback when the data directory is read-only.

---

## 2. Environment variables

| Variable | Required | Purpose |
| :- | :- | :- |
| `APB_TOKEN` | **yes** | Bot token from [@BotFather](https://t.me/BotFather) — `123456789:AAH…`. `BOT_TOKEN` / `TELEGRAM_TOKEN` are also accepted. |
| `APB_ADMINS` | no | Comma-separated Telegram user ids. If unset, the first person to send `/post` in a private chat claims ownership. |
| `APB_NVIDIA_KEY` | no | `nvapi-…` key from [build.nvidia.com](https://build.nvidia.com) — enables the free AI features. |
| `PORT` / `APB_PORT` | platform | Health-check port. Injected automatically by most PaaS. **Unset → no socket is opened at all.** |
| `APB_DATA_DIR` | no | Where `apb.json` (chats, drafts, templates, schedules) lives. Default `./data`. Point it at a mounted disk/volume. |

Never commit tokens. Set them in the platform dashboard as *secret* env vars.

---

## 3. Per-platform recipes

### Render — the log above looks like Render
1. Your current service: **Settings → Runtime → change `Node` to `Python 3`**
   (or `Docker`, which uses the Dockerfile and is the most predictable).
2. **Build command:** `pip install -r requirements.txt`
3. **Start command:** `python bot.py`
4. Best shape: delete the Web Service and create a **Background Worker**
   (workers are not port-probed). Then start with `python bot.py --no-health`.
   Keeping it a Web Service is fine too — set **Health Check Path** to `/health`.
5. Env: `APB_TOKEN`, `APB_ADMINS`, optional `APB_NVIDIA_KEY`.
6. Persistence: add a **Disk** (e.g. mounted at `/var/data`) and set
   `APB_DATA_DIR=/var/data`. Render's filesystem is wiped on every deploy.
7. Free-tier web services sleep after 15 min idle — a sleeping poller receives
   no updates. Use a Background Worker (never sleeps) or a paid instance.
8. Or let [`render.yaml`](render.yaml) do all of it: **New → Blueprint**.

### Railway
* **Settings → Build → Builder:** `DOCKERFILE` (recommended) or `NIXPACKS`
  (`nixpacks.toml` pins Python 3.12 and the start command).
* **Settings → Deploy → Start command:** `python bot.py`
* Variables: `APB_TOKEN`, `APB_ADMINS`, `APB_NVIDIA_KEY`. Railway injects
  `PORT` only if you generate a domain; set `APB_PORT=8080` yourself otherwise,
  or run `python bot.py --no-health` and use a worker-style service.
* Volume: mount one at `/data`, set `APB_DATA_DIR=/data`.

### Koyeb
* Service type **Worker** (no port/health check needed) or **Web** with health
  check path `/health`.
* Koyeb wants a *fully qualified* `.python-version` — `3.12.10` ✓ (already set),
  or just use the Dockerfile.
* Start: `python bot.py`. Volumes are supported on paid plans → `APB_DATA_DIR`.

### Heroku
```bash
heroku create advanced-posting-bot
heroku stack:set container -a advanced-posting-bot   # or add runtime.txt for the Python buildpack
heroku config:set APB_TOKEN="123:ABC" APB_ADMINS="123456789"
git push heroku arena/01a0d7b1-advaced-posting-bot-in-tg:main
```
Heroku's Python buildpack needs a **`runtime.txt`** with a currently supported
version (e.g. `python-3.12.10`) — add one only if you use that buildpack, since
Heroku rejects versions it no longer ships. The container stack (`Dockerfile`)
has no such restriction. Use a **worker** dyno: `heroku ps:scale web=0 worker=1`.

### Fly.io
```bash
fly launch --no-deploy --copy-config   # accepts the Dockerfile
fly secrets set APB_TOKEN="123:ABC" APB_ADMINS="123456789"
fly volumes create apb_data --size 1    # then mount it and set APB_DATA_DIR
fly deploy
```
Remove the `http_service` block from the generated `fly.toml` (or keep it and
point checks at `/health`) — the bot needs no inbound traffic.

### Any Docker host / VPS
```bash
docker build -t apb .                                  # add --build-arg WITH_PILLOW=1 for photo watermarks
docker run -d --name apb --restart unless-stopped \
  -e APB_TOKEN="123:ABC" -e APB_ADMINS="123456789" \
  -e APB_NVIDIA_KEY="nvapi-..." -e PORT=8080 -p 8080:8080 \
  -v apb-data:/data apb
docker logs -f apb
```

### Plain server, no containers
```bash
git clone https://github.com/harshi79/Advaced-Posting-Bot-In-Tg && cd Advaced-Posting-Bot-In-Tg
export APB_TOKEN="123:ABC" APB_ADMINS="123456789"
python3 bot.py --no-health          # Python 3.9+, nothing to install
# keep it alive with systemd / pm2 / supervisor / tmux
```

---

## 4. Health endpoints (`apb/health.py`)

Bound to `0.0.0.0:$PORT` **only** when `PORT`/`APB_PORT`/`--port` is set.
Liveness and readiness are separate, so a slow `getMe` round-trip can never be
mistaken for a crash loop.

| Endpoint | Code | Meaning |
| :- | :- | :- |
| `/` | 200 | human-readable "ok" |
| `/health`, `/healthz`, `/live` | 200 | **liveness** — the process is up (JSON: uptime, pid, bot, chats, scheduled) |
| `/ready`, `/readyz` | 200 / 503 | **readiness** — 200 only after the bot logged in and started polling |
| anything else | 404 | JSON hint |

`HEAD` is supported on every path. Use `/health` for platform health checks
unless your platform distinguishes liveness/readiness (then `/live` + `/ready`).

Turn it off entirely with `--no-health` (pure worker mode, zero sockets).

---

## 5. Persistent state

`apb.json` holds chats, composer drafts, templates, channel signatures,
scheduled/recurring posts and bulk queues. Without a disk it is rebuilt from
scratch on every deploy — schedules included.

| Platform | What to do |
| :- | :- |
| Render | Add a Disk → `APB_DATA_DIR=/var/data` |
| Railway | Add a Volume → `APB_DATA_DIR=/data` |
| Fly | `fly volumes create` → mount → `APB_DATA_DIR=/data` |
| Docker | `-v apb-data:/data` (the image already defaults to `/data`) |
| VPS | leave the default `./data`, or set `APB_DATA_DIR` |

If the chosen directory turns out to be read-only, the bot prints a warning and
falls back to a temp dir instead of dying — check your logs for
`WARNING: data dir … is not writable`.

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
| :- | :- | :- |
| `Using Node.js 20` in the build log | service runtime is Node | switch to Python 3 / Docker (§3) |
| Build OK, instant crash loop | `python` missing (Node image) or bad start command | start command `python bot.py` |
| `Waiting for your service to be ready` times out | web service, nothing listening | set `PORT`, or use a worker + `--no-health` |
| `No bot token. Set APB_TOKEN…` (exit 2) | env var not set on the service | add `APB_TOKEN` in the dashboard and redeploy |
| `Could not log in to Telegram: …` (exit 3) | token revoked/typo/extra quotes | regenerate at @BotFather, paste raw |
| `TelegramError: getUpdates (409)` | the same token is polling twice | stop the other copy (laptop, old service) |
| `health server could not bind` | port taken / not allowed | let the platform inject `PORT`, or `--port N` |
| state disappears after each deploy | ephemeral filesystem | mount a disk and set `APB_DATA_DIR` (§5) |
| watermark says "text signature" | Pillow absent | `pip install Pillow` or build with `--build-arg WITH_PILLOW=1` |

Verify a deploy locally before pushing:

```bash
python3 bot.py --selftest          # offline checks, no token needed
PORT=8099 python3 bot.py --token 1:fake &   # watch the startup banner
curl -i localhost:8099/health
```
