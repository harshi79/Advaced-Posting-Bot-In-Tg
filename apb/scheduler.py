"""apb.scheduler — background thread that fires scheduled posts on time."""

from __future__ import annotations

import logging
import threading
import time

log = logging.getLogger(__name__)


class Scheduler(threading.Thread):
    """Checks the store every few seconds and publishes due posts."""

    def __init__(self, store, publish_fn, interval=3.0):
        super().__init__(daemon=True, name="apb-scheduler")
        self.store = store
        self.publish_fn = publish_fn          # (job_id, job_dict) -> result dict
        self.interval = interval
        self._stop = threading.Event()

    def run(self):
        log.info("scheduler started (interval %.1fs)", self.interval)
        while not self._stop.is_set():
            try:
                for jid, job in self.store.due_scheduled():
                    log.info("publishing scheduled job %s (repeat=%s)",
                             jid, job.get("repeat", "none"))
                    try:
                        self.publish_fn(jid, job)
                        if self.store.reschedule_recurring(jid):
                            log.info("job %s rescheduled", jid)
                        else:
                            self.store.finish_scheduled(jid, ok=True)
                    except Exception as exc:
                        log.error("scheduled job %s failed: %s", jid, exc)
                        self.store.finish_scheduled(jid, ok=False, error=str(exc))
            except Exception as exc:  # keep the thread alive no matter what
                log.exception("scheduler loop error: %s", exc)
            self._stop.wait(self.interval)

    def stop(self):
        self._stop.set()
