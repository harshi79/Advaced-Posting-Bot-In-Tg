/**
 * src/posto.js — PostoRobot-style features, mixed into the Bot prototype.
 *
 * | Posto feature            | Here                                                      |
 * | ------------------------ | --------------------------------------------------------- |
 * | Multi-channel publishing | /channels + 🌐 publish (per-channel signature & delay)     |
 * | Scheduled posts          | /post → 📅 (natural language)                              |
 * | Recurring posts          | repeat hourly / daily / weekly / custom interval           |
 * | Bulk posting             | /bulk — collect many, post all now or auto-schedule        |
 * | Templates                | /templates + 📋 save from the publish panel                |
 * | Inline buttons           | /buttons (colored, free)                                   |
 * | AI (write/rewrite/…)     | NVIDIA NIM, free forever                                   |
 * | Watermarks               | ©️ optional sharp watermark + per-post signature            |
 * | Slideshow generator      | 🎞 toggle in composer + /slideshow (albums)                 |
 * | Turbo mode               | /turbo — zero-click publishing                             |
 * | Hidden text              | ||spoilers|| in Rich Markdown (free)                       |
 * | Premium emojis           | skipped — the only Premium-gated API bit                   |
 * | Paid posts               | ⭐ Stars toggle (sendPaidMedia, experimental)               |
 *
 * The AI is NVIDIA ONLY: ONE model, `nvidia/nemotron-3-super-120b-a12b` on the
 * free NIM tier (no card, no expiry, ~40 req/min).
 */

import * as R from './rich.js';
import { TelegramError } from './telegram.js';
import { AIError } from './nvidia.js';
import { mdToBlocks } from './mdblocks.js';
import { SmoothEditor, SmoothStream } from './smooth.js';
import { fmtWhen, kb, parseDelay, parseInterval, parseWhen, sleep } from './utils.js';
import { logger } from './logger.js';
import * as watermark from './watermark.js';

const log = logger('posto');

const CB = 'apb';

export const postoMethods = {

  /** Called from the Bot constructor. */
  initPosto(ai = null) {
    this.ai = ai;
    this.bulks = new Map();          // chat_id -> bulk session
    this.chanSessions = new Map();   // chat_id -> {state, channel_id}
    this.slides = new Map();         // chat_id -> {media, panel}
    this.aiResults = new Map();      // chat_id -> last AI generation
  },

  // ======================================================= message routing

  /**
   * Intercept non-command messages for bulk/channel/slideshow sessions.
   * Returns true when the message was consumed.
   */
  postoMessage(msg, chatId) {
    const bulk = this.bulks.get(chatId);
    if (bulk) {
      void this.bulkFeed(chatId, msg, bulk).catch((err) => log.error(`bulk feed: ${err?.message || err}`));
      return true;
    }
    const session = this.chanSessions.get(chatId);
    if (session) {
      void this.channelFeed(chatId, msg, session).catch((err) => log.error(`channel feed: ${err?.message || err}`));
      return true;
    }
    const slide = this.slides.get(chatId);
    if (slide) {
      void this.slideshowFeed(chatId, msg, slide).catch((err) => log.error(`slideshow feed: ${err?.message || err}`));
      return true;
    }
    return false;
  },

  /** Clear every Posto session for a chat (bulk, channels, slideshow). */
  async postoCancel(chatId) {
    const bulk = this.bulks.get(chatId);
    this.bulks.delete(chatId);
    if (bulk?.editor) {
      try {
        bulk.editor.update({ richMessage: R.markdownMessage('🚫 Bulk collector closed.') });
        await bulk.editor.close();
      } catch { /* ignore */ }
    }
    this.chanSessions.delete(chatId);
    const slide = this.slides.get(chatId);
    this.slides.delete(chatId);
    if (slide?.panel) {
      try {
        await this.api.call('deleteMessage', { chat_id: chatId, message_id: slide.panel });
      } catch { /* ignore */ }
    }
    this.aiResults.delete(chatId);
  },

  // =============================================================== /turbo

  async cmdTurbo(msg) {
    if (!(await this.ensureAdmin(msg))) return;
    const on = !this.store.setting('turbo');
    this.store.setSetting('turbo', on);
    await this.api.sendRich(msg.chat.id, R.markdownMessage(
      `⚡ **Turbo Mode: ${on ? 'ON' : 'OFF'}**\n\n${on
        ? 'Hit **/done** and the post publishes instantly — to every saved channel '
          + '(or here if none). No confirmation clicks.'
        : 'Back to normal: /done shows the publish panel first.'}`,
    ));
  },

  /** Called from cmdDone; true when turbo already published. */
  async turboTryPublish(comp) {
    if (!this.store.setting('turbo')) return false;
    const channels = this.store.channels();
    const pairs = Object.entries(channels);
    if (pairs.length) {
      this.publishMulti(
        comp,
        pairs.map(([cid, ch]) => [Number(cid), ch.signature || null]),
        `⚡ turbo → ${pairs.length} channels`,
      );
    } else {
      await this.publishTo(comp, { kind: 'here', chat_id: comp.chat_id });
    }
    return true;
  },

  // ============================================================ /channels

  async cmdChannels(msg) {
    if (!(await this.ensureAdmin(msg))) return;
    await this.sendChannelsPanel(msg.chat.id);
  },

  async sendChannelsPanel(chatId) {
    const channels = this.store.channels();
    const rows = [];
    const lines = ['🌐 **Your channels** — posts fan out to all of them.', ''];
    if (!Object.keys(channels).length) {
      lines.push('_None yet. Add channels where this bot is an admin (it needs post rights)._');
    }
    for (const [cid, ch] of Object.entries(channels)) {
      const sig = ch.signature || '';
      const delay = ch.delay;
      lines.push(`• **${ch.title || cid}** \`${cid}\`${sig ? ` · “${sig}”` : ''}${delay ? ` · +${Math.round(delay)}s` : ''}`);
      rows.push([
        { text: '🖋 signature', callback_data: `${CB}:chsig:${cid}` },
        { text: '⏱ delay', callback_data: `${CB}:chdelay:${cid}` },
        { text: '🗑', callback_data: `${CB}:chdel:${cid}`, style: 'danger' },
      ]);
    }
    rows.push([{ text: '➕ Add channel', callback_data: `${CB}:chadd`, style: 'success' }]);
    await this.api.sendRich(chatId, R.markdownMessage(lines.join('\n')), { reply_markup: kb(rows) });
  },

  async channelFeed(chatId, msg, session) {
    const state = session.state;
    const text = String(msg.text || msg.caption || '').trim();

    if (state === 'await_add') {
      const fwd = msg.forward_from_chat || {};
      let target = null;
      let title = null;
      if (fwd.id !== undefined) {
        target = fwd.id;
        title = fwd.title || String(fwd.id);
      } else {
        const token = text.split(/\s+/)[0] || '';
        if (token.startsWith('@') || /^-?\d+$/.test(token)) {
          target = token;
          title = token;
        }
      }
      if (target === null) {
        await this.api.sendRich(chatId, R.markdownMessage(
          '⚠️ Send an `@username`, a numeric id, or **forward any post from that channel**.',
        ));
        return;
      }
      try {
        const info = await this.api.call('getChat', { chat_id: target });
        title = info.title || title;
      } catch (err) {
        await this.api.sendRich(chatId, R.markdownMessage(
          `❌ Can't see \`${target}\` — am I an admin there?\n\`${String(err).slice(0, 200)}\``,
        ));
        return;
      }
      this.store.addChannel(target, { title });
      this.chanSessions.delete(chatId);
      await this.api.sendRich(chatId, R.markdownMessage(
        `✅ Added **${title}** \`${target}\` — make sure I can **post** there.`,
      ));
      await this.sendChannelsPanel(chatId);
      return;
    }

    if (state === 'await_sign') {
      const cid = session.channel_id;
      const ch = this.store.channel(cid) || {};
      this.store.addChannel(cid, { title: ch.title || '', signature: text || null });
      this.chanSessions.delete(chatId);
      await this.api.sendRich(chatId, R.markdownMessage(
        `🖋 Signature for **${ch.title || cid}**: _${text || '(none)'}_`,
      ));
      await this.sendChannelsPanel(chatId);
      return;
    }

    if (state === 'await_delay') {
      const cid = session.channel_id;
      const delay = parseDelay(text || '');
      if (delay === null || delay > 600) {
        await this.api.sendRich(chatId, R.markdownMessage('⚠️ Send a delay like `5s` or `2m` (max 10m).'));
        return;
      }
      const ch = this.store.channel(cid) || {};
      this.store.addChannel(cid, { title: ch.title || '', delay });
      this.chanSessions.delete(chatId);
      await this.api.sendRich(chatId, R.markdownMessage(
        `⏱ Delay after posting to **${ch.title || cid}**: ${delay}s.`,
      ));
      await this.sendChannelsPanel(chatId);
    }
  },

  // =========================================================== /templates

  async cmdTemplates(msg) {
    if (!(await this.ensureAdmin(msg))) return;
    const tpls = this.store.templates();
    const rows = [];
    const lines = ['📋 **Templates** — reusable formats with buttons & signature.', ''];
    if (!tpls.length) {
      lines.push('_No templates yet — compose a post, then 📋 Template in the publish panel._');
    }
    for (const [tid, t] of tpls.slice(0, 10)) {
      lines.push(`• **${t.name || 'untitled'}** — ${(t.markdown || '').length.toLocaleString('en-US')} chars${t.buttons?.length ? ' · 🔘' : ''}`);
      rows.push([
        { text: '✍️ New post', callback_data: `${CB}:tplnew:${tid}`, style: 'primary' },
        { text: '🗑', callback_data: `${CB}:tpldel:${tid}`, style: 'danger' },
      ]);
    }
    await this.api.sendRich(msg.chat.id, R.markdownMessage(lines.join('\n')), {
      reply_markup: rows.length ? kb(rows) : undefined,
    });
  },

  templateToComposer(chatId, tid) {
    const t = this.store.template(tid);
    if (!t) return null;
    const comp = this.newComposer(chatId);
    comp.parts = [t.markdown || ''];
    comp.media = t.media || [];
    comp.buttons = t.buttons || [];
    comp.signature = t.signature || '';
    return comp;
  },

  // ================================================================ /bulk

  async cmdBulk(msg) {
    const chatId = msg.chat.id;
    if (!(await this.ensureAdmin(msg))) return;
    const bulk = {
      items: [], state: 'collect', target: null, interval: null, panel: null, editor: null,
    };
    this.bulks.set(chatId, bulk);
    const panel = await this.api.sendRich(chatId, R.markdownMessage(this.bulkMd(bulk)), {
      reply_markup: this.bulkKb(),
    });
    bulk.panel = panel.message_id;
    bulk.editor = new SmoothEditor(this.api, chatId, panel.message_id, { minInterval: 900 });
  },

  bulkMd(bulk) {
    const items = bulk.items;
    const media = items.reduce((sum, i) => sum + (i.media?.length || 0), 0);
    const last = items.length ? String(items[items.length - 1].text || '').slice(0, 80) : '';
    const lines = [
      `📦 **Bulk collector** — ${items.length} post${items.length === 1 ? '' : 's'} · ${media} media`,
      '',
      'Send **one post per message** (text, or photo/video with a caption). Albums are '
      + 'kept together. /cancel aborts.',
    ];
    if (last) lines.push('', `Last: _${last.replace(/\|/g, '')}_`);
    if (bulk.state === 'await_interval') lines.push('', '⏱ **Interval between posts?** e.g. `6h`, `90m`, `2d`');
    if (bulk.state === 'await_start') lines.push('', '📅 **Start when?** e.g. `now`, `+30m`, `21:30`, `tomorrow 09:00`');
    return lines.join('\n');
  },

  bulkKb() {
    return kb([[
      { text: '✅ Done collecting', callback_data: `${CB}:bulkgo`, style: 'success' },
      { text: '🚫 Cancel', callback_data: `${CB}:bulkcancel`, style: 'danger' },
    ]]);
  },

  bulkTargetKb(nChannels) {
    const rows = [[{ text: '📍 Post all here now', callback_data: `${CB}:bulk:here`, style: 'primary' }]];
    if (nChannels) {
      rows.push([{ text: '🌐 To my channels now', callback_data: `${CB}:bulk:chans`, style: 'primary' }]);
    }
    rows.push(
      [
        { text: '📅 Auto-schedule here…', callback_data: `${CB}:bulksched:here` },
        { text: '📅 Auto-schedule channels…', callback_data: `${CB}:bulksched:chans` },
      ],
      [{ text: '🚫 Cancel', callback_data: `${CB}:bulkcancel`, style: 'danger' }],
    );
    return kb(rows);
  },

  async bulkFeed(chatId, msg, bulk) {
    if (bulk.state === 'await_interval') {
      const interval = parseInterval(String(msg.text || '').trim());
      if (interval === null) {
        bulk.editor.update({
          richMessage: R.markdownMessage(`${this.bulkMd(bulk)}\n\n⚠️ Try \`6h\`, \`90m\`, \`2d\` — minimum 1 minute.`),
          replyMarkup: this.bulkKb(),
        });
        return;
      }
      bulk.interval = interval;
      bulk.state = 'await_start';
      bulk.editor.update({ richMessage: R.markdownMessage(this.bulkMd(bulk)), replyMarkup: null });
      return;
    }
    if (bulk.state === 'await_start') {
      const text = String(msg.text || '').trim().toLowerCase();
      const start = ['now', 'asap'].includes(text) ? Date.now() / 1000 + 60 : parseWhen(text);
      if (start === null) {
        bulk.editor.update({
          richMessage: R.markdownMessage(`${this.bulkMd(bulk)}\n\n⚠️ Couldn't parse that time.`),
          replyMarkup: null,
        });
        return;
      }
      this.bulkAutoschedule(chatId, bulk, start);
      return;
    }

    // ---- collecting ----
    const media = this.extractMedia(msg);
    const text = String(msg.text || msg.caption || '').trim();
    if (!media && !text) return;
    const mgid = msg.media_group_id;
    const items = bulk.items;
    if (mgid && items.length && items[items.length - 1].mgid === mgid) {
      const last = items[items.length - 1];
      if (media) last.media.push({ kind: media.kind, file_id: media.file_id });
      if (text) last.text = text;
    } else {
      items.push({
        text,
        media: media ? [{ kind: media.kind, file_id: media.file_id }] : [],
        mgid: mgid || null,
      });
    }
    bulk.editor.update({ richMessage: R.markdownMessage(this.bulkMd(bulk)), replyMarkup: this.bulkKb() });
  },

  /** Post every collected item now (paced, progress live-edited). */
  bulkRun(chatId, bulk, targetKind) {
    void (async () => {
      const dests = targetKind === 'chans'
        ? Object.entries(this.store.channels()).map(([cid, ch]) => [Number(cid), ch.signature || null])
        : [[chatId, null]];
      const editor = bulk.editor;
      let ok = 0;
      let fail = 0;
      let done = 0;
      const total = Math.max(1, bulk.items.length * dests.length);
      for (const item of bulk.items) {
        const comp = this.itemToComp(chatId, item);
        for (const [dest, sig] of dests) {
          try {
            await this.deliverOne(dest, comp, { signature: sig });
            ok += 1;
            this.store.bump(true);
          } catch (err) {
            fail += 1;
            this.store.bump(false);
            log.warn(`bulk send to ${dest} failed: ${err?.message || err}`);
          }
          done += 1;
          if (editor) {
            editor.update({
              richMessage: R.markdownMessage(`⚡ **Bulk posting** — ${done}/${total} · ✅ ${ok} · ❌ ${fail}`),
            });
          }
          await sleep(1100);
        }
      }
      if (editor) {
        editor.update({
          richMessage: R.markdownMessage(
            `✅ **Bulk done** — ${bulk.items.length} posts · ✅ ${ok} delivered · ❌ ${fail} failed.`,
          ),
        });
        await editor.close();
      }
      this.bulks.delete(chatId);
    })().catch((err) => log.error(`bulk run crashed\n${err?.stack || err}`));
  },

  bulkAutoschedule(chatId, bulk, start) {
    const interval = bulk.interval;
    const target = bulk.target === 'chans' ? { kind: 'channels' } : { kind: 'here', chat_id: chatId };
    bulk.items.forEach((item, i) => {
      this.store.addScheduled(start + i * interval, target, item.text || ' ', {
        media: (item.media || []).map((m, j) => ({ id: `m${j + 1}`, kind: m.kind, media: m.file_id })),
        note: 'bulk',
        repeat: 'none',
      });
    });
    const editor = bulk.editor;
    if (editor) {
      editor.update({
        richMessage: R.markdownMessage(
          `📅 **Auto-scheduled ${bulk.items.length} posts** — one every **${interval / 3600}h**, `
          + `starting ${fmtWhen(start)}.\n\n👀 \`/schedule\` to manage them.`,
        ),
      });
      void editor.close();
    }
    this.bulks.delete(chatId);
  },

  itemToComp(chatId, item) {
    const comp = this.newComposer(chatId);
    comp.parts = [item.text || ' '];
    comp.media = (item.media || []).map((m, i) => ({ id: `m${i + 1}`, kind: m.kind, media: m.file_id }));
    return comp;
  },

  // =========================================================== /slideshow

  async cmdSlideshow(msg) {
    const chatId = msg.chat.id;
    if (!(await this.ensureAdmin(msg))) return;
    const panel = await this.api.sendRich(chatId, R.markdownMessage(
      '🎞 **Slideshow maker** — send an album (or photos one by one), then send the '
      + "caption text and I'll build the slideshow.\n\n/cancel to abort.",
    ));
    this.slides.set(chatId, { media: [], panel: panel.message_id });
  },

  async slideshowFeed(chatId, msg, slide) {
    const media = this.extractMedia(msg);
    const text = String(msg.text || '').trim();
    if (media) {
      slide.media.push(media);
      try {
        await this.api.call('deleteMessage', { chat_id: chatId, message_id: msg.message_id });
      } catch { /* ignore */ }
      try {
        await this.api.call('editMessageText', {
          chat_id: chatId,
          message_id: slide.panel,
          text: `🎞 Slideshow: ${slide.media.length} media collected — send more, or send the caption text now.`,
        });
      } catch { /* ignore */ }
      return;
    }
    if (text) {
      if (!slide.media.length) {
        await this.api.sendRich(chatId, R.markdownMessage('⚠️ Send some photos/videos first.'));
        return;
      }
      this.slides.delete(chatId);
      try {
        await this.api.call('deleteMessage', { chat_id: chatId, message_id: slide.panel });
      } catch { /* ignore */ }
      await this.api.sendRich(chatId, this.buildSlideshowIrm({ parts: [text], media: slide.media }));
    }
  },

  // ==================================================================== AI

  async cmdAi(msg, args) {
    const chatId = msg.chat.id;
    if (!(await this.ensureAdmin(msg))) return;
    if (!args) {
      await this.api.sendRich(chatId, R.markdownMessage(
        `🤖 **AI — NVIDIA NIM, free forever**\n\nModel: \`${this.ai.model}\`\n\n`
        + '• `/ai write about autumn coffee specials`\n'
        + '• or compose with /post and use the 🤖 buttons: write, rewrite, translate, '
        + 'shorten, expand — the answer **streams in live**, then loads into your post '
        + `with one tap.\n\n${this.ai.statusLine()}`,
      ));
      return;
    }
    this.aiRun(chatId, 'write', args, { replace: false });
  },

  /**
   * Validate a composer AI action; returns an await-state (write/translate),
   * the kind to run immediately, or null.
   */
  async aiAction(chatId, kind) {
    if (!this.ai.enabled) {
      await this.api.sendRich(chatId, R.markdownMessage(
        '🤖 AI is off. Get a **free** NVIDIA key (no card, never expires):\n\n'
        + '1. open build.nvidia.com\n2. sign in → API keys → generate (`nvapi-…`)\n'
        + '3. set `APB_NVIDIA_KEY` in your service and restart me.\n\n'
        + 'Free tier: ~40 requests/min, forever.',
      ));
      return null;
    }
    const comp = this.composers.get(chatId);
    if (kind === 'write') return 'await_ai_prompt';
    if (!comp || !comp.parts.length) {
      await this.api.sendRich(chatId, R.markdownMessage(
        '✍️ Compose something first (/post) — then I can rewrite it.',
      ));
      return null;
    }
    if (kind === 'translate') return 'await_ai_lang';
    return kind;   // rewrite / shorten / expand run immediately
  },

  /** Generate with NVIDIA, streaming live, then offer Use / Regenerate. */
  aiRun(chatId, kind, prompt, { base = null, replace = false } = {}) {
    void this.aiRunTask(chatId, kind, prompt, base, replace)
      .catch((err) => log.error(`ai run crashed\n${err?.stack || err}`));
  },

  async aiRunTask(chatId, kind, prompt, base, replace) {
    try {
      if (base === null && ['rewrite', 'shorten', 'expand', 'translate'].includes(kind)) {
        const comp = this.composers.get(chatId);
        base = comp ? this.composerMarkdown(comp) : '';
      }
      let userPrompt;
      if (kind === 'rewrite') userPrompt = this.ai.rewritePost(base, prompt || 'make it punchier');
      else if (kind === 'shorten') userPrompt = this.ai.shortenPost(base);
      else if (kind === 'expand') userPrompt = this.ai.expandPost(base);
      else if (kind === 'translate') userPrompt = this.ai.translatePost(base, prompt || 'English');
      else userPrompt = this.ai.writePost(prompt);

      const stream = new SmoothStream(this.api, chatId, {
        draftId: Date.now() % 2147483647,
        privateChat: Number(chatId) > 0,
        draftInterval: 800,
      });
      await stream.begin({ thinkingText: `🧠 ${this.ai.model.split('/').pop()} is writing…` });
      let text = '';
      try {
        for await (const chunk of this.ai.stream(userPrompt)) {
          text += chunk;
          stream.update(R.markdownMessage(`${text} ▌`));
        }
      } catch (err) {
        if (!(err instanceof AIError) && !(err instanceof TelegramError)) throw err;
        log.warn(`AI stream failed (${err?.message || err}); trying blocking call`);
        text = await this.ai.complete(userPrompt);
        stream.update(R.markdownMessage(text));
      }

      const msg = await stream.finalize(R.markdownMessage(text));
      this.aiResults.set(chatId, {
        kind, prompt, base, replace, text, msg_id: msg?.message_id,
      });
      if (!msg) return;
      try {
        await this.api.call('editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: msg.message_id,
          reply_markup: kb([[
            { text: '📝 Use in my post', callback_data: `${CB}:aiuse`, style: 'success' },
            { text: '🔁 Regenerate', callback_data: `${CB}:airegen` },
            { text: '🚫 Discard', callback_data: `${CB}:aidel`, style: 'danger' },
          ]]),
        });
      } catch (err) {
        log.debug(`ai markup edit failed: ${err?.message || err}`);
      }
    } catch (err) {
      log.error(`ai run crashed\n${err?.stack || err}`);
      try {
        await this.api.sendRich(chatId, R.markdownMessage(`😵 AI failed: \`${String(err?.message || err).slice(0, 250)}\``));
      } catch { /* ignore */ }
    }
  },

  /** Load the last AI result into the composer; resolves with a status string. */
  async aiUse(chatId) {
    const res = this.aiResults.get(chatId);
    this.aiResults.delete(chatId);
    if (!res) return 'expired';
    let comp = this.composers.get(chatId);
    if (!comp) {
      comp = this.newComposer(chatId);
      comp.parts = [res.text];
      const fakeMsg = {
        chat: { id: chatId, type: 'private' },
        from: { id: this.admins[0] || 0 },
      };
      await this.cmdPost(fakeMsg, '', comp);
      return 'new-post';
    }
    if (res.replace) {
      comp.backup_parts = [...comp.parts];
      comp.parts = [res.text];
    } else {
      comp.parts.push(res.text);
    }
    this.updatePanel(comp, { extra: '🤖 AI result loaded — preview refreshed.' });
    await this.sendPreview(comp);
    return 'loaded';
  },

  // ================================================ composer feed extension

  /** Handle the extra composer await-states; true when consumed. */
  async postoComposerFeed(comp, text, msg) {
    const state = comp.state;
    const chatId = comp.chat_id;

    if (state === 'await_ai_prompt') {
      if (text) {
        comp.state = 'content';
        this.updatePanel(comp);
        this.aiRun(chatId, 'write', text, { replace: false });
      }
      return true;
    }

    if (state === 'await_ai_lang') {
      if (text) {
        comp.state = 'content';
        this.updatePanel(comp);
        this.aiRun(chatId, 'translate', text, { base: this.composerMarkdown(comp), replace: true });
      }
      return true;
    }

    if (state === 'await_repeat') {
      if (text) {
        if (['once', 'none', 'no', '1'].includes(text.toLowerCase())) {
          await this.createScheduled(comp, comp.sched_time, 'none');
          return true;
        }
        const interval = parseInterval(text);
        if (interval) {
          await this.createScheduled(comp, comp.sched_time, `every:${interval}`);
          return true;
        }
      }
      this.updatePanel(comp, {
        extra: '⚠️ Tap a repeat option, or send `once` / an interval like `6h`.',
      });
      return true;
    }

    if (state === 'await_stars') {
      const stars = text.trim().replace(/^⭐/, '').trim();
      if (/^\d+$/.test(stars) && parseInt(stars, 10) >= 1) {
        comp.stars = parseInt(stars, 10);
        comp.state = 'published_panel';
        this.updatePanel(comp, {
          extra: `⭐ Paid post: **${comp.stars} Stars** (photo/video only, experimental).`,
        });
      } else {
        comp.state = 'published_panel';
        this.updatePanel(comp, { extra: '⚠️ Stars must be a number ≥ 1 — paid posting left off.' });
      }
      return true;
    }

    if (state === 'await_sign') {
      comp.signature = text;
      comp.state = 'published_panel';
      this.updatePanel(comp, { extra: `🖋 Signature: _${text || '(none)'}_` });
      return true;
    }

    if (state === 'await_wm_text') {
      if (text) {
        this.store.setSetting('watermark_text', text);
        this.store.setSetting('watermark_on', true);
        const sharp = await watermark.available();
        this.updatePanel(comp, {
          extra: `©️ Watermark “${text}” — ${sharp
            ? 'applied to photos on publish.'
            : '⚠️ install sharp (`npm install sharp`) for real photo watermarks; '
              + "meanwhile it's used as a text signature on photos."}`,
        });
      } else {
        this.store.setSetting('watermark_on', false);
        this.updatePanel(comp, { extra: '©️ Watermark off.' });
      }
      comp.state = 'published_panel';
      return true;
    }

    return false;
  },

  async wmAvailable() {
    return watermark.available();
  },

  async createScheduled(comp, when, repeat) {
    const chatId = comp.chat_id;
    const jid = this.store.addScheduled(
      when,
      comp.target || { kind: 'here', chat_id: chatId },
      this.composerMarkdown(comp),
      {
        mode: comp.mode,
        buttons: comp.buttons,
        media: comp.media,
        note: this.composerTitle(comp),
        repeat,
        slideshow: comp.slideshow,
        stars: comp.stars,
      },
    );
    let repTxt;
    if (repeat === 'none') repTxt = 'once';
    else if (['hourly', 'daily', 'weekly'].includes(repeat)) repTxt = `every ${repeat.slice(0, -2)}`;
    else if (typeof repeat === 'string' && repeat.startsWith('every:')) {
      repTxt = `every ${parseFloat(repeat.split(':')[1]) / 3600}h`;
    } else repTxt = String(repeat);
    this.updatePanel(comp, {
      extra: `📅 Scheduled as \`${jid}\` — ${fmtWhen(when)}, **${repTxt}**.\n👀 \`/schedule\` to manage.`,
    });
  },

  /** After a time was parsed for scheduling — ask how to repeat. */
  askRepeat(comp, when) {
    comp.sched_time = when;
    comp.state = 'await_repeat';
    this.updatePanel(comp, {
      extra: `📅 ${fmtWhen(when)} — **repeat?**\n\nTap below or send an interval like \`6h\`.`,
      keyboard: kb([
        [
          { text: '1️⃣ Once', callback_data: `${CB}:rep:none`, style: 'primary' },
          { text: '🔁 Hourly', callback_data: `${CB}:rep:hourly` },
          { text: '📆 Daily', callback_data: `${CB}:rep:daily` },
          { text: '🗓 Weekly', callback_data: `${CB}:rep:weekly` },
        ],
        [{ text: '🚫 Cancel', callback_data: `${CB}:cancel`, style: 'danger' }],
      ]),
    });
  },

  // ==================================================== publishing support

  async publishChannels(comp) {
    const channels = this.store.channels();
    const pairs = Object.entries(channels);
    if (!pairs.length) {
      this.updatePanel(comp, {
        extra: '🌐 No channels saved yet — /channels to add them (I must be an admin there).',
      });
      return;
    }
    this.publishMulti(
      comp,
      pairs.map(([cid, ch]) => [Number(cid), ch.signature || null]),
      `🌐 ${pairs.length} channels`,
    );
  },

  /** Publish to several destinations with per-channel pacing/signature. */
  publishMulti(comp, dests, label = '') {
    void (async () => {
      const editor = comp.panel_editor;
      let ok = 0;
      let fail = 0;
      for (let i = 0; i < dests.length; i += 1) {
        const [dest, sig] = dests[i];
        try {
          await this.deliverOne(dest, comp, { signature: sig, privateChat: Number(dest) > 0 });
          ok += 1;
          this.store.bump(true);
        } catch (err) {
          fail += 1;
          this.store.bump(false);
          log.warn(`publish to ${dest} failed: ${err?.message || err}`);
        }
        if (editor) {
          editor.update({
            richMessage: R.markdownMessage(
              `📤 **Publishing** ${label} — ${i + 1}/${dests.length} · ✅ ${ok} · ❌ ${fail}`,
            ),
          });
        }
        let delay = 1100;
        const ch = this.store.channel(dest);
        if (ch?.delay) delay = Math.max(200, Number(ch.delay) * 1000);
        await sleep(delay);
      }
      if (editor) {
        let extra = `✅ **Published** to ${ok} chat${ok === 1 ? '' : 's'} · ❌ ${fail} failed.`;
        if (fail) extra += '\n_(check that I\'m admin in the failed channels)_';
        editor.update({ richMessage: R.markdownMessage(extra), replyMarkup: this.publishedKb() });
        await editor.close();
      }
      comp.state = 'published_panel';
    })().catch((err) => log.error(`publish multi crashed\n${err?.stack || err}`));
  },

  /** Blocks-mode rich message: slideshow of collected media + text. */
  buildSlideshowIrm(comp, markdown = null) {
    const mediaBlocks = [];
    for (const m of comp.media || []) {
      const fid = m.media || m.file_id;
      if (m.kind === 'photo') mediaBlocks.push(R.photoBlock(fid));
      else if (m.kind === 'video') mediaBlocks.push(R.videoBlock(fid));
      else if (m.kind === 'animation') mediaBlocks.push(R.animationBlock(fid));
    }
    if (!mediaBlocks.length) mediaBlocks.push(R.paragraph('_(no media)_'));
    const blocks = [R.slideshow(mediaBlocks)];
    const md = markdown !== null ? markdown : (comp.parts || []).join('\n\n');
    blocks.push(...mdToBlocks(md || ''));
    return R.richMessage({ blocks });
  },

  applySignature(markdown, signature) {
    if (!signature) return markdown;
    return `${String(markdown).replace(/\s+$/, '')}\n\n— _${signature}_`;
  },

  // ======================================================= callback router

  /** Handle Posto-feature callbacks; true when consumed. */
  async postoCallback(cbq, parts, action) {
    const msg = cbq.message || {};
    const chat = msg.chat || {};
    const chatId = chat.id;
    const user = cbq.from || {};
    const needAdmin = () => this.ensureAdmin(msg, user);

    // ---- channels ----
    if (action === 'chadd') {
      await this.api.answerCbq(cbq.id);
      if (!(await needAdmin())) return true;
      this.chanSessions.set(chatId, { state: 'await_add' });
      await this.api.sendRich(chatId, R.markdownMessage(
        '➕ **Add channel** — send the `@username` / numeric id, or **forward any post from that channel**.',
      ));
      return true;
    }
    if (['chsig', 'chdelay', 'chdel'].includes(action) && parts.length > 2) {
      const cid = parts[2];
      if (action === 'chdel') {
        await this.api.answerCbq(cbq.id, { text: '🗑 removed' });
        this.store.delChannel(cid);
        await this.sendChannelsPanel(chatId);
        return true;
      }
      await this.api.answerCbq(cbq.id);
      if (action === 'chsig') {
        this.chanSessions.set(chatId, { state: 'await_sign', channel_id: cid });
        await this.api.sendRich(chatId, R.markdownMessage(
          '🖋 Send the signature text appended under every post in that channel (or `-` for none).',
        ));
      } else {
        this.chanSessions.set(chatId, { state: 'await_delay', channel_id: cid });
        await this.api.sendRich(chatId, R.markdownMessage(
          '⏱ Send the delay to wait after posting there (`5s` … `2m`, max `10m`).',
        ));
      }
      return true;
    }

    // ---- templates ----
    if (action === 'tplnew' && parts.length > 2) {
      await this.api.answerCbq(cbq.id);
      if (!(await needAdmin())) return true;
      const comp = this.templateToComposer(chatId, parts[2]);
      if (comp === null) {
        await this.api.answerCbq(cbq.id, { text: 'template gone', showAlert: true });
        return true;
      }
      await this.cmdPost({ chat, from: user }, '', comp);
      return true;
    }
    if (action === 'tpldel' && parts.length > 2) {
      await this.api.answerCbq(cbq.id, { text: '🗑 deleted' });
      this.store.delTemplate(parts[2]);
      await this.cmdTemplates({ chat, from: user });
      return true;
    }

    // ---- bulk ----
    if (action === 'bulkgo') {
      const bulk = this.bulks.get(chatId);
      if (!bulk) {
        await this.api.answerCbq(cbq.id, { text: 'expired — /bulk to restart', showAlert: true });
        return true;
      }
      if (!bulk.items.length) {
        await this.api.answerCbq(cbq.id, { text: 'collect some posts first!', showAlert: true });
        return true;
      }
      await this.api.answerCbq(cbq.id);
      if (bulk.editor) {
        bulk.editor.update({
          richMessage: R.markdownMessage(`${this.bulkMd(bulk)}\n\n**Where to?**`),
          replyMarkup: this.bulkTargetKb(Object.keys(this.store.channels()).length),
        });
      }
      return true;
    }
    if (['bulkhere', 'bulkchans'].includes(action)
      || (action === 'bulk' && parts.length > 2 && ['here', 'chans'].includes(parts[2]))) {
      const bulk = this.bulks.get(chatId);
      if (!bulk) {
        await this.api.answerCbq(cbq.id, { text: 'expired', showAlert: true });
        return true;
      }
      const kind = action === 'bulk' ? parts[2] : action.slice(4);
      await this.api.answerCbq(cbq.id, { text: '⚡ posting…' });
      this.bulkRun(chatId, bulk, kind);
      return true;
    }
    if (action === 'bulksched' && parts.length > 2) {
      const bulk = this.bulks.get(chatId);
      if (!bulk) {
        await this.api.answerCbq(cbq.id, { text: 'expired', showAlert: true });
        return true;
      }
      await this.api.answerCbq(cbq.id);
      bulk.target = parts[2];
      bulk.state = 'await_interval';
      if (bulk.editor) {
        bulk.editor.update({ richMessage: R.markdownMessage(this.bulkMd(bulk)), replyMarkup: null });
      }
      return true;
    }
    if (action === 'bulkcancel') {
      const bulk = this.bulks.get(chatId);
      this.bulks.delete(chatId);
      await this.api.answerCbq(cbq.id, { text: '🚫 cancelled' });
      if (bulk?.editor) {
        bulk.editor.update({ richMessage: R.markdownMessage('🚫 Bulk collector closed.') });
        await bulk.editor.close();
      }
      return true;
    }

    // ---- composer AI ----
    const aiKinds = { aiw: 'write', air: 'rewrite', ait: 'translate', ais: 'shorten', aie: 'expand' };
    if (aiKinds[action]) {
      await this.api.answerCbq(cbq.id);
      if (!(await needAdmin())) return true;
      const kind = aiKinds[action];
      const comp = this.composers.get(chatId);
      const stateOrKind = await this.aiAction(chatId, kind);
      if (stateOrKind === null) return true;
      if (['await_ai_prompt', 'await_ai_lang'].includes(stateOrKind)) {
        if (comp) {
          comp.state = stateOrKind;
          this.updatePanel(comp, {
            extra: kind === 'write'
              ? '🤖 Send the **topic** to write about.'
              : '🌐 Send the **target language** (e.g. `Hindi`, `Spanish`).',
          });
        }
        return true;
      }
      this.aiRun(chatId, kind, null, { replace: true });
      return true;
    }
    if (action === 'aiuse') {
      const status = await this.aiUse(chatId);
      const texts = {
        loaded: '📝 loaded into your post!',
        'new-post': '📝 new post started with the AI text!',
        expired: 'nothing to load — generate something first',
      };
      await this.api.answerCbq(cbq.id, { text: texts[status] || status, showAlert: status === 'expired' });
      return true;
    }
    if (action === 'airegen') {
      const res = this.aiResults.get(chatId);
      if (!res) {
        await this.api.answerCbq(cbq.id, { text: 'nothing to regenerate', showAlert: true });
        return true;
      }
      await this.api.answerCbq(cbq.id, { text: '🔁 regenerating…' });
      this.aiRun(chatId, res.kind, res.prompt, { base: res.base, replace: res.replace });
      return true;
    }
    if (action === 'aidel') {
      this.aiResults.delete(chatId);
      await this.api.answerCbq(cbq.id, { text: '🚫 discarded' });
      return true;
    }

    // ---- composer: repeat / slideshow / paid / signature / watermark ----
    const comp = this.composers.get(chatId);
    if (!comp) return false;

    if (action === 'rep' && parts.length > 2) {
      await this.api.answerCbq(cbq.id);
      const rep = ['none', 'hourly', 'daily', 'weekly'].includes(parts[2]) ? parts[2] : 'none';
      await this.createScheduled(comp, comp.sched_time, rep);
      return true;
    }
    if (action === 'slide') {
      comp.slideshow = !comp.slideshow;
      await this.api.answerCbq(cbq.id, { text: `🎞 slideshow ${comp.slideshow ? 'ON' : 'OFF'}` });
      this.updatePanel(comp);
      this.refreshPreview(comp);
      return true;
    }
    if (action === 'star') {
      await this.api.answerCbq(cbq.id);
      comp.state = 'await_stars';
      this.updatePanel(comp, {
        extra: '⭐ **Paid post** — send the price in **Telegram Stars** (integer ≥ 1). '
          + 'Photo/video posts only, experimental.',
      });
      return true;
    }
    if (action === 'sign') {
      await this.api.answerCbq(cbq.id);
      comp.state = 'await_sign';
      this.updatePanel(comp, { extra: '🖋 Send the signature line appended under this post.' });
      return true;
    }
    if (action === 'wm') {
      if (this.store.setting('watermark_on')) {
        this.store.setSetting('watermark_on', false);
        await this.api.answerCbq(cbq.id, { text: '©️ watermark off' });
        this.updatePanel(comp, { extra: '©️ Watermark off.' });
      } else {
        await this.api.answerCbq(cbq.id);
        comp.state = 'await_wm_text';
        this.updatePanel(comp, {
          extra: '©️ Send the **watermark text** (e.g. `@yourchannel`) — applied to photos when publishing.',
        });
      }
      return true;
    }
    if (action === 'tplsave') {
      await this.api.answerCbq(cbq.id, { text: '📋 template saved' });
      const tid = this.store.addTemplate(this.composerTitle(comp), this.composerMarkdown(comp), {
        buttons: comp.buttons,
        media: comp.media,
        signature: comp.signature || '',
      });
      this.updatePanel(comp, {
        extra: `📋 Saved as template \`${tid}\` — /templates to reuse it.`,
      });
      return true;
    }
    if (action === 'pub' && parts.length > 2 && parts[2] === 'chans') {
      await this.api.answerCbq(cbq.id);
      await this.publishChannels(comp);
      return true;
    }

    return false;
  },

  // ---------------------------------------------------- media preparation

  /**
   * Build InputRichMessage media refs; watermarked photos are re-uploaded via
   * attach:// and returned as `files`.
   */
  async prepareMedia(comp) {
    const wmOn = Boolean(this.store.setting('watermark_on'))
      && Boolean(this.store.setting('watermark_text'));
    const refs = [];
    const files = {};
    for (const m of comp.media || []) {
      let media = m.media;
      const kind = m.kind;
      if (wmOn && kind === 'photo') {
        let marked = null;
        if (await watermark.available()) {
          try {
            const blob = await this.api.downloadFile(media);
            marked = await watermark.watermarkBytes(blob, this.store.setting('watermark_text'));
          } catch (err) {
            log.warn(`watermark download failed: ${err?.message || err}`);
          }
        }
        if (marked) {
          const name = `wm${m.id}`;
          files[name] = { filename: 'watermark.jpg', bytes: marked, contentType: 'image/jpeg' };
          media = `attach://${name}`;
        }
      }
      refs.push(R.mediaRef(m.id, media, kind));
    }
    return { refs, files };
  },
};

export default postoMethods;
