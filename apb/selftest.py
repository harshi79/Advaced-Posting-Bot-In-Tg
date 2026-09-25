"""apb.selftest — offline sanity checks (no network, no bot token).

Run with:  python bot.py --selftest
"""

from __future__ import annotations

import datetime
import io
import json
import os
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
    with tempfile.TemporaryDirectory() as tmp:
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


def test_composer_flow():
    from .handlers import Bot
    api = FlowAPI()
    with tempfile.TemporaryDirectory() as tmp:
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


def run():
    print("Advanced Posting Bot — selftest\n")
    t0 = time.time()
    for fn in (test_richtext, test_blocks, test_rich_message, test_analysis,
               test_parse_when, test_parse_buttons, test_smooth_editor,
               test_api_payload, test_store, test_content, test_composer_flow):
        print("· {}".format(fn.__name__))
        fn()
    dt = time.time() - t0
    print("\n{}/{} checks passed in {:.2f}s".format(len(PASS), len(PASS) + len(FAIL), dt))
    if FAIL:
        print("FAILED: " + ", ".join(FAIL))
        return 1
    print("All good — the rich machinery is ready. 🚀")
    return 0


if __name__ == "__main__":
    sys.exit(run())
