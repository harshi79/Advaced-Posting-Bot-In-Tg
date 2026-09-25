/**
 * src/scheduler.js — background loop that fires scheduled & recurring posts.
 *
 * Runs on a timer (never blocking the polling loop) and survives restarts:
 * jobs live in the store, so a redeploy resumes them.  Recurring jobs are
 * advanced to their next slot without drift.
 */

import { logger } from './logger.js';

const log = logger('scheduler');

export class Scheduler {
  constructor(store, publishFn, { interval = 3000 } = {}) {
    this.store = store;
    this.publishFn = publishFn;   // async (jobId, job) => void
    this.interval = interval;
    this.timer = null;
    this.running = false;
    this.stopped = false;
    this.ticks = 0;
    this.lastTick = null;
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick(); }, this.interval);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    log.info(`scheduler started (every ${this.interval / 1000}s)`);
    void this.tick();
  }

  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    this.ticks += 1;
    this.lastTick = Date.now() / 1000;
    try {
      for (const [jid, job] of this.store.dueScheduled()) {
        log.info(`publishing scheduled job ${jid} (repeat=${job.repeat || 'none'})`);
        try {
          await this.publishFn(jid, job);
          if (this.store.rescheduleRecurring(jid)) log.info(`job ${jid} rescheduled`);
          else this.store.finishScheduled(jid, { ok: true });
        } catch (err) {
          log.error(`scheduled job ${jid} failed: ${err?.message || err}`);
          this.store.finishScheduled(jid, { ok: false, error: String(err?.message || err) });
        }
      }
    } catch (err) {
      log.error(`scheduler loop error: ${err?.stack || err}`);   // keep running
    } finally {
      this.running = false;
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export default Scheduler;
