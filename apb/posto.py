"""apb.posto — PostoRobot-style features implanted into the bot.

Feature matrix vs @PostoRobot ("Automate multi-channel posts with recurring,
bulk posting, buttons, AI & more"):

| Posto feature        | Here |
| -------------------  | ---- |
| Multi-channel publishing | /channels + 🌐 publish (per-channel signature & delay) |
| Scheduled posts      | /post → 📅 (natural language) |
| **Recurring** posts  | repeat hourly / daily / weekly / custom interval |
| **Bulk posting**     | /bulk — collect many posts, post all now or auto-schedule |
| Templates            | /templates + 💾 save from composer (buttons & signature) |
| Inline buttons       | /buttons (colored, free) |
| AI (write / rewrite / translate / shorten / expand) | NVIDIA NIM, free forever |
| Watermarks           | optional Pillow photo watermark + signature fallback |
| Slideshow generator  | 🎞 toggle in composer + /slideshow (albums) |
| Turbo Mode           | /turbo — zero-click publishing |
| Hidden text          | ||spoilers|| in Rich Markdown (free) |
| Premium emojis       | skipped — the only Premium-gated API bit |
| Paid posts           | ⭐ Stars toggle (sendPaidMedia, experimental) |

The AI is NVIDIA ONLY (user requirement): ONE model, NVIDIA's own latest
flagship generation — ``nvidia/nemotron-3-super-120b-a12b`` on the free
NIM tier (no card, no expiry, ~40 req/min).
"""

from __future__ import annotations

import logging
import threading
import time
import traceback

from . import rich as R
from .api import TelegramError
from .mdblocks import md_to_blocks
from .nvidia import AIError
from .smooth import SmoothEditor, SmoothStream
from .utils import fmt_when, kb, parse_interval, parse_when

log = logging.getLogger(__name__)

CB = "apb"


class PostoMixin:
    """Mixed into handlers.Bot — channels/templates/bulk/turbo/slideshow/AI
    plus multi-destination publishing."""

    def init_posto(self, ai=None):
        self.ai = ai
        self.bulks = {}          # chat_id -> bulk session
        self.chan_sessions = {}  # chat_id -> {"state", "channel_id"}
        self.slides = {}         # chat_id -> {"media": [...], "panel"}
        self.ai_results = {}     # chat_id -> last AI generation info

    # ===================================================== message routing

    def posto_message(self, msg, chat_id):
        """Intercept non-command messages for bulk/channel/slideshow
        sessions.  Returns True when consumed."""
        bulk = self.bulks.get(chat_id)
        if bulk is not None:
            self.bulk_feed(chat_id, msg, bulk)
            return True
        chs = self.chan_sessions.get(chat_id)
        if chs is not None:
            self.channel_feed(chat_id, msg, chs)
            return True
        slide = self.slides.get(chat_id)
        if slide is not None:
            self.slideshow_feed(chat_id, msg, slide)
            return True
        return False

    def posto_cancel(self, chat_id):
        """Clear every Posto session for a chat (bulk, channels, slideshow)."""
        bulk = self.bulks.pop(chat_id, None)
        if bulk and bulk.get("editor"):
            try:
                bulk["editor"].update(
                    rich_message=R.markdown_message("🚫 Bulk collector closed."))
                bulk["editor"].close()
            except Exception:
                pass
        self.chan_sessions.pop(chat_id, None)
        slide = self.slides.pop(chat_id, None)
        if slide and slide.get("panel"):
            try:
                self.api.call("deleteMessage", chat_id=chat_id,
                              message_id=slide["panel"])
            except TelegramError:
                pass
        self.ai_results.pop(chat_id, None)

    # ============================================================ /turbo

    def cmd_turbo(self, msg, args):
        if not self.ensure_admin(msg):
            return
        on = not bool(self.store.setting("turbo"))
        self.store.set_setting("turbo", on)
        self.api.send_rich(msg["chat"]["id"], R.markdown_message(
            "⚡ **Turbo Mode: {}**\n\n{}".format(
                "ON" if on else "OFF",
                "Hit **/done** and the post publishes instantly — to every "
                "saved channel (or here if none). No confirmation clicks."
                if on else
                "Back to normal: /done shows the publish panel first.")))

    def turbo_try_publish(self, comp):
        """Called from cmd_done; True if turbo published already."""
        if not self.store.setting("turbo"):
            return False
        channels = self.store.channels()
        if channels:
            self.publish_multi(
                comp,
                [(int(cid), ch.get("signature") or None)
                 for cid, ch in channels.items()],
                label="⚡ turbo → {} channels".format(len(channels)))
        else:
            self.publish_to(comp, {"kind": "here", "chat_id": comp["chat_id"]})
        return True

    # ========================================================= /channels

    def cmd_channels(self, msg, args):
        if not self.ensure_admin(msg):
            return
        self.send_channels_panel(msg["chat"]["id"])

    def send_channels_panel(self, chat_id):
        channels = self.store.channels()
        rows = []
        lines = ["🌐 **Your channels** — posts fan out to all of them.", ""]
        if not channels:
            lines.append("_None yet. Add channels where this bot is an admin "
                         "(it needs post rights)._")
        for cid, ch in channels.items():
            sig = ch.get("signature") or ""
            delay = ch.get("delay")
            lines.append("• **{}** `{}`{}{}".format(
                ch.get("title") or cid, cid,
                " · “{}”".format(sig) if sig else "",
                " · +{:.0f}s".format(delay) if delay else ""))
            rows.append([
                {"text": "🖋 signature", "callback_data": "{}:chsig:{}".format(CB, cid)},
                {"text": "⏱ delay", "callback_data": "{}:chdelay:{}".format(CB, cid)},
                {"text": "🗑", "callback_data": "{}:chdel:{}".format(CB, cid),
                 "style": "danger"},
            ])
        rows.append([{"text": "➕ Add channel", "callback_data": CB + ":chadd",
                      "style": "success"}])
        self.api.send_rich(chat_id, R.markdown_message("\n".join(lines)),
                           reply_markup=kb(rows))

    def channel_feed(self, chat_id, msg, session):
        state = session.get("state")
        text = (msg.get("text") or msg.get("caption") or "").strip()

        if state == "await_add":
            fwd = msg.get("forward_from_chat") or {}
            target = title = None
            if fwd.get("id"):
                target, title = fwd["id"], fwd.get("title") or str(fwd["id"])
            else:
                token = text.split()[0] if text else ""
                if token.startswith("@") or token.lstrip("-").isdigit():
                    target = title = token
            if target is None:
                self.api.send_rich(chat_id, R.markdown_message(
                    "⚠️ Send an `@username`, a numeric id, or **forward any "
                    "post from that channel**."))
                return
            try:
                info = self.api.call("getChat", chat_id=target)
                title = info.get("title") or title
            except TelegramError as exc:
                self.api.send_rich(chat_id, R.markdown_message(
                    "❌ Can't see `{}` — am I an admin there?\n`{}`".format(
                        target, str(exc)[:200])))
                return
            self.store.add_channel(target, title)
            self.chan_sessions.pop(chat_id, None)
            self.api.send_rich(chat_id, R.markdown_message(
                "✅ Added **{}** `{}` — make sure I can **post** there.".format(
                    title, target)))
            self.send_channels_panel(chat_id)
            return

        if state == "await_sign":
            cid = session.get("channel_id")
            ch = self.store.channel(cid) or {}
            self.store.add_channel(cid, ch.get("title", ""), signature=text or None)
            self.chan_sessions.pop(chat_id, None)
            self.api.send_rich(chat_id, R.markdown_message(
                "🖋 Signature for **{}**: _{}_".format(
                    ch.get("title") or cid, text or "(none)")))
            self.send_channels_panel(chat_id)
            return

        if state == "await_delay":
            cid = session.get("channel_id")
            delay = parse_interval(text or "")
            if delay is None or delay > 600:
                self.api.send_rich(chat_id, R.markdown_message(
                    "⚠️ Send a delay like `5s` or `2m` (max 10m)."))
                return
            ch = self.store.channel(cid) or {}
            self.store.add_channel(cid, ch.get("title", ""), delay=delay)
            self.chan_sessions.pop(chat_id, None)
            self.api.send_rich(chat_id, R.markdown_message(
                "⏱ Delay after posting to **{}**: {}s.".format(
                    ch.get("title") or cid, delay)))
            self.send_channels_panel(chat_id)

    # ======================================================== /templates

    def cmd_templates(self, msg, args):
        if not self.ensure_admin(msg):
            return
        tpls = self.store.templates()
        rows = []
        lines = ["📋 **Templates** — reusable formats with buttons & signature.", ""]
        if not tpls:
            lines.append("_No templates yet — compose a post, then 💾 Save "
                         "template in the publish panel._")
        for tid, t in tpls[:10]:
            lines.append("• **{}** — {:,} chars{}".format(
                t.get("name") or "untitled", len(t.get("markdown") or ""),
                " · 🔘" if t.get("buttons") else ""))
            rows.append([
                {"text": "✍️ New post", "callback_data": "{}:tplnew:{}".format(CB, tid),
                 "style": "primary"},
                {"text": "🗑", "callback_data": "{}:tpldel:{}".format(CB, tid),
                 "style": "danger"},
            ])
        self.api.send_rich(msg["chat"]["id"], R.markdown_message("\n".join(lines)),
                           reply_markup=kb(rows) if rows else None)

    def template_to_composer(self, chat_id, tid):
        t = self.store.template(tid)
        if not t:
            return None
        comp = self._new_composer(chat_id)
        comp["parts"] = [t.get("markdown") or ""]
        comp["media"] = t.get("media") or []
        comp["buttons"] = t.get("buttons") or []
        comp["signature"] = t.get("signature") or ""
        return comp

    # ============================================================ /bulk

    def cmd_bulk(self, msg, args):
        chat_id = msg["chat"]["id"]
        if not self.ensure_admin(msg):
            return
        self.bulks[chat_id] = bulk = {
            "items": [], "state": "collect", "target": None, "interval": None,
            "panel": None, "editor": None,
        }
        panel = self.api.send_rich(
            chat_id, R.markdown_message(self.bulk_md(bulk)),
            reply_markup=self.bulk_kb())
        bulk["panel"] = panel["message_id"]
        bulk["editor"] = SmoothEditor(self.api, chat_id, panel["message_id"],
                                      min_interval=0.9)

    def bulk_md(self, bulk):
        items = bulk["items"]
        media = sum(len(i.get("media", [])) for i in items)
        last = (items[-1].get("text") or "")[:80] if items else ""
        lines = [
            "📦 **Bulk collector** — {} post{} · {} media".format(
                len(items), "" if len(items) == 1 else "s", media),
            "",
            "Send **one post per message** (text, or photo/video with a "
            "caption). Albums are kept together. /cancel aborts.",
        ]
        if last:
            lines += ["", "Last: _{}_".format(last.replace("|", ""))]
        if bulk.get("state") == "await_interval":
            lines += ["", "⏱ **Interval between posts?** e.g. `6h`, `90m`, `2d`"]
        if bulk.get("state") == "await_start":
            lines += ["", "📅 **Start when?** e.g. `now`, `+30m`, `21:30`, "
                          "`tomorrow 09:00`"]
        return "\n".join(lines)

    def bulk_kb(self):
        return kb([
            [{"text": "✅ Done collecting", "callback_data": CB + ":bulkgo",
              "style": "success"},
             {"text": "🚫 Cancel", "callback_data": CB + ":bulkcancel",
              "style": "danger"}],
        ])

    def bulk_target_kb(self, n_channels):
        rows = [[{"text": "📍 Post all here now",
                  "callback_data": CB + ":bulk:here", "style": "primary"}]]
        if n_channels:
            rows.append([{"text": "🌐 To my channels now",
                          "callback_data": CB + ":bulk:chans", "style": "primary"}])
        rows += [
            [{"text": "📅 Auto-schedule here…", "callback_data": CB + ":bulksched:here"},
             {"text": "📅 Auto-schedule channels…",
              "callback_data": CB + ":bulksched:chans"}],
            [{"text": "🚫 Cancel", "callback_data": CB + ":bulkcancel",
              "style": "danger"}],
        ]
        return kb(rows)

    def bulk_feed(self, chat_id, msg, bulk):
        if bulk.get("state") == "await_interval":
            interval = parse_interval((msg.get("text") or "").strip())
            if interval is None:
                bulk["editor"].update(
                    rich_message=R.markdown_message(
                        self.bulk_md(bulk) +
                        "\n\n⚠️ Try `6h`, `90m`, `2d` — minimum 1 minute."),
                    reply_markup=self.bulk_kb())
                return
            bulk["interval"] = interval
            bulk["state"] = "await_start"
            bulk["editor"].update(rich_message=R.markdown_message(self.bulk_md(bulk)),
                                  reply_markup=None)
            return
        if bulk.get("state") == "await_start":
            text = (msg.get("text") or "").strip().lower()
            start = time.time() + 60 if text in ("now", "asap") else parse_when(text)
            if start is None:
                bulk["editor"].update(
                    rich_message=R.markdown_message(
                        self.bulk_md(bulk) + "\n\n⚠️ Couldn't parse that time."),
                    reply_markup=None)
                return
            self.bulk_autoschedule(chat_id, bulk, start)
            return

        # ---- collecting ----
        media = self.extract_media(msg)
        text = (msg.get("text") or msg.get("caption") or "").strip()
        if not media and not text:
            return
        mgid = msg.get("media_group_id")
        if mgid and bulk["items"] and bulk["items"][-1].get("mgid") == mgid:
            # continuation of an album — merge into the previous item
            if media:
                bulk["items"][-1]["media"].append(
                    {"kind": media["kind"], "file_id": media["file_id"]})
            if text:
                bulk["items"][-1]["text"] = text
        else:
            bulk["items"].append({
                "text": text,
                "media": [{"kind": media["kind"], "file_id": media["file_id"]}]
                          if media else [],
                "mgid": mgid,
            })
        bulk["editor"].update(rich_message=R.markdown_message(self.bulk_md(bulk)),
                              reply_markup=self.bulk_kb())

    def bulk_run(self, chat_id, bulk, target_kind):
        """Post every collected item now (paced, progress live-edited)."""
        def worker():
            dests = ([(int(cid), ch.get("signature") or None)
                      for cid, ch in self.store.channels().items()]
                     if target_kind == "chans" else [(chat_id, None)])
            editor = bulk.get("editor")
            ok = fail = done = 0
            total = max(1, len(bulk["items"]) * len(dests))
            for item in bulk["items"]:
                comp = self._item_to_comp(chat_id, item)
                for dest, sig in dests:
                    try:
                        self.deliver_one(dest, comp, signature=sig)
                        ok += 1
                        self.store.bump(True)
                    except (TelegramError, ValueError) as exc:
                        fail += 1
                        self.store.bump(False)
                        log.warning("bulk send to %s failed: %s", dest, exc)
                    done += 1
                    if editor:
                        editor.update(rich_message=R.markdown_message(
                            "⚡ **Bulk posting** — {}/{} · ✅ {} · ❌ {}".format(
                                done, total, ok, fail)))
                    time.sleep(1.1)
            if editor:
                editor.update(rich_message=R.markdown_message(
                    "✅ **Bulk done** — {} posts · ✅ {} delivered · ❌ {} failed.".format(
                        len(bulk["items"]), ok, fail)))
                editor.close()
            self.bulks.pop(chat_id, None)

        threading.Thread(target=worker, daemon=True).start()

    def bulk_autoschedule(self, chat_id, bulk, start):
        interval = bulk["interval"]
        target = ({"kind": "channels"} if bulk.get("target") == "chans"
                  else {"kind": "here", "chat_id": chat_id})
        for i, item in enumerate(bulk["items"]):
            self.store.add_scheduled(
                start + i * interval, target, item.get("text") or " ",
                media=[{"id": "m{}".format(j + 1), "kind": m["kind"],
                        "media": m["file_id"]}
                       for j, m in enumerate(item.get("media") or [])],
                note="bulk", repeat="none")
        editor = bulk.get("editor")
        if editor:
            editor.update(rich_message=R.markdown_message(
                "📅 **Auto-scheduled {} posts** — one every **{:g}h**, starting {}."
                "\n\n👀 `/schedule` to manage them.".format(
                    len(bulk["items"]), interval / 3600.0, fmt_when(start))))
            editor.close()
        self.bulks.pop(chat_id, None)

    def _item_to_comp(self, chat_id, item):
        comp = self._new_composer(chat_id)
        comp["parts"] = [item.get("text") or " "]
        comp["media"] = [
            {"id": "m{}".format(i + 1), "kind": m["kind"], "media": m["file_id"]}
            for i, m in enumerate(item.get("media") or [])
        ]
        return comp

    # ====================================================== /slideshow

    def cmd_slideshow(self, msg, args):
        chat_id = msg["chat"]["id"]
        if not self.ensure_admin(msg):
            return
        panel = self.api.send_rich(chat_id, R.markdown_message(
            "🎞 **Slideshow maker** — send an album (or photos one by one), "
            "then send the caption text and I'll build the slideshow.\n\n"
            "/cancel to abort."))
        self.slides[chat_id] = {"media": [], "panel": panel["message_id"]}

    def slideshow_feed(self, chat_id, msg, slide):
        media = self.extract_media(msg)
        text = (msg.get("text") or "").strip()
        if media:
            slide["media"].append(media)
            try:
                self.api.call("deleteMessage", chat_id=chat_id,
                              message_id=msg["message_id"])
            except TelegramError:
                pass
            try:
                self.api.call(
                    "editMessageText", chat_id=chat_id, message_id=slide["panel"],
                    text="🎞 Slideshow: {} media collected — send more, or send "
                         "the caption text now.".format(len(slide["media"])))
            except TelegramError:
                pass
            return
        if text:
            if not slide["media"]:
                self.api.send_rich(chat_id, R.markdown_message(
                    "⚠️ Send some photos/videos first."))
                return
            self.slides.pop(chat_id, None)
            try:
                self.api.call("deleteMessage", chat_id=chat_id,
                              message_id=slide["panel"])
            except TelegramError:
                pass
            self.api.send_rich(
                chat_id,
                self.build_slideshow_irm({"parts": [text], "media": slide["media"]}))

    # ================================================================ AI

    def cmd_ai(self, msg, args):
        chat_id = msg["chat"]["id"]
        if not self.ensure_admin(msg):
            return
        if not args:
            self.api.send_rich(chat_id, R.markdown_message(
                "🤖 **AI — NVIDIA NIM, free forever**\n\n"
                "Model: `{}`\n\n"
                "• `/ai write about autumn coffee specials`\n"
                "• or compose with /post and use the 🤖 buttons: write, "
                "rewrite, translate, shorten, expand — the answer **streams "
                "in live**, then loads into your post with one tap.\n\n{}".format(
                    self.ai.model, self.ai.status_line())))
            return
        self.ai_run(chat_id, "write", args, replace=False)

    def ai_action(self, chat_id, kind):
        """Validate a composer AI action; returns a composer await-state
        (write/translate) or the kind to run immediately, or None."""
        if not self.ai.enabled:
            self.api.send_rich(chat_id, R.markdown_message(
                "🤖 AI is off. Get a **free** NVIDIA key (no card, never "
                "expires):\n\n1. open build.nvidia.com\n2. sign in → API keys "
                "→ generate (`nvapi-…`)\n3. `export APB_NVIDIA_KEY=…` and "
                "restart me.\n\nFree tier: ~40 requests/min, forever."))
            return None
        comp = self.composers.get(chat_id)
        if kind == "write":
            return "await_ai_prompt"
        if comp is None or not comp["parts"]:
            self.api.send_rich(chat_id, R.markdown_message(
                "✍️ Compose something first (/post) — then I can rewrite it."))
            return None
        if kind == "translate":
            return "await_ai_lang"
        return kind  # rewrite / shorten / expand run immediately

    def ai_run(self, chat_id, kind, prompt, base=None, replace=False):
        """Generate with NVIDIA, streaming live, then offer Use/Regenerate."""
        def worker():
            try:
                self._ai_run(chat_id, kind, prompt, base, replace)
            except Exception:
                log.error("ai run crashed\n%s", traceback.format_exc())
                try:
                    self.api.send_rich(chat_id, R.markdown_message(
                        "😵 AI crashed — see logs."))
                except TelegramError:
                    pass

        threading.Thread(target=worker, daemon=True).start()

    def _ai_run(self, chat_id, kind, prompt, base, replace):
        if base is None and kind in ("rewrite", "shorten", "expand", "translate"):
            comp = self.composers.get(chat_id)
            base = self.composer_markdown(comp) if comp else ""
        if kind == "rewrite":
            user_prompt = self.ai.rewrite_post(base, prompt or "make it punchier")
        elif kind == "shorten":
            user_prompt = self.ai.shorten_post(base)
        elif kind == "expand":
            user_prompt = self.ai.expand_post(base)
        elif kind == "translate":
            user_prompt = self.ai.translate_post(base, prompt or "English")
        else:
            user_prompt = self.ai.write_post(prompt)

        stream = SmoothStream(
            self.api, chat_id,
            draft_id=int(time.time() * 1000) % 2147483647,
            private=chat_id > 0, draft_interval=0.8)
        stream.begin(thinking_text="🧠 {} is writing…".format(
            self.ai.model.split("/")[-1]))
        text = ""
        try:
            for chunk in self.ai.stream(user_prompt):
                text += chunk
                stream.update(R.markdown_message(text + " ▌"))
        except AIError as exc:
            log.warning("AI stream failed (%s); trying blocking call", exc)
            text = self.ai.complete(user_prompt)
            stream.update(R.markdown_message(text))
        except TelegramError:
            # display pipeline hiccuped; generation itself may still work
            text = self.ai.complete(user_prompt)
            stream.update(R.markdown_message(text))

        msg = stream.finalize(R.markdown_message(text))
        self.ai_results[chat_id] = {
            "kind": kind, "prompt": prompt, "base": base, "replace": replace,
            "text": text, "msg_id": (msg or {}).get("message_id"),
        }
        if not msg:
            return
        try:
            self.api.call(
                "editMessageReplyMarkup", chat_id=chat_id,
                message_id=msg["message_id"],
                reply_markup=kb([[
                    {"text": "📝 Use in my post", "callback_data": CB + ":aiuse",
                     "style": "success"},
                    {"text": "🔁 Regenerate", "callback_data": CB + ":airegen"},
                    {"text": "🚫 Discard", "callback_data": CB + ":aidel",
                     "style": "danger"},
                ]]))
        except TelegramError as exc:
            log.debug("ai markup edit failed: %s", exc)

    def ai_use(self, chat_id):
        """Load the last AI result into the composer; returns status text."""
        res = self.ai_results.pop(chat_id, None)
        if not res:
            return "expired"
        comp = self.composers.get(chat_id)
        if comp is None:
            comp = self._new_composer(chat_id)
            comp["parts"] = [res["text"]]
            fake_msg = {"chat": {"id": chat_id, "type": "private"},
                        "from": {"id": self.admins[0] if self.admins else 0}}
            self.cmd_post(fake_msg, "", comp=comp)
            return "new-post"
        if res["replace"]:
            comp["backup_parts"] = list(comp["parts"])
            comp["parts"] = [res["text"]]
        else:
            comp["parts"].append(res["text"])
        self.update_panel(comp, extra="🤖 AI result loaded — preview refreshed.")
        self.send_preview(comp)
        return "loaded"

    # ============================================ composer feed extensions

    def posto_composer_feed(self, comp, text, msg):
        """Handle the new composer await-states; True if consumed."""
        state = comp.get("state")
        chat_id = comp["chat_id"]

        if state == "await_ai_prompt":
            if text:
                comp["state"] = "content"
                self.update_panel(comp)
                self.ai_run(chat_id, "write", text, replace=False)
            return True

        if state == "await_ai_lang":
            if text:
                comp["state"] = "content"
                self.update_panel(comp)
                self.ai_run(chat_id, "translate", text,
                            base=self.composer_markdown(comp), replace=True)
            return True

        if state == "await_repeat":
            if text:
                if text.lower() in ("once", "none", "no", "1"):
                    self.create_scheduled(comp, comp["sched_time"], "none")
                    return True
                interval = parse_interval(text)
                if interval:
                    self.create_scheduled(comp, comp["sched_time"],
                                          "every:{}".format(interval))
                    return True
            self.update_panel(comp, extra=(
                "⚠️ Tap a repeat option, or send `once` / an interval like `6h`."))
            return True

        if state == "await_stars":
            stars = text.strip().lstrip("⭐").strip()
            if stars.isdigit() and int(stars) >= 1:
                comp["stars"] = int(stars)
                comp["state"] = "published_panel"
                self.update_panel(comp, extra="⭐ Paid post: **{} Stars** "
                                  "(photo/video only, experimental).".format(
                                      comp["stars"]))
            else:
                comp["state"] = "published_panel"
                self.update_panel(comp, extra="⚠️ Stars must be a number ≥ 1 — "
                                  "paid posting left off.")
            return True

        if state == "await_sign":
            comp["signature"] = text
            comp["state"] = "published_panel"
            self.update_panel(comp, extra="🖋 Signature: _{}_".format(
                text or "(none)"))
            return True

        if state == "await_wm_text":
            if text:
                self.store.set_setting("watermark_text", text)
                self.store.set_setting("watermark_on", True)
                extra = "©️ Watermark “{}” — {}".format(
                    text,
                    "applied to photos on publish." if self.wm_available()
                    else "⚠️ install Pillow (`pip install Pillow`) for real "
                         "photo watermarks; meanwhile it's used as a text "
                         "signature on photos.")
            else:
                self.store.set_setting("watermark_on", False)
                extra = "©️ Watermark off."
            comp["state"] = "published_panel"
            self.update_panel(comp, extra=extra)
            return True

        return False

    def wm_available(self):
        from . import watermark
        return watermark.available()

    def create_scheduled(self, comp, when, repeat):
        chat_id = comp["chat_id"]
        jid = self.store.add_scheduled(
            when, comp.get("target") or {"kind": "here", "chat_id": chat_id},
            self.composer_markdown(comp), mode=comp["mode"],
            buttons=comp["buttons"], media=comp["media"],
            note=self.composer_title(comp), repeat=repeat,
            slideshow=comp.get("slideshow", False), stars=comp.get("stars"))
        if repeat == "none":
            rep_txt = "once"
        elif repeat in ("hourly", "daily", "weekly"):
            rep_txt = "every " + repeat[:-2]
        elif isinstance(repeat, str) and repeat.startswith("every:"):
            rep_txt = "every {:g}h".format(float(repeat.split(":")[1]) / 3600)
        else:
            rep_txt = str(repeat)
        self.update_panel(comp, extra=(
            "📅 Scheduled as `{}` — {}, **{}**.\n👀 `/schedule` to manage.".format(
                jid, fmt_when(when), rep_txt)))

    def ask_repeat(self, comp, when):
        """After a time was parsed for scheduling — ask how to repeat."""
        comp["sched_time"] = when
        comp["state"] = "await_repeat"
        self.update_panel(comp, extra=(
            "📅 {} — **repeat?**\n\nTap below or send an interval like `6h`.".format(
                fmt_when(when))),
            keyboard=kb([
                [{"text": "1️⃣ Once", "callback_data": CB + ":rep:none",
                  "style": "primary"},
                 {"text": "🔁 Hourly", "callback_data": CB + ":rep:hourly"},
                 {"text": "📆 Daily", "callback_data": CB + ":rep:daily"},
                 {"text": "🗓 Weekly", "callback_data": CB + ":rep:weekly"}],
                [{"text": "🚫 Cancel", "callback_data": CB + ":cancel",
                  "style": "danger"}],
            ]))

    # ================================================ publishing support

    def publish_channels(self, comp):
        channels = self.store.channels()
        if not channels:
            self.update_panel(comp, extra=(
                "🌐 No channels saved yet — /channels to add them "
                "(I must be an admin there)."))
            return
        self.publish_multi(
            comp,
            [(int(cid), ch.get("signature") or None)
             for cid, ch in channels.items()],
            label="🌐 {} channels".format(len(channels)))

    def publish_multi(self, comp, dests, label=""):
        """Publish to several destinations with per-channel pacing/signature."""
        editor = comp.get("panel_editor")

        def worker():
            ok = fail = 0
            for i, (dest, sig) in enumerate(dests, 1):
                try:
                    self.deliver_one(dest, comp, signature=sig,
                                     private=isinstance(dest, int) and dest > 0)
                    ok += 1
                    self.store.bump(True)
                except (TelegramError, ValueError) as exc:
                    fail += 1
                    self.store.bump(False)
                    log.warning("publish to %s failed: %s", dest, exc)
                if editor:
                    editor.update(rich_message=R.markdown_message(
                        "📤 **Publishing** {} — {}/{} · ✅ {} · ❌ {}".format(
                            label, i, len(dests), ok, fail)))
                delay = 1.1
                ch = self.store.channel(dest)
                if ch and ch.get("delay"):
                    delay = max(0.2, float(ch["delay"]))
                time.sleep(delay)
            if editor:
                extra = "✅ **Published** to {} chat{} · ❌ {} failed.".format(
                    ok, "" if ok == 1 else "s", fail)
                if fail:
                    extra += "\n_(check that I'm admin in the failed channels)_"
                editor.update(rich_message=R.markdown_message(extra),
                              reply_markup=self.published_kb())
                editor.close()
            comp["state"] = "published_panel"

        threading.Thread(target=worker, daemon=True).start()

    def build_slideshow_irm(self, comp, markdown=None):
        """Blocks-mode rich message: slideshow of collected media + text."""
        media_blocks = []
        for m in comp.get("media", []):
            fid = m.get("media") or m.get("file_id")
            kind = m.get("kind")
            if kind == "photo":
                media_blocks.append(R.photo_block(fid))
            elif kind == "video":
                media_blocks.append(R.video_block(fid))
            elif kind == "animation":
                media_blocks.append(R.animation_block(fid))
        if not media_blocks:
            media_blocks.append(R.paragraph("_(no media)_"))
        blocks = [R.slideshow(media_blocks)]
        md = markdown if markdown is not None else "\n\n".join(comp.get("parts", []))
        blocks += md_to_blocks(md or "")
        return R.rich_message(blocks=blocks)

    def apply_signature(self, markdown, signature):
        if not signature:
            return markdown
        return "{}\n\n— _{}_".format(markdown.rstrip(), signature)

    # ==================================================== callback router

    def posto_callback(self, cbq, parts, action):
        """Handle Posto-feature callbacks; True when consumed."""
        msg = cbq.get("message") or {}
        chat = msg.get("chat") or {}
        chat_id = chat.get("id")
        user = cbq.get("from") or {}

        def need_admin():
            return self.ensure_admin(msg, user=user)

        # ---- channels ----
        if action == "chadd":
            self.api.answer_cbq(cbq["id"])
            if not need_admin():
                return True
            self.chan_sessions[chat_id] = {"state": "await_add"}
            self.api.send_rich(chat_id, R.markdown_message(
                "➕ **Add channel** — send the `@username` / numeric id, or "
                "**forward any post from that channel**."))
            return True
        if action in ("chsig", "chdelay", "chdel") and len(parts) > 2:
            cid = parts[2]
            if action == "chdel":
                self.api.answer_cbq(cbq["id"], text="🗑 removed")
                self.store.del_channel(cid)
                self.send_channels_panel(chat_id)
                return True
            self.api.answer_cbq(cbq["id"])
            if action == "chsig":
                self.chan_sessions[chat_id] = {"state": "await_sign", "channel_id": cid}
                self.api.send_rich(chat_id, R.markdown_message(
                    "🖋 Send the signature text appended under every post "
                    "in that channel (or `-` for none)."))
            else:
                self.chan_sessions[chat_id] = {"state": "await_delay", "channel_id": cid}
                self.api.send_rich(chat_id, R.markdown_message(
                    "⏱ Send the delay to wait after posting there "
                    "(`5s` … `2m`, max `10m`)."))
            return True

        # ---- templates ----
        if action == "tplnew" and len(parts) > 2:
            self.api.answer_cbq(cbq["id"])
            if not need_admin():
                return True
            comp = self.template_to_composer(chat_id, parts[2])
            if comp is None:
                self.api.answer_cbq(cbq["id"], text="template gone", show_alert=True)
                return True
            self.cmd_post({"chat": chat, "from": user}, "", comp=comp)
            return True
        if action == "tpldel" and len(parts) > 2:
            self.api.answer_cbq(cbq["id"], text="🗑 deleted")
            self.store.del_template(parts[2])
            self.cmd_templates({"chat": chat, "from": user}, "")
            return True

        # ---- bulk ----
        if action == "bulkgo":
            bulk = self.bulks.get(chat_id)
            if bulk is None:
                self.api.answer_cbq(cbq["id"], text="expired — /bulk to restart",
                                    show_alert=True)
                return True
            if not bulk["items"]:
                self.api.answer_cbq(cbq["id"], text="collect some posts first!",
                                    show_alert=True)
                return True
            self.api.answer_cbq(cbq["id"])
            editor = bulk.get("editor")
            if editor:
                editor.update(
                    rich_message=R.markdown_message(self.bulk_md(bulk) +
                                                    "\n\n**Where to?**"),
                    reply_markup=self.bulk_target_kb(len(self.store.channels())))
            return True
        if action in ("bulkhere", "bulkchans") or \
                (action == "bulk" and len(parts) > 2 and parts[2] in ("here", "chans")):
            bulk = self.bulks.get(chat_id)
            if bulk is None:
                self.api.answer_cbq(cbq["id"], text="expired", show_alert=True)
                return True
            kind = parts[2] if action == "bulk" else action[4:]
            self.api.answer_cbq(cbq["id"], text="⚡ posting…")
            self.bulk_run(chat_id, bulk, kind)
            return True
        if action == "bulksched" and len(parts) > 2:
            bulk = self.bulks.get(chat_id)
            if bulk is None:
                self.api.answer_cbq(cbq["id"], text="expired", show_alert=True)
                return True
            self.api.answer_cbq(cbq["id"])
            bulk["target"] = parts[2]
            bulk["state"] = "await_interval"
            editor = bulk.get("editor")
            if editor:
                editor.update(rich_message=R.markdown_message(self.bulk_md(bulk)),
                              reply_markup=None)
            return True
        if action == "bulkcancel":
            bulk = self.bulks.pop(chat_id, None)
            self.api.answer_cbq(cbq["id"], text="🚫 cancelled")
            if bulk and bulk.get("editor"):
                bulk["editor"].update(
                    rich_message=R.markdown_message("🚫 Bulk collector closed."))
                bulk["editor"].close()
            return True

        # ---- composer AI ----
        ai_kinds = {"aiw": "write", "air": "rewrite", "ait": "translate",
                    "ais": "shorten", "aie": "expand"}
        if action in ai_kinds:
            self.api.answer_cbq(cbq["id"])
            if not need_admin():
                return True
            kind = ai_kinds[action]
            with self._lock:
                comp = self.composers.get(chat_id)
            state_or_kind = self.ai_action(chat_id, kind)
            if state_or_kind is None:
                return True
            if state_or_kind in ("await_ai_prompt", "await_ai_lang"):
                if comp is not None:
                    comp["state"] = state_or_kind
                    self.update_panel(comp, extra=(
                        "🤖 Send the **topic** to write about."
                        if kind == "write" else
                        "🌐 Send the **target language** (e.g. `Hindi`, `Spanish`)."))
                return True
            self.ai_run(chat_id, kind, None, replace=True)
            return True
        if action == "aiuse":
            status = self.ai_use(chat_id)
            texts = {"loaded": "📝 loaded into your post!",
                     "new-post": "📝 new post started with the AI text!",
                     "expired": "nothing to load — generate something first"}
            self.api.answer_cbq(cbq["id"], text=texts.get(status, status),
                                show_alert=(status == "expired"))
            return True
        if action == "airegen":
            res = self.ai_results.get(chat_id)
            if not res:
                self.api.answer_cbq(cbq["id"], text="nothing to regenerate",
                                    show_alert=True)
                return True
            self.api.answer_cbq(cbq["id"], text="🔁 regenerating…")
            self.ai_run(chat_id, res["kind"], res["prompt"], res["base"],
                        res["replace"])
            return True
        if action == "aidel":
            self.ai_results.pop(chat_id, None)
            self.api.answer_cbq(cbq["id"], text="🚫 discarded")
            return True

        # ---- composer: repeat / slideshow / paid / signature / watermark ----
        with self._lock:
            comp = self.composers.get(chat_id)
        if comp is None:
            return False

        if action == "rep" and len(parts) > 2:
            self.api.answer_cbq(cbq["id"])
            rep = parts[2] if parts[2] in ("none", "hourly", "daily", "weekly") \
                else "none"
            self.create_scheduled(comp, comp["sched_time"], rep)
            return True
        if action == "slide":
            comp["slideshow"] = not comp.get("slideshow", False)
            self.api.answer_cbq(cbq["id"], text="🎞 slideshow " +
                                ("ON" if comp["slideshow"] else "OFF"))
            self.update_panel(comp)
            self.refresh_preview(comp)
            return True
        if action == "star":
            self.api.answer_cbq(cbq["id"])
            comp["state"] = "await_stars"
            self.update_panel(comp, extra=(
                "⭐ **Paid post** — send the price in **Telegram Stars** "
                "(integer ≥ 1). Photo/video posts only, experimental."))
            return True
        if action == "sign":
            self.api.answer_cbq(cbq["id"])
            comp["state"] = "await_sign"
            self.update_panel(comp, extra=(
                "🖋 Send the signature line appended under this post."))
            return True
        if action == "wm":
            if self.store.setting("watermark_on"):
                self.store.set_setting("watermark_on", False)
                self.api.answer_cbq(cbq["id"], text="©️ watermark off")
                self.update_panel(comp, extra="©️ Watermark off.")
            else:
                self.api.answer_cbq(cbq["id"])
                comp["state"] = "await_wm_text"
                self.update_panel(comp, extra=(
                    "©️ Send the **watermark text** (e.g. `@yourchannel`) — "
                    "applied to photos when publishing."))
            return True
        if action == "tplsave":
            self.api.answer_cbq(cbq["id"], text="📋 template saved")
            tid = self.store.add_template(
                self.composer_title(comp), self.composer_markdown(comp),
                buttons=comp.get("buttons"), media=comp.get("media"),
                signature=comp.get("signature", ""))
            self.update_panel(comp, extra="📋 Saved as template `{}` — "
                              "/templates to reuse it.".format(tid))
            return True
        if action == "pub" and len(parts) > 2 and parts[2] == "chans":
            self.api.answer_cbq(cbq["id"])
            self.publish_channels(comp)
            return True

        return False

    # ------------------------------------------------- media preparation

    def prepare_media(self, comp):
        """Build InputRichMessage.media refs; watermarked photos are
        re-uploaded via attach:// (returns (refs, files))."""
        from . import watermark as WM

        wm_on = bool(self.store.setting("watermark_on")) and \
            bool(self.store.setting("watermark_text"))
        refs, files = [], {}
        for m in comp.get("media", []):
            media, kind = m["media"], m["kind"]
            if wm_on and kind == "photo":
                marked = None
                if WM.available():
                    try:
                        blob = self.api.download_file(media)
                        marked = WM.watermark_bytes(
                            blob, self.store.setting("watermark_text"))
                    except TelegramError as exc:
                        log.warning("watermark download failed: %s", exc)
                if marked:
                    name = "wm" + m["id"]
                    files[name] = ("watermark.jpg", marked, "image/jpeg")
                    media = "attach://" + name
            refs.append(R.media_ref(m["id"], media, kind))
        return refs, files
