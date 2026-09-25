/**
 * src/store.js — atomic JSON persistence for the bot.
 *
 * Everything (chats, drafts, schedules, channels, templates, settings) lives
 * in ONE JSON file which is rewritten atomically: write to a sibling temp file
 * then `rename()`, so a crash mid-write can never corrupt live state.
 *
 * On a platform with an ephemeral filesystem (Veroa, Render, Railway …) the
 * file survives restarts of the *same* instance but not redeploys — point
 * APB_DATA_DIR at a mounted disk to keep it forever.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPEAT_SECONDS = { hourly: 3600, daily: 86400, weekly: 7 * 86400 };

let seq = 0;

function newId(prefix = '') {
  seq += 1;
  return `${prefix}${Date.now()}-${seq}`;
}

export function defaultDataDir(projectRoot) {
  return process.env.APB_DATA_DIR || process.env.DATA_DIR || path.join(projectRoot, 'data');
}

/**
 * Make sure `dir` exists and is writable.  Falls back to a temp directory with
 * a loud warning instead of crash-looping on a read-only filesystem.
 */
export function ensureWritableDir(dir, warn = console.warn) {
  const probe = path.join(dir, '.apb-write-test');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return dir;
  } catch (err) {
    const fallback = path.join(os.tmpdir(), 'apb-data');
    warn(`WARNING: data dir ${dir} is not writable (${err.message}).\n`
      + `         Falling back to ${fallback} — state is lost when this instance restarts.\n`
      + '         Mount a disk/volume and set APB_DATA_DIR to keep it.');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

export class Store {
  static DEFAULTS = {
    chats: {},      // chat_id -> {title, type, first_seen}
    drafts: {},     // draft_id -> {title, markdown, mode, buttons, media, created}
    scheduled: {},  // job_id -> {run_at, target, markdown, mode, buttons, media, note, status, repeat}
    channels: {},   // chat_id -> {title, signature, delay, added}
    templates: {},  // tpl_id -> {name, markdown, buttons, media, signature, created}
    settings: { turbo: false, watermark_on: false, watermark_text: '' },
    admins: [],
    sent: 0,
    failed: 0,
  };

  constructor(filePath) {
    this.path = filePath;
    this.data = structuredClone(Store.DEFAULTS);
    this.load();
  }

  // ------------------------------------------------------------------- io

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed)) this.data[key] = value;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Corrupt JSON: keep a copy for forensics, start fresh, never crash.
        try {
          fs.renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
        } catch { /* ignore */ }
      }
    }
  }

  save() {
    const dir = path.dirname(path.resolve(this.path));
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.apb-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.path);
  }

  // -------------------------------------------------------------- settings

  setting(key, fallback = null) {
    return this.data.settings?.[key] ?? fallback;
  }

  setSetting(key, value) {
    if (!this.data.settings) this.data.settings = {};
    this.data.settings[key] = value;
    this.save();
  }

  // -------------------------------------------------------------- channels

  addChannel(chatId, { title = '', signature = null, delay = null } = {}) {
    const key = String(chatId);
    const entry = this.data.channels[key] || (this.data.channels[key] = {});
    entry.title = title || entry.title || key;
    entry.added = entry.added || Date.now() / 1000;
    if (signature !== null) entry.signature = signature;
    if (delay !== null) entry.delay = Number(delay);
    this.save();
    return entry;
  }

  channel(chatId) {
    return this.data.channels[String(chatId)] || null;
  }

  channels() {
    return { ...this.data.channels };
  }

  delChannel(chatId) {
    const key = String(chatId);
    if (this.data.channels[key]) {
      delete this.data.channels[key];
      this.save();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------- templates

  addTemplate(name, markdown, { buttons = null, media = null, signature = '' } = {}) {
    const tid = newId('t');
    this.data.templates[tid] = {
      name,
      markdown,
      buttons: buttons || [],
      media: media || [],
      signature: signature || '',
      created: Date.now() / 1000,
    };
    this.save();
    return tid;
  }

  templates() {
    return Object.entries(this.data.templates).sort((a, b) => (b[1].created || 0) - (a[1].created || 0));
  }

  template(tid) {
    return this.data.templates[String(tid)] || null;
  }

  delTemplate(tid) {
    const key = String(tid);
    if (this.data.templates[key]) {
      delete this.data.templates[key];
      this.save();
      return true;
    }
    return false;
  }

  // ----------------------------------------------------------------- chats

  chatEnsure(chatId, title = '', chatType = '') {
    const key = String(chatId);
    const entry = this.data.chats[key] || (this.data.chats[key] = {});
    const changed = entry.title !== (title || entry.title || '');
    entry.title = title || entry.title || '';
    entry.type = chatType || entry.type || '';
    if (!entry.first_seen) entry.first_seen = Date.now() / 1000;
    if (changed || !entry.first_seen) this.save();
    return entry;
  }

  chats() {
    return Object.keys(this.data.chats);
  }

  // ---------------------------------------------------------------- drafts

  addDraft(title, markdown, { mode = 'rich', buttons = null, media = null } = {}) {
    const did = newId();
    this.data.drafts[did] = {
      title,
      markdown,
      mode,
      buttons: buttons || [],
      media: media || [],
      created: Date.now() / 1000,
    };
    this.save();
    return did;
  }

  drafts() {
    return Object.entries(this.data.drafts).sort((a, b) => (b[1].created || 0) - (a[1].created || 0));
  }

  draft(did) {
    return this.data.drafts[String(did)] || null;
  }

  delDraft(did) {
    const key = String(did);
    if (this.data.drafts[key]) {
      delete this.data.drafts[key];
      this.save();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------- scheduled

  addScheduled(runAt, target, markdown, {
    mode = 'rich', buttons = null, media = null, note = '',
    repeat = 'none', slideshow = false, stars = null,
  } = {}) {
    const jid = newId();
    this.data.scheduled[jid] = {
      run_at: runAt,
      target,
      markdown,
      mode,
      buttons: buttons || [],
      media: media || [],
      note,
      status: 'pending',
      repeat,
      slideshow: !!slideshow,
      stars,
    };
    this.save();
    return jid;
  }

  repeatInterval(job) {
    const rep = job?.repeat ?? 'none';
    if (REPEAT_SECONDS[rep]) return REPEAT_SECONDS[rep];
    if (typeof rep === 'number' && rep > 0) return rep;
    if (typeof rep === 'string' && rep.startsWith('every:')) {
      const value = parseFloat(rep.split(':')[1]);
      return Number.isFinite(value) ? value : null;
    }
    return null;
  }

  /** Advance a recurring job to its next run (no drift). */
  rescheduleRecurring(jid, now = Date.now() / 1000) {
    const job = this.data.scheduled[String(jid)];
    if (!job) return false;
    const interval = this.repeatInterval(job);
    if (!interval) return false;
    let next = (job.run_at || now) + interval;
    while (next <= now) next += interval;      // catch up if we fell behind
    job.run_at = next;
    job.status = 'pending';
    this.save();
    return true;
  }

  /** Return and mark running all pending jobs whose time has come. */
  dueScheduled(now = Date.now() / 1000) {
    const due = [];
    for (const [jid, job] of Object.entries(this.data.scheduled)) {
      if (job.status === 'pending' && (job.run_at || 0) <= now) {
        job.status = 'running';
        due.push([jid, job]);
      }
    }
    if (due.length) this.save();
    return due;
  }

  finishScheduled(jid, { ok = true, error = null } = {}) {
    const key = String(jid);
    const job = this.data.scheduled[key];
    if (!job) return;
    if (ok) delete this.data.scheduled[key];
    else {
      job.status = 'failed';
      job.error = error || 'unknown error';
    }
    this.save();
  }

  scheduled() {
    return Object.entries(this.data.scheduled).sort((a, b) => (a[1].run_at || 0) - (b[1].run_at || 0));
  }

  delScheduled(jid) {
    const key = String(jid);
    if (this.data.scheduled[key]) {
      delete this.data.scheduled[key];
      this.save();
      return true;
    }
    return false;
  }

  // ----------------------------------------------------------------- stats

  bump(ok = true) {
    if (ok) this.data.sent += 1;
    else this.data.failed += 1;
    this.save();
  }

  stats() {
    return {
      chats: Object.keys(this.data.chats).length,
      drafts: Object.keys(this.data.drafts).length,
      scheduled: Object.keys(this.data.scheduled).length,
      channels: Object.keys(this.data.channels).length,
      templates: Object.keys(this.data.templates).length,
      sent: this.data.sent,
      failed: this.data.failed,
    };
  }
}

export default Store;
