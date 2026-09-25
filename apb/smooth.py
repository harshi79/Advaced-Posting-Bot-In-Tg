"""apb.smooth — buttery-smooth message editing & live streaming.

Two mechanisms, both free:

* :class:`SmoothEditor` — debounced ``editMessageText`` with
  ``rich_message``.  Rapid updates are coalesced into at most one edit per
  interval (default ~1.1s — Telegram's practical edit cadence), identical
  payloads are skipped, 429s are retried after ``retry_after``.  Result:
  flicker-free live updates in groups/channels/private chats.

* :class:`SmoothStream` — AI-style live typing via ``sendRichMessageDraft``
  (Bot API 10.1).  The draft preview is ANIMATED by Telegram itself when
  updated with the same ``draft_id`` — no flashing, real streaming.
  Optional ``thinking`` block (10.1, draft-only) shows a shimmering
  "Thinking…" placeholder first.  Private chats only; falls back to a
  :class:`SmoothEditor` elsewhere.
"""

from __future__ import annotations

import json
import logging
import threading
import time

from .api import TelegramError

log = logging.getLogger(__name__)


class _Debouncer:
    """Run ``fn`` at most once per ``interval``; always flush the last call."""

    def __init__(self, interval, fn):
        self.interval = max(0.05, interval)
        self._fn = fn
        self._lock = threading.Lock()
        self._pending = False
        self._last = 0.0
        self._timer = None
        self._closed = False

    def call(self):
        with self._lock:
            if self._closed:
                return
            self._pending = True
            now = time.time()
            wait = self._last + self.interval - now
        if wait <= 0:
            self._run()
        else:
            self._schedule(wait)

    def _schedule(self, wait):
        with self._lock:
            if self._timer is not None or self._closed:
                return
            self._timer = threading.Timer(wait, self._run)
            self._timer.daemon = True
            self._timer.start()

    def _run(self):
        with self._lock:
            self._timer = None
            if self._closed:
                return
            if not self._pending:
                return
            self._pending = False
        try:
            self._fn()
        except Exception as exc:  # never kill the timer thread
            log.debug("debounced fn error: %s", exc)
        with self._lock:
            self._last = time.time()

    def flush(self, timeout=5.0):
        """Force the pending call through immediately (waits for completion)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                if not self._pending and self._timer is None:
                    return True
            if not self._pending:
                with self._lock:
                    if not self._pending:
                        return True
            time.sleep(0.02)
        return False

    def close(self):
        with self._lock:
            self._closed = True
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None


class SmoothEditor:
    """Live editor for one already-sent message.

    ``update()`` as often as you like (every keystroke, every stream
    chunk…) — the message on screen changes at a steady, flicker-free pace.
    """

    def __init__(self, api, chat_id, message_id, min_interval=1.1, parse_mode=None):
        self.api = api
        self.chat_id = chat_id
        self.message_id = message_id
        self.parse_mode = parse_mode
        self.last_payload = None
        self.last_error = None
        self._payload = None
        self._payload_lock = threading.Lock()
        self._debounce = _Debouncer(min_interval, self._flush)

    # ------------------------------------------------------------- public

    def update(self, rich_message=None, text=None, reply_markup=None):
        """Queue a new state; exactly one of rich_message / text."""
        with self._payload_lock:
            self._payload = {
                "rich_message": rich_message,
                "text": text,
                "reply_markup": reply_markup,
            }
        self._debounce.call()

    def flush(self, timeout=5.0):
        """Wait until any pending debounced edit has been sent."""
        return self._debounce.flush(timeout=timeout)

    def close(self):
        self._debounce.flush()
        self._debounce.close()

    # ------------------------------------------------------------ private

    def _flush(self):
        with self._payload_lock:
            payload = self._payload
            self._payload = None
        if payload is None:
            return
        signature = json.dumps(payload, sort_keys=True, default=str)
        if signature == self.last_payload:
            return
        try:
            if payload.get("rich_message") is not None:
                self.api.edit_rich(
                    self.chat_id,
                    self.message_id,
                    payload["rich_message"],
                    reply_markup=payload.get("reply_markup"),
                )
            else:
                kw = {}
                if self.parse_mode:
                    kw["parse_mode"] = self.parse_mode
                self.api.call(
                    "editMessageText",
                    chat_id=self.chat_id,
                    message_id=self.message_id,
                    text=payload.get("text") or "…",
                    reply_markup=payload.get("reply_markup"),
                    **kw
                )
            self.last_payload = signature
            self.last_error = None
        except TelegramError as exc:
            self.last_error = exc
            if exc.matches("message is not modified"):
                self.last_payload = signature
                return
            if exc.matches("message to edit not found", "message to edit not found",
                      "can't be edited", "MESSAGE_ID_INVALID"):
                log.debug("edit target gone: %s", exc)
                self._debounce.close()
                return
            if exc.error_code == 429:
                with self._payload_lock:
                    self._payload = payload
                ra = exc.retry_after if exc.retry_after is not None else 1
                self._debounce.interval = max(self._debounce.interval, ra + 0.5)
                self._debounce.call()
                return
            raise


class SmoothStream:
    """AI-style streaming reply.

    In private chats: ``sendRichMessageDraft`` with a stable ``draft_id``
    (Telegram animates the changes), an optional shimmering *thinking*
    block while content is being produced, then a final ``sendRichMessage``
    that persists the message.

    Anywhere else (groups/channels): sends a real message immediately and
    live-edits it through a :class:`SmoothEditor` — same smooth feel.
    """

    def __init__(self, api, chat_id, draft_id=None, private=True,
                 edit_interval=1.1, draft_interval=0.5):
        self.api = api
        self.chat_id = chat_id
        self.draft_id = draft_id or int(time.time() * 1000) % 2147483647
        self.private = private
        self.editor = None
        self.message = None
        self.aborted = False
        self._debounce = _Debouncer(
            draft_interval if private else edit_interval, self._flush
        )
        self._current = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------- public

    def begin(self, thinking_text=None, rich=None):
        """Show the streaming placeholder (thinking block or first content)."""
        if self.aborted:
            return
        if self.private:
            blocks = []
            if thinking_text:
                blocks.append({"type": "thinking", "text": thinking_text})
            if rich is not None:
                blocks += _blocks_of(rich)
            try:
                self.api.send_draft(
                    self.chat_id, self.draft_id,
                    {"blocks": blocks} if blocks else {"markdown": "…"},
                    can_stop=True, keep_on_stop=True,
                )
                return
            except TelegramError as exc:
                log.debug("draft failed (%s); falling back to edits", exc)
                self.private = False
        if rich is None:
            rich = {"markdown": "_" + (thinking_text or "Thinking…") + "_"}
        self.message = self._send(rich)
        if self.message:
            self.editor = SmoothEditor(self.api, self.chat_id,
                                       self.message.get("message_id"))

    def update(self, rich):
        """Stream new (partial) content; same draft_id => animated change."""
        if self.aborted:
            return
        with self._lock:
            self._current = rich
        if self.private:
            self._debounce.call()
        elif self.editor is not None:
            self.editor.update(rich_message=rich)

    def finalize(self, rich, **send_kwargs):
        """Persist the full message; returns the sent Message (or None)."""
        self._debounce.flush(timeout=3)
        self._debounce.close()
        if self.aborted and not getattr(self, "_keep_on_stop", False):
            return None
        msg = self._send(rich, **send_kwargs)
        if msg:
            self.message = msg
        if self.editor:
            self.editor.close()
        return msg

    def abort(self, keep=False):
        """Stop streaming.  ``keep=True`` lets a later finalize() still
        persist what has been streamed so far (draft had keep_on_stop)."""
        self.aborted = True
        self._keep_on_stop = keep
        self._debounce.close()
        if self.editor and not keep:
            self.editor.close()

    # ------------------------------------------------------------ private

    def _send(self, rich, **kw):
        try:
            return self.api.send_rich(self.chat_id, rich, **kw)
        except TelegramError as exc:
            if exc.error_code == 429 and exc.retry_after:
                time.sleep(exc.retry_after + 0.2)
                return self.api.send_rich(self.chat_id, rich, **kw)
            raise

    def _flush(self):
        with self._lock:
            rich = self._current
        if rich is None:
            return
        try:
            self.api.send_draft(self.chat_id, self.draft_id, rich,
                                can_stop=True, keep_on_stop=True)
        except TelegramError as exc:
            if exc.matches("message to edit not found", "MESSAGE_ID_INVALID"):
                return
            if exc.error_code == 429:
                ra = exc.retry_after if exc.retry_after is not None else 1
                self._debounce.interval = max(self._debounce.interval, ra + 0.5)
                with self._lock:
                    self._current = rich
                self._debounce.call()
            else:
                log.debug("draft update failed: %s", exc)


def _blocks_of(rich):
    if isinstance(rich, dict) and isinstance(rich.get("blocks"), list):
        return list(rich["blocks"])
    return []


def stream_words(api, chat_id, text, draft_id=None, private=True,
                 words_per_step=2, step_delay=0.35, thinking_text=None,
                 on_done=None, **send_kwargs):
    """Convenience typewriter: stream ``text`` word-by-word, then finalize.

    Returns the final Message.  This is the demo-friendly path; bots that
    generate content chunk-by-chunk should call SmoothStream directly.
    """
    stream = SmoothStream(api, chat_id, draft_id=draft_id, private=private)
    stream.begin(thinking_text=thinking_text or "Thinking…")
    words = text.split(" ")
    buf = []
    for i in range(0, len(words), words_per_step):
        if stream.aborted:
            return None
        buf.extend(words[i:i + words_per_step])
        stream.update({"markdown": " ".join(buf) + " ▌"})
        time.sleep(step_delay)
    return stream.finalize({"markdown": text}, **send_kwargs)
