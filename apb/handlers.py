"""apb.handlers — commands, callbacks and the post-composer wizard.

This is the bot's brain.  It wires the free Bot API 10.1–10.3 goodies
into a posting workflow:

* compose in Markdown → live, smoothly-edited preview (editMessageText
  with rich_message),
* publish here / to a channel / broadcast to everyone (paced),
* schedule in natural language,
* AI-style streaming demo (sendRichMessageDraft + thinking block),
* ephemeral group replies (ephemeral_message_parameters),
* colored buttons everywhere.
"""

from __future__ import annotations

import logging
import threading
import time
import traceback

from . import content, rich as R
from .api import TelegramError
from .smooth import SmoothEditor, SmoothStream
from .utils import fmt_when, kb, parse_button_rows, parse_when

log = logging.getLogger(__name__)

CB = "apb"  # callback namespace


class Bot:
    def __init__(self, api, store, admins=()):
        self.api = api
        self.store = store
        self.admins = list(admins) or list(store.data.get("admins", []))
        self.composers = {}   # chat_id -> composer state dict
        self.streams = {}     # chat_id -> SmoothStream
        self._lock = threading.RLock()

    # ================================================================ router

    def dispatch(self, update):
        if not isinstance(update, dict):
            return
        if update.get("message"):
            self.on_message(update["message"])
        elif update.get("callback_query"):
            self.on_callback(update["callback_query"])
        elif update.get("stopped_message_generation"):
            self.on_generation_stopped(update["stopped_message_generation"])

    def on_message(self, msg):
        try:
            self._on_message(msg)
        except TelegramError as exc:
            log.error("telegram error: %s", exc)
            self.try_reply_error(msg, exc)
        except Exception:
            log.error("handler crashed\n%s", traceback.format_exc())

    def _on_message(self, msg):
        chat = msg.get("chat") or {}
        chat_id = chat.get("id")
        if chat_id is None:
            return
        user = msg.get("from") or {}
        uid = user.get("id")
        if chat.get("type") == "private":
            self.store.chat_ensure(chat_id, user.get("first_name", ""), "private")

        text = (msg.get("text") or msg.get("caption") or "").strip()
        if text.startswith("/"):
            self.route_command(text, msg)
            return

        with self._lock:
            comp = self.composers.get(chat_id)
        if comp is not None:
            self.feed_composer(chat_id, msg, comp)
        elif chat.get("type") == "private" and self.is_admin(uid):
            self.api.send_rich(chat_id, R.markdown_message(
                "Got it 🙂 — **/post** starts a new post, **/demo** shows "
                "everything this bot can do."))

    def route_command(self, text, msg):
        pieces = text.split(None, 1)
        name = pieces[0][1:].split("@")[0].lower()
        args = (pieces[1] if len(pieces) > 1 else "").strip()
        table = {
            "start": self.cmd_start, "help": self.cmd_help,
            "demo": self.cmd_demo, "post": self.cmd_post, "new": self.cmd_post,
            "preview": self.cmd_preview, "done": self.cmd_done,
            "buttons": self.cmd_buttons, "cancel": self.cmd_cancel,
            "stop": self.cmd_stop, "drafts": self.cmd_drafts,
            "schedule": self.cmd_schedule, "bcast": self.cmd_bcast,
            "broadcast": self.cmd_bcast, "edit": self.cmd_edit,
            "stream": self.cmd_stream, "stats": self.cmd_stats,
            "id": self.cmd_id, "ping": self.cmd_ping,
        }
        handler = table.get(name)
        if handler is None:
            return
        try:
            handler(msg, args)
        except TelegramError as exc:
            log.error("command /%s failed: %s", name, exc)
            self.try_reply_error(msg, exc)
        except Exception:
            log.error("command /%s crashed\n%s", name, traceback.format_exc())
            try:
                self.api.send_text(msg["chat"]["id"], "😵 Something broke — see logs.")
            except Exception:
                pass

    def try_reply_error(self, msg, exc):
        try:
            chat_id = (msg.get("chat") or {}).get("id")
            if chat_id:
                self.api.send_rich(chat_id, R.markdown_message(
                    "⚠️ Telegram said no: `{}`".format(str(exc)[:300])))
        except Exception:
            pass

    # ============================================================= commands

    def cmd_start(self, msg, args):
        chat = msg["chat"]
        irm = R.rich_message(blocks=content.welcome_blocks())
        k = kb([
            [{"text": "✨ Show me everything", "callback_data": CB + ":demo", "style": "primary"}],
            [{"text": "🔁 Smooth streaming demo", "callback_data": CB + ":stream"}],
        ])
        if self.is_admin((msg.get("from") or {}).get("id")) and chat["type"] == "private":
            k["inline_keyboard"].append(
                [{"text": "✍️ New post", "callback_data": CB + ":post", "style": "success"}])
        kw = {}
        if chat["type"] == "private":
            kw["message_effect_id"] = content.EFFECTS["❤️"]
        self.api.send_rich(chat["id"], irm, reply_markup=k, **kw)

    def cmd_help(self, msg, args):
        self.api.send_rich(msg["chat"]["id"], R.markdown_message(content.help_markdown()))

    def cmd_demo(self, msg, args):
        m = self.api.send_rich(
            msg["chat"]["id"], R.rich_message(blocks=content.demo_blocks()),
            reply_markup=content.demo_footer_keyboard())
        try:
            self.api.react(msg["chat"]["id"], m["message_id"], "🔥")
        except TelegramError:
            pass

    def cmd_stats(self, msg, args):
        s = self.store.stats()
        blocks = [
            R.heading("📊 Delivery stats", 3),
            R.table(
                [["Metric", "Value"],
                 ["Chats seen", s["chats"]],
                 ["Drafts", s["drafts"]],
                 ["Scheduled", s["scheduled"]],
                 ["Posts delivered", s["sent"]],
                 ["Failed sends", s["failed"]]],
                aligns=["left", "right"], compact=True),
            R.footer("stats live in data/apb.json"),
        ]
        self.api.send_rich(msg["chat"]["id"], R.rich_message(blocks=blocks))

    def cmd_id(self, msg, args):
        chat = msg["chat"]
        user = msg.get("from") or {}
        md = ("🆔 **Chat id:** `{}`\n👤 **Your id:** `{}`\n🏷 Type: `{}`".format(
            chat["id"], user.get("id", "?"), chat.get("type")))
        if chat["type"] in ("group", "supergroup"):
            try:
                self.api.send_ephemeral_rich(
                    chat["id"], user["id"], R.markdown_message(md))
                return
            except TelegramError:
                pass
        self.api.send_rich(chat["id"], R.markdown_message(md))

    def cmd_ping(self, msg, args):
        chat = msg["chat"]
        user = msg.get("from") or {}
        if chat["type"] in ("group", "supergroup"):
            try:
                self.api.send_ephemeral_rich(
                    chat["id"], user["id"], R.markdown_message("🏓 pong — only you see this"))
                return
            except TelegramError:
                pass
        self.api.send_text(chat["id"], "🏓 pong")

    # ------------------------------------------------------------- composer

    def cmd_post(self, msg, args, comp=None):
        chat = msg["chat"]
        if not self.ensure_admin(msg):
            return
        if comp is None:
            comp = self._new_composer(chat["id"])
        with self._lock:
            self.composers[chat["id"]] = comp
        panel = self.api.send_rich(
            chat["id"],
            R.markdown_message(self.panel_md(comp)),
            reply_markup=self.compose_kb("compose"))
        comp["panel_msg"] = panel["message_id"]
        comp["panel_editor"] = SmoothEditor(self.api, chat["id"], panel["message_id"],
                                            min_interval=0.9)

    def _new_composer(self, chat_id):
        return {
            "chat_id": chat_id,
            "state": "content",
            "parts": [],
            "media": [],
            "mode": "rich",
            "buttons": [],
            "effect": None,
            "panel_msg": None,
            "panel_editor": None,
            "preview_msg": None,
            "preview_editor": None,
            "published": None,
        }

    def feed_composer(self, chat_id, msg, comp):
        state = comp.get("state")
        text = (msg.get("text") or msg.get("caption") or "").strip()

        if state == "content":
            media = self.extract_media(msg)
            if media:
                slot = "m{}".format(len(comp["media"]) + 1)
                comp["media"].append(
                    {"id": slot, "kind": media["kind"], "media": media["file_id"]})
                self.update_panel(comp, extra="📎 {} saved as `{}` — embed: `![](tg://{}?id={})`".format(
                    media["kind"], slot, media["kind"], slot))
                return
            if text:
                comp["parts"].append(text)
                self.update_panel(comp)
                self.refresh_preview(comp)
            return

        if state == "await_channel":
            target = text.split()[0] if text else ""
            if not (target.startswith("@") or target.lstrip("-").isdigit()):
                self.update_panel(comp, extra="⚠️ Send an `@username` or a numeric chat id.")
                return
            comp["target"] = {"kind": "channel", "chat_id": target}
            comp["state"] = "published_panel"
            self.publish_to(comp, {"kind": "channel", "chat_id": target})
            return

        if state == "await_time":
            when = parse_when(text)
            if when is None:
                self.update_panel(comp, extra=(
                    "⏰ Couldn't parse that. Try `+2h`, `21:30`, `tomorrow 09:00` "
                    "or `2026-12-25 10:00`."))
                return
            jid = self.store.add_scheduled(
                when, comp.get("target") or {"kind": "here", "chat_id": chat_id},
                self.composer_markdown(comp), mode=comp["mode"],
                buttons=comp["buttons"], media=comp["media"],
                note=self.composer_title(comp))
            self.set_panel_state(comp, "published_panel")
            self.update_panel(comp, extra="📅 Scheduled as job `{}` — {}.\n👀 `/schedule` to manage.".format(
                jid, fmt_when(when)))
            return

        if state == "await_buttons":
            rows, errors = parse_button_rows(text)
            if errors:
                self.update_panel(comp, extra="⚠️ " + "\n⚠️ ".join(errors[:3]))
                return
            comp["buttons"] = rows
            self.set_panel_state(comp, "content")
            self.update_panel(comp, extra="🔘 {} button row(s) saved.".format(len(rows)))
            self.refresh_preview(comp)
            return

        if state == "await_edit":
            if text:
                self.typewriter_edit(comp["edit_chat"], comp["edit_msg"], text)
                with self._lock:
                    self.composers.pop(chat_id, None)
            return

    def extract_media(self, msg):
        if msg.get("photo"):
            return {"kind": "photo", "file_id": msg["photo"][-1]["file_id"]}
        for key, kind in (("video", "video"), ("animation", "animation"),
                          ("audio", "audio"), ("voice", "voice_note"),
                          ("document", "document")):
            if msg.get(key):
                return {"kind": kind, "file_id": msg[key]["file_id"]}
        return None

    # ------------------------------------------------------- composer cmds

    def cmd_preview(self, msg, args):
        with self._lock:
            comp = self.composers.get(msg["chat"]["id"])
        if not comp:
            self.api.send_text(msg["chat"]["id"], "Nothing to preview — /post first.")
            return
        self.send_preview(comp)

    def cmd_done(self, msg, args):
        with self._lock:
            comp = self.composers.get(msg["chat"]["id"])
        if not comp:
            self.api.send_text(msg["chat"]["id"], "Nothing to finish — /post first.")
            return
        if not comp["parts"]:
            self.update_panel(comp, extra="📭 Nothing composed yet — send some Markdown first.")
            return
        if comp["preview_msg"] is None:
            self.send_preview(comp)
        self.set_panel_state(comp, "published_panel")
        self.update_panel(comp)

    def cmd_buttons(self, msg, args):
        with self._lock:
            comp = self.composers.get(msg["chat"]["id"])
        if not comp:
            self.api.send_text(msg["chat"]["id"], "Start /post first.")
            return
        comp["state"] = "await_buttons"
        self.update_panel(comp, extra=(
            "🔘 **Buttons** — one row per line, buttons on the same row split by `;;`:\n"
            "```\n"
            "Read more | https://example.com | primary\n"
            "👍 Like | cb:like ;; 🔄 Share | cb:share\n"
            "Delete | cb:delete | danger\n"
            "```\n"
            "Colors: `primary` 🔵 `success` 🟢 `danger` 🔴. Send the lines now."))

    def cmd_cancel(self, msg, args):
        chat_id = msg["chat"]["id"]
        with self._lock:
            comp = self.composers.pop(chat_id, None)
        if comp:
            self.finish_panel(comp, "🚫 Composer closed.")
        else:
            stream = self.streams.get(chat_id)
            if stream:
                stream.abort(keep=False)

    def cmd_stop(self, msg, args):
        stream = self.streams.get(msg["chat"]["id"])
        if stream:
            stream.abort(keep=True)

    def cmd_drafts(self, msg, args):
        if not self.ensure_admin(msg):
            return
        rows = []
        for did, d in self.store.drafts()[:8]:
            rows.append([
                {"text": "📝 " + (d.get("title") or "untitled")[:40],
                 "callback_data": "{}:draft:load:{}".format(CB, did)},
                {"text": "🗑", "callback_data": "{}:draft:del:{}".format(CB, did),
                 "style": "danger"},
            ])
        if not rows:
            rows = [[{"text": "📭 no drafts yet", "callback_data": CB + ":noop"}]]
        self.api.send_rich(msg["chat"]["id"], R.markdown_message(
            "🗂 **Saved drafts** — tap to load into the composer."),
            reply_markup=kb(rows))

    def cmd_schedule(self, msg, args):
        if not self.ensure_admin(msg):
            return
        rows = []
        lines = ["⏰ **Scheduled posts**\n"]
        for jid, job in self.store.scheduled()[:8]:
            when = fmt_when(job["run_at"])
            status = "" if job.get("status") == "pending" else " · " + job.get("status", "")
            lines.append("• `{}` — {}{} — {}".format(
                jid, when, status, job.get("note") or job.get("target", {}).get("chat_id", "")))
            rows.append([{"text": "🗑 cancel " + when[:16],
                          "callback_data": "{}:scheddel:{}".format(CB, jid),
                          "style": "danger"}])
        if not rows:
            lines.append("📭 nothing scheduled. Compose a post → 📅 Schedule…")
        self.api.send_rich(msg["chat"]["id"], R.markdown_message("\n".join(lines)),
                           reply_markup=kb(rows) if rows else None)

    def cmd_bcast(self, msg, args):
        if not self.ensure_admin(msg):
            return
        self.api.send_rich(msg["chat"]["id"], R.markdown_message(
            "📣 Broadcasting is built into the composer: **/post** → **✅ Done** → "
            "**📤 Broadcast all**. I'll pace the sends and live-edit the progress here."))

    def cmd_edit(self, msg, args):
        chat = msg["chat"]
        if not self.ensure_admin(msg):
            return
        reply = msg.get("reply_to_message") or {}
        target = reply.get("message_id") if (reply.get("from") or {}).get("is_bot") else None
        if target and args:
            self.typewriter_edit(chat["id"], target, args)
            return
        if target:
            with self._lock:
                comp = self.composers.get(chat["id"]) or self._new_composer(chat["id"])
                comp["state"] = "await_edit"
                comp["edit_chat"], comp["edit_msg"] = chat["id"], target
                self.composers[chat["id"]] = comp
            self.api.send_rich(chat["id"], R.markdown_message(
                "✏️ Reply with the new Markdown for message `{}` — watch it edit "
                "itself smoothly.".format(target)))
            return
        self.api.send_rich(chat["id"], R.markdown_message(
            "✏️ **Usage:** reply to one of my rich messages with `/edit <new markdown>` "
            "— I'll re-type it live into the same message."))

    def cmd_stream(self, msg, args):
        self.start_stream_demo(msg["chat"]["id"])

    # ============================================================= callbacks

    def on_callback(self, cbq):
        data = cbq.get("data") or ""
        try:
            self._on_callback(cbq, data)
        except TelegramError as exc:
            log.error("callback failed: %s", exc)
            try:
                self.api.answer_cbq(cbq["id"], text="⚠️ " + str(exc)[:180], show_alert=True)
            except Exception:
                pass
        except Exception:
            log.error("callback crashed\n%s", traceback.format_exc())

    def _on_callback(self, cbq, data):
        parts = data.split(":")
        action = parts[1] if len(parts) > 1 else ""
        msg = cbq.get("message") or {}
        chat = msg.get("chat") or {}
        chat_id = chat.get("id")
        user = cbq.get("from") or {}
        uid = user.get("id")

        if action == "demo":
            self.api.answer_cbq(cbq["id"])
            self.cmd_demo({"chat": chat, "from": user}, "")
            return
        if action == "post":
            self.api.answer_cbq(cbq["id"])
            if self.ensure_admin(cbq.get("message") or {}, user=user):
                self.cmd_post({"chat": chat, "from": user}, "")
            return
        if action == "stream":
            self.api.answer_cbq(cbq["id"])
            if chat_id:
                self.start_stream_demo(chat_id)
            return
        if action == "secret":
            self.demo_ephemeral(cbq)
            return
        if action == "effect" and len(parts) > 2:
            emoji = parts[2]
            if chat.get("type") != "private":
                self.api.answer_cbq(
                    cbq["id"], text="🪄 Effects only animate in private chats", show_alert=True)
                return
            self.api.answer_cbq(cbq["id"], text="🪄 Watch the next message…")
            self.api.send_rich(
                chat_id, R.markdown_message("This message arrived with a {} effect.".format(emoji)),
                message_effect_id=content.EFFECTS.get(emoji))
            return
        if action == "noop":
            self.api.answer_cbq(cbq["id"])
            return

        # ---- composer callbacks (need an active composer) ----
        with self._lock:
            comp = self.composers.get(chat_id)
        if comp is None and action in ("pv", "done", "btns", "mode", "cancel", "pub",
                                       "sched", "save", "resume", "eff"):
            self.api.answer_cbq(cbq["id"], text="Composer expired — /post to start a new one",
                                show_alert=True)
            return
        if comp is None:
            self.api.answer_cbq(cbq["id"])
            return

        if action == "pv":
            self.api.answer_cbq(cbq["id"], text="👁 refreshing preview…")
            self.send_preview(comp, force=True)
        elif action == "done":
            self.api.answer_cbq(cbq["id"])
            self.cmd_done({"chat": chat, "from": user}, "")
        elif action == "btns":
            self.api.answer_cbq(cbq["id"])
            self.cmd_buttons({"chat": chat, "from": user}, "")
        elif action == "mode":
            comp["mode"] = "plain" if comp["mode"] == "rich" else "rich"
            self.api.answer_cbq(cbq["id"], text="mode: " + comp["mode"])
            self.update_panel(comp)
            self.refresh_preview(comp)
        elif action == "eff":
            cycle = [None, "🎉", "🔥", "❤️", "👍"]
            comp["effect"] = cycle[(cycle.index(comp["effect"]) + 1) % len(cycle)]
            self.api.answer_cbq(
                cbq["id"], text="effect: " + (comp["effect"] or "off") +
                " (private chats only)")
            self.update_panel(comp)
        elif action == "cancel":
            self.api.answer_cbq(cbq["id"], text="🚫 cancelled")
            with self._lock:
                self.composers.pop(chat_id, None)
            self.finish_panel(comp, "🚫 Composer closed.")
        elif action == "resume":
            self.api.answer_cbq(cbq["id"], text="✏️ keep typing!")
            self.set_panel_state(comp, "content")
            self.update_panel(comp)
        elif action == "save":
            did = self.store.add_draft(self.composer_title(comp),
                                       self.composer_markdown(comp), mode=comp["mode"],
                                       buttons=comp["buttons"], media=comp["media"])
            self.api.answer_cbq(cbq["id"], text="💾 saved")
            self.update_panel(comp, extra="💾 Saved draft `{}` — `/drafts` to reload.".format(did))
        elif action == "sched":
            self.api.answer_cbq(cbq["id"])
            comp["state"] = "await_time"
            self.update_panel(comp, extra=(
                "📅 **When?** Natural language works:\n`+90m` · `21:30` · "
                "`tomorrow 09:00` · `2026-12-25 10:00`"))
        elif action == "pub" and len(parts) > 2:
            self.api.answer_cbq(cbq["id"])
            target_kind = parts[2]
            if target_kind == "here":
                self.publish_to(comp, {"kind": "here", "chat_id": chat_id})
            elif target_kind == "chan":
                comp["state"] = "await_channel"
                self.update_panel(comp, extra=(
                    "📣 Send the channel `@username` (or numeric id) — "
                    "I must be an **admin** there."))
            elif target_kind == "all":
                self.broadcast(comp)
        elif action == "pin" and comp.get("published"):
            self.api.answer_cbq(cbq["id"], text="📌 pinning…")
            try:
                self.api.call("pinChatMessage", chat_id=comp["published"]["chat_id"],
                              message_id=comp["published"]["message_id"],
                              disable_notification=True)
            except TelegramError as exc:
                self.api.answer_cbq(cbq["id"], text="⚠️ " + str(exc)[:160], show_alert=True)
        elif action == "react" and comp.get("published"):
            self.api.answer_cbq(cbq["id"], text="🔥")
            try:
                self.api.react(comp["published"]["chat_id"],
                               comp["published"]["message_id"], "🔥")
            except TelegramError:
                pass
        elif action == "draft" and len(parts) > 3:
            sub, did = parts[2], parts[3]
            self.api.answer_cbq(cbq["id"])
            if sub == "load":
                d = self.store.draft(did)
                if d:
                    comp = self._new_composer(chat_id)
                    comp["parts"] = [d["markdown"]]
                    comp["media"] = d.get("media") or []
                    comp["buttons"] = d.get("buttons") or []
                    comp["mode"] = d.get("mode", "rich")
                    with self._lock:
                        self.composers[chat_id] = comp
                    self.cmd_post({"chat": chat, "from": user}, "")
            elif sub == "del":
                self.store.del_draft(did)
                self.api.send_rich(chat_id, R.markdown_message("🗑 Draft `{}` deleted.".format(did)))
        elif action == "scheddel" and len(parts) > 2:
            self.store.del_scheduled(parts[2])
            self.api.answer_cbq(cbq["id"], text="🗑 cancelled")
            self.api.call("deleteMessage", chat_id=chat_id, message_id=msg.get("message_id"))
        else:
            self.api.answer_cbq(cbq["id"])

    def on_generation_stopped(self, gen):
        """User pressed ⏹ on a streaming draft (Bot API 10.3 update)."""
        chat = (gen or {}).get("chat") or {}
        cid = chat.get("id")
        stream = self.streams.get(cid)
        if stream:
            stream.abort(keep=True)

    # ============================================================ demo bits

    def demo_ephemeral(self, cbq):
        msg = cbq.get("message") or {}
        chat = msg.get("chat") or {}
        uid = (cbq.get("from") or {}).get("id")
        secret = R.markdown_message(
            "👀 **Ephemeral message** — nobody else in this chat can see it.\n\n"
            "Sent with `ephemeral_message_parameters` (Bot API 10.2/10.3): "
            "group replies that whisper to one user. Free, of course.")
        try:
            self.api.send_ephemeral_rich(
                chat.get("id"), uid, secret,
                callback_query_id=cbq["id"], replace_callback_query_message=False)
            self.api.answer_cbq(cbq["id"], text="👀 sent — for your eyes only")
        except TelegramError:
            self.api.answer_cbq(
                cbq["id"], text="Ephemeral delivery works in groups — in private "
                "chats everyone is already alone 🙂", show_alert=True)

    def start_stream_demo(self, chat_id):
        def worker():
            try:
                self._stream_demo(chat_id)
            except Exception:
                log.error("stream demo crashed\n%s", traceback.format_exc())

        threading.Thread(target=worker, daemon=True).start()

    def _stream_demo(self, chat_id):
        stream = SmoothStream(self.api, chat_id,
                              draft_id=int(time.time() * 1000) % 2147483647,
                              private=True)
        self.streams[chat_id] = stream
        try:
            stream.begin(thinking_text="🧠 Composing something smooth…")
            words = content.STREAM_TEXT.split(" ")
            buf = []
            for i in range(0, len(words), 3):
                if stream.aborted:
                    break
                buf.extend(words[i:i + 3])
                stream.update(R.markdown_message(" ".join(buf) + " ▌"))
                time.sleep(0.35)
            final = " ".join(buf) if stream.aborted else content.STREAM_TEXT
            if stream.aborted:
                final += "\n\n⏹ stopped early — still smooth, right?"
            stream.abort(keep=True)
            stream.finalize(R.markdown_message(final))
        finally:
            self.streams.pop(chat_id, None)

    def typewriter_edit(self, chat_id, message_id, markdown):
        def worker():
            editor = SmoothEditor(self.api, chat_id, message_id, min_interval=1.0)
            words = markdown.split(" ")
            buf = []
            for i in range(0, len(words), 4):
                buf.extend(words[i:i + 4])
                editor.update(rich_message=R.markdown_message(" ".join(buf) + " ▌"))
                time.sleep(0.45)
            editor.update(rich_message=R.markdown_message(markdown))
            editor.close()

        threading.Thread(target=worker, daemon=True).start()

    # =========================================================== publishing

    def composer_markdown(self, comp):
        return "\n\n".join(comp["parts"])

    def composer_title(self, comp):
        md = self.composer_markdown(comp)
        first = ""
        for line in md.splitlines():
            cleaned = line.strip().lstrip("#").strip()
            if cleaned:
                first = cleaned
                break
        return (first or "untitled")[:48]

    def build_irm(self, comp):
        if comp.get("mode") == "plain":
            return None
        media = [R.media_ref(m["id"], m["media"], m["kind"]) for m in comp.get("media", [])]
        return R.rich_message(markdown=self.composer_markdown(comp), media=media or None)

    def deliver_one(self, chat_id, comp, private=False):
        """Send the composed post to one chat; returns the sent Message."""
        markup = kb(comp["buttons"]) if comp.get("buttons") else None
        if comp.get("mode") == "plain":
            return self.api.send_text(
                chat_id, self.composer_markdown(comp),
                parse_mode="Markdown", reply_markup=markup)
        irm = self.build_irm(comp)
        problems = R.check_limits(irm)
        if problems:
            raise ValueError("; ".join(problems))
        kw = {}
        if private and comp.get("effect"):
            kw["message_effect_id"] = content.EFFECTS.get(comp["effect"])
        return self.api.send_rich(chat_id, irm, reply_markup=markup, **kw)

    def publish_to(self, comp, target):
        chat_id = comp["chat_id"]
        try:
            if target["kind"] == "all":
                self.broadcast(comp)
                return
            dest = target.get("chat_id", chat_id)
            is_private = isinstance(dest, int) and dest > 0
            res = self.deliver_one(dest, comp, private=is_private)
            self.store.bump(True)
            comp["published"] = {"chat_id": dest, "message_id": res.get("message_id")}
            comp["state"] = "published_panel"
            self.update_panel(
                comp,
                extra="✅ **Published** — message `{}` in `{}`.".format(
                    res.get("message_id"), dest),
                keyboard=self.published_kb())
        except (TelegramError, ValueError) as exc:
            self.store.bump(False)
            self.update_panel(comp, extra="❌ Publish failed: `{}`".format(str(exc)[:250]))

    def broadcast(self, comp):
        chat_id = comp["chat_id"]
        panel_msg = comp.get("panel_msg")

        def worker():
            chats = self.store.chats()
            editor = (SmoothEditor(self.api, chat_id, panel_msg, min_interval=1.0)
                      if panel_msg else None)
            ok = fail = 0
            for i, cid in enumerate(chats, 1):
                try:
                    self.deliver_one(int(cid), comp, private=False)
                    ok += 1
                    self.store.bump(True)
                except (TelegramError, ValueError) as exc:
                    fail += 1
                    self.store.bump(False)
                    log.warning("broadcast to %s failed: %s", cid, exc)
                if editor:
                    editor.update(
                        rich_message=R.markdown_message(
                            "📤 **Broadcasting** — {}/{} chats · ✅ {} · ❌ {}".format(
                                i, len(chats), ok, fail)))
                time.sleep(1.05)
            summary = "📤 **Broadcast finished** — ✅ {} delivered · ❌ {} failed.".format(ok, fail)
            if editor:
                editor.update(rich_message=R.markdown_message(summary),
                              reply_markup=self.published_kb())
                editor.close()
            comp["state"] = "published_panel"

        threading.Thread(target=worker, daemon=True).start()

    def deliver_scheduled(self, jid, job):
        """Entry point used by the scheduler thread."""
        comp = {
            "chat_id": (job.get("target") or {}).get("chat_id"),
            "parts": [job.get("markdown") or ""],
            "media": job.get("media") or [],
            "buttons": job.get("buttons") or [],
            "mode": job.get("mode", "rich"),
            "effect": None,
        }
        target = job.get("target") or {}
        if target.get("kind") == "all":
            chats = self.store.chats()
            ok = fail = 0
            for cid in chats:
                try:
                    self.deliver_one(int(cid), comp)
                    ok += 1
                    self.store.bump(True)
                except (TelegramError, ValueError) as exc:
                    fail += 1
                    log.warning("scheduled broadcast to %s failed: %s", cid, exc)
                time.sleep(1.05)
            self.notify_admins("📅 Scheduled broadcast `{}` done — ✅ {} ❌ {}".format(
                jid, ok, fail))
            return
        dest = target.get("chat_id")
        res = self.deliver_one(dest, comp)
        self.store.bump(True)
        self.notify_admins("📅 Scheduled post `{}` delivered ✓ (message `{}` in `{}`)".format(
            jid, res.get("message_id"), dest))

    def notify_admins(self, markdown):
        for uid in list(self.admins):
            try:
                self.api.send_rich(uid, R.markdown_message(markdown))
            except TelegramError as exc:
                log.warning("notify admin %s failed: %s", uid, exc)

    # ============================================================== panels

    def compose_kb(self, state):
        if state == "compose":
            return kb([
                [{"text": "👁 Preview", "callback_data": CB + ":pv", "style": "primary"},
                 {"text": "✅ Done", "callback_data": CB + ":done", "style": "success"}],
                [{"text": "🎨 Buttons", "callback_data": CB + ":btns"},
                 {"text": "💤 Mode: rich", "callback_data": CB + ":mode"}],
                [{"text": "🚫 Cancel", "callback_data": CB + ":cancel", "style": "danger"}],
            ])
        return kb([
            [{"text": "✅ Publish here", "callback_data": CB + ":pub:here", "style": "success"}],
            [{"text": "📣 To channel…", "callback_data": CB + ":pub:chan", "style": "primary"},
             {"text": "📤 Broadcast all", "callback_data": CB + ":pub:all", "style": "primary"}],
            [{"text": "📅 Schedule…", "callback_data": CB + ":sched"},
             {"text": "🪄 Effect: off", "callback_data": CB + ":eff"},
             {"text": "💾 Save draft", "callback_data": CB + ":save"}],
            [{"text": "✏️ Keep editing", "callback_data": CB + ":resume"},
             {"text": "🚫 Discard", "callback_data": CB + ":cancel", "style": "danger"}],
        ])

    def published_kb(self):
        return kb([
            [{"text": "📌 Pin it", "callback_data": CB + ":pin"},
             {"text": "🔥 React", "callback_data": CB + ":react"},
             {"text": "👍 Done", "callback_data": CB + ":noop", "style": "success"}],
        ])

    def set_panel_state(self, comp, state):
        comp["state"] = state if state != "published_panel" else comp["state"]
        if state == "content":
            comp["state"] = "content"

    def panel_md(self, comp, extra=None):
        parts = len(comp["parts"])
        chars = sum(len(p) for p in comp["parts"])
        media = len(comp.get("media", []))
        lines = ["🧵 **Composer** — {} part{} · {:,} chars · {} media · mode: `{}`".format(
            parts, "" if parts == 1 else "s", chars, media, comp["mode"])]
        if comp.get("buttons"):
            lines.append("🔘 {} button row(s) · 🪄 effect: {}".format(
                len(comp["buttons"]), comp.get("effect") or "off"))
        if comp["state"] == "await_buttons":
            lines.append("\n🔘 send button lines now (see above)")
        if extra:
            lines.append("\n" + extra)
        if comp["state"] in ("content", "await_buttons"):
            lines.append("\n<details><summary>✍️ format help</summary>\n\n{}\n</details>".format(
                content.composer_help_markdown()))
        return "\n".join(lines)

    def update_panel(self, comp, extra=None, keyboard=None):
        editor = comp.get("panel_editor")
        if editor is None:
            return
        kb_state = "compose" if comp["state"] in ("content", "await_buttons") else "publish"
        editor.update(
            rich_message=R.markdown_message(self.panel_md(comp, extra)),
            reply_markup=keyboard or self.compose_kb(kb_state))

    def finish_panel(self, comp, text):
        editor = comp.get("panel_editor")
        try:
            if editor is not None:
                editor.close()
                self.api.edit_rich(comp["chat_id"], comp["panel_msg"],
                                   R.markdown_message(text))
            elif comp.get("panel_msg"):
                self.api.edit_rich(comp["chat_id"], comp["panel_msg"],
                                   R.markdown_message(text))
        except TelegramError:
            pass
        if comp.get("preview_editor"):
            comp["preview_editor"].close()

    def send_preview(self, comp, force=False):
        chat_id = comp["chat_id"]
        if not comp["parts"] and not comp["media"]:
            self.update_panel(comp, extra="📭 Nothing to preview yet — send Markdown first.")
            return
        irm = self.build_irm(comp)
        if comp.get("mode") == "plain":
            if comp.get("preview_msg") and not force:
                self.api.call(
                    "editMessageText", chat_id=chat_id, message_id=comp["preview_msg"],
                    text=self.composer_markdown(comp), parse_mode="Markdown")
            else:
                m = self.api.send_text(chat_id, self.composer_markdown(comp),
                                       parse_mode="Markdown")
                comp["preview_msg"] = m["message_id"]
            return
        problems = R.check_limits(irm)
        if problems:
            self.update_panel(comp, extra="⚠️ " + " · ".join(problems))
            return
        if comp.get("preview_msg") and not force:
            if comp.get("preview_editor") is None:
                comp["preview_editor"] = SmoothEditor(self.api, chat_id, comp["preview_msg"],
                                                      min_interval=1.2)
            comp["preview_editor"].update(rich_message=irm)
        else:
            m = self.api.send_rich(chat_id, irm)
            comp["preview_msg"] = m["message_id"]
            comp["preview_editor"] = SmoothEditor(self.api, chat_id, m["message_id"],
                                                  min_interval=1.2)

    def refresh_preview(self, comp):
        if comp.get("preview_msg") and comp.get("preview_editor"):
            if comp.get("mode") == "plain":
                return
            comp["preview_editor"].update(rich_message=self.build_irm(comp))

    # =============================================================== admin

    def is_admin(self, uid):
        return uid is not None and uid in self.admins

    def ensure_admin(self, msg, user=None):
        user = user or msg.get("from") or {}
        uid = user.get("id")
        if self.is_admin(uid):
            return True
        # No admins configured yet: the first person to use /post in a
        # private chat claims ownership (self-hosting convenience).
        if not self.admins and msg.get("chat", {}).get("type") == "private":
            self.admins.append(uid)
            self.store.data.setdefault("admins", []).append(uid)
            self.store.save()
            self.api.send_rich(msg["chat"]["id"], R.markdown_message(
                "🔑 You're the first admin — claimed! Configure `APB_ADMINS` "
                "to hard-code admins instead."))
            return True
        chat_id = msg.get("chat", {}).get("id")
        note = "🔒 Admins only."
        if chat_id is not None:
            try:
                if msg.get("chat", {}).get("type") in ("group", "supergroup"):
                    self.api.send_ephemeral_rich(chat_id, uid, R.markdown_message(note))
                else:
                    self.api.send_text(chat_id, note)
            except TelegramError:
                try:
                    self.api.send_text(chat_id, note)
                except TelegramError:
                    pass
        return False
