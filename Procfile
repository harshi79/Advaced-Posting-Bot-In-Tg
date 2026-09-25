# Advanced Posting Bot is a pure Python 3 app (zero third-party deps).
#
# It is a long-running Telegram *poller*. Historically it opened no socket at
# all, which makes "web service" platforms hang on
#   ==> Waiting for your service to be ready
# and then abort the release as crash-looping. bot.py now also serves a tiny
# health endpoint on $PORT (see apb/health.py), so it satisfies both shapes:
#
#   web    → for platforms that require a listening port + health check
#   worker → for platforms that happily run a background process
#
# Pick whichever your platform starts; both run exactly the same code.
# If your platform ignores Procfile, set the start command to `python bot.py`.
#
#   required env:  APB_TOKEN        (bot token from @BotFather)
#   optional env:  APB_ADMINS       (comma-separated Telegram user ids)
#   optional env:  APB_NVIDIA_KEY   (nvapi-... key for the free AI features)
#   optional env:  APB_DATA_DIR     (persistent dir; default ./data)
#   optional env:  PORT / APB_PORT  (health port; unset → no socket at all)
web: python bot.py
worker: python bot.py
