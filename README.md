# ✨ Advanced Posting Bot in Telegram

A **rich-media posting bot** for channels, groups and private chats — built on
**Telegram Bot API 10.3** (Aug 2026) with **zero dependencies** (pure Python 3
stdlib).

It makes a bot look *Premium without Premium*: real headings, tables,
collapsible sections, checklists, LaTeX math, marked text, spoilers, colored
buttons — and **buttery-smooth message editing / live streaming**. All of it is
free; the only Premium-gated Bot API feature (custom emoji) is deliberately
avoided. See [`RESEARCH.md`](RESEARCH.md) for the full version-by-version
read-through (9.1 → 10.3).

```
 _   _ _______ ____  __  __ _____ ____      _    _
| | | | ____ / ___||  \/  | ____|  _ \    / \  | |
| |_| |  _| \___ \| |\/| |  _| | |_) |  / _ \ | |
|  _  | |___ ___) | |  | | |___|  _ <  / ___ \| |___
|_| |_|_____|____/|_|  |_|_____|_| \_\/_/   \_\_____|
        Advanced Posting Bot · rich · free · smooth
```

## 🚀 Quick start

```bash
# 1. get a token from @BotFather
export APB_TOKEN="123456:ABC-your-token"
export APB_ADMINS="123456789"        # your user id (optional — see below)

# 2. run (Python 3.9+, nothing to install!)
python3 bot.py

# offline sanity checks, no token needed
python3 bot.py --selftest
```

No admins configured? The **first person to send `/post` in a private chat
claims ownership** (handy for self-hosting; clear `data/apb.json` to reset).

## 🧠 What makes it “rich” (all free)

| Capability | Bot API | Where you see it |
| :- | :- | :- |
| Rich Messages: headings, tables, details, quotes, math, marked, spoilers, footnotes | 10.1 | `/demo`, every post you compose |
| **Animated streaming drafts** + shimmering *thinking* block | 10.1 | `/stream` — AI-style live typing |
| **Smooth live editing** (`editMessageText` + `rich_message`, debounced) | 10.1 | preview & panel update themselves while you type |
| Media embedded *inside* documents (`tg://photo?id=`) | 10.2 | send a photo while composing |
| **Ephemeral messages** — replies only one user can see | 10.2/10.3 | `/id`, `/ping`, 👀 demo button in groups |
| **Buttons inside the message body** with colors | 10.3 | `/demo` section 7 |
| Colored classic buttons (`primary`/`success`/`danger`) | 9.4 | every keyboard |
| Message effects (🎉 🔥 ❤️) | 7.2 | `/start` in private chat |
| Reactions, pinning, scheduling, broadcasting | — | composer panel |

## 📖 Commands

| Command | Who | What |
| :- | :- | :- |
| `/start` | everyone | rich welcome (+ ❤️ effect in private) |
| `/demo` | everyone | the full rich showcase — tables, math, details, buttons… |
| `/stream` | everyone | watch smooth live-typing / streaming edits |
| `/post` | admins | start composing (Markdown in, rich post out) |
| `/preview` `/done` | admins | live preview / finish composing |
| `/buttons` | admins | add colored buttons to the post |
| `/drafts` `/schedule` | admins | manage saved drafts / scheduled posts |
| `/edit` | admins | reply to a bot message with `/edit <markdown>` — it re-types itself |
| `/stats` `/id` `/ping` `/cancel` | everyone | utilities |

## ✍️ Composing

1. `/post`, then just **send Markdown** — as many messages as you like.
   Rich Markdown ≈ GitHub-Flavored Markdown: `# headings`, `**bold**`,
   `==marked==`, `||spoiler||`, `> quotes`, tables, `- [ ]` task lists,
   footnotes, fenced code, `$math$` — plus rich HTML tags:
   `<details>`, `<aside>quote<cite>credit</cite></aside>`,
   `<tg-map lat="41.9" long="12.5" zoom="14"/>`, `<tg-collage>`, `<tg-slideshow>`.
2. **Send a photo/video/audio/animation** while composing → the bot stores it
   and gives you a `tg://photo?id=m1` link to embed with `![](tg://photo?id=m1)`.
3. `/preview` renders it live — **keep typing, the preview edits itself
   smoothly** (debounced ~1.1 s, flicker-free).
4. `/done` → panel:
   **✅ Publish here · 📣 To channel… · 📤 Broadcast all · 📅 Schedule… ·
   🪄 Effect · 💾 Save draft**
5. Buttons (one row per line, `;;` splits a row):

   ```
   Read more | https://example.com | primary
   👍 Like | cb:like ;; 🔄 Share | cb:share
   Delete | cb:delete | danger
   ```

6. Scheduling understands `+90m` · `21:30` · `tomorrow 09:00` · `2026-12-25 10:00`.

## 🏗 Architecture

```
bot.py                 entry point (CLI, polling loop)
apb/
├── api.py             Bot API 10.3 client (urllib, retries, 429 backoff, multipart)
├── rich.py            RichText/RichBlock/InputRichMessage builders + limit checks
├── smooth.py          SmoothEditor (debounced rich edits) · SmoothStream (drafts)
├── handlers.py        commands, callbacks, composer wizard, publishing
├── scheduler.py       background thread firing scheduled posts
├── store.py           atomic JSON persistence (data/apb.json)
├── content.py         welcome/help/demo content
├── utils.py           time & button-row parsing
└── selftest.py        76 offline checks (python bot.py --selftest)
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
- Broadcasts are paced (~1 msg/s) to respect Telegram's limits.
- `💤 Mode: plain` in the composer switches a post to classic `sendMessage`
  Markdown for very old audiences.

## 📄 License

See [LICENSE](LICENSE).
