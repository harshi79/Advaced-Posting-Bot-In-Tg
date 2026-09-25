#!/usr/bin/env python3
"""Advanced Posting Bot — entry point.

Run:
    python bot.py                       # uses APB_TOKEN / BOT_TOKEN env
    python bot.py --token 123:ABC       # explicit token
    python bot.py --selftest            # offline sanity checks, no network

Admins come from APB_ADMINS (comma-separated user ids).  If unset, the
first person to /post in a private chat claims ownership.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from apb import __version__  # noqa: E402
from apb.api import Telegram  # noqa: E402
from apb.handlers import Bot  # noqa: E402
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
    p.add_argument("--data", default=None, help="data directory (default ./data)")
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

    data_dir = args.data or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
    os.makedirs(data_dir, exist_ok=True)

    tg = Telegram(token)
    me = tg.call("getMe")
    store = Store(os.path.join(data_dir, "apb.json"))
    bot = Bot(tg, store, admins=admins_from(args))
    sched = Scheduler(store, bot.deliver_scheduled)
    sched.start()

    print(BANNER.strip())
    print("Logged in as @{} (id {})".format(me.get("username"), me.get("id")))
    print("Admins: {} · chats seen: {} · scheduled: {}".format(
        bot.admins or "(first /post claims it)", len(store.chats()),
        len(store.data.get("scheduled", {}))))
    print("Try /demo, /post, /stream — Ctrl+C to stop.\n")

    allowed = ["message", "callback_query", "stopped_message_generation"]
    try:
        for update in tg.updates(allowed_updates=allowed):
            bot.dispatch(update)
    except KeyboardInterrupt:
        print("\nbye 👋")
    finally:
        sched.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
