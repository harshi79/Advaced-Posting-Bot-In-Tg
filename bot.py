#!/usr/bin/env python3
"""Advanced Posting Bot — entry point.

Run:
    python bot.py                       # uses APB_TOKEN / BOT_TOKEN env
    python bot.py --token 123:ABC       # explicit token
    python bot.py --selftest            # offline sanity checks, no network

Admins come from APB_ADMINS (comma-separated user ids).  If unset, the
first person to /post in a private chat claims ownership.

Deploying (Railway / Render / Koyeb / Heroku / Fly / Cloud Run …):
    PORT=8080 python bot.py             # also serves GET /health and /ready
    python bot.py --no-health           # pure worker, no socket at all
See DEPLOY.md for per-platform settings.
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from apb.api import Telegram  # noqa: E402
from apb.handlers import Bot  # noqa: E402
from apb.health import HealthServer, resolve_port  # noqa: E402
from apb.scheduler import Scheduler  # noqa: E402
from apb.store import Store  # noqa: E402

BANNER = r"""
 _   _ _______ ____  __  __ _____ ____      _    _
| | | | ____ / ___||  \/  | ____|  _ \    / \  | |
| |_| |  _| \___ \| |\/| |  _| | |_) |  / _ \ | |
|  _  | |___ ___) | |  | | |___|  _ <  / ___ \| |___
|_| |_|_____|____/|_|  |_|_____|_| \_\/_/   \_\_____|
        Advanced Posting Bot · rich · free · smooth
"""


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Advanced Posting Bot for Telegram")
    p.add_argument("--token", help="bot token (or env APB_TOKEN/BOT_TOKEN)")
    p.add_argument("--admins", help="comma-separated admin user ids (or env APB_ADMINS)")
    p.add_argument("--data", default=None,
                   help="data directory (default $APB_DATA_DIR or ./data)")
    p.add_argument("--port", type=int, default=None,
                   help="health-check port (default $APB_PORT / $PORT; "
                        "platforms that wait for a listening port need this)")
    p.add_argument("--no-health", action="store_true",
                   help="do not open the HTTP health endpoint (pure worker mode)")
    p.add_argument("--selftest", action="store_true", help="run offline tests and exit")
    p.add_argument("--verbose", "-v", action="store_true")
    return p.parse_args(argv)


def admins_from(args):
    raw = args.admins or os.environ.get("APB_ADMINS") or os.environ.get("ADMINS") or ""
    out = []
    for chunk in raw.replace(";", ",").split(","):
        chunk = chunk.strip()
        if chunk.isdigit():
            out.append(int(chunk))
    return out


def main(argv=None):
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    if args.selftest:
        from apb import selftest
        return selftest.run()

    token = args.token or os.environ.get("APB_TOKEN") or os.environ.get("BOT_TOKEN") \
        or os.environ.get("TELEGRAM_TOKEN")
    if not token:
        print("No bot token. Set APB_TOKEN or pass --token.\n"
              "Get one from @BotFather on Telegram.", file=sys.stderr)
        return 2

    data_dir = args.data or os.environ.get("APB_DATA_DIR") \
        or os.environ.get("DATA_DIR") \
        or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
    try:
        os.makedirs(data_dir, exist_ok=True)
        probe = os.path.join(data_dir, ".apb-write-test")
        with open(probe, "w") as fh:
            fh.write("ok")
        os.remove(probe)
    except OSError as exc:
        # Read-only or ephemeral filesystem (common on PaaS). Fall back to a
        # writable temp dir instead of crash-looping; warn loudly so the user
        # attaches a real volume (see DEPLOY.md → persistent state).
        fallback = os.path.join(tempfile.gettempdir(), "apb-data")
        print("WARNING: data dir {} is not writable ({}).\n"
              "         Falling back to {} — state will be lost when this "
              "instance restarts.\n         Mount a disk/volume and set "
              "APB_DATA_DIR to keep it.".format(data_dir, exc, fallback),
              file=sys.stderr)
        data_dir = fallback
        os.makedirs(data_dir, exist_ok=True)

    # Bind the health endpoint FIRST: platforms that deploy "web services"
    # probe a TCP port before the release is considered healthy, and getMe
    # below is a network round-trip that must not look like a crash loop.
    health = None
    health_up = False
    if not args.no_health:
        port = resolve_port(args.port)
        if port:
            health = HealthServer(port=port)
            health_up = health.start()

    tg = Telegram(token)
    try:
        me = tg.call("getMe")
    except Exception as exc:
        code = getattr(exc, "error_code", None)
        desc = getattr(exc, "description", None) or str(exc)
        if code in (401, 403, 404):
            hint = ("  • is APB_TOKEN the full \"123456789:AA…\" string from\n"
                    "    @BotFather — no quotes, spaces or newlines around it?\n"
                    "  • was the token revoked or regenerated since you saved it?\n"
                    "  • is the env var set on the *service*, not just locally?")
        elif code == -1:
            hint = ("  • can this host reach api.telegram.org:443 outbound?\n"
                    "    (locked-down networks, egress firewalls and proxies\n"
                    "     are the usual suspects — the bot only ever dials out)\n"
                    "  • does DNS resolve? try: getent hosts api.telegram.org\n"
                    "  • if you are behind a corporate proxy, export HTTPS_PROXY")
        else:
            hint = "  • check the description above against https://core.telegram.org/bots/api"
        print("Could not log in to Telegram: {}\n{}".format(desc, hint), file=sys.stderr)
        if health:
            health.stop()
        return 3

    store = Store(os.path.join(data_dir, "apb.json"))
    bot = Bot(tg, store, admins=admins_from(args))
    sched = Scheduler(store, bot.deliver_scheduled)
    sched.start()

    if health:
        health.stats = lambda: {
            "bot": "@{}".format(me.get("username")),
            "admins": len(bot.admins),
            "chats": len(store.chats()),
            "scheduled": len(store.data.get("scheduled", {})),
        }
        health.mark_ready("polling @{}".format(me.get("username")))

    print(BANNER.strip())
    print("Logged in as @{} (id {})".format(me.get("username"), me.get("id")))
    print("Admins: {} · chats seen: {} · scheduled: {}".format(
        bot.admins or "(first /post claims it)", len(store.chats()),
        len(store.data.get("scheduled", {}))))
    print("Data dir: {}".format(data_dir))
    if health is not None:
        if health_up:
            print("Health  : {}  (readiness: /ready)".format(health.url))
        else:
            print("Health  : NOT LISTENING — the port was taken; the bot still "
                  "polls, but a port-probing platform will call this a crash loop")
    print(bot.ai.status_line())
    print("Try /demo, /post, /bulk, /channels, /ai — Ctrl+C to stop.\n")

    # PaaS redeploys send SIGTERM. Without a handler Python dies mid-poll and
    # the platform books it as a crash; raising KeyboardInterrupt in the main
    # thread reuses the clean shutdown path below (stop scheduler + health).
    def _on_term(_signum, _frame):
        raise KeyboardInterrupt

    for name in ("SIGTERM", "SIGHUP"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, _on_term)
            except (ValueError, OSError, RuntimeError):
                pass                      # not main thread / not supported here

    allowed = ["message", "callback_query", "stopped_message_generation"]
    try:
        for update in tg.updates(allowed_updates=allowed):
            bot.dispatch(update)
    except KeyboardInterrupt:
        print("\nbye 👋")
    finally:
        sched.stop()
        if health:
            health.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
