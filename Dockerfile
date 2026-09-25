# Advanced Posting Bot — pure Python 3, zero third-party dependencies.
#
# This Dockerfile is the most reliable way to deploy: it pins the runtime to
# Python, so the platform can never fall back to a Node.js image for a repo
# that contains no JavaScript at all.
#
#   docker build -t apb .
#   docker run --rm -e APB_TOKEN="123:ABC" -e APB_ADMINS="123456789" \
#              -e PORT=8080 -p 8080:8080 -v apb-data:/data apb
#
# Want real photo watermarks (the ©️ feature) baked in?
#   docker build --build-arg WITH_PILLOW=1 -t apb .

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# requirements.txt is intentionally empty of packages (stdlib only), but the
# layer is kept so a future Pillow pin installs without invalidating the copy.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

ARG WITH_PILLOW=0
RUN if [ "$WITH_PILLOW" = "1" ]; then \
        pip install --no-cache-dir Pillow ; \
    fi

COPY . .

# Persistent state (chats, composer drafts, schedules) lives in /data —
# mount a volume there or the store resets on every deploy.
RUN mkdir -p /data
ENV APB_DATA_DIR=/data \
    APB_PORT=8080 \
    PORT=8080

# The bot is a long-polling worker; the health server exists purely so
# "web service" platforms have a port to probe. See apb/health.py.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('APB_PORT','8080')+'/health',timeout=4)"

# exec form so SIGTERM reaches Python (clean scheduler shutdown).
CMD ["python", "bot.py"]
