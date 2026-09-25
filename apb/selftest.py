"""apb.selftest — offline sanity checks (no network, no bot token).

Run with:  python bot.py --selftest
"""

from __future__ import annotations

import datetime
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.error

from . import rich as R
from .api import Telegram, TelegramError
from .smooth import SmoothEditor
from .store import Store
from .utils import parse_button_rows, parse_when

PASS, FAIL = [], []


# ------------------------------------------------------- test infrastructure
class _TolerantTempDir(tempfile.TemporaryDirectory):
    """TemporaryDirectory that survives a daemon thread's late write.

    Publishing fan-out workers, ``SmoothEditor`` timers and stream demos are
    daemon threads (``apb/handlers.py``, ``apb/posto.py``, ``apb/smooth.py``).
    One of them can call ``store.save()`` — which ``mkstemp()``s a ``.tmp``
    file in the data dir — a hair *after* the ``with`` block exits. ``rmtree``
    then dies with ``OSError: [Errno 39] Directory not empty`` on an otherwise
    green run. Leftover files in /tmp are harmless; a red selftest is not.
    """

    def cleanup(self, *args, **kwargs):
        try:
            super().cleanup(*args, **kwargs)
        except OSError:
            shutil.rmtree(self.name, ignore_errors=True)


def tmpdir():
    """Version-proof temp dir whose cleanup never raises (Python 3.9 → 3.13)."""
    try:                                    # 3.10+ has the flag built in
        return tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    except TypeError:                       # 3.9 → our tolerant subclass
        return _TolerantTempDir()


def quiesce(budget=20.0, per_thread=2.0):
    """Join leftover daemon threads.

    Without this, a worker that is still logging when the interpreter starts
    finalizing aborts the whole process::

        Fatal Python error: _enter_buffered_busy: could not acquire lock for
        <_io.BufferedWriter name='<stderr>'> at interpreter shutdown,
        possibly due to daemon threads

    which surfaces as a selftest that passes every check and then dies with
    exit code 134. Returns the names of threads that outlived the budget.
    """
    deadline = time.time() + budget
    while True:
        live = [t for t in threading.enumerate()
                if t is not threading.current_thread() and t.is_alive()]
        if not live:
            return []
        if time.time() >= deadline:
            return [t.name for t in live]
        for t in live:
            t.join(max(0.0, min(per_thread, deadline - time.time())))


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print("  ✓ {}".format(name))
    else:
        FAIL.append(name)
        print("  ✗ {} {}".format(name, detail))


# ---------------------------------------------------------------- tests

def test_richtext():
    b = R.bold("hi")
    check("bold shape", b == {"type": "bold", "text": "hi"}, b)
    check("spoiler shape", R.spoiler("x") == {"type": "spoiler", "text": "x"})
    check("link shape", R.link("t", "https://a") ==
          {"type": "url", "text": "t", "url": "https://a"})
    check("anchor link empty name", R.anchor_link("top") ==
          {"type": "anchor_link", "text": "top", "anchor_name": ""})
    check("richtext arrays allowed", R.italic(["a", R.bold("b")]) ==
          {"type": "italic", "text": ["a", {"type": "bold", "text": "b"}]})


def test_blocks():
    h = R.heading("T", 9)
    check("heading clamps size", h["size"] == 6 and h["type"] == "heading", h)

    t = R.table([["a", "b"], ["c", "d"]], aligns=["left", "center"])
    check("table shape", t["type"] == "table" and t["cells"][0][0]["is_header"] is True)
    check("table cells require align/valign",
          t["cells"][1][1]["align"] == "center" and t["cells"][1][0]["valign"] == "top")

    li = R.list_item("task", checkbox=True, checked=True)
    check("list item checkbox", li["has_checkbox"] is True and li["is_checked"] is True
          and li["blocks"][0]["type"] == "paragraph")

    d = R.details("sum", ["body"])
    check("details shape", d["type"] == "details" and d["summary"] == "sum"
          and d["blocks"][0]["text"] == "body" and d["is_open"] is False)

    btn = R.rbutton("Go", callback_data="x:y")
    check("rbutton shape", btn == {"text": "Go", "callback_data": "x:y"}, btn)
    try:
        R.rbutton("Bad", url="https://a", callback_data="z")
        check("rbutton rejects two actions", False)
    except ValueError:
        check("rbutton rejects two actions", True)
    try:
        R.rbutton("Bad", callback_data="x" * 65)
        check("rbutton enforces 64-byte data", False)
    except ValueError:
        check("rbutton enforces 64-byte data", True)

    row = R.buttons_row([R.rbutton("a", callback_data="a"),
                         R.rbutton("b", callback_data="b")], align="right")
    check("buttons row shape", row["type"] == "buttons" and row["align"] == "right"
          and len(row["buttons"]) == 2)

    th = R.thinking()
    check("thinking block", th == {"type": "thinking", "text": "Thinking…"})

    m = R.media_ref("m1", "FILE123", "photo")
    check("media_ref shape", m == {"id": "m1", "media": {"type": "photo", "media": "FILE123"}}, m)
    try:
        R.media_ref("bad slot!", "x", "photo")
        check("media_ref validates slot", False)
    except ValueError:
        check("media_ref validates slot", True)

    p = R.photo_block("https://x/y.jpg", caption="cap", credit="me", spoiler=True)
    check("photo block", p["photo"]["media"] == "https://x/y.jpg" and p["has_spoiler"]
          and p["caption"]["credit"] == "me")

    check("map clamps zoom", R.map_block(1, 2, zoom=99)["zoom"] == 24)


def test_rich_message():
    try:
        R.rich_message(markdown="a", html="b")
        check("irm rejects two modes", False)
    except ValueError:
        check("irm rejects two modes", True)
    irm = R.markdown_message("**hi**", media=[R.media_ref("m1", "F", "video")])
    check("irm markdown+media", irm == {"markdown": "**hi**",
                                        "media": [{"id": "m1", "media": {"type": "video", "media": "F"}}]}, irm)


def test_analysis():
    blocks = [
        R.heading("h", 2),
        R.bullet_list([R.list_item("a"), R.list_item([R.blockquote(["q"])])]),
        R.table([["1", "2"], ["3", "4"], ["5", "6"]]),
        R.details("s", ["x", "y"]),
    ]
    n = R.count_blocks(blocks)
    # 1 heading + (list 1 + 2 items + 3 nested blocks) + (table 1 + 3 rows)
    # + (details 1 + 2 paragraphs) = 14
    check("count_blocks", n == 14, "got {}".format(n))
    check("nesting_depth", R.nesting_depth(blocks) == 3, R.nesting_depth(blocks))
    text = R.plain_text(blocks)
    check("plain_text", "h" in text and "• a" in text and "1 | 2" in text, text)

    big = R.rich_message(markdown="x" * 40000)
    check("check_limits catches size", len(R.check_limits(big)) == 1, R.check_limits(big))
    ok = R.rich_message(blocks=blocks)
    check("check_limits ok", R.check_limits(ok) == [], R.check_limits(ok))
    check("strip_markdown", R.strip_markdown("**b** `c` [l](u)") == "b c l",
          R.strip_markdown("**b** `c` [l](u)"))


def test_parse_when():
    now = datetime.datetime(2026, 9, 25, 12, 0, 0)
    t = parse_when("+90m", now)
    check("+90m", t == (now + datetime.timedelta(minutes=90)).timestamp())
    t = parse_when("+2h", now)
    check("+2h", t == (now + datetime.timedelta(hours=2)).timestamp())
    t = parse_when("+1d12h", now)
    check("+1d12h", t == (now + datetime.timedelta(days=1, hours=12)).timestamp())
    t = parse_when("10:00", now)
    check("10:00 rolls to tomorrow", t == (now + datetime.timedelta(days=1)).replace(
        hour=10, minute=0, second=0).timestamp())
    t = parse_when("14:00", now)
    check("14:00 today", t == now.replace(hour=14, minute=0, second=0).timestamp())
    t = parse_when("tomorrow 09:30", now)
    check("tomorrow 09:30", t == (now + datetime.timedelta(days=1)).replace(
        hour=9, minute=30, second=0).timestamp())
    t = parse_when("2026-12-25 10:00", now)
    check("absolute date", t == datetime.datetime(2026, 12, 25, 10, 0).timestamp())
    check("garbage -> None", parse_when("next tuesday maybe", now) is None)
    check("past date -> None", parse_when("2020-01-01 10:00", now) is None)


def test_parse_buttons():
    rows, errs = parse_button_rows(
        "Read | https://a.example | primary\n"
        "👍 Like | cb:like ;; Share | cb:share | success\n"
        "Delete | cb:del | danger\n")
    check("buttons parse rows", len(rows) == 3 and len(rows[1]) == 2, rows)
    check("buttons parse fields", rows[0][0]["url"] == "https://a.example"
          and rows[0][0]["style"] == "primary" and rows[1][1]["callback_data"] == "share")
    check("buttons no errors", errs == [], errs)
    rows2, errs2 = parse_button_rows("Bad line\nX | ftp://nope\nY | cb:ok | purple")
    check("buttons bad rows rejected", rows2 == [[{"text": "Y", "callback_data": "ok"}]], rows2)
    check("buttons errors reported", len(errs2) == 3, errs2)


class FakeAPI:
    def __init__(self, fail_first_with=None):
        self.edits = []
        self.sends = []
        self._fail = fail_first_with

    def edit_rich(self, chat_id, message_id, rich_message, **kw):
        if self._fail is not None:
            exc = self._fail
            self._fail = None
            raise exc
        self.edits.append((chat_id, message_id, rich_message, kw))

    def send_rich(self, chat_id, rich_message, **kw):
        self.sends.append((chat_id, rich_message, kw))
        return {"message_id": len(self.sends), "chat": {"id": chat_id}}

    def call(self, method, **kw):
        return {"message_id": 999, "chat": {"id": kw.get("chat_id")}}


def test_smooth_editor():
    api = FakeAPI()
    ed = SmoothEditor(api, 1, 2, min_interval=0.12)
    for i in range(12):  # hammer it
        ed.update(rich_message=R.markdown_message("v{}".format(i)))
        time.sleep(0.03)
    ed.close()
    check("smooth editor coalesces", 2 <= len(api.edits) <= 5,
          "edits={} (want 2..5)".format(len(api.edits)))
    last = api.edits[-1][2]
    check("smooth editor final state", last["markdown"] == "v11", last)

    # 429 handling: first edit hits a rate limit, editor retries later
    api2 = FakeAPI(fail_first_with=TelegramError(
        "editMessageText", "Too Many Requests: retry after 0", 429, {"retry_after": 0}))
    ed2 = SmoothEditor(api2, 1, 2, min_interval=0.05)
    ed2.update(rich_message=R.markdown_message("x"))
    ok = ed2.flush(timeout=3)
    check("smooth editor survives 429", ok and len(api2.edits) == 1,
          "flush={} edits={}".format(ok, len(api2.edits)))

    # identical payload skip
    api3 = FakeAPI()
    ed3 = SmoothEditor(api3, 1, 2, min_interval=0.05)
    ed3.update(rich_message=R.markdown_message("same"))
    ed3.flush(timeout=3)
    ed3.update(rich_message=R.markdown_message("same"))
    ed3.flush(timeout=3)
    ed3.close()
    check("smooth editor skips no-ops", len(api3.edits) == 1, len(api3.edits))


def test_api_payload():
    """Telegram.call must drop Nones and JSON-encode the body."""
    captured = {}

    class FakeResponse(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["body"] = json.loads(req.data.decode())
        captured["ct"] = req.headers.get("Content-type")
        return FakeResponse(b'{"ok": true, "result": {"message_id": 42}}')

    import urllib.request as urlreq
    orig = urlreq.urlopen
    urlreq.urlopen = fake_urlopen
    try:
        tg = Telegram("123:ABC")
        res = tg.send_rich(7, R.markdown_message("hi"), disable_notification=None)
        check("api returns result", res == {"message_id": 42}, res)
        check("api drops None params", "disable_notification" not in captured["body"])
        check("api nested rich_message", captured["body"]["rich_message"] == {"markdown": "hi"})
        check("api json content-type", captured["ct"] == "application/json")
        check("api url", captured["url"].endswith("/bot123:ABC/sendRichMessage"))
    finally:
        urlreq.urlopen = orig


def test_store():
    with tmpdir() as tmp:
        path = os.path.join(tmp, "sub", "apb.json")
        s = Store(path)
        s.chat_ensure(10, "Ann", "private")
        s.chat_ensure(-100, "chan", "channel")
        did = s.add_draft("Hello", "# Hello\nworld", buttons=[[{"text": "x", "callback_data": "y"}]])
        jid = s.add_scheduled(time.time() - 5, {"kind": "here", "chat_id": 10},
                              "# Later", note="Hello")
        s.bump(True)
        s2 = Store(path)  # reload from disk
        check("store roundtrip chats", len(s2.chats()) == 2)
        check("store roundtrip draft", s2.draft(did)["markdown"] == "# Hello\nworld")
        due = s2.due_scheduled()
        check("store due job", len(due) == 1 and due[0][1]["note"] == "Hello")
        s2.finish_scheduled(due[0][0], ok=True)
        check("store finish removes job", s2.due_scheduled() == [])
        check("store stats", s2.stats()["sent"] == 1)


def test_content():
    from . import content
    demo = R.rich_message(blocks=content.demo_blocks())
    check("demo blocks within limits", R.check_limits(demo) == [], R.check_limits(demo))
    n = R.count_blocks(demo["blocks"])
    check("demo blocks count sane", 20 <= n <= 100, n)
    check("demo has in-document buttons", any(
        b.get("type") == "buttons" for b in demo["blocks"]))
    check("demo has table", any(b.get("type") == "table" for b in demo["blocks"]))
    check("demo has details", any(b.get("type") == "details" for b in demo["blocks"]))
    check("demo has math", any(b.get("type") == "mathematical_expression" for b in demo["blocks"]))
    welcome = R.rich_message(blocks=content.welcome_blocks())
    check("welcome within limits", R.check_limits(welcome) == [])
    check("help markdown non-trivial", len(content.help_markdown()) > 500)
    check("stream text present", "smooth" in content.STREAM_TEXT)
    json.dumps(demo), json.dumps(welcome)  # must be serializable


class FlowAPI:
    """Records everything the bot would send to Telegram."""

    def __init__(self):
        self.sent = []
        self.next_id = 100

    def _msg(self, chat_id):
        self.next_id += 1
        return {"message_id": self.next_id, "chat": {"id": chat_id}}

    def _rec(self, item):
        json.dumps(item, default=str)  # everything must be JSON-serializable
        self.sent.append(item)

    def send_rich(self, chat_id, rich_message, **kw):
        self._rec(("sendRichMessage", chat_id, rich_message, kw))
        return self._msg(chat_id)

    def edit_rich(self, chat_id, message_id, rich_message, **kw):
        self._rec(("editMessageText", chat_id, message_id, rich_message, kw))
        return self._msg(chat_id)

    def send_text(self, chat_id, text, **kw):
        self._rec(("sendMessage", chat_id, text, kw))
        return self._msg(chat_id)

    def call(self, method, **kw):
        self._rec((method, kw))
        return self._msg(kw.get("chat_id", 0))

    def answer_cbq(self, cbq_id, text=None, show_alert=None):
        self._rec(("answerCallbackQuery", cbq_id, text))

    def react(self, chat_id, message_id, emoji):
        self._rec(("setMessageReaction", chat_id, message_id, emoji))

    def send_draft(self, chat_id, draft_id, rich_message, **kw):
        self._rec(("sendRichMessageDraft", chat_id, draft_id, rich_message, kw))
        return True

    def send_ephemeral_rich(self, chat_id, receiver_user_id, rich_message, **kw):
        self._rec(("ephemeral", chat_id, receiver_user_id, rich_message, kw))
        return {"message_id": 0, "ephemeral_message_id": 1}

    def send_rich_multipart(self, chat_id, rich_message, files, **kw):
        self._rec(("sendRichMessageMultipart", chat_id, rich_message, sorted(files), kw))
        return self._msg(chat_id)

    def download_file(self, file_id):
        self._rec(("downloadFile", file_id))
        return b"fakejpgbytes"


def test_composer_flow():
    from .handlers import Bot
    api = FlowAPI()
    with tmpdir() as tmp:
        store = Store(os.path.join(tmp, "apb.json"))
        bot = Bot(api, store, admins=[1])
        chat = {"id": 55, "type": "private"}
        user = {"id": 1, "is_bot": False}

        bot.dispatch({"message": {"chat": chat, "from": user, "text": "/post"}})
        comp = bot.composers.get(55)
        check("composer created", comp is not None and comp["state"] == "content")
        check("panel sent as rich", api.sent[0][0] == "sendRichMessage"
              and "markdown" in api.sent[0][2])

        bot.dispatch({"message": {"chat": chat, "from": user, "text": "# Big News\n\nHello **world**"}})
        bot.dispatch({"message": {"chat": chat, "from": user, "text": "Second paragraph with ||spoiler||"}})
        comp["panel_editor"].flush(timeout=3)
        panel_edits = [s for s in api.sent if s[0] == "editMessageText"]
        check("panel updated smoothly", len(panel_edits) >= 1)

        bot.dispatch({"message": {"chat": chat, "from": user, "text": "/done"}})
        previews = [s for s in api.sent
                    if s[0] == "sendRichMessage" and "Big News" in str(s[2])]
        check("preview rendered", len(previews) == 1)

        bot.dispatch({"callback_query": {
            "id": "cq1", "from": user, "data": "apb:pub:here",
            "message": {"chat": chat, "message_id": comp["panel_msg"],
                        "from": {"id": 999, "is_bot": True}}}})
        comp["panel_editor"].flush(timeout=3)
        pubs = [s for s in api.sent
                if s[0] == "sendRichMessage" and "Big News" in str(s[2])]
        check("published to chat", len(pubs) == 2, len(pubs))  # preview + real post
        check("callback answered", any(s[0] == "answerCallbackQuery" for s in api.sent))
        check("store counts delivery", store.stats()["sent"] == 1)
        check("composer marked published", comp.get("published") is not None)

        # schedule round-trip
        bot.dispatch({"message": {"chat": chat, "from": user, "text": "/post"}})
        comp2 = bot.composers[55]
        bot.dispatch({"message": {"chat": chat, "from": user, "text": "Scheduled hello"}})
        bot.dispatch({"callback_query": {
            "id": "cq2", "from": user, "data": "apb:sched",
            "message": {"chat": chat, "message_id": comp2["panel_msg"],
                        "from": {"id": 999, "is_bot": True}}}})
        t_before = time.time()
        bot.dispatch({"message": {"chat": chat, "from": user, "text": "+2h"}})
        check("repeat prompt shown", comp2["state"] == "await_repeat", comp2["state"])
        bot.dispatch({"message": {"chat": chat, "from": user, "text": "once"}})
        jobs = store.scheduled()
        check("schedule stored", len(jobs) == 1
              and jobs[0][1]["markdown"] == "Scheduled hello", jobs)
        check("schedule time sane", t_before + 7100 < jobs[0][1]["run_at"] < t_before + 7250,
              jobs[0][1]["run_at"] - t_before)
        # make it due, then run the scheduler delivery path
        jobs[0][1]["run_at"] = time.time() - 10
        store.save()
        job = store.due_scheduled()[0]
        bot.deliver_scheduled(job[0], job[1])
        check("scheduled job delivers", store.stats()["sent"] == 2)
        check("admin notified", any(
            s[0] == "sendRichMessage" and "delivered" in str(s[2]) for s in api.sent))


# ------------------------------------------------------------ Posto

class FakeAI:
    model = "nvidia/nemotron-3-super-120b-a12b"
    enabled = True

    def status_line(self):
        return "🤖 AI: test model"

    def stream(self, prompt, **kw):
        for w in ("Hello ", "**world** ", "from ", "NVIDIA"):
            yield w

    def complete(self, prompt, **kw):
        return "Hello **world** from NVIDIA"

    def write_post(self, p, tone=None, language=None):
        return p

    def rewrite_post(self, text, instruction=""):
        return text

    def translate_post(self, text, language):
        return text

    def shorten_post(self, text):
        return text

    def expand_post(self, text):
        return text


def wait_until(cond, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cond():
            return True
        time.sleep(0.05)
    return False


def test_mdblocks():
    from .mdblocks import md_to_blocks
    blocks = md_to_blocks("# Title\n\nHello **bold** and `code`\n\n- a\n- [x] done\n\n> quote")
    kinds = [b["type"] for b in blocks]
    check("mdblocks kinds", kinds == ["heading", "paragraph", "list", "blockquote"], kinds)
    check("mdblocks inline bold", blocks[1]["text"] == ["Hello ",
          {"type": "bold", "text": "bold"}, " and ",
          {"type": "code", "text": "code"}], blocks[1]["text"])
    check("mdblocks checklist", blocks[2]["items"][1]["is_checked"] is True)
    blocks2 = md_to_blocks("```python\nprint(1)\n```\n\n---\n\n1. one\n2. two")
    kinds2 = [b["type"] for b in blocks2]
    check("mdblocks pre/divider/ordered", kinds2 == ["pre", "divider", "list"], kinds2)
    check("mdblocks pre language", blocks2[0]["language"] == "python")
    blocks3 = md_to_blocks("| a | b |\n|:-:|-:|\n| 1 | 2 |")
    check("mdblocks table", blocks3[0]["type"] == "table"
          and blocks3[0]["cells"][0][0]["align"] == "center"
          and blocks3[0]["cells"][1][1]["align"] == "right", blocks3)


def test_nvidia_client():
    from .nvidia import NVIDIA, AIError

    captured = {}

    class FakeResp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["auth"] = req.headers.get("Authorization")
        captured["body"] = json.loads(req.data.decode())
        if captured.get("mode") == "401":
            import urllib.error
            raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized",
                                         {}, io.BytesIO(b'{"message": "bad key"}'))
        if captured.get("mode") == "stream":
            payload = (b'data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n'
                       b'data: {"choices":[{"delta":{"content":"there"}}]}\n\n'
                       b'data: [DONE]\n\n')
            return FakeResp(payload)
        return FakeResp(b'{"choices":[{"message":{"content":"full reply"}}]}')

    import urllib.request as urlreq
    orig = urlreq.urlopen
    urlreq.urlopen = fake_urlopen
    try:
        ai = NVIDIA(api_key="nvapi-test")
        check("nvidia default model", ai.model == "nvidia/nemotron-3-super-120b-a12b",
              ai.model)
        check("nvidia disabled without key", not NVIDIA().enabled)
        out = ai.complete("write about tea")
        check("nvidia complete", out == "full reply", out)
        check("nvidia auth header", captured["auth"] == "Bearer nvapi-test")
        check("nvidia payload model", captured["body"]["model"] == ai.model)
        check("nvidia endpoint", captured["url"].endswith("/v1/chat/completions"))
        captured["mode"] = "stream"
        chunks = list(ai.stream("write about tea"))
        check("nvidia sse stream", chunks == ["Hi ", "there"], chunks)
        captured["mode"] = "401"
        try:
            ai.complete("x")
            check("nvidia 401 friendly", False)
        except AIError as exc:
            check("nvidia 401 friendly", "key" in str(exc).lower(), str(exc))
    finally:
        urlreq.urlopen = orig


def test_store_posto():
    with tmpdir() as tmp:
        s = Store(os.path.join(tmp, "apb.json"))
        check("settings default", s.setting("turbo") is False)
        s.set_setting("turbo", True)
        s.add_channel(-100123, "News", signature="@news", delay=5)
        tid = s.add_template("Daily", "# Daily", buttons=[[{"text": "x",
                                                            "callback_data": "y"}]])
        s2 = Store(os.path.join(tmp, "apb.json"))
        check("settings roundtrip", s2.setting("turbo") is True)
        check("channel roundtrip", s2.channel(-100123)["signature"] == "@news"
              and s2.channel(-100123)["delay"] == 5)
        check("template roundtrip", s2.template(tid)["name"] == "Daily")
        s2.del_channel(-100123)
        check("channel delete", s2.channels() == {})

        # recurring math
        now = time.time()
        jid = s2.add_scheduled(now - 10, {"kind": "here", "chat_id": 1}, "x",
                               repeat="daily")
        job = s2.scheduled()[0][1]
        check("repeat_interval daily", s2.repeat_interval(job) == 86400)
        check("reschedule advances", s2.reschedule_recurring(jid, now=now) is True)
        job = s2.scheduled()[0][1]
        check("rescheduled future", now < job["run_at"] <= now + 86400 + 1)
        check("rescheduled pending", job["status"] == "pending")
        jid2 = s2.add_scheduled(now, {"kind": "here", "chat_id": 1}, "y",
                                repeat="every:3600")
        job2 = [j for jid, j in s2.scheduled() if jid == jid2][0]
        check("repeat_interval custom", s2.repeat_interval(job2) == 3600,
              job2.get("repeat"))


def test_scheduler_recurring():
    from .handlers import Bot
    api = FlowAPI()
    with tmpdir() as tmp:
        store = Store(os.path.join(tmp, "apb.json"))
        bot = Bot(api, store, admins=[1], ai=FakeAI())
        now = time.time()
        jid = store.add_scheduled(now - 5, {"kind": "here", "chat_id": 55},
                                  "rec post", repeat="hourly")
        jid2 = store.add_scheduled(now - 5, {"kind": "channels"}, "chan post",
                                   repeat="none")
        store.add_channel(-100, "Chan A", signature="@a")
        store.add_channel(-200, "Chan B")
        for j, job in store.due_scheduled():
            bot.deliver_scheduled(j, job)
            if not store.reschedule_recurring(j):
                store.finish_scheduled(j, ok=True)
        remaining = dict(store.scheduled())
        check("recurring job survives", jid in remaining, list(remaining))
        check("recurring rescheduled", remaining[jid]["run_at"] > now)
        check("one-shot removed", jid2 not in remaining)
        chans = [x for x in api.sent if x[0] == "sendRichMessage"
                 and "chan post" in str(x[2])]
        check("channels fan-out", len(chans) == 2, len(chans))
        sig = [x for x in api.sent if "@a" in str(x[2])]
        check("channel signature applied", len(sig) == 1, len(sig))


def test_ai_flow():
    from .handlers import Bot
    api = FlowAPI()
    with tmpdir() as tmp:
        store = Store(os.path.join(tmp, "apb.json"))
        bot = Bot(api, store, admins=[1], ai=FakeAI())
        chat = {"id": 55, "type": "private"}
        user = {"id": 1, "is_bot": False}

        bot.dispatch({"message": {"chat": chat, "from": user, "text": "/post"}})
        bot.dispatch({"message": {"chat": chat, "from": user,
                                  "text": "original draft content"}})
        comp = bot.composers[55]

        bot.dispatch({"callback_query": {
            "id": "cq1", "from": user, "data": "apb:aiw",
            "message": {"chat": chat, "message_id": comp["panel_msg"],
                        "from": {"id": 9, "is_bot": True}}}})
        check("ai write prompts for topic", comp["state"] == "await_ai_prompt",
              comp["state"])
        bot.dispatch({"message": {"chat": chat, "from": user,
                                  "text": "why bots are cool"}})
        ok = wait_until(lambda: 55 in bot.ai_results, timeout=10)
        check("ai streamed result", ok and
              bot.ai_results[55]["text"] == "Hello **world** from NVIDIA",
              bot.ai_results.get(55))
        check("ai used draft animation", any(
            s[0] == "sendRichMessageDraft" for s in api.sent))
        status = bot.ai_use(55)
        check("ai use loaded", status == "loaded" and
              "NVIDIA" in comp["parts"][-1], (status, comp["parts"]))
        check("ai write appends", comp["parts"][0] == "original draft content")

        # rewrite (replace=True) keeps a backup
        bot.dispatch({"callback_query": {
            "id": "cq2", "from": user, "data": "apb:air",
            "message": {"chat": chat, "message_id": comp["panel_msg"],
                        "from": {"id": 9, "is_bot": True}}}})
        ok = wait_until(lambda: 55 in bot.ai_results, timeout=10)
        bot.ai_use(55)
        check("ai rewrite replaces + backup", comp["parts"] == [
            "Hello **world** from NVIDIA"]
            and comp["backup_parts"][0] == "original draft content",
            (comp["parts"], comp.get("backup_parts")))

        # AI off -> hint instead of crash
        bot.ai.enabled = False
        state = bot.ai_action(55, "rewrite")
        check("ai disabled hint", state is None and
              any("build.nvidia.com" in str(s) for s in api.sent))
        bot.ai.enabled = True


def test_bulk_flow():
    from .handlers import Bot
    api = FlowAPI()
    with tmpdir() as tmp:
        store = Store(os.path.join(tmp, "apb.json"))
        bot = Bot(api, store, admins=[1], ai=FakeAI())
        chat = {"id": 55, "type": "private"}
        user = {"id": 1, "is_bot": False}

        bot.dispatch({"message": {"chat": chat, "from": user, "text": "/bulk"}})
        check("bulk session", 55 in bot.bulks)
        for i in range(3):
            bot.dispatch({"message": {"chat": chat, "from": user,
                                      "text": "bulk post {}".format(i)}})
        bulk = bot.bulks[55]
        check("bulk collected", len(bulk["items"]) == 3, len(bulk["items"]))
        # album grouping: same media_group_id merges
        bot.dispatch({"message": {"chat": chat, "from": user, "caption": "album",
                                  "photo": [{"file_id": "f1"}],
                                  "media_group_id": "g1"}})
        bot.dispatch({"message": {"chat": chat, "from": user,
                                  "photo": [{"file_id": "f2"}],
                                  "media_group_id": "g1"}})
        check("bulk album merged", len(bulk["items"]) == 4
              and len(bulk["items"][-1]["media"]) == 2,
              (len(bulk["items"]), bulk["items"][-1]["media"]))

        bot.dispatch({"callback_query": {
            "id": "cq1", "from": user, "data": "apb:bulkgo",
            "message": {"chat": chat, "message_id": bulk["panel"],
                        "from": {"id": 9, "is_bot": True}}}})
        bot.dispatch({"callback_query": {
            "id": "cq2", "from": user, "data": "apb:bulk:here",
            "message": {"chat": chat, "message_id": bulk["panel"],
                        "from": {"id": 9, "is_bot": True}}}})
        ok = wait_until(lambda: 55 not in bot.bulks, timeout=30)
        check("bulk finished", ok)
        posts = [s for s in api.sent if s[0] == "sendRichMessage"
                 and "bulk post" in str(s[2])]
        check("bulk delivered all", len(posts) == 3, len(posts))
        albums = [s for s in api.sent if s[0] == "sendRichMessage"
                  and "media" in s[2]]
        check("bulk album delivered rich", len(albums) == 1, len(albums))

        # auto-schedule path
        bot.dispatch({"message": {"chat": chat, "from": user, "text": "/bulk"}})
        bot.dispatch({"message": {"chat": chat, "from": user, "text": "sched me"}})
        bulk2 = bot.bulks[55]
        bot.dispatch({"callback_query": {
            "id": "cq3", "from": user, "data": "apb:bulksched:here",
            "message": {"chat": chat, "message_id": bulk2["panel"],
                        "from": {"id": 9, "is_bot": True}}}})
        bot.dispatch({"message": {"chat": chat, "from": user, "text": "2h"}})
        bot.dispatch({"message": {"chat": chat, "from": user, "text": "now"}})
        jobs = store.scheduled()
        check("bulk autoscheduled", len(jobs) == 1
              and jobs[0][1]["markdown"] == "sched me", jobs)


def test_slideshow_and_paid():
    from .handlers import Bot
    api = FlowAPI()
    with tmpdir() as tmp:
        store = Store(os.path.join(tmp, "apb.json"))
        bot = Bot(api, store, admins=[1], ai=FakeAI())

        comp = bot._new_composer(55)
        comp["parts"] = ["# Trip"]
        comp["media"] = [
            {"id": "m1", "kind": "photo", "media": "F1"},
            {"id": "m2", "kind": "photo", "media": "F2"},
        ]
        comp["slideshow"] = True
        irm = bot.build_irm(comp)
        check("slideshow blocks mode", "blocks" in irm and
              irm["blocks"][0]["type"] == "slideshow", list(irm))
        check("slideshow has photos", len(irm["blocks"][0]["blocks"]) == 2)
        check("slideshow keeps text", any(b["type"] == "heading" for b in irm["blocks"]))
        check("slideshow within limits", R.check_limits(irm) == [])

        bot.deliver_one(55, comp)
        check("slideshow delivered as blocks", any(
            s[0] == "sendRichMessage" and "blocks" in s[2] for s in api.sent))

        comp2 = bot._new_composer(55)
        comp2["parts"] = ["exclusive pics"]
        comp2["media"] = [{"id": "m1", "kind": "photo", "media": "F1"}]
        comp2["stars"] = 25
        bot.deliver_one(55, comp2)
        paid = [s for s in api.sent if s[0] == "sendPaidMedia"]
        check("paid post sent", len(paid) == 1 and paid[0][1]["star_count"] == 25,
              paid)

        comp3 = bot._new_composer(55)
        comp3["parts"] = ["plain mode with media"]
        comp3["media"] = [{"id": "m1", "kind": "photo", "media": "F1"}]
        comp3["mode"] = "plain"
        bot.deliver_one(55, comp3)
        mg = [s for s in api.sent if s[0] == "sendMediaGroup"]
        check("plain mode media group", len(mg) == 1 and
              mg[0][1]["media"][0]["caption"] == "plain mode with media", mg)

        comp4 = bot._new_composer(55)
        comp4["parts"] = ["signed post"]
        bot.deliver_one(55, comp4, signature="@mychan")
        check("signature appended", any(
            s[0] == "sendRichMessage" and "@mychan" in s[2].get("markdown", "")
            for s in api.sent))


def test_channels_and_templates_flow():
    from .handlers import Bot
    api = FlowAPI()
    with tmpdir() as tmp:
        store = Store(os.path.join(tmp, "apb.json"))
        bot = Bot(api, store, admins=[1], ai=FakeAI())
        chat = {"id": 55, "type": "private"}
        user = {"id": 1, "is_bot": False}

        bot.dispatch({"message": {"chat": chat, "from": user, "text": "/channels"}})
        bot.dispatch({"callback_query": {
            "id": "cq1", "from": user, "data": "apb:chadd",
            "message": {"chat": chat, "message_id": 1,
                        "from": {"id": 9, "is_bot": True}}}})
        bot.dispatch({"message": {"chat": chat, "from": user,
                                  "forward_from_chat": {"id": -100777,
                                                        "title": "My Channel"},
                                  "text": "fwd"}})
        check("channel added by forward", -100777 in
              [int(c) for c in store.channels()], list(store.channels()))

        # templates
        bot.dispatch({"message": {"chat": chat, "from": user, "text": "/post"}})
        comp = bot.composers[55]
        bot.dispatch({"message": {"chat": chat, "from": user,
                                  "text": "# Template post"}})
        bot.dispatch({"callback_query": {
            "id": "cq2", "from": user, "data": "apb:tplsave",
            "message": {"chat": chat, "message_id": comp["panel_msg"],
                        "from": {"id": 9, "is_bot": True}}}})
        tpls = store.templates()
        check("template saved", len(tpls) == 1
              and "Template post" in tpls[0][1]["markdown"], tpls)
        bot.dispatch({"message": {"chat": chat, "from": user, "text": "/cancel"}})

        bot.dispatch({"callback_query": {
            "id": "cq3", "from": user, "data": "apb:tplnew:" + tpls[0][0],
            "message": {"chat": chat, "message_id": 1,
                        "from": {"id": 9, "is_bot": True}}}})
        comp2 = bot.composers.get(55)
        check("template loads into composer", comp2 is not None
              and "Template post" in comp2["parts"][0])
        bot.dispatch({"message": {"chat": chat, "from": user, "text": "/cancel"}})

        # publish to channels
        bot.dispatch({"message": {"chat": chat, "from": user, "text": "/post"}})
        comp3 = bot.composers[55]
        bot.dispatch({"message": {"chat": chat, "from": user, "text": "fan out"}})
        bot.dispatch({"callback_query": {
            "id": "cq4", "from": user, "data": "apb:done",
            "message": {"chat": chat, "message_id": comp3["panel_msg"],
                        "from": {"id": 9, "is_bot": True}}}})
        bot.dispatch({"callback_query": {
            "id": "cq5", "from": user, "data": "apb:pub:chans",
            "message": {"chat": chat, "message_id": comp3["panel_msg"],
                        "from": {"id": 9, "is_bot": True}}}})
        ok = wait_until(lambda: store.stats()["sent"] == 1, timeout=15)
        check("publish to channels delivered", ok and any(
            s[0] == "sendRichMessage" and "fan out" in str(s[2]) and s[1] == -100777
            for s in api.sent), store.stats())

        # turbo mode
        bot.dispatch({"message": {"chat": chat, "from": user, "text": "/turbo"}})
        check("turbo on", store.setting("turbo") is True)
        bot.dispatch({"message": {"chat": chat, "from": user, "text": "/post"}})
        comp4 = bot.composers[55]
        bot.dispatch({"message": {"chat": chat, "from": user, "text": "turbo post"}})
        bot.dispatch({"message": {"chat": chat, "from": user, "text": "/done"}})
        ok = wait_until(lambda: store.stats()["sent"] == 2, timeout=15)
        check("turbo publishes instantly", ok and any(
            len(s) > 2 and "turbo post" in str(s[2]) and s[1] == -100777
            for s in api.sent))


def test_watermark_module():
    from . import watermark
    check("watermark availability flag", isinstance(watermark.available(), bool))
    if watermark.available():
        # 10x10 red PNG -> watermarked JPEG
        import struct, zlib
        def chunk(tag, data):
            c = tag + data
            return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))
        ihdr = struct.pack(">IIBBBBB", 10, 10, 8, 2, 0, 0, 0)
        raw = b"".join(b"\x00" + b"\xff\x00\x00" * 10 for _ in range(10))
        png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
               + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
        out = watermark.watermark_bytes(png, "@test")
        check("watermark produces jpeg", out is not None and
              out[:2] == b"\xff\xd8", type(out))
    else:
        check("watermark graceful without PIL", True)


def test_health_server():
    """The HTTP probe platforms use to decide a deploy is healthy."""
    import urllib.request
    from . import health

    def get(url, method="GET"):
        req = urllib.request.Request(url, method=method)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:          # 4xx/5xx are real answers
            return e.code, e.read()

    # --- port resolution -------------------------------------------------
    old = {k: os.environ.get(k) for k in ("PORT", "APB_PORT")}
    try:
        os.environ.pop("PORT", None)
        os.environ.pop("APB_PORT", None)
        check("no port env → no health server", health.resolve_port() is None)
        os.environ["PORT"] = "9111"
        check("PORT is honoured", health.resolve_port() == 9111)
        os.environ["APB_PORT"] = "9222"
        check("APB_PORT beats PORT", health.resolve_port() == 9222)
        check("--port beats both", health.resolve_port(9333) == 9333)
        os.environ["APB_PORT"] = "not-a-port"
        check("garbage port ignored", health.resolve_port() == 9111)
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    # --- live socket -----------------------------------------------------
    hs = health.HealthServer(port=0, host="127.0.0.1",
                             stats=lambda: {"bot": "@selftest"})
    started = hs.start()          # blocks until the socket is listening
    check("health server binds", started is True and hs.bound and hs.bound_port > 0,
          (started, hs.bound_port))
    base = "http://127.0.0.1:{}".format(hs.bound_port)

    code, body = get(base + "/health")
    payload = json.loads(body or b"{}")
    check("/health is 200 while starting", code == 200, code)
    check("/health reports liveness json",
          payload.get("status") == "starting" and payload.get("ready") is False
          and payload.get("runtime") == "python"
          and payload.get("service") == "advanced-posting-bot", payload)
    check("stats callable merged", payload.get("bot") == "@selftest", payload)

    code, _ = get(base + "/ready")
    check("/ready is 503 before login", code == 503, code)

    hs.mark_ready("polling @x")
    code, body = get(base + "/ready")
    check("/ready flips to 200", code == 200, code)
    check("/ready carries detail",
          json.loads(body).get("detail") == "polling @x")
    check("status becomes ok once ready",
          json.loads(get(base + "/health")[1]).get("status") == "ok")
    hs.mark_not_ready("degraded")
    check("mark_not_ready reverts readiness", get(base + "/ready")[0] == 503)
    hs.mark_ready("polling @x")

    code, body = get(base + "/")
    check("/ is a plain 200", code == 200 and b"Advanced Posting Bot" in body, code)
    code, _ = get(base + "/healthz")
    check("/healthz alias works", code == 200, code)
    code, _ = get(base + "/nope")
    check("unknown path is 404", code == 404, code)

    code, body = get(base + "/health", method="HEAD")
    check("HEAD /health is 200 with empty body", code == 200 and body == b"",
          (code, body))

    hs.stats = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
    code, body = get(base + "/health")
    check("broken stats never break /health",
          code == 200 and "boom" in json.loads(body).get("stats_error", ""), code)
    check("probe hits counted", hs.hits >= 7, hs.hits)

    # A taken port must not take the bot down with it — it logs and reports
    # False, so the banner can warn that a port-probing platform will fail.
    dup = health.HealthServer(port=hs.bound_port, host="127.0.0.1")
    check("second bind on a taken port fails cleanly",
          dup.start(wait=3) is False and dup.bound is False, dup.bound)
    check("the original still answers", get(base + "/health")[0] == 200)

    hs.stop()
    try:
        get(base + "/health")
        check("port released after stop", False, "still answering")
    except Exception:
        check("port released after stop", True)


def test_parse_interval():
    from .utils import parse_interval
    check("interval 6h", parse_interval("6h") == 21600)
    check("interval every 90m", parse_interval("every 90m") == 5400)
    check("interval 2d", parse_interval("2d") == 172800)
    check("interval 45 (minutes)", parse_interval("45") == 2700)
    check("interval 1d12h", parse_interval("1d12h") == 129600)
    check("interval too small", parse_interval("30s") is None)
    check("interval garbage", parse_interval("whenever") is None)


def run():
    print("Advanced Posting Bot — selftest\n")
    t0 = time.time()
    stragglers = []
    for fn in (test_richtext, test_blocks, test_rich_message, test_analysis,
               test_parse_when, test_parse_buttons, test_smooth_editor,
               test_api_payload, test_store, test_content, test_composer_flow,
               test_mdblocks, test_nvidia_client, test_store_posto,
               test_scheduler_recurring, test_ai_flow, test_bulk_flow,
               test_slideshow_and_paid, test_channels_and_templates_flow,
               test_watermark_module, test_health_server, test_parse_interval):
        print("· {}".format(fn.__name__))
        fn()
        # Publishing/streaming workers are daemon threads; let them land before
        # the next test (and long before interpreter shutdown — see quiesce()).
        stragglers = quiesce() or stragglers
    dt = time.time() - t0
    print("\n{}/{} checks passed in {:.2f}s".format(len(PASS), len(PASS) + len(FAIL), dt))
    if stragglers:
        print("note: threads still running after the run: {}".format(", ".join(stragglers)))
    if FAIL:
        print("FAILED: " + ", ".join(FAIL))
        return 1
    print("All good — the rich machinery is ready. 🚀")
    return 0


if __name__ == "__main__":
    sys.exit(run())
