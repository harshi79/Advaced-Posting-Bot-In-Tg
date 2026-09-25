# Advanced Posting Bot is a Node.js app with ZERO npm dependencies.
#
# It is a long-polling Telegram bot (outbound HTTPS to api.telegram.org only)
# that *also* serves a tiny HTTP status page on $PORT, so it satisfies both
# web-service and worker shapes of every platform:
#
#   web    → platforms that require a listening port + health check   (/health)
#   worker → platforms that happily run a background process
#
# Both run exactly the same code. If your platform ignores the Procfile, set
# the start command to `npm start` (or `node src/index.js`).
#
#   required env:  APB_TOKEN        (bot token from @BotFather)
#   optional env:  APB_ADMINS       (comma-separated Telegram user ids)
#   optional env:  APB_NVIDIA_KEY   (nvapi-... free key for the AI features)
#   optional env:  APB_DATA_DIR     (persistent dir; default ./data)
#   optional env:  PORT / APB_PORT  (HTTP port; default 8080)
web: npm start
worker: node src/index.js --no-health
