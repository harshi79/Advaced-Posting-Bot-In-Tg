/**
 * src/smooth.js — buttery-smooth message editing & live streaming.
 *
 * Two mechanisms, both free:
 *
 *   SmoothEditor — debounced `editMessageText` with `rich_message`.  Rapid
 *   updates are coalesced into at most one edit per interval (default ~1.1s,
 *   Telegram's practical edit cadence), identical payloads are skipped, 429s
 *   are retried after `retry_after`.  Result: flicker-free live updates.
 *
 *   SmoothStream — AI-style live typing via `sendRichMessageDraft` (Bot API
 *   10.1).  Telegram animates the change when the same draft_id is reused, so
 *   the preview streams instead of flashing.  Private chats only; it falls
 *   back to a SmoothEditor on a real message anywhere else.
 */

import { TelegramError } from './telegram.js';
import { logger } from './logger.js';
import { sleep } from './utils.js';

const log = logger('smooth');

/** Run `fn` at most once per interval; always flush the last call. */
export class Debouncer {
  constructor(intervalMs, fn) {
    this.interval = Math.max(50, intervalMs);
    this._fn = fn;
    this._pending = false;
    this._last = 0;
    this._timer = null;
    this._closed = false;
    this._running = Promise.resolve();
  }

  call() {
    if (this._closed) return;
    this._pending = true;
    const wait = this._last + this.interval - Date.now();
    if (wait <= 0) this.#run();
    else this.#schedule(wait);
  }

  #schedule(wait) {
    if (this._timer || this._closed) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.#run();
    }, wait);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  #run() {
    if (this._closed || !this._pending) return;
    this._pending = false;
    this._last = Date.now();
    this._running = Promise.resolve()
      .then(() => this._fn())
      .catch((err) => log.debug(`debounced fn error: ${err?.message || err}`));
  }

  /** Wait until any pending call has been sent (up to `timeoutMs`). */
  async flush(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this._pending && !this._timer) {
        await this._running;
        return true;
      }
      await sleep(20);
    }
    return false;
  }

  close() {
    this._closed = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

function stableKey(value) {
  try {
    return JSON.stringify(value, (key, val) => {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        return Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]));
      }
      return val;
    });
  } catch {
    return String(value);
  }
}

/**
 * Live editor for one already-sent message.
 * `update()` as often as you like — the message changes at a steady pace.
 */
export class SmoothEditor {
  constructor(api, chatId, messageId, { minInterval = 1100, parseMode = null } = {}) {
    this.api = api;
    this.chatId = chatId;
    this.messageId = messageId;
    this.parseMode = parseMode;
    this.lastPayload = null;
    this.lastError = null;
    this._payload = null;
    this._debounce = new Debouncer(minInterval, () => this.#flush());
  }

  /** Queue a new state; exactly one of richMessage / text. */
  update({ richMessage = null, text = null, replyMarkup = null } = {}) {
    this._payload = { rich_message: richMessage, text, reply_markup: replyMarkup };
    this._debounce.call();
  }

  /** Wait until any pending debounced edit has been sent. */
  flush(timeoutMs = 5000) {
    return this._debounce.flush(timeoutMs);
  }

  async close() {
    await this._debounce.flush();
    this._debounce.close();
  }

  async #flush() {
    const payload = this._payload;
    this._payload = null;
    if (payload === null) return;
    const signature = stableKey(payload);
    if (signature === this.lastPayload) return;
    try {
      if (payload.rich_message !== null && payload.rich_message !== undefined) {
        await this.api.editRich(this.chatId, this.messageId, payload.rich_message, {
          reply_markup: payload.reply_markup ?? undefined,
        });
      } else {
        const kwargs = {};
        if (this.parseMode) kwargs.parse_mode = this.parseMode;
        await this.api.call('editMessageText', {
          chat_id: this.chatId,
          message_id: this.messageId,
          text: payload.text || '…',
          reply_markup: payload.reply_markup ?? undefined,
          ...kwargs,
        });
      }
      this.lastPayload = signature;
      this.lastError = null;
    } catch (err) {
      this.lastError = err;
      if (!(err instanceof TelegramError)) throw err;
      if (err.matches('message is not modified')) {
        this.lastPayload = signature;
        return;
      }
      if (err.matches('message to edit not found', "can't be edited", 'MESSAGE_ID_INVALID')) {
        log.debug(`edit target gone: ${err.message}`);
        this._debounce.close();
        return;
      }
      if (err.errorCode === 429) {
        this._payload = payload;
        const retryAfter = err.retryAfter ?? 1;
        this._debounce.interval = Math.max(this._debounce.interval, (retryAfter + 0.5) * 1000);
        this._debounce.call();
        return;
      }
      throw err;
    }
  }
}

function blocksOf(rich) {
  if (rich && typeof rich === 'object' && Array.isArray(rich.blocks)) return [...rich.blocks];
  return [];
}

/**
 * AI-style streaming reply.
 *
 * Private chats: `sendRichMessageDraft` with a stable draft_id (Telegram
 * animates the changes), an optional shimmering *thinking* block while content
 * is produced, then a final `sendRichMessage` that persists the message.
 * Elsewhere: a real message live-edited through a SmoothEditor.
 */
export class SmoothStream {
  constructor(api, chatId, {
    draftId = null, privateChat = true, editInterval = 1100, draftInterval = 500,
  } = {}) {
    this.api = api;
    this.chatId = chatId;
    this.draftId = draftId ?? (Date.now() % 2147483647);
    this.privateChat = privateChat;
    this.editor = null;
    this.message = null;
    this.aborted = false;
    this._keepOnStop = false;
    this._current = null;
    this._debounce = new Debouncer(this.privateChat ? draftInterval : editInterval, () => this.#flush());
  }

  /** Show the streaming placeholder (thinking block or first content). */
  async begin({ thinkingText = null, rich = null } = {}) {
    if (this.aborted) return;
    if (this.privateChat) {
      const blocks = [];
      if (thinkingText) blocks.push({ type: 'thinking', text: thinkingText });
      if (rich) blocks.push(...blocksOf(rich));
      try {
        await this.api.sendDraft(
          this.chatId,
          this.draftId,
          blocks.length ? { blocks } : { markdown: '…' },
          { canStop: true, keepOnStop: true },
        );
        return;
      } catch (err) {
        log.debug(`draft failed (${err?.message || err}); falling back to edits`);
        this.privateChat = false;
      }
    }
    const first = rich ?? { markdown: `_${thinkingText || 'Thinking…'}_` };
    this.message = await this.#send(first);
    if (this.message) {
      this.editor = new SmoothEditor(this.api, this.chatId, this.message.message_id);
    }
  }

  /** Stream new (partial) content; same draft_id → animated change. */
  update(rich) {
    if (this.aborted) return;
    this._current = rich;
    if (this.privateChat) this._debounce.call();
    else if (this.editor) this.editor.update({ richMessage: rich });
  }

  /** Persist the full message; resolves with the sent Message (or null). */
  async finalize(rich, kwargs = {}) {
    await this._debounce.flush(3000);
    this._debounce.close();
    if (this.aborted && !this._keepOnStop) return null;
    const msg = await this.#send(rich, kwargs);
    if (msg) this.message = msg;
    if (this.editor) await this.editor.close();
    return msg;
  }

  /**
   * Stop streaming. keep=true lets a later finalize() still persist what has
   * been streamed so far (the draft was sent with keep_on_stop).
   */
  abort(keep = false) {
    this.aborted = true;
    this._keepOnStop = keep;
    this._debounce.close();
    if (this.editor && !keep) this.editor.close();
  }

  async #send(rich, kwargs = {}) {
    try {
      return await this.api.sendRich(this.chatId, rich, kwargs);
    } catch (err) {
      if (err instanceof TelegramError && err.errorCode === 429 && err.retryAfter) {
        await sleep((err.retryAfter + 0.2) * 1000);
        return this.api.sendRich(this.chatId, rich, kwargs);
      }
      throw err;
    }
  }

  async #flush() {
    const rich = this._current;
    if (rich === null || rich === undefined) return;
    try {
      await this.api.sendDraft(this.chatId, this.draftId, rich, { canStop: true, keepOnStop: true });
    } catch (err) {
      if (!(err instanceof TelegramError)) {
        log.debug(`draft update failed: ${err?.message || err}`);
        return;
      }
      if (err.matches('message to edit not found', 'MESSAGE_ID_INVALID')) return;
      if (err.errorCode === 429) {
        const retryAfter = err.retryAfter ?? 1;
        this._debounce.interval = Math.max(this._debounce.interval, (retryAfter + 0.5) * 1000);
        this._current = rich;
        this._debounce.call();
      } else {
        log.debug(`draft update failed: ${err.message}`);
      }
    }
  }
}

/**
 * Convenience typewriter: stream `text` word-by-word, then finalize.
 * Returns the final Message.
 */
export async function streamWords(api, chatId, text, {
  draftId = null, privateChat = true, wordsPerStep = 2, stepDelay = 350,
  thinkingText = null, ...sendKwargs
} = {}) {
  const stream = new SmoothStream(api, chatId, { draftId, privateChat });
  await stream.begin({ thinkingText: thinkingText || 'Thinking…' });
  const words = String(text).split(' ');
  const buf = [];
  for (let i = 0; i < words.length; i += wordsPerStep) {
    if (stream.aborted) return null;
    buf.push(...words.slice(i, i + wordsPerStep));
    stream.update({ markdown: `${buf.join(' ')} ▌` });
    await sleep(stepDelay);
  }
  return stream.finalize({ markdown: text }, sendKwargs);
}
