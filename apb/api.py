"""apb.api — a tiny, dependency-free Telegram Bot API client.

Targets Bot API 10.3 (August 24, 2026).  Uses only the standard library so
the bot can call brand-new methods (``sendRichMessage``,
``sendRichMessageDraft``, ``editEphemeralMessage*``, …) long before
third-party frameworks support them.

JSON conventions
----------------
When a request is posted as ``application/json`` (the default here), every
parameter the official docs call "A JSON-serialized object" can be passed as
a real nested dict/list — Telegram's server accepts that.  For
``multipart/form-data`` uploads the same fields are ``json.dumps``-ed into
strings automatically.
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
import uuid

log = logging.getLogger(__name__)


class TelegramError(RuntimeError):
    """An error returned by (or while talking to) the Bot API server."""

    def __init__(self, method, description, error_code, params=None):
        super().__init__("{} failed ({}): {}".format(method, error_code, description))
        self.method = method
        self.description = description or ""
        self.error_code = error_code
        self.params = params or {}

    @property
    def retry_after(self):
        return self.params.get("retry_after")

    def matches(self, *fragments):
        """Case-insensitive 'description contains fragment' test."""
        d = self.description.lower()
        return any(f.lower() in d for f in fragments)


class Telegram:
    """Very small Bot API wrapper with retries, 429 backoff and long polling."""

    def __init__(self, token, timeout=60, max_retries=3, base=None):
        self.token = token
        self.timeout = timeout
        self.max_retries = max_retries
        self.base = (base or "https://api.telegram.org").rstrip("/")
        self._offset = 0

    # ------------------------------------------------------------------ core

    def call(self, method, timeout=None, **params):
        """POST a JSON request; returns the ``result`` field."""
        payload = {k: v for k, v in params.items() if v is not None}
        body = json.dumps(payload).encode("utf-8")
        return self._request(method, body, "application/json", timeout or self.timeout)

    def call_multipart(self, method, files, **params):
        """POST multipart/form-data; ``files`` maps name -> (fname, bytes, ctype).

        Needed when a rich message embeds uploads referenced with
        ``attach://<name>`` inside ``InputRichMessage.media``.
        """
        boundary = "----apb" + uuid.uuid4().hex
        chunks = []
        for key, value in params.items():
            if value is None:
                continue
            if isinstance(value, (dict, list)):
                value = json.dumps(value)
            chunks.append(
                ("--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n").format(
                    b=boundary, k=key, v=value
                ).encode("utf-8")
            )
        for name, (fname, blob, ctype) in files.items():
            chunks.append(
                (
                    "--{b}\r\nContent-Disposition: form-data; name=\"{n}\"; filename=\"{f}\"\r\n"
                    "Content-Type: {t}\r\n\r\n"
                ).format(b=boundary, n=name, f=fname, t=ctype or "application/octet-stream").encode("utf-8")
                + blob
                + b"\r\n"
            )
        chunks.append(("--{}--\r\n").format(boundary).encode("utf-8"))
        return self._request(
            method, b"".join(chunks), "multipart/form-data; boundary=" + boundary, self.timeout
        )

    def _request(self, method, body, content_type, timeout):
        url = "{}/bot{}/{}".format(self.base, self.token, method)
        attempt = 0
        while True:
            attempt += 1
            req = urllib.request.Request(
                url, data=body, headers={"Content-Type": content_type}, method="POST"
            )
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    raw = resp.read()
                data = json.loads(raw.decode("utf-8"))
            except urllib.error.HTTPError as exc:
                raw = exc.read().decode("utf-8", "replace")
                try:
                    data = json.loads(raw)
                except ValueError:
                    data = {}
                desc = data.get("description") or raw[:300] or "HTTP {}".format(exc.code)
                code = data.get("error_code", exc.code)
                params = data.get("parameters") or {}
                if (code == 429 or code >= 500) and attempt <= self.max_retries:
                    delay = params["retry_after"] if params.get("retry_after") is not None else min(2 ** attempt, 15)
                    log.warning("%s: HTTP %s, retrying in %ss", method, code, delay)
                    time.sleep(delay)
                    continue
                raise TelegramError(method, desc, code, params)
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                if attempt <= self.max_retries:
                    delay = min(2 ** attempt, 15)
                    log.warning("%s: network error (%s), retrying in %ss", method, exc, delay)
                    time.sleep(delay)
                    continue
                raise TelegramError(method, str(exc), -1)
            if not data.get("ok"):
                raise TelegramError(
                    method,
                    data.get("description", "unknown error"),
                    data.get("error_code", -1),
                    data.get("parameters") or {},
                )
            return data.get("result")

    # ------------------------------------------------------------- polling

    def get_updates(self, timeout=25, limit=100, allowed_updates=None):
        """One long-poll call; remembers the update offset internally."""
        params = {"timeout": timeout, "limit": limit, "offset": self._offset or None}
        if allowed_updates:
            params["allowed_updates"] = allowed_updates
        updates = self.call("getUpdates", timeout=timeout + 20, **params)
        if updates:
            self._offset = updates[-1]["update_id"] + 1
        return updates

    def updates(self, poll_timeout=25, allowed_updates=None):
        """Infinite generator of updates (never raises)."""
        while True:
            try:
                for upd in self.get_updates(poll_timeout, allowed_updates=allowed_updates):
                    yield upd
            except TelegramError as exc:
                log.error("polling error: %s", exc)
                time.sleep(3)

    # ------------------------------------------------- Bot API 10.x sugar

    # Rich Messages (10.1) -------------------------------------------------

    def send_rich(self, chat_id, rich_message, **kw):
        """sendRichMessage — rich_message is an InputRichMessage dict."""
        return self.call("sendRichMessage", chat_id=chat_id, rich_message=rich_message, **kw)

    def send_rich_multipart(self, chat_id, rich_message, files, **kw):
        """sendRichMessage with file uploads (``attach://<name>`` media)."""
        return self.call_multipart(
            "sendRichMessage", files, chat_id=chat_id, rich_message=rich_message, **kw)

    def download_file(self, file_id):
        """getFile + download -> raw bytes (used for watermarking photos)."""
        info = self.call("getFile", file_id=file_id)
        path = info.get("file_path")
        if not path:
            raise TelegramError("getFile", "no file_path returned", -1)
        url = "{}/file/bot{}/{}".format(self.base, self.token, path)
        last_exc = None
        for _ in range(self.max_retries + 1):
            try:
                with urllib.request.urlopen(url, timeout=self.timeout) as resp:
                    return resp.read()
            except (urllib.error.URLError, OSError) as exc:
                last_exc = exc
                time.sleep(1)
        raise TelegramError("download", str(last_exc), -1)

    def edit_rich(self, chat_id, message_id, rich_message, **kw):
        """editMessageText with rich_message (text/rich_message are exclusive)."""
        return self.call(
            "editMessageText", chat_id=chat_id, message_id=message_id, rich_message=rich_message, **kw
        )

    def send_draft(self, chat_id, draft_id, rich_message, can_stop=None, keep_on_stop=None):
        """sendRichMessageDraft — animated streaming preview (private chats).

        The draft lives ~30s as a preview and must be finalized with a
        regular ``send_rich`` call.  Repeated calls with the same
        ``draft_id`` animate the change instead of flashing.
        """
        return self.call(
            "sendRichMessageDraft",
            chat_id=chat_id,
            draft_id=draft_id,
            rich_message=rich_message,
            can_stop=can_stop,
            keep_on_stop=keep_on_stop,
        )

    # Ephemeral messages (10.2, reshaped in 10.3) ---------------------------

    def send_ephemeral_rich(
        self,
        chat_id,
        receiver_user_id,
        rich_message,
        callback_query_id=None,
        replace_callback_query_message=None,
        **kw
    ):
        """Send a rich message only ``receiver_user_id`` can see (groups)."""
        ephemeral = {"receiver_user_id": receiver_user_id}
        if callback_query_id is not None:
            ephemeral["callback_query_id"] = callback_query_id
        if replace_callback_query_message is not None:
            ephemeral["replace_callback_query_message"] = replace_callback_query_message
        kw.pop("ephemeral_message_parameters", None)
        return self.call(
            "sendRichMessage",
            chat_id=chat_id,
            rich_message=rich_message,
            ephemeral_message_parameters=ephemeral,
            **kw
        )

    def edit_ephemeral_rich(self, receiver_user_id, ephemeral_message_id, rich_message, **kw):
        return self.call(
            "editEphemeralMessageText",
            receiver_user_id=receiver_user_id,
            ephemeral_message_id=ephemeral_message_id,
            rich_message=rich_message,
            **kw
        )

    def delete_ephemeral(self, chat_id, receiver_user_id, ephemeral_message_id):
        return self.call(
            "deleteEphemeralMessage",
            chat_id=chat_id,
            receiver_user_id=receiver_user_id,
            ephemeral_message_id=ephemeral_message_id,
        )

    # Classic helpers --------------------------------------------------------

    def send_text(self, chat_id, text, **kw):
        return self.call("sendMessage", chat_id=chat_id, text=text, **kw)

    def answer_cbq(self, callback_query_id, text=None, show_alert=None):
        return self.call(
            "answerCallbackQuery",
            callback_query_id=callback_query_id,
            text=text,
            show_alert=show_alert,
        )

    def react(self, chat_id, message_id, emoji):
        """setMessageReaction with a single emoji (free, any chat type)."""
        return self.call(
            "setMessageReaction",
            chat_id=chat_id,
            message_id=message_id,
            reaction=[{"type": "emoji", "emoji": emoji}],
        )
