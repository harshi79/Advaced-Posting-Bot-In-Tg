# Advanced Posting Bot — 100% Node.js, zero runtime dependencies.
#
#   docker build -t apb .
#   docker run --rm -e APB_TOKEN="123:ABC" -e APB_ADMINS="123456789" \
#              -e PORT=8080 -p 8080:8080 -v apb-data:/data apb
#
# Want real photo watermarks (the ©️ feature) baked in?
#   docker build --build-arg WITH_SHARP=1 -t apb .

FROM node:20-slim

ENV NODE_ENV=production \
    PORT=8080 \
    APB_DATA_DIR=/data

WORKDIR /app

# No runtime dependencies — the bot uses Node's stdlib + built-in fetch.
# The layer is here so optional extras (sharp) install without stale caches.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

ARG WITH_SHARP=0
RUN if [ "$WITH_SHARP" = "1" ]; then npm install --omit=dev --no-audit --no-fund sharp ; fi

COPY src ./src

# Persistent state (chats, drafts, schedules, channels) lives in /data —
# mount a volume there or the store resets when the container is replaced.
RUN mkdir -p /data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# exec form so SIGTERM reaches Node (clean scheduler + server shutdown).
CMD ["node", "src/index.js"]
