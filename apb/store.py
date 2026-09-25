"""apb.store — tiny atomic JSON persistence for the bot."""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time


class _Seq:
    """Monotonic suffix so ids never collide inside the same millisecond."""

    def __init__(self):
        self._n = 0
        self._lock = threading.Lock()

    def next(self):
        with self._lock:
            self._n += 1
            return self._n


_SEQ = _Seq()


def _new_id(prefix=""):
    return "{}{}-{}".format(prefix, int(time.time() * 1000), _SEQ.next())


class Store:
    """All state lives in one JSON file, written atomically."""

    DEFAULTS = {
        "chats": {},        # chat_id -> {"title", "type", "first_seen"}
        "drafts": {},       # draft_id -> {"title", "markdown", "mode", "buttons", "media", "created"}
        "scheduled": {},    # job_id  -> {"run_at", "target", "markdown", "mode", "buttons", "media", "note", "status", "repeat"}
        "channels": {},     # chat_id -> {"title", "signature", "delay", "added"}
        "templates": {},    # tpl_id  -> {"name", "markdown", "buttons", "media", "signature", "created"}
        "settings": {"turbo": False, "watermark_on": False, "watermark_text": ""},
        "sent": 0,
        "failed": 0,
    }

    # ------------------------------------------------------- settings

    def setting(self, key, default=None):
        return self.data.get("settings", {}).get(key, default)

    def set_setting(self, key, value):
        with self._lock:
            self.data.setdefault("settings", {})[key] = value
            self.save()

    # ------------------------------------------------------- channels

    def add_channel(self, chat_id, title="", signature=None, delay=None):
        with self._lock:
            entry = self.data["channels"].setdefault(str(chat_id), {})
            entry["title"] = title or entry.get("title", str(chat_id))
            entry.setdefault("added", time.time())
            if signature is not None:
                entry["signature"] = signature
            if delay is not None:
                entry["delay"] = float(delay)
            self.save()
            return entry

    def channel(self, chat_id):
        return self.data["channels"].get(str(chat_id))

    def channels(self):
        return dict(self.data["channels"])

    def del_channel(self, chat_id):
        with self._lock:
            if str(chat_id) in self.data["channels"]:
                del self.data["channels"][str(chat_id)]
                self.save()
                return True
            return False

    # ------------------------------------------------------ templates

    def add_template(self, name, markdown, buttons=None, media=None, signature=""):
        with self._lock:
            tid = _new_id("t")
            self.data["templates"][tid] = {
                "name": name, "markdown": markdown,
                "buttons": buttons or [], "media": media or [],
                "signature": signature or "", "created": time.time(),
            }
            self.save()
            return tid

    def templates(self):
        return sorted(self.data["templates"].items(), key=lambda kv: -kv[1].get("created", 0))

    def template(self, tid):
        return self.data["templates"].get(str(tid))

    def del_template(self, tid):
        with self._lock:
            if str(tid) in self.data["templates"]:
                del self.data["templates"][str(tid)]
                self.save()
                return True
            return False

    def __init__(self, path):
        self.path = path
        self._lock = threading.RLock()
        self.data = json.loads(json.dumps(self.DEFAULTS))  # deep copy
        self._load()

    # ------------------------------------------------------------ io

    def _load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                loaded = json.load(fh)
            for key, val in loaded.items():
                self.data[key] = val
        except (OSError, ValueError):
            pass

    def save(self):
        with self._lock:
            directory = os.path.dirname(os.path.abspath(self.path))
            os.makedirs(directory, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    json.dump(self.data, fh, ensure_ascii=False, indent=1, sort_keys=True)
                os.replace(tmp, self.path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise

    # ---------------------------------------------------------- chats

    def chat_ensure(self, chat_id, title="", chat_type=""):
        with self._lock:
            entry = self.data["chats"].setdefault(str(chat_id), {})
            changed = entry.get("title") != (title or entry.get("title", ""))
            entry["title"] = title or entry.get("title", "")
            entry["type"] = chat_type or entry.get("type", "")
            entry.setdefault("first_seen", time.time())
            if changed or "first_seen" not in entry:
                self.save()
            return entry

    def chats(self):
        return list(self.data["chats"].keys())

    # --------------------------------------------------------- drafts

    def add_draft(self, title, markdown, mode="rich", buttons=None, media=None):
        with self._lock:
            did = _new_id()
            self.data["drafts"][did] = {
                "title": title,
                "markdown": markdown,
                "mode": mode,
                "buttons": buttons or [],
                "media": media or [],
                "created": time.time(),
            }
            self.save()
            return did

    def drafts(self):
        return sorted(self.data["drafts"].items(), key=lambda kv: -kv[1].get("created", 0))

    def draft(self, did):
        return self.data["drafts"].get(str(did))

    def del_draft(self, did):
        with self._lock:
            if str(did) in self.data["drafts"]:
                del self.data["drafts"][str(did)]
                self.save()
                return True
            return False

    # ------------------------------------------------------ scheduled

    def add_scheduled(self, run_at, target, markdown, mode="rich", buttons=None,
                      media=None, note="", repeat="none", slideshow=False, stars=None):
        with self._lock:
            jid = _new_id()
            self.data["scheduled"][jid] = {
                "run_at": run_at,
                "target": target,
                "markdown": markdown,
                "mode": mode,
                "buttons": buttons or [],
                "media": media or [],
                "note": note,
                "status": "pending",
                "repeat": repeat,
                "slideshow": bool(slideshow),
                "stars": stars,
            }
            self.save()
            return jid

    REPEAT_SECONDS = {"hourly": 3600, "daily": 86400, "weekly": 7 * 86400}

    def repeat_interval(self, job):
        rep = job.get("repeat") or "none"
        if rep in self.REPEAT_SECONDS:
            return self.REPEAT_SECONDS[rep]
        if isinstance(rep, (int, float)) and rep > 0:
            return rep
        if isinstance(rep, str) and rep.startswith("every:"):
            try:
                return float(rep.split(":", 1)[1])
            except ValueError:
                return None
        return None

    def reschedule_recurring(self, jid, now=None):
        """Advance a recurring job to its next run (no drift)."""
        now = now or time.time()
        with self._lock:
            job = self.data["scheduled"].get(str(jid))
            if job is None:
                return False
            interval = self.repeat_interval(job)
            if not interval:
                return False
            nxt = job.get("run_at", now) + interval
            while nxt <= now:               # catch up if we fell behind
                nxt += interval
            job["run_at"] = nxt
            job["status"] = "pending"
            self.save()
            return True

    def due_scheduled(self, now=None):
        """Return and mark running all pending jobs whose time has come."""
        now = now or time.time()
        due = []
        with self._lock:
            for jid, job in self.data["scheduled"].items():
                if job.get("status") == "pending" and job.get("run_at", 0) <= now:
                    job["status"] = "running"
                    due.append((jid, job))
            if due:
                self.save()
        return due

    def finish_scheduled(self, jid, ok=True, error=None):
        with self._lock:
            job = self.data["scheduled"].get(str(jid))
            if job is None:
                return
            if ok:
                del self.data["scheduled"][str(jid)]
            else:
                job["status"] = "failed"
                job["error"] = error or "unknown error"
            self.save()

    def scheduled(self):
        return sorted(self.data["scheduled"].items(), key=lambda kv: kv[1].get("run_at", 0))

    def del_scheduled(self, jid):
        with self._lock:
            if str(jid) in self.data["scheduled"]:
                del self.data["scheduled"][str(jid)]
                self.save()
                return True
            return False

    # ---------------------------------------------------------- stats

    def bump(self, ok=True):
        with self._lock:
            self.data["sent" if ok else "failed"] += 1
            self.save()

    def stats(self):
        return {
            "chats": len(self.data["chats"]),
            "drafts": len(self.data["drafts"]),
            "scheduled": len(self.data["scheduled"]),
            "sent": self.data["sent"],
            "failed": self.data["failed"],
        }
