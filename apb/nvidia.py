"""apb.nvidia — AI helpers powered by NVIDIA NIM (build.nvidia.com).

Why NVIDIA NIM:
  * free FOREVER — no credit card, no expiring credits, ~40 requests/min
  * OpenAI-compatible Chat Completions at https://integrate.api.nvidia.com/v1
  * hosts NVIDIA's own latest open models

The ONE model this bot uses (latest, not outdated, free):
  nvidia/nemotron-3-super-120b-a12b   — NVIDIA's own Nemotron-3 generation
  (hybrid Mamba-Transformer MoE, ~1M context, fast: only ~12B active params,
  tuned for instruction following / agentic work).

Get a key (takes a minute, free): https://build.nvidia.com → sign in →
API keys → generate (starts with ``nvapi-``).  Then:

    export APB_NVIDIA_KEY="nvapi-..."

Only NVIDIA is used — no other AI provider, nothing paid.
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request

log = logging.getLogger(__name__)

BASE_URL = "https://integrate.api.nvidia.com/v1"
DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b"

SYSTEM_PROMPT = (
    "You are the in-house copywriter of a Telegram channel. You write posts in "
    "Telegram Rich Markdown: GitHub-Flavored Markdown (headings, **bold**, "
    "*italic*, tables, `- [ ]` task lists, fenced code, footnotes) plus "
    "Telegram extras like ==marked text== and ||hidden spoilers||.\n"
    "Rules: output ONLY the post itself — no explanations, no surrounding code "
    "fence, no 'Here is your post'. Keep it punchy and scannable. Use at most "
    "one H1-style heading, short paragraphs, and emoji where it helps. "
    "Answer in the language of the request."
)


class AIError(RuntimeError):
    pass


class NVIDIA:
    """Thin Chat-Completions client for NVIDIA NIM (streaming included)."""

    def __init__(self, api_key=None, model=None, timeout=90):
        self.api_key = api_key or ""
        self.model = model or os.environ.get("APB_AI_MODEL") or DEFAULT_MODEL
        self.timeout = timeout

    # ------------------------------------------------------------ status

    @property
    def enabled(self):
        return bool(self.api_key)

    def status_line(self):
        if not self.enabled:
            return ("🤖 AI: off — set APB_NVIDIA_KEY (free key from "
                    "build.nvidia.com, no card needed)")
        return "🤖 AI: {} @ NVIDIA NIM (free tier)".format(self.model)

    # ------------------------------------------------------------ request

    def _post(self, payload, stream=False):
        if not self.enabled:
            raise AIError("no NVIDIA API key — get a free one at build.nvidia.com")
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            BASE_URL + "/chat/completions",
            data=body,
            headers={
                "Authorization": "Bearer " + self.api_key,
                "Content-Type": "application/json",
                "Accept": "text/event-stream" if stream else "application/json",
            },
            method="POST",
        )
        try:
            return urllib.request.urlopen(req, timeout=self.timeout)
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            detail = raw[:300]
            try:
                err = json.loads(raw)
                detail = (err.get("message") or err.get("detail")
                          or err.get("title") or detail)
            except ValueError:
                pass
            if exc.code == 401:
                raise AIError("NVIDIA key rejected (401) — check APB_NVIDIA_KEY")
            if exc.code == 404 and "model" in detail.lower():
                raise AIError("model not available on your NIM account: "
                              "{} — try APB_AI_MODEL".format(self.model))
            if exc.code == 429:
                raise AIError("NVIDIA free tier rate limit (40 RPM) — "
                              "retry in a few seconds")
            raise AIError("NVIDIA API error {}: {}".format(exc.code, detail))
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise AIError("cannot reach NVIDIA NIM: {}".format(exc))

    # ------------------------------------------------------------ helpers

    def complete(self, user_prompt, system=None, max_tokens=2048, temperature=0.7):
        """Blocking completion -> plain text."""
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system or SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": False,
        }
        with self._post(payload) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        try:
            return data["choices"][0]["message"]["content"].strip()
        except (KeyError, IndexError, TypeError):
            raise AIError("unexpected NVIDIA response: {}".format(json.dumps(data)[:300]))

    def stream(self, user_prompt, system=None, max_tokens=2048, temperature=0.7):
        """Yield text chunks as they arrive (SSE parsing, zero deps)."""
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system or SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": True,
        }
        buf = b""
        with self._post(payload, stream=True) as resp:
            while True:
                chunk = resp.read(1)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.strip()
                    if not line.startswith(b"data:"):
                        continue
                    data = line[5:].strip()
                    if data == b"[DONE]":
                        return
                    try:
                        obj = json.loads(data.decode("utf-8"))
                    except ValueError:
                        continue
                    try:
                        delta = obj["choices"][0]["delta"].get("content")
                    except (KeyError, IndexError, TypeError, AttributeError):
                        delta = None
                    if delta:
                        yield delta

    # ------------------------------------------------------- post skills

    def write_post(self, prompt, tone=None, language=None):
        ask = "Write a Telegram channel post about: {}".format(prompt)
        if tone:
            ask += "\nTone: {}".format(tone)
        if language:
            ask += "\nLanguage: {}".format(language)
        return ask

    def rewrite_post(self, text, instruction="make it punchier, keep the meaning"):
        return ("Rewrite the following Telegram post. Instruction: {}.\n\n"
                "Post:\n{}".format(instruction, text))

    def translate_post(self, text, language):
        return ("Translate this Telegram post into {}. Keep the Rich Markdown "
                "formatting and emoji.\n\nPost:\n{}".format(language, text))

    def shorten_post(self, text):
        return ("Shorten this Telegram post to roughly half its length while "
                "keeping all key facts and the formatting.\n\nPost:\n{}".format(text))

    def expand_post(self, text):
        return ("Expand this Telegram post with a bit more detail and one "
                "extra section. Keep the Rich Markdown style.\n\nPost:\n{}".format(text))
