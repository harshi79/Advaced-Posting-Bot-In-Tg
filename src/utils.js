/**
 * src/utils.js — tiny parsing helpers (time, intervals, button rows).
 *
 * Everything is dependency-free and mirrors the behaviour of the original
 * Python build so muscle memory (and old notes) still work:
 *
 *   parseWhen('+90m' | '21:30' | 'tomorrow 09:00' | '2026-12-25 10:00')
 *   parseInterval('6h' | 'every 6h' | '90m' | '2d' | '45')
 *   parseButtonRows('Label | https://x | primary')
 */

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Parse a human schedule time into a UNIX timestamp (seconds).
 * Returns null when unparseable or already in the past.
 */
export function parseWhen(text, now = new Date()) {
  let s = String(text ?? '').trim().toLowerCase();
  if (!s) return null;
  const at = (d) => d.getTime() / 1000;

  // +30m / +2h / +1d / +90 (minutes)
  let m = s.match(/^\+\s*(\d+)\s*([mhd]?)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2] || 'm';
    const secs = n * ({ m: 60, h: 3600, d: 86400 }[unit]);
    return at(new Date(now.getTime() + secs * 1000));
  }

  // +1d12h30m
  m = s.match(/^\+\s*(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/);
  if (m && (m[1] || m[2] || m[3])) {
    const d = parseInt(m[1] || '0', 10);
    const h = parseInt(m[2] || '0', 10);
    const mi = parseInt(m[3] || '0', 10);
    const when = new Date(now.getTime());
    when.setDate(when.getDate() + d);
    when.setHours(when.getHours() + h);
    when.setMinutes(when.getMinutes() + mi);
    return at(when);
  }

  // tomorrow / tmr  → tomorrow 09:00
  m = s.match(/^(?:tomorrow|tmr)$/);
  if (m) {
    const when = new Date(now.getTime());
    when.setDate(when.getDate() + 1);
    when.setHours(9, 0, 0, 0);
    return at(when);
  }

  // tomorrow 09:30
  m = s.match(/^(?:tomorrow|tmr)\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const when = new Date(now.getTime());
    when.setDate(when.getDate() + 1);
    when.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
    return at(when);
  }

  // 22:30 / 22:30:15 — today, or tomorrow if already past
  m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const when = new Date(now.getTime());
    when.setHours(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3] || '0', 10), 0);
    if (when.getTime() <= now.getTime()) when.setDate(when.getDate() + 1);
    return at(when);
  }

  // 2026-12-25 10:00 / 2026-12-25T10:00(:ss)
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ t](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const when = new Date(
      parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10),
      parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6] || '0', 10), 0,
    );
    if (Number.isNaN(when.getTime())) return null;
    // guard against JS rolling over an invalid date (Feb 31 → Mar 3)
    if (when.getMonth() !== parseInt(m[2], 10) - 1 || when.getDate() !== parseInt(m[3], 10)) return null;
    if (when.getTime() <= now.getTime()) return null;
    return at(when);
  }

  return null;
}

/** 'Fri 25 Sep 2026, 14:05' — local time, same shape as the Python build. */
export function fmtWhen(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  return `${DAYS[d.getDay()]} ${pad2(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 'in 1h 20m' / '2d 3h ago' style helper for status pages. */
export function fmtAgo(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

/**
 * Parse a repeat/spacing interval into seconds.
 * Accepts '6h', 'every 6h', '90m', '2d', '30s', '45' (bare number = minutes).
 * Returns integer seconds (min 60) or null.
 */
export function parseInterval(text) {
  let s = String(text ?? '').trim().toLowerCase();
  s = s.replace(/^every\s*/, '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const total = parseInt(s, 10) * 60;
    return total >= 60 ? total : null;
  }
  const m = s.match(/^(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/);
  if (m && (m[1] || m[2] || m[3] || m[4])) {
    const total = (parseInt(m[1] || '0', 10) * 86400)
      + (parseInt(m[2] || '0', 10) * 3600)
      + (parseInt(m[3] || '0', 10) * 60)
      + parseInt(m[4] || '0', 10);
    return total >= 60 ? total : null;
  }
  return null;
}

/**
 * Parse a *pacing delay* into seconds — like parseInterval but without the
 * one-minute floor, because per-channel delays are often `5s`.
 * Bare numbers mean SECONDS here (`5` → 5s). Returns seconds or null.
 */
export function parseDelay(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const total = parseInt(s, 10);
    return total >= 1 ? total : null;
  }
  const m = s.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/);
  if (m && (m[1] || m[2] || m[3])) {
    const total = (parseInt(m[1] || '0', 10) * 3600)
      + (parseInt(m[2] || '0', 10) * 60)
      + parseInt(m[3] || '0', 10);
    return total >= 1 ? total : null;
  }
  return null;
}

export const INLINE_STYLES = ['primary', 'success', 'danger'];

/**
 * Parse the /buttons mini-language into inline-keyboard rows.
 *
 * Each non-empty line is ONE row; buttons on the same row are separated by
 * `;;`.  Each button:  `Label | https://url | primary`  or  `Label | cb:data`.
 * Returns `{ rows, errors }`.
 */
export function parseButtonRows(text) {
  const rows = [];
  const errors = [];
  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const lineNo = idx + 1;
    const row = [];
    for (const rawPart of line.split(';;')) {
      const part = rawPart.trim();
      if (!part) continue;
      const segs = part.split('|').map((s) => s.trim());
      if (segs.length < 2) {
        errors.push(`line ${lineNo}: use \`Label | url-or-cb:data | color\` — got ${JSON.stringify(part)}`);
        continue;
      }
      const label = segs[0];
      const action = segs[1];
      let style = segs[2] || null;
      if (style && !INLINE_STYLES.includes(style)) {
        errors.push(`line ${lineNo}: style must be one of ${INLINE_STYLES.join('/')} (got ${JSON.stringify(style)})`);
        style = null;
      }
      if (!label) {
        errors.push(`line ${lineNo}: empty button label`);
        continue;
      }
      const btn = { text: label.slice(0, 64) };
      if (action.startsWith('cb:')) {
        const data = action.slice(3);
        const bytes = Buffer.byteLength(data, 'utf8');
        if (bytes < 1 || bytes > 64) {
          errors.push(`line ${lineNo}: callback_data must be 1-64 bytes`);
          continue;
        }
        btn.callback_data = data;
      } else if (action.startsWith('http://') || action.startsWith('https://')) {
        btn.url = action;
      } else {
        errors.push(`line ${lineNo}: action must be a https:// URL or cb:data — got ${JSON.stringify(action)}`);
        continue;
      }
      if (style) btn.style = style;
      row.push(btn);
    }
    if (row.length) rows.push(row);
  });
  return { rows, errors };
}

/** Build an InlineKeyboardMarkup from rows of button dicts. */
export function kb(rows) {
  return { inline_keyboard: rows || [] };
}

/** Human byte count for logs. */
export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
