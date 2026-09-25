/**
 * src/telegram.js — a tiny, dependency-free Telegram Bot API client.
 *
 * Targets Bot API 10.3.  Uses Node's built-in global `fetch`, `FormData` and
 * `Blob` (Node 18+), so the bot can call brand-new methods such as
 * `sendRichMessage`, `sendRichMessageDraft` and `editEphemeralMessageText`
 * without waiting for any framework to catch up.
 *
 * JSON conventions: when a request is sent as `application/json` (the
 * default here) every parameter the docs call "a JSON-serialized object" can
 * be passed as a real nested object/array.  Multipart uploads stringify those
 * fields automatically.
 */

import { logger } from './logger.js';
import { sleep } from './utils.js';

const log = logger('telegram');

export class TelegramError extends Error {
  constructor(method, description, errorCode, params = {}) {
    super(`${method} failed (${errorCode}): ${description}`);
    this.name = 'TelegramError';
    this.method = method;
    this.description = description || '';
    this.errorCode = errorCode;
    this.params = params || {};
  }

  get retryAfter() {
    return this.params?.retry_after ?? null;
  }

  /** Case-insensitive "description contains fragment" test. */
  matches(...fragments) {
    const d = this.description.toLowerCase();
    return fragments.some((f) => d.includes(String(f).toLowerCase()));
  }
}

/** True for errors that mean "this chat/message is unusable", not "retry". */
export function isPermanent(err) {
  return err instanceof TelegramError && err.errorCode >= 400 && err.errorCode < 500
    && !err.retryAfter;
}

/**
 * True when the API server does not know the method at all — e.g. an older or
 * self-hosted Bot API server that predates `sendRichMessage`. Callers use this
 * to degrade gracefully instead of failing the whole publish.
 */
export function isUnknownMethod(err) {
  return err instanceof TelegramError
    && (err.errorCode === 404
      || /method (not found|is not available)|unknown method|not implemented|unsupported method/i
        .test(err.description || ''));
}

/**
 * True when Telegram rejected `message_effect_id` — the ids are undocumented
 * and get rotated, so the send is retried without the effect instead of being
 * lost (see content.EFFECTS).
 */
export function isEffectError(err) {
  if (!(err instanceof TelegramError)) return false;
  if (err.errorCode !== 400) return false;
  return /effect_id|effect id|message_effect/i.test(err.description || '');
}

function timeoutSignal(seconds) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(Math.max(1000, Math.round(seconds * 1000)));
  }
  return undefined;
}

export class Telegram {
  constructor(token, { timeout = 60, maxRetries = 3, base = 'https://api.telegram.org' } = {}) {
    this.token = token;
    this.timeout = timeout;
    this.maxRetries = maxRetries;
    this.base = String(base || 'https://api.telegram.org').replace(/\/+$/, '');
    this.offset = 0;
    this.calls = 0;
    /** Effect ids Telegram has already rejected — never sent twice. */
    this.deadEffectIds = new Set();
  }

  // ------------------------------------------------------------------ core

  /**
   * POST a JSON request; resolves with the `result` field.
   *
   * `message_effect_id` gets special care: Telegram's effect ids are
   * undocumented and rotate, so a rejected one (`EFFECT_ID_INVALID`) is
   * remembered and the very same message is retried without the effect — an
   * animation is never worth losing a /start or a publish over.
   */
  async call(method, params = {}, { timeout = null } = {}) {
    const payload = {};
    for (const [k, v] of Object.entries(params)) {
      if (v === null || v === undefined) continue;
      payload[k] = v;
    }
    if (payload.message_effect_id !== undefined
        && this.deadEffectIds.has(String(payload.message_effect_id))) {
      delete payload.message_effect_id;
    }
    const send = () => this.#request(method, {
      body: JSON.stringify(payload),
      contentType: 'application/json',
      timeout: timeout ?? this.timeout,
    });
    try {
      return await send();
    } catch (err) {
      if (!isEffectError(err) || payload.message_effect_id === undefined) throw err;
      this.#dropEffect(method, payload, err);
      return send();
    }
  }

  /**
   * POST multipart/form-data.
   * `files` maps field name → { filename, bytes (Buffer|Uint8Array), contentType }.
   * Needed when a rich message embeds uploads via `attach://<name>`.
   */
  async callMultipart(method, files, params = {}, { timeout = null } = {}) {
    const build = () => {
      const form = new FormData();
      for (const [k, v] of Object.entries(params)) {
        if (v === null || v === undefined) continue;
        if (k === 'message_effect_id' && this.deadEffectIds.has(String(v))) continue;
        form.append(k, (typeof v === 'object') ? JSON.stringify(v) : String(v));
      }
      for (const [name, file] of Object.entries(files || {})) {
        const blob = new Blob([file.bytes], { type: file.contentType || 'application/octet-stream' });
        form.append(name, blob, file.filename || name);
      }
      return form;
    };
    const send = () => this.#request(method, {
      body: build(),
      contentType: null, // fetch sets the multipart boundary itself
      timeout: (timeout ?? this.timeout) + 60,
    });
    try {
      return await send();
    } catch (err) {
      if (!isEffectError(err) || params.message_effect_id === undefined) throw err;
      this.#dropEffect(method, params, err);
      return send();
    }
  }

  /** Forget an effect id Telegram refused and warn once, so the log explains it. */
  #dropEffect(method, params, err) {
    const id = params.message_effect_id;
    this.deadEffectIds.add(String(id));
    delete params.message_effect_id;
    log.warn(`${method}: message_effect_id ${id} rejected (${err.description}) — `
      + 'resending without the effect; update APB_EFFECT_IDS to fix the animation');
  }

  async #request(method, { body, contentType, timeout }) {
    const url = `${this.base}/bot${this.token}/${method}`;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      this.calls += 1;
      try {
        const headers = contentType ? { 'content-type': contentType } : {};
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: timeoutSignal(timeout),
        });
        const raw = await res.text();
        let data;
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch {
          data = {};
        }
        if (!res.ok) {
          const params = data.parameters || {};
          const code = data.error_code ?? res.status;
          const desc = data.description || raw.slice(0, 300) || `HTTP ${res.status}`;
          if ((code === 429 || code >= 500) && attempt <= this.maxRetries) {
            const delaySec = params.retry_after ?? Math.min(2 ** attempt, 15);
            log.warn(`${method}: HTTP ${code}, retrying in ${delaySec}s`);
            await sleep(delaySec * 1000);
            continue;
          }
          throw new TelegramError(method, desc, code, params);
        }
        if (!data.ok) {
          throw new TelegramError(method, data.description || 'unknown error', data.error_code ?? -1, data.parameters || {});
        }
        return data.result;
      } catch (err) {
        if (err instanceof TelegramError) throw err;
        if (attempt <= this.maxRetries) {
          const delaySec = Math.min(2 ** attempt, 15);
          log.warn(`${method}: network error (${err?.message || err}), retrying in ${delaySec}s`);
          await sleep(delaySec * 1000);
          continue;
        }
        throw new TelegramError(method, String(err?.message || err), -1);
      }
    }
  }

  // --------------------------------------------------------------- polling

  /** One long-poll call; remembers the update offset internally. */
  async getUpdates({ pollTimeout = 25, limit = 100, allowedUpdates = null } = {}) {
    const params = { timeout: pollTimeout, limit };
    if (this.offset) params.offset = this.offset;
    if (allowedUpdates) params.allowed_updates = allowedUpdates;
    const updates = await this.call('getUpdates', params, { timeout: pollTimeout + 20 });
    if (Array.isArray(updates) && updates.length) {
      this.offset = updates[updates.length - 1].update_id + 1;
    }
    return updates || [];
  }

  /** Infinite async generator of updates (never throws). */
  async *updates({ pollTimeout = 25, allowedUpdates = null, shouldStop = () => false } = {}) {
    while (!shouldStop()) {
      try {
        const batch = await this.getUpdates({ pollTimeout, allowedUpdates });
        for (const update of batch) {
          yield update;
          if (shouldStop()) return;
        }
      } catch (err) {
        if (shouldStop()) return;
        log.error(`polling error: ${err?.message || err}`);
        await sleep(3000);
      }
    }
  }

  // -------------------------------------------------- Bot API 10.x sugar

  /** sendRichMessage — `richMessage` is an InputRichMessage dict. */
  sendRich(chatId, richMessage, kwargs = {}) {
    return this.call('sendRichMessage', { chat_id: chatId, rich_message: richMessage, ...kwargs });
  }

  /** sendRichMessage with file uploads (`attach://<name>` media). */
  sendRichMultipart(chatId, richMessage, files, kwargs = {}) {
    return this.callMultipart('sendRichMessage', files, { chat_id: chatId, rich_message: richMessage, ...kwargs });
  }

  /** getFile + download → Buffer (watermarking, re-uploads). */
  async downloadFile(fileId) {
    const info = await this.call('getFile', { file_id: fileId });
    const filePath = info?.file_path;
    if (!filePath) throw new TelegramError('getFile', 'no file_path returned', -1);
    const url = `${this.base}/file/bot${this.token}/${filePath}`;
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const res = await fetch(url, { signal: timeoutSignal(this.timeout) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      } catch (err) {
        lastErr = err;
        await sleep(1000);
      }
    }
    throw new TelegramError('download', String(lastErr?.message || lastErr), -1);
  }

  /** editMessageText with rich_message (text and rich_message are exclusive). */
  editRich(chatId, messageId, richMessage, kwargs = {}) {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, rich_message: richMessage, ...kwargs });
  }

  /**
   * sendRichMessageDraft — animated streaming preview (private chats).
   * The draft lives ~30s and must be finalized with a regular sendRich call.
   * Repeated calls with the same draft_id animate the change.
   */
  sendDraft(chatId, draftId, richMessage, { canStop = null, keepOnStop = null } = {}) {
    return this.call('sendRichMessageDraft', {
      chat_id: chatId,
      draft_id: draftId,
      rich_message: richMessage,
      can_stop: canStop,
      keep_on_stop: keepOnStop,
    });
  }

  /** Send a rich message only `receiverUserId` can see (groups, 10.2/10.3). */
  sendEphemeralRich(chatId, receiverUserId, richMessage, kwargs = {}) {
    const { callbackQueryId = null, replaceCallbackQueryMessage = null, ...rest } = kwargs;
    const ephemeral = { receiver_user_id: receiverUserId };
    if (callbackQueryId !== null) ephemeral.callback_query_id = callbackQueryId;
    if (replaceCallbackQueryMessage !== null) ephemeral.replace_callback_query_message = replaceCallbackQueryMessage;
    return this.call('sendRichMessage', {
      chat_id: chatId,
      rich_message: richMessage,
      ephemeral_message_parameters: ephemeral,
      ...rest,
    });
  }

  editEphemeralRich(receiverUserId, ephemeralMessageId, richMessage, kwargs = {}) {
    return this.call('editEphemeralMessageText', {
      receiver_user_id: receiverUserId,
      ephemeral_message_id: ephemeralMessageId,
      rich_message: richMessage,
      ...kwargs,
    });
  }

  deleteEphemeral(chatId, receiverUserId, ephemeralMessageId) {
    return this.call('deleteEphemeralMessage', {
      chat_id: chatId,
      receiver_user_id: receiverUserId,
      ephemeral_message_id: ephemeralMessageId,
    });
  }

  // ------------------------------------------------------ classic helpers

  sendText(chatId, text, kwargs = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, ...kwargs });
  }

  answerCbq(callbackQueryId, { text = null, showAlert = null } = {}) {
    return this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    });
  }

  /** setMessageReaction with a single emoji (free, any chat type). */
  react(chatId, messageId, emoji) {
    return this.call('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji }],
    });
  }
}

export default Telegram;
