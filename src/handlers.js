/**
 * src/handlers.js — commands, callbacks and the post-composer wizard.
 *
 * The bot's brain: it wires the free Bot API 10.1–10.3 goodies into a posting
 * workflow —
 *   * compose in Markdown → live, smoothly edited preview,
 *   * publish here / to a channel / broadcast to everyone (paced),
 *   * schedule in natural language (with recurring repeats),
 *   * AI-style streaming (sendRichMessageDraft + thinking block),
 *   * ephemeral group replies, colored buttons everywhere.
 *
 * Posto-style extras (channels, bulk, templates, turbo, slideshow, AI,
 * watermarks, paid posts) live in ./posto.js and are mixed into this class —
 * exactly like the original Python mixin.
 */

import * as R from './rich.js';
import * as content from './content.js';
import { TelegramError, isUnknownMethod } from './telegram.js';
import { NVIDIA } from './nvidia.js';
import { SmoothEditor, SmoothStream } from './smooth.js';
import { fmtWhen, kb, parseButtonRows, parseWhen, sleep } from './utils.js';
import { logger } from './logger.js';
import { postoMethods } from './posto.js';

const log = logger('bot');

export const CB = 'apb';   // callback namespace

export class Bot {
  constructor(api, store, { admins = [], ai = null } = {}) {
    this.api = api;
    this.store = store;
    this.admins = admins.length ? [...admins] : [...(store.data.admins || [])];
    this.composers = new Map();   // chat_id -> composer state
    this.streams = new Map();     // chat_id -> SmoothStream
    this._queue = Promise.resolve();
    this.initPosto(ai || new NVIDIA(
      process.env.APB_NVIDIA_KEY || process.env.NVIDIA_API_KEY || null,
    ));
  }

  /**
   * Effect id for `emoji`, honouring `settings.effect_ids` in data/apb.json
   * and the `APB_EFFECT_IDS` env var. Returns null when nothing valid is known,
   * so callers send the message *without* the effect instead of failing.
   */
  effectId(emoji) {
    return content.effectId(emoji, this.store.setting('effect_ids'));
  }

  // ================================================================= router

  /** Enqueue an update; handlers run strictly in order, never concurrently. */
  dispatch(update) {
    if (!update || typeof update !== 'object') return;
    this._queue = this._queue
      .then(() => this.#handle(update))
      .catch((err) => log.error(`update handling crashed\n${err?.stack || err}`));
  }

  /** Await idle (used by the self-test and by graceful shutdown). */
  idle() {
    return this._queue;
  }

  async #handle(update) {
    if (update.message) await this.onMessage(update.message);
    else if (update.callback_query) await this.onCallback(update.callback_query);
    else if (update.stopped_message_generation) this.onGenerationStopped(update.stopped_message_generation);
  }

  async onMessage(msg) {
    try {
      await this.#onMessage(msg);
    } catch (err) {
      if (err instanceof TelegramError) {
        log.error(`telegram error: ${err.message}`);
        await this.tryReplyError(msg, err);
      } else {
        log.error(`handler crashed\n${err?.stack || err}`);
      }
    }
  }

  async #onMessage(msg) {
    const chat = msg.chat || {};
    const chatId = chat.id;
    if (chatId === undefined || chatId === null) return;
    const user = msg.from || {};
    const uid = user.id;
    if (chat.type === 'private') this.store.chatEnsure(chatId, user.first_name || '', 'private');

    const text = String(msg.text || msg.caption || '').trim();
    if (text.startsWith('/')) {
      await this.routeCommand(text, msg);
      return;
    }
    if (this.postoMessage(msg, chatId)) return;

    const comp = this.composers.get(chatId);
    if (comp) {
      await this.feedComposer(chatId, msg, comp);
    } else if (chat.type === 'private' && this.isAdmin(uid)) {
      await this.api.sendRich(chatId, R.markdownMessage(
        'Got it 🙂 — **/post** starts a new post, **/demo** shows everything this bot can do.',
      ));
    }
  }

  async routeCommand(text, msg) {
    const pieces = text.split(/\s+/);
    const name = pieces[0].slice(1).split('@')[0].toLowerCase();
    const args = text.slice(pieces[0].length).trim();
    const table = {
      start: this.cmdStart, help: this.cmdHelp,
      demo: this.cmdDemo, post: this.cmdPost, new: this.cmdPost,
      preview: this.cmdPreview, done: this.cmdDone,
      buttons: this.cmdButtons, cancel: this.cmdCancel,
      stop: this.cmdStop, drafts: this.cmdDrafts,
      schedule: this.cmdSchedule, bcast: this.cmdBcast,
      broadcast: this.cmdBcast, edit: this.cmdEdit,
      stream: this.cmdStream, stats: this.cmdStats,
      id: this.cmdId, ping: this.cmdPing,
      channels: this.cmdChannels, templates: this.cmdTemplates,
      bulk: this.cmdBulk, turbo: this.cmdTurbo,
      slideshow: this.cmdSlideshow, ai: this.cmdAi,
    };
    const handler = table[name];
    if (!handler) return;
    try {
      await handler.call(this, msg, args);
    } catch (err) {
      log.error(`command /${name} failed: ${err?.message || err}`);
      if (err instanceof TelegramError) {
        await this.tryReplyError(msg, err);
      } else {
        log.error(err?.stack || String(err));
        try {
          await this.api.sendText(msg.chat.id, '😵 Something broke — see logs.');
        } catch { /* ignore */ }
      }
    }
  }

  async tryReplyError(msg, err) {
    try {
      const chatId = msg?.chat?.id;
      if (chatId !== undefined) {
        await this.api.sendRich(chatId, R.markdownMessage(`⚠️ Telegram said no: \`${String(err).slice(0, 300)}\``));
      }
    } catch { /* ignore */ }
  }

  // =============================================================== commands

  async cmdStart(msg) {
    const chat = msg.chat;
    const irm = R.richMessage({ blocks: content.welcomeBlocks() });
    const keyboard = kb([
      [{ text: '✨ Show me everything', callback_data: `${CB}:demo`, style: 'primary' }],
      [{ text: '🔁 Smooth streaming demo', callback_data: `${CB}:stream` }],
    ]);
    if (this.isAdmin(msg.from?.id) && chat.type === 'private') {
      keyboard.inline_keyboard.push([{ text: '✍️ New post', callback_data: `${CB}:post`, style: 'success' }]);
    }
    const kwargs = {};
    const heart = this.effectId('❤️');
    if (chat.type === 'private' && heart) kwargs.message_effect_id = heart;
    await this.api.sendRich(chat.id, irm, { reply_markup: keyboard, ...kwargs });
  }

  async cmdHelp(msg) {
    await this.api.sendRich(msg.chat.id, R.markdownMessage(content.helpMarkdown()));
  }

  async cmdDemo(msg) {
    const m = await this.api.sendRich(msg.chat.id, R.richMessage({ blocks: content.demoBlocks() }), {
      reply_markup: content.demoFooterKeyboard(),
    });
    try {
      await this.api.react(msg.chat.id, m.message_id, '🔥');
    } catch { /* reactions are optional */ }
  }

  async cmdStats(msg) {
    const s = this.store.stats();
    const blocks = [
      R.heading('📊 Delivery stats', 3),
      R.table(
        [
          ['Metric', 'Value'],
          ['Chats seen', s.chats],
          ['Channels', s.channels],
          ['Templates', s.templates],
          ['Drafts', s.drafts],
          ['Scheduled (incl. recurring)', s.scheduled],
          ['Posts delivered', s.sent],
          ['Failed sends', s.failed],
        ],
        { aligns: ['left', 'right'], compact: true },
      ),
      R.paragraph([R.code(this.ai.statusLine())]),
      R.footer(`⚡ turbo ${this.store.setting('turbo') ? 'on' : 'off'} · ©️ watermark `
        + `${this.store.setting('watermark_on') ? 'on' : 'off'} · runtime Node ${process.version} · stats live in data/apb.json`),
    ];
    await this.api.sendRich(msg.chat.id, R.richMessage({ blocks }));
  }

  async cmdId(msg) {
    const chat = msg.chat;
    const user = msg.from || {};
    const md = `🆔 **Chat id:** \`${chat.id}\`\n👤 **Your id:** \`${user.id ?? '?'}\`\n🏷 Type: \`${chat.type}\``;
    if (['group', 'supergroup'].includes(chat.type)) {
      try {
        await this.api.sendEphemeralRich(chat.id, user.id, R.markdownMessage(md));
        return;
      } catch { /* fall through to a normal message */ }
    }
    await this.api.sendRich(chat.id, R.markdownMessage(md));
  }

  async cmdPing(msg) {
    const chat = msg.chat;
    const user = msg.from || {};
    if (['group', 'supergroup'].includes(chat.type)) {
      try {
        await this.api.sendEphemeralRich(chat.id, user.id, R.markdownMessage('🏓 pong — only you see this'));
        return;
      } catch { /* fall through */ }
    }
    await this.api.sendText(chat.id, '🏓 pong');
  }

  // --------------------------------------------------------------- composer

  async cmdPost(msg, args, comp = null) {
    const chat = msg.chat;
    if (!(await this.ensureAdmin(msg))) return;
    const state = comp || this.newComposer(chat.id);
    this.composers.set(chat.id, state);
    const panel = await this.api.sendRich(chat.id, R.markdownMessage(this.panelMd(state)), {
      reply_markup: this.composeKb('compose', state),
    });
    state.panel_msg = panel.message_id;
    state.panel_editor = new SmoothEditor(this.api, chat.id, panel.message_id, { minInterval: 900 });
  }

  newComposer(chatId) {
    return {
      chat_id: chatId,
      state: 'content',
      parts: [],
      media: [],
      mode: 'rich',
      buttons: [],
      effect: null,
      slideshow: false,
      stars: null,
      signature: '',
      backup_parts: null,
      panel_msg: null,
      panel_editor: null,
      preview_msg: null,
      preview_editor: null,
      published: null,
    };
  }

  async feedComposer(chatId, msg, comp) {
    const state = comp.state;
    const text = String(msg.text || msg.caption || '').trim();

    if (await this.postoComposerFeed(comp, text, msg)) return;

    if (state === 'content') {
      const media = this.extractMedia(msg);
      if (media) {
        const slot = `m${comp.media.length + 1}`;
        comp.media.push({ id: slot, kind: media.kind, media: media.file_id });
        this.updatePanel(comp, {
          extra: `📎 ${media.kind} saved as \`${slot}\` — embed: \`![](tg://${media.kind}?id=${slot})\``,
        });
        return;
      }
      if (text) {
        comp.parts.push(text);
        this.updatePanel(comp);
        this.refreshPreview(comp);
      }
      return;
    }

    if (state === 'await_channel') {
      const target = text.split(/\s+/)[0] || '';
      if (!(target.startsWith('@') || /^-?\d+$/.test(target))) {
        this.updatePanel(comp, { extra: '⚠️ Send an `@username` or a numeric chat id.' });
        return;
      }
      comp.target = { kind: 'channel', chat_id: target };
      comp.state = 'published_panel';
      await this.publishTo(comp, { kind: 'channel', chat_id: target });
      return;
    }

    if (state === 'await_time') {
      const when = parseWhen(text);
      if (when === null) {
        this.updatePanel(comp, {
          extra: "⏰ Couldn't parse that. Try `+2h`, `21:30`, `tomorrow 09:00` or `2026-12-25 10:00`.",
        });
        return;
      }
      this.askRepeat(comp, when);
      return;
    }

    if (state === 'await_buttons') {
      const { rows, errors } = parseButtonRows(text);
      if (errors.length) {
        this.updatePanel(comp, { extra: `⚠️ ${errors.slice(0, 3).join('\n⚠️ ')}` });
        return;
      }
      comp.buttons = rows;
      comp.state = 'content';
      this.updatePanel(comp, { extra: `🔘 ${rows.length} button row(s) saved.` });
      this.refreshPreview(comp);
      return;
    }

    if (state === 'await_edit') {
      if (text) {
        this.typewriterEdit(comp.edit_chat, comp.edit_msg, text);
        this.composers.delete(chatId);
      }
    }
  }

  extractMedia(msg) {
    if (msg.photo?.length) return { kind: 'photo', file_id: msg.photo[msg.photo.length - 1].file_id };
    for (const [key, kind] of [['video', 'video'], ['animation', 'animation'],
      ['audio', 'audio'], ['voice', 'voice_note'], ['document', 'document']]) {
      if (msg[key]) return { kind, file_id: msg[key].file_id };
    }
    return null;
  }

  // ------------------------------------------------------- composer commands

  async cmdPreview(msg) {
    const comp = this.composers.get(msg.chat.id);
    if (!comp) {
      await this.api.sendText(msg.chat.id, 'Nothing to preview — /post first.');
      return;
    }
    await this.sendPreview(comp);
  }

  async cmdDone(msg) {
    const comp = this.composers.get(msg.chat.id);
    if (!comp) {
      await this.api.sendText(msg.chat.id, 'Nothing to finish — /post first.');
      return;
    }
    if (!comp.parts.length) {
      this.updatePanel(comp, { extra: '📭 Nothing composed yet — send some Markdown first.' });
      return;
    }
    if (comp.preview_msg === null) await this.sendPreview(comp);
    if (await this.turboTryPublish(comp)) return;
    comp.state = 'published_panel';
    this.updatePanel(comp);
  }

  async cmdButtons(msg) {
    const comp = this.composers.get(msg.chat.id);
    if (!comp) {
      await this.api.sendText(msg.chat.id, 'Start /post first.');
      return;
    }
    comp.state = 'await_buttons';
    this.updatePanel(comp, {
      extra: '🔘 **Buttons** — one row per line, buttons on the same row split by `;;`:\n'
        + '```\n'
        + 'Read more | https://example.com | primary\n'
        + '👍 Like | cb:like ;; 🔄 Share | cb:share\n'
        + 'Delete | cb:delete | danger\n'
        + '```\n'
        + 'Colors: `primary` 🔵 `success` 🟢 `danger` 🔴. Send the lines now.',
    });
  }

  async cmdCancel(msg) {
    const chatId = msg.chat.id;
    const comp = this.composers.get(chatId);
    this.composers.delete(chatId);
    if (comp) await this.finishPanel(comp, '🚫 Composer closed.');
    else this.streams.get(chatId)?.abort(false);
    this.postoCancel(chatId);
  }

  async cmdStop(msg) {
    this.streams.get(msg.chat.id)?.abort(true);
  }

  async cmdDrafts(msg) {
    if (!(await this.ensureAdmin(msg))) return;
    let rows = [];
    for (const [did, d] of this.store.drafts().slice(0, 8)) {
      rows.push([
        { text: `📝 ${String(d.title || 'untitled').slice(0, 40)}`, callback_data: `${CB}:draft:load:${did}` },
        { text: '🗑', callback_data: `${CB}:draft:del:${did}`, style: 'danger' },
      ]);
    }
    if (!rows.length) rows = [[{ text: '📭 no drafts yet', callback_data: `${CB}:noop` }]];
    await this.api.sendRich(msg.chat.id, R.markdownMessage('🗂 **Saved drafts** — tap to load into the composer.'), {
      reply_markup: kb(rows),
    });
  }

  async cmdSchedule(msg) {
    if (!(await this.ensureAdmin(msg))) return;
    const rows = [];
    const lines = ['⏰ **Scheduled posts**\n'];
    for (const [jid, job] of this.store.scheduled().slice(0, 8)) {
      const when = fmtWhen(job.run_at);
      const status = job.status === 'pending' ? '' : ` · ${job.status || ''}`;
      const rep = job.repeat || 'none';
      let repTxt = { none: '', hourly: ' · 🔁 hourly', daily: ' · 🔁 daily', weekly: ' · 🔁 weekly' }[rep];
      if (repTxt === undefined) {
        repTxt = (typeof rep === 'string' && rep.startsWith('every:'))
          ? ` · 🔁 every ${(parseFloat(rep.split(':')[1]) / 3600).toFixed(2).replace(/\.?0+$/, '')}h`
          : '';
      }
      lines.push(`• \`${jid}\` — ${when}${status}${repTxt} — ${job.note || job.target?.chat_id || ''}`);
      rows.push([{
        text: `${rep !== 'none' ? '⏹ end ' : '🗑 cancel '}${when.slice(0, 16)}`,
        callback_data: `${CB}:scheddel:${jid}`,
        style: 'danger',
      }]);
    }
    if (!rows.length) lines.push('📭 nothing scheduled. Compose a post → 📅 Schedule…');
    await this.api.sendRich(msg.chat.id, R.markdownMessage(lines.join('\n')), {
      reply_markup: rows.length ? kb(rows) : undefined,
    });
  }

  async cmdBcast(msg) {
    if (!(await this.ensureAdmin(msg))) return;
    await this.api.sendRich(msg.chat.id, R.markdownMessage(
      '📣 Broadcasting is built into the composer: **/post** → **✅ Done** → '
      + '**📤 Broadcast all**. I\'ll pace the sends and live-edit the progress here.',
    ));
  }

  async cmdEdit(msg, args) {
    const chat = msg.chat;
    if (!(await this.ensureAdmin(msg))) return;
    const reply = msg.reply_to_message || {};
    const target = reply.from?.is_bot ? reply.message_id : null;
    if (target && args) {
      this.typewriterEdit(chat.id, target, args);
      return;
    }
    if (target) {
      const comp = this.composers.get(chat.id) || this.newComposer(chat.id);
      comp.state = 'await_edit';
      comp.edit_chat = chat.id;
      comp.edit_msg = target;
      this.composers.set(chat.id, comp);
      await this.api.sendRich(chat.id, R.markdownMessage(
        `✏️ Reply with the new Markdown for message \`${target}\` — watch it edit itself smoothly.`,
      ));
      return;
    }
    await this.api.sendRich(chat.id, R.markdownMessage(
      '✏️ **Usage:** reply to one of my rich messages with `/edit <new markdown>` — '
      + "I'll re-type it live into the same message.",
    ));
  }

  async cmdStream(msg) {
    this.startStreamDemo(msg.chat.id);
  }

  // ============================================================== callbacks

  async onCallback(cbq) {
    const data = cbq.data || '';
    try {
      await this.#onCallback(cbq, data);
    } catch (err) {
      log.error(`callback failed: ${err?.message || err}`);
      if (!(err instanceof TelegramError)) log.error(err?.stack || String(err));
      try {
        await this.api.answerCbq(cbq.id, { text: `⚠️ ${String(err).slice(0, 180)}`, showAlert: true });
      } catch { /* ignore */ }
    }
  }

  async #onCallback(cbq, data) {
    const parts = data.split(':');
    const action = parts.length > 1 ? parts[1] : '';
    const msg = cbq.message || {};
    const chat = msg.chat || {};
    const chatId = chat.id;
    const user = cbq.from || {};

    if (action && await this.postoCallback(cbq, parts, action)) return;

    if (action === 'demo') {
      await this.api.answerCbq(cbq.id);
      await this.cmdDemo({ chat, from: user });
      return;
    }
    if (action === 'post') {
      await this.api.answerCbq(cbq.id);
      if (await this.ensureAdmin(msg, user)) await this.cmdPost({ chat, from: user });
      return;
    }
    if (action === 'stream') {
      await this.api.answerCbq(cbq.id);
      if (chatId !== undefined) this.startStreamDemo(chatId);
      return;
    }
    if (action === 'secret') {
      await this.demoEphemeral(cbq);
      return;
    }
    if (action === 'effect' && parts.length > 2) {
      const emoji = parts[2];
      if (chat.type !== 'private') {
        await this.api.answerCbq(cbq.id, { text: '🪄 Effects only animate in private chats', showAlert: true });
        return;
      }
      await this.api.answerCbq(cbq.id, { text: '🪄 Watch the next message…' });
      const eid = this.effectId(emoji);
      await this.api.sendRich(
        chatId,
        R.markdownMessage(`This message arrived with a ${emoji} effect.`),
        eid ? { message_effect_id: eid } : {},
      );
      return;
    }
    if (action === 'noop') {
      await this.api.answerCbq(cbq.id);
      return;
    }

    // ---- composer callbacks (need an active composer) ----
    const comp = this.composers.get(chatId);
    const composerActions = ['pv', 'done', 'btns', 'mode', 'cancel', 'pub', 'sched', 'save',
      'resume', 'eff', 'pin', 'react', 'draft', 'scheddel'];
    if (!comp && composerActions.includes(action)) {
      await this.api.answerCbq(cbq.id, { text: 'Composer expired — /post to start a new one', showAlert: true });
      return;
    }
    if (!comp) {
      await this.api.answerCbq(cbq.id);
      return;
    }

    if (action === 'pv') {
      await this.api.answerCbq(cbq.id, { text: '👁 refreshing preview…' });
      await this.sendPreview(comp, { force: true });
    } else if (action === 'done') {
      await this.api.answerCbq(cbq.id);
      await this.cmdDone({ chat, from: user });
    } else if (action === 'btns') {
      await this.api.answerCbq(cbq.id);
      await this.cmdButtons({ chat, from: user });
    } else if (action === 'mode') {
      comp.mode = comp.mode === 'rich' ? 'plain' : 'rich';
      await this.api.answerCbq(cbq.id, { text: `mode: ${comp.mode}` });
      this.updatePanel(comp);
      this.refreshPreview(comp);
    } else if (action === 'eff') {
      const cycle = [null, '🎉', '🔥', '❤️', '👍'];
      comp.effect = cycle[(cycle.indexOf(comp.effect) + 1) % cycle.length];
      await this.api.answerCbq(cbq.id, { text: `effect: ${comp.effect || 'off'} (private chats only)` });
      this.updatePanel(comp);
    } else if (action === 'cancel') {
      await this.api.answerCbq(cbq.id, { text: '🚫 cancelled' });
      this.composers.delete(chatId);
      await this.finishPanel(comp, '🚫 Composer closed.');
    } else if (action === 'resume') {
      await this.api.answerCbq(cbq.id, { text: '✏️ keep typing!' });
      comp.state = 'content';
      this.updatePanel(comp);
    } else if (action === 'save') {
      const did = this.store.addDraft(this.composerTitle(comp), this.composerMarkdown(comp), {
        mode: comp.mode, buttons: comp.buttons, media: comp.media,
      });
      await this.api.answerCbq(cbq.id, { text: '💾 saved' });
      this.updatePanel(comp, { extra: `💾 Saved draft \`${did}\` — \`/drafts\` to reload.` });
    } else if (action === 'sched') {
      await this.api.answerCbq(cbq.id);
      comp.state = 'await_time';
      this.updatePanel(comp, {
        extra: '📅 **When?** Natural language works:\n`+90m` · `21:30` · `tomorrow 09:00` · `2026-12-25 10:00`',
      });
    } else if (action === 'pub' && parts.length > 2) {
      await this.api.answerCbq(cbq.id);
      const targetKind = parts[2];
      if (targetKind === 'here') {
        await this.publishTo(comp, { kind: 'here', chat_id: chatId });
      } else if (targetKind === 'chan') {
        comp.state = 'await_channel';
        this.updatePanel(comp, {
          extra: `📣 Send the channel \`@username\` (or numeric id) — I must be an **admin** there.`,
        });
      } else if (targetKind === 'all') {
        this.broadcast(comp);
      }
    } else if (action === 'pin' && comp.published) {
      await this.api.answerCbq(cbq.id, { text: '📌 pinning…' });
      try {
        await this.api.call('pinChatMessage', {
          chat_id: comp.published.chat_id,
          message_id: comp.published.message_id,
          disable_notification: true,
        });
      } catch (err) {
        await this.api.answerCbq(cbq.id, { text: `⚠️ ${String(err).slice(0, 160)}`, showAlert: true });
      }
    } else if (action === 'react' && comp.published) {
      await this.api.answerCbq(cbq.id, { text: '🔥' });
      try {
        await this.api.react(comp.published.chat_id, comp.published.message_id, '🔥');
      } catch { /* ignore */ }
    } else if (action === 'draft' && parts.length > 3) {
      const sub = parts[2];
      const did = parts[3];
      await this.api.answerCbq(cbq.id);
      if (sub === 'load') {
        const d = this.store.draft(did);
        if (d) {
          const fresh = this.newComposer(chatId);
          fresh.parts = [d.markdown];
          fresh.media = d.media || [];
          fresh.buttons = d.buttons || [];
          fresh.mode = d.mode || 'rich';
          await this.cmdPost({ chat, from: user }, '', fresh);
        }
      } else if (sub === 'del') {
        this.store.delDraft(did);
        await this.api.sendRich(chatId, R.markdownMessage(`🗑 Draft \`${did}\` deleted.`));
      }
    } else if (action === 'scheddel' && parts.length > 2) {
      this.store.delScheduled(parts[2]);
      await this.api.answerCbq(cbq.id, { text: '🗑 cancelled' });
      await this.api.call('deleteMessage', { chat_id: chatId, message_id: msg.message_id });
    } else {
      await this.api.answerCbq(cbq.id);
    }
  }

  /** User pressed ⏹ on a streaming draft (Bot API 10.3 update). */
  onGenerationStopped(gen) {
    const cid = gen?.chat?.id;
    this.streams.get(cid)?.abort(true);
  }

  // ============================================================== demo bits

  async demoEphemeral(cbq) {
    const msg = cbq.message || {};
    const chat = msg.chat || {};
    const uid = cbq.from?.id;
    const secret = R.markdownMessage(
      '👀 **Ephemeral message** — nobody else in this chat can see it.\n\n'
      + 'Sent with `ephemeral_message_parameters` (Bot API 10.2/10.3): group replies '
      + 'that whisper to one user. Free, of course.',
    );
    try {
      await this.api.sendEphemeralRich(chat.id, uid, secret, {
        callbackQueryId: cbq.id,
        replaceCallbackQueryMessage: false,
      });
      await this.api.answerCbq(cbq.id, { text: '👀 sent — for your eyes only' });
    } catch {
      await this.api.answerCbq(cbq.id, {
        text: 'Ephemeral delivery works in groups — in private chats everyone is already alone 🙂',
        showAlert: true,
      });
    }
  }

  startStreamDemo(chatId) {
    void this.#streamDemo(chatId).catch((err) => log.error(`stream demo crashed\n${err?.stack || err}`));
  }

  async #streamDemo(chatId) {
    const stream = new SmoothStream(this.api, chatId, { draftId: Date.now() % 2147483647, privateChat: true });
    this.streams.set(chatId, stream);
    try {
      await stream.begin({ thinkingText: '🧠 Composing something smooth…' });
      const words = content.STREAM_TEXT.split(' ');
      const buf = [];
      for (let i = 0; i < words.length; i += 3) {
        if (stream.aborted) break;
        buf.push(...words.slice(i, i + 3));
        stream.update(R.markdownMessage(`${buf.join(' ')} ▌`));
        await sleep(350);
      }
      let final = stream.aborted
        ? `${buf.join(' ')}\n\n⏹ stopped early — still smooth, right?`
        : content.STREAM_TEXT;
      if (!final.trim()) final = content.STREAM_TEXT;
      stream.abort(true);
      await stream.finalize(R.markdownMessage(final));
    } finally {
      this.streams.delete(chatId);
    }
  }

  typewriterEdit(chatId, messageId, markdown) {
    void (async () => {
      const editor = new SmoothEditor(this.api, chatId, messageId, { minInterval: 1000 });
      const words = markdown.split(' ');
      const buf = [];
      for (let i = 0; i < words.length; i += 4) {
        buf.push(...words.slice(i, i + 4));
        editor.update({ richMessage: R.markdownMessage(`${buf.join(' ')} ▌`) });
        await sleep(450);
      }
      editor.update({ richMessage: R.markdownMessage(markdown) });
      await editor.close();
    })().catch((err) => log.error(`typewriter edit failed: ${err?.message || err}`));
  }

  // ============================================================= publishing

  composerMarkdown(comp) {
    return (comp.parts || []).join('\n\n');
  }

  composerTitle(comp) {
    const md = this.composerMarkdown(comp);
    for (const line of md.split('\n')) {
      const cleaned = line.trim().replace(/^#+/, '').trim();
      if (cleaned) return cleaned.slice(0, 48);
    }
    return 'untitled';
  }

  buildIrm(comp) {
    if (comp.mode === 'plain') return null;
    if (comp.slideshow && comp.media?.length) return this.buildSlideshowIrm(comp);
    const media = (comp.media || []).map((m) => R.mediaRef(m.id, m.media, m.kind));
    return R.richMessage({ markdown: this.composerMarkdown(comp), media: media.length ? media : null });
  }

  /**
   * Send the composed post to one chat.
   * Handles paid (Stars) media posts, plain mode (media group), slideshow
   * blocks mode, watermarked uploads, signatures and private-chat effects.
   */
  async deliverOne(chatId, comp, { privateChat = false, signature = null } = {}) {
    const markup = comp.buttons?.length ? kb(comp.buttons) : undefined;
    const markdown = this.applySignature(this.composerMarkdown(comp), signature || comp.signature);
    const media = comp.media || [];

    // ---- paid posts (sendPaidMedia, photo/video only) ----
    if (comp.stars && media.length && media.every((m) => ['photo', 'video'].includes(m.kind))) {
      return this.api.call('sendPaidMedia', {
        chat_id: chatId,
        star_count: comp.stars,
        media: media.map((m) => ({ type: m.kind, media: m.media })),
        caption: R.stripMarkdown(markdown).slice(0, 1000) || undefined,
        reply_markup: markup,
      });
    }

    // ---- plain mode ----
    if (comp.mode === 'plain') {
      if (media.length) {
        const group = media.map((m, i) => {
          const item = { type: m.kind, media: m.media };
          if (i === 0 && markdown) {
            item.caption = markdown.slice(0, 1000);
            item.parse_mode = 'Markdown';
          }
          return item;
        });
        const res = await this.api.call('sendMediaGroup', { chat_id: chatId, media: group });
        return Array.isArray(res) ? res[0] : res;
      }
      return this.api.sendText(chatId, markdown, { parse_mode: 'Markdown', reply_markup: markup });
    }

    // ---- rich mode ----
    let irm;
    let files = {};
    if (comp.slideshow && media.length) {
      irm = this.buildSlideshowIrm(comp, markdown);
    } else {
      const prepared = await this.prepareMedia(comp);
      files = prepared.files;
      irm = R.richMessage({ markdown, media: prepared.refs.length ? prepared.refs : null });
    }
    const problems = R.checkLimits(irm);
    if (problems.length) throw new Error(problems.join('; '));
    const kwargs = {};
    const eid = privateChat && comp.effect ? this.effectId(comp.effect) : null;
    if (eid) kwargs.message_effect_id = eid;
    try {
      if (Object.keys(files).length) {
        return await this.api.sendRichMultipart(chatId, irm, files, { reply_markup: markup, ...kwargs });
      }
      return await this.api.sendRich(chatId, irm, { reply_markup: markup, ...kwargs });
    } catch (err) {
      if (!isUnknownMethod(err)) throw err;
      // This Bot API server has no Rich Messages (older/self-hosted API): the
      // post still has to go out, so send the plain-text version and remember.
      this.store.setSetting('rich_unsupported', true);
      log.warn('sendRichMessage is not supported by this API server — publishing as a classic message');
      const text = R.stripMarkdown(markdown).trim().slice(0, 4096) || String(markdown).slice(0, 4096);
      return this.api.sendText(chatId, text, { reply_markup: markup });
    }
  }

  async publishTo(comp, target) {
    const chatId = comp.chat_id;
    try {
      if (target.kind === 'all') {
        this.broadcast(comp);
        return;
      }
      const dest = target.chat_id ?? chatId;
      const isPrivate = Number.isInteger(dest) && dest > 0;
      const res = await this.deliverOne(dest, comp, { privateChat: isPrivate });
      this.store.bump(true);
      comp.published = { chat_id: dest, message_id: res?.message_id };
      comp.state = 'published_panel';
      this.updatePanel(comp, {
        extra: `✅ **Published** — message \`${res?.message_id}\` in \`${dest}\`.`,
        keyboard: this.publishedKb(),
      });
    } catch (err) {
      this.store.bump(false);
      log.warn(`publish to ${target?.chat_id ?? chatId} failed: ${err?.message || err}`);
      this.updatePanel(comp, { extra: `❌ Publish failed: \`${String(err?.message || err).slice(0, 250)}\`` });
    }
  }

  broadcast(comp) {
    void this.#broadcastWorker(comp).catch((err) => log.error(`broadcast crashed\n${err?.stack || err}`));
  }

  async #broadcastWorker(comp) {
    const chatId = comp.chat_id;
    const panelMsg = comp.panel_msg;
    const chats = this.store.chats();
    const editor = panelMsg ? new SmoothEditor(this.api, chatId, panelMsg, { minInterval: 1000 }) : null;
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < chats.length; i += 1) {
      const cid = chats[i];
      try {
        await this.deliverOne(Number(cid), comp, { privateChat: Number(cid) > 0 });
        ok += 1;
        this.store.bump(true);
      } catch (err) {
        fail += 1;
        this.store.bump(false);
        log.warn(`broadcast to ${cid} failed: ${err?.message || err}`);
      }
      if (editor) {
        editor.update({
          richMessage: R.markdownMessage(`📤 **Broadcasting** — ${i + 1}/${chats.length} chats · ✅ ${ok} · ❌ ${fail}`),
        });
      }
      await sleep(1050);
    }
    const summary = `📤 **Broadcast finished** — ✅ ${ok} delivered · ❌ ${fail} failed.`;
    if (editor) {
      editor.update({ richMessage: R.markdownMessage(summary), replyMarkup: this.publishedKb() });
      await editor.close();
    }
    comp.state = 'published_panel';
  }

  /** Entry point used by the scheduler. */
  async deliverScheduled(jid, job) {
    const target = job.target || {};
    const comp = {
      chat_id: target.chat_id,
      parts: [job.markdown || ''],
      media: job.media || [],
      buttons: job.buttons || [],
      mode: job.mode || 'rich',
      effect: null,
      slideshow: !!job.slideshow,
      stars: job.stars ?? null,
      signature: '',
    };
    if (target.kind === 'channels') {
      let ok = 0;
      let fail = 0;
      for (const [cid, ch] of Object.entries(this.store.channels())) {
        try {
          await this.deliverOne(Number(cid), comp, { signature: ch.signature || null });
          ok += 1;
          this.store.bump(true);
        } catch (err) {
          fail += 1;
          log.warn(`scheduled channel post to ${cid} failed: ${err?.message || err}`);
        }
        await sleep(1100);
      }
      await this.notifyAdmins(`📅 Scheduled post \`${jid}\` → ${ok + fail} channels · ✅ ${ok} ❌ ${fail}`);
      return;
    }
    if (target.kind === 'all') {
      const chats = this.store.chats();
      let ok = 0;
      let fail = 0;
      for (const cid of chats) {
        try {
          await this.deliverOne(Number(cid), comp);
          ok += 1;
          this.store.bump(true);
        } catch (err) {
          fail += 1;
          log.warn(`scheduled broadcast to ${cid} failed: ${err?.message || err}`);
        }
        await sleep(1050);
      }
      await this.notifyAdmins(`📅 Scheduled broadcast \`${jid}\` done — ✅ ${ok} ❌ ${fail}`);
      return;
    }
    const dest = target.chat_id;
    const res = await this.deliverOne(dest, comp);
    this.store.bump(true);
    await this.notifyAdmins(`📅 Scheduled post \`${jid}\` delivered ✓ (message \`${res?.message_id}\` in \`${dest}\`)`);
  }

  async notifyAdmins(markdown) {
    for (const uid of [...this.admins]) {
      try {
        await this.api.sendRich(uid, R.markdownMessage(markdown));
      } catch (err) {
        log.warn(`notify admin ${uid} failed: ${err?.message || err}`);
      }
    }
  }

  // ================================================================= panels

  composeKb(state, comp = null) {
    if (state === 'compose') {
      const rows = [
        [
          { text: '👁 Preview', callback_data: `${CB}:pv`, style: 'primary' },
          { text: '✅ Done', callback_data: `${CB}:done`, style: 'success' },
        ],
        [
          { text: '🤖 AI write', callback_data: `${CB}:aiw`, style: 'primary' },
          { text: '♻️ Rewrite', callback_data: `${CB}:air` },
          { text: '🌐 Translate', callback_data: `${CB}:ait` },
          { text: '✂️ Shorten', callback_data: `${CB}:ais` },
          { text: '➕ Expand', callback_data: `${CB}:aie` },
        ],
        [
          { text: '🎨 Buttons', callback_data: `${CB}:btns` },
          { text: `💤 Mode: ${comp?.mode || 'rich'}`, callback_data: `${CB}:mode` },
        ],
      ];
      if (comp?.media?.length) {
        rows.push([{
          text: `🎞 Slideshow: ${comp.slideshow ? 'ON' : 'off'}`,
          callback_data: `${CB}:slide`,
          style: comp.slideshow ? 'success' : undefined,
        }]);
      }
      rows.push([{ text: '🚫 Cancel', callback_data: `${CB}:cancel`, style: 'danger' }]);
      return kb(rows);
    }
    return kb([
      [
        { text: '✅ Publish here', callback_data: `${CB}:pub:here`, style: 'success' },
        { text: `🌐 Channels (${Object.keys(this.store.channels()).length})`, callback_data: `${CB}:pub:chans`, style: 'primary' },
      ],
      [
        { text: '📣 To channel…', callback_data: `${CB}:pub:chan`, style: 'primary' },
        { text: '📤 Broadcast all', callback_data: `${CB}:pub:all`, style: 'primary' },
      ],
      [
        { text: '📅 Schedule…', callback_data: `${CB}:sched` },
        { text: `🪄 Effect: ${comp?.effect || 'off'}`, callback_data: `${CB}:eff` },
        { text: '💾 Save draft', callback_data: `${CB}:save` },
        { text: '📋 Template', callback_data: `${CB}:tplsave` },
      ],
      [
        { text: '⭐ Paid…', callback_data: `${CB}:star` },
        { text: '🖋 Signature', callback_data: `${CB}:sign` },
        { text: `©️ Watermark: ${this.store.setting('watermark_on') ? 'on' : 'off'}`, callback_data: `${CB}:wm` },
      ],
      [
        { text: '✏️ Keep editing', callback_data: `${CB}:resume` },
        { text: '🚫 Discard', callback_data: `${CB}:cancel`, style: 'danger' },
      ],
    ]);
  }

  publishedKb() {
    return kb([[
      { text: '📌 Pin it', callback_data: `${CB}:pin` },
      { text: '🔥 React', callback_data: `${CB}:react` },
      { text: '👍 Done', callback_data: `${CB}:noop`, style: 'success' },
    ]]);
  }

  panelMd(comp, extra = null) {
    const parts = comp.parts.length;
    const chars = comp.parts.reduce((sum, p) => sum + p.length, 0);
    const media = comp.media?.length || 0;
    const lines = [
      `🧵 **Composer** — ${parts} part${parts === 1 ? '' : 's'} · ${chars.toLocaleString('en-US')} chars `
      + `· ${media} media · mode: \`${comp.mode}\``,
    ];
    if (comp.buttons?.length) {
      lines.push(`🔘 ${comp.buttons.length} button row(s) · 🪄 effect: ${comp.effect || 'off'}`);
    }
    if (media) lines.push(`🎞 slideshow: **${comp.slideshow ? 'ON' : 'off'}**`);
    if (comp.stars) lines.push(`⭐ paid post: **${comp.stars} Stars**`);
    if (comp.signature) lines.push(`🖋 signature: _${comp.signature}_`);
    if (this.store.setting('turbo')) lines.push('⚡ turbo mode — /done publishes instantly');
    if (comp.state === 'await_buttons') lines.push('\n🔘 send button lines now (see above)');
    if (extra) lines.push(`\n${extra}`);
    if (['content', 'await_buttons'].includes(comp.state)) {
      lines.push(`\n<details><summary>✍️ format help</summary>\n\n${content.composerHelpMarkdown()}\n</details>`);
    }
    return lines.join('\n');
  }

  updatePanel(comp, { extra = null, keyboard = null } = {}) {
    const editor = comp.panel_editor;
    if (!editor) return;
    const kbState = ['content', 'await_buttons', 'await_ai_prompt', 'await_ai_lang'].includes(comp.state)
      ? 'compose' : 'publish';
    editor.update({
      richMessage: R.markdownMessage(this.panelMd(comp, extra)),
      replyMarkup: keyboard || this.composeKb(kbState, comp),
    });
  }

  async finishPanel(comp, text) {
    try {
      if (comp.panel_editor) {
        await comp.panel_editor.close();
        await this.api.editRich(comp.chat_id, comp.panel_msg, R.markdownMessage(text));
      } else if (comp.panel_msg) {
        await this.api.editRich(comp.chat_id, comp.panel_msg, R.markdownMessage(text));
      }
    } catch { /* panel may be gone */ }
    if (comp.preview_editor) await comp.preview_editor.close();
  }

  async sendPreview(comp, { force = false } = {}) {
    const chatId = comp.chat_id;
    if (!comp.parts.length && !comp.media?.length) {
      this.updatePanel(comp, { extra: '📭 Nothing to preview yet — send Markdown first.' });
      return;
    }
    const irm = this.buildIrm(comp);
    if (comp.mode === 'plain') {
      if (comp.preview_msg && !force) {
        await this.api.call('editMessageText', {
          chat_id: chatId,
          message_id: comp.preview_msg,
          text: this.composerMarkdown(comp),
          parse_mode: 'Markdown',
        });
      } else {
        const m = await this.api.sendText(chatId, this.composerMarkdown(comp), { parse_mode: 'Markdown' });
        comp.preview_msg = m.message_id;
      }
      return;
    }
    const problems = R.checkLimits(irm);
    if (problems.length) {
      this.updatePanel(comp, { extra: `⚠️ ${problems.join(' · ')}` });
      return;
    }
    if (comp.preview_msg && !force) {
      if (!comp.preview_editor) {
        comp.preview_editor = new SmoothEditor(this.api, chatId, comp.preview_msg, { minInterval: 1200 });
      }
      comp.preview_editor.update({ richMessage: irm });
    } else {
      const m = await this.api.sendRich(chatId, irm);
      comp.preview_msg = m.message_id;
      comp.preview_editor = new SmoothEditor(this.api, chatId, m.message_id, { minInterval: 1200 });
    }
  }

  refreshPreview(comp) {
    if (comp.preview_msg && comp.preview_editor && comp.mode !== 'plain') {
      comp.preview_editor.update({ richMessage: this.buildIrm(comp) });
    }
  }

  // ================================================================== admin

  isAdmin(uid) {
    return uid !== undefined && uid !== null && this.admins.includes(uid);
  }

  async ensureAdmin(msg, user = null) {
    const who = user || msg.from || {};
    const uid = who.id;
    if (this.isAdmin(uid)) return true;
    // No admins configured yet: the first person to /post in a private chat
    // claims ownership (self-hosting convenience).
    if (!this.admins.length && msg?.chat?.type === 'private') {
      this.admins.push(uid);
      this.store.data.admins = [...(this.store.data.admins || []), uid];
      this.store.save();
      await this.api.sendRich(msg.chat.id, R.markdownMessage(
        "🔑 You're the first admin — claimed! Configure `APB_ADMINS` to hard-code admins instead.",
      ));
      return true;
    }
    const chatId = msg?.chat?.id;
    const note = '🔒 Admins only.';
    if (chatId !== undefined) {
      try {
        if (['group', 'supergroup'].includes(msg.chat.type)) {
          await this.api.sendEphemeralRich(chatId, uid, R.markdownMessage(note));
        } else {
          await this.api.sendText(chatId, note);
        }
      } catch {
        try {
          await this.api.sendText(chatId, note);
        } catch { /* ignore */ }
      }
    }
    return false;
  }
}

// Mix the Posto feature set (channels, bulk, templates, turbo, slideshow, AI,
// watermarks, paid posts) into the Bot prototype — the JS twin of the Python
// `class Bot(PostoMixin)`.
Object.assign(Bot.prototype, postoMethods);

export default Bot;
