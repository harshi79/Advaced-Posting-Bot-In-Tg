# ✨ Advanced Posting Bot in Telegram

A **rich-media posting bot** for channels, groups and private chats — built on
**Telegram Bot API 10.3** (Aug 2026) with **zero dependencies** (pure Python 3
stdlib), now with **all of @PostoRobot's automation features** and **free-forever
NVIDIA AI**.

It makes a bot look *Premium without Premium*: real headings, tables,
collapsible sections, checklists, LaTeX math, marked text, spoilers, colored
buttons — and **buttery-smooth message editing / live streaming**. All of it is
free; the only Premium-gated Bot API feature (custom emoji) is deliberately
avoided. See [`RESEARCH.md`](RESEARCH.md) for the full version-by-version
read-through (9.1 → 10.3) and the Posto feature research.

```
 _   _ _______ ____  __  __ _____ ____      _    _
| | | | ____ / ___||  \/  | ____|  _ \    / \  | |
| |_| |  _| \___ \| |\/| |  _| | |_) |  / _ \ | |
|  _  | |___ ___) | |  | | |___|  _ <  / ___ \| |___
|_| |_|_____|____/|_|  |_|_____|_| \_\/_/   \_\_____|
     Advanced Posting Bot · rich · free · smooth · Posto-grade
```

## 🚀 Quick start

```bash
# 1. get a token from @BotFather
export APB_TOKEN="123456:ABC-your-token"
export APB_ADMINS="123456789"        # your user id (optional — see below)

# 2. (optional, free forever) NVIDIA AI — build.nvidia.com → API keys
export APB_NVIDIA_KEY="nvapi-..."

# 3. run (Python 3.9+, nothing to install!)
python3 bot.py

# offline sanity checks — 166 checks, no token needed
python3 bot.py --selftest
```

No admins configured? The **first person to send `/post` in a private chat
claims ownership** (handy for self-hosting; clear `data/apb.json` to reset).

## ☁️ Deploy

**This bot is pure Python — it is not a Node app.** There is no `package.json`
and no JavaScript anywhere in the repo, so a Node.js runtime can only
crash-loop it (`python: command not found`). Use a **Python 3** or **Docker**
runtime with the start command `python bot.py`.

```bash
# any Docker host — pins python:3.12-slim, no guessing
docker build -t apb .
docker run -d --restart unless-stopped -e APB_TOKEN="123:ABC" \
  -e APB_ADMINS="123456789" -p 8080:8080 -v apb-data:/data apb
```

The bot is a long-polling **worker**: it only dials out to `api.telegram.org`
and needs no inbound traffic. For platforms that insist on probing a port
(`==> Waiting for your service to be ready`), it also serves a tiny health
endpoint when `PORT`/`APB_PORT` is set — `GET /health` (liveness) and
`GET /ready` (readiness, 503 until logged in). Pure worker mode: `--no-health`.

Per-platform settings (Render, Railway, Koyeb, Heroku, Fly, bare VPS), env
vars, persistent state and a crash-loop troubleshooting table:
**[`DEPLOY.md`](DEPLOY.md)**.

## 🧩 Posto features — all implanted

Everything [@PostoRobot](https://t.me/PostoRobot) does, free:

| Posto feature | In this bot |
| :- | :- |
| **Multi-channel publishing** | `/channels` — add by forward/@username; per-channel **signature** + **delay**; publish fans out with live progress |
| **Scheduled posts** | natural language: `+90m` · `21:30` · `tomorrow 09:00` · `2026-12-25 10:00` |
| **Recurring posts** | repeat **hourly / daily / weekly / custom** (`every 6h`); survives restarts; `/schedule` → ⏹ end |
| **Bulk posting** | `/bulk` — send 100 posts (albums kept together), then **post all now** or **auto-schedule** spread over time |
| **Templates** | `/templates` + 📋 save from composer — buttons, media & signature included |
| **Buttons** | `/buttons` — colored inline buttons (blue/green/red, free) |
| **AI** | 🤖 NVIDIA NIM — write, rewrite, translate, shorten, expand; output **streams in live** and loads into your post with one tap |
| **Watermarks** | ©️ watermark photos on publish (optional `pip install Pillow`) + per-channel/per-post **signatures** |
| **Slideshow generator** | send an album while composing → toggle 🎞 Slideshow; or `/slideshow` |
| **Turbo Mode** | `/turbo` — `/done` publishes instantly, zero confirmation clicks |
| **Hidden text** | `||spoiler||` in Rich Markdown (free) |
| **Premium emojis** | skipped — the *only* Premium-gated Bot API feature |
| **Paid posts** | ⭐ sell photo/video posts for Telegram Stars (`sendPaidMedia`, experimental) |

## 🤖 AI — NVIDIA only, free forever

One model, no paid anything: **`nvidia/nemotron-3-super-120b-a12b`** — NVIDIA's
own latest Nemotron-3 generation (hybrid Mamba-Transformer MoE, ~1M context,
fast) on the **free NIM tier** at `integrate.api.nvidia.com`:
no credit card, no expiring credits, ~40 requests/minute.

```bash
export APB_NVIDIA_KEY="nvapi-..."   # build.nvidia.com → API keys
# optional: override the model
export APB_AI_MODEL="nvidia/nemotron-3-ultra-550b-a55b"
```

Then: `/ai write about monsoon travel deals` — or hit the 🤖 buttons in the
composer. The answer **streams in live** (animated draft + thinking block in
private chats, smooth edits elsewhere) and becomes your post with one tap.

## 🧠 What makes it “rich” (all free)

| Capability | Bot API | Where you see it |
| :- | :- | :- |
| Rich Messages: headings, tables, details, quotes, math, marked, spoilers, footnotes | 10.1 | `/demo`, every post you compose |
| **Animated streaming drafts** + shimmering *thinking* block | 10.1 | `/stream`, AI generation |
| **Smooth live editing** (`editMessageText` + `rich_message`, debounced) | 10.1 | preview & panel update themselves while you type |
| Media embedded *inside* documents (`tg://photo?id=`) | 10.2 | send a photo while composing |
| **Ephemeral messages** — replies only one user can see | 10.2/10.3 | `/id`, `/ping`, 👀 demo button in groups |
| **Buttons inside the message body** with colors | 10.3 | `/demo` section 7 |
| Colored classic buttons (`primary`/`success`/`danger`) | 9.4 | every keyboard |
| Message effects (🎉 🔥 ❤️) | 7.2 | `/start` in private chat |

## 📖 Commands

| Command | Who | What |
| :- | :- | :- |
| `/start` `/help` | everyone | rich welcome · full manual |
| `/demo` | everyone | the full rich showcase |
| `/post` | admins | compose (Markdown in, rich post out) |
| `/bulk` | admins | bulk collector → post all / auto-schedule |
| `/channels` | admins | manage destination channels |
| `/templates` | admins | reusable formats |
| `/turbo` | admins | toggle zero-click publishing |
| `/slideshow` | admins | album → slideshow |
| `/ai <topic>` | admins | NVIDIA writing (streams live) |
| `/drafts` `/schedule` | admins | drafts · scheduled & recurring posts |
| `/stream` `/demo` | everyone | smoothness showcase |
| `/edit` | admins | reply to a bot message with `/edit <md>` — it re-types itself |
| `/stats` `/id` `/ping` `/cancel` | everyone | utilities |

## ✍️ Composing

1. `/post`, then just **send Markdown** — as many messages as you like.
   Rich Markdown ≈ GitHub-Flavored Markdown: `# headings`, `**bold**`,
   `==marked==`, `||spoiler||`, `> quotes`, tables, `- [ ]` task lists,
   footnotes, fenced code, `$math$` — plus rich HTML tags:
   `<details>`, `<aside>quote<cite>credit</cite></aside>`,
   `<tg-map lat="41.9" long="12.5" zoom="14"/>`, `<tg-collage>`, `<tg-slideshow>`.
2. **Send media** while composing → saved with a `tg://photo?id=m1` embed link.
   Send an album and toggle 🎞 **Slideshow** to render it as one slideshow.
3. 🤖 **AI buttons**: write from a topic, rewrite, translate, shorten, expand.
4. `/preview` — keep typing, the preview edits itself smoothly.
5. `/done` → panel: **Publish here · 🌐 Channels · 📣 Channel… · Broadcast all ·
   Schedule (with repeat) · Effect · Paid (⭐ Stars) · Signature · Watermark ·
   Save draft/template**.
6. Buttons (one row per line, `;;` splits a row):

   ```
   Read more | https://example.com | primary
   👍 Like | cb:like ;; 🔄 Share | cb:share
   Delete | cb:delete | danger
   ```

## 🏗 Architecture

```
bot.py                 entry point (CLI, polling loop)
apb/
├── api.py             Bot API 10.3 client (urllib, retries, 429 backoff, multipart)
├── rich.py            RichText/RichBlock/InputRichMessage builders + limit checks
├── smooth.py          SmoothEditor (debounced rich edits) · SmoothStream (drafts)
├── handlers.py        commands, callbacks, composer wizard, publishing
├── posto.py           Posto features: channels/bulk/templates/turbo/AI/slideshow
├── nvidia.py          NVIDIA NIM client (free tier, SSE streaming)
├── mdblocks.py        Markdown → InputRichBlock converter (slideshow posts)
├── watermark.py       optional Pillow photo watermarking
├── scheduler.py       background thread: scheduled + recurring posts
├── store.py           atomic JSON persistence (data/apb.json)
├── content.py         welcome/help/demo content
├── utils.py           time/interval & button-row parsing
├── health.py          tiny HTTP /health · /ready probe for PaaS deploys
└── selftest.py        166 offline checks (python bot.py --selftest)
```

**Smooth editing, exactly:** `SmoothEditor` coalesces any number of `update()`
calls into ≤1 `editMessageText` per interval, skips no-op payloads, honors
`retry_after`, and swallows “message is not modified”. `SmoothStream` uses
`sendRichMessageDraft` with a stable `draft_id` (Telegram animates the change),
shows the `thinking` block while producing content, and finalizes with
`sendRichMessage`; in groups it transparently falls back to a `SmoothEditor`
on a real message.

## ⚠️ Notes & limits

- Rich rendering needs an **up-to-date Telegram client** on the receiving side
  (old clients get degraded text).
- `sendRichMessageDraft` and message effects: **private chats only**;
  ephemeral messages: **groups/supergroups only** — the bot falls back gracefully.
- One rich message: **32,768 chars · 500 blocks · 16 nesting · 50 media ·
  20 table columns** (validated before sending).
- Broadcasts/bulk are paced (~1 msg/s + per-channel delay) to respect limits.
- Paid posts are **experimental** — Telegram decides where paid media may
  appear; errors are surfaced in the panel.
- AI is rate-limited by NVIDIA's free tier (~40 req/min) — the bot surfaces
  friendly errors and never falls back to a paid provider.

## 📄 License

See [LICENSE](LICENSE).
