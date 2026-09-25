/**
 * src/selftest.js — offline sanity checks (no network, no bot token needed).
 *
 *   npm test          (or: node src/index.js --selftest)
 *
 * Covers the parsers, rich-message builders, block converter, store,
 * debounced editor, HTTP client (with a mocked fetch), NVIDIA client (mocked
 * SSE), the composer flow, Posto features (channels/bulk/slideshow/turbo/AI),
 * the scheduler and the HTTP status server.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as R from './rich.js';
import * as content from './content.js';
import { parseButtonRows, parseDelay, parseInterval, parseWhen, fmtWhen, kb } from './utils.js';
import { mdToBlocks, inline } from './mdblocks.js';
import { Store } from './store.js';
import { Debouncer, SmoothEditor, SmoothStream } from './smooth.js';
import { Telegram, TelegramError, isEffectError, isUnknownMethod } from './telegram.js';
import { NVIDIA, AIError } from './nvidia.js';
import { Bot } from './handlers.js';
import { Scheduler } from './scheduler.js';
import { HealthServer, resolvePort } from './health.js';
import * as watermark from './watermark.js';
import { sleep } from './utils.js';

let passed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

function section(title) {
  console.log(`\n── ${title}`);
}

// ------------------------------------------------------------- test doubles

class FakeApi {
  constructor() {
    this.messages = [];
    this.calls = [];
    this.nextId = 100;
    this.edits = [];
    this.drafts = [];
    this.ephemeral = [];
    this.multipart = [];
  }

  async call(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'getMe') return { id: 1, username: 'selftest_bot', is_bot: true };
    if (method === 'getChat') return { id: params.chat_id, title: 'Fake Channel', type: 'channel' };
    if (method === 'getFile') return { file_path: 'photos/file_1.jpg' };
    if (method === 'sendMediaGroup') return [{ message_id: this.nextId++ }];
    return { message_id: this.nextId++, chat: { id: params.chat_id ?? 1 } };
  }

  async callMultipart(method, files, params = {}) {
    this.multipart.push({ method, files, params });
    return { message_id: this.nextId++ };
  }

  async sendRich(chatId, irm, kwargs = {}) {
    const msg = { message_id: this.nextId++, chat: { id: chatId } };
    this.messages.push({ chatId, irm, kwargs, msg });
    return msg;
  }

  async sendRichMultipart(chatId, irm, files, kwargs = {}) {
    this.multipart.push({ method: 'sendRichMessage', files, chatId, irm, kwargs });
    return { message_id: this.nextId++ };
  }

  async editRich(chatId, messageId, irm, kwargs = {}) {
    this.edits.push({ chatId, messageId, irm, kwargs });
    return { message_id: messageId };
  }

  async sendText(chatId, text, kwargs = {}) {
    this.calls.push({ method: 'sendMessage', params: { chat_id: chatId, text, ...kwargs } });
    return { message_id: this.nextId++ };
  }

  async sendDraft(chatId, draftId, irm) {
    this.drafts.push({ chatId, draftId, irm });
    return true;
  }

  async sendEphemeralRich(chatId, userId, irm, kwargs = {}) {
    this.ephemeral.push({ chatId, userId, irm, kwargs });
    return { message_id: this.nextId++ };
  }

  async downloadFile() {
    return Buffer.from('fake-image-bytes');
  }

  async answerCbq(id, opts = {}) {
    this.calls.push({ method: 'answerCallbackQuery', params: { id, ...opts } });
    return true;
  }

  async react(chatId, messageId, emoji) {
    this.calls.push({ method: 'setMessageReaction', params: { chatId, messageId, emoji } });
    return true;
  }
}

class FakeAI {
  constructor() {
    this.model = 'fake/model';
    this.enabled = true;
  }

  statusLine() { return `🤖 AI: ${this.model} (fake)`; }

  async *stream(prompt) {
    yield 'Hello ';
    yield `world from ${prompt.slice(0, 12)}`;
  }

  async complete() { return 'Hello world (blocking)'; }

  writePost(p) { return `write:${p}`; }

  rewritePost(t, i) { return `rewrite:${i}`; }

  translatePost(t, l) { return `translate:${l}`; }

  shortenPost(t) { return `shorten:${t}`; }

  expandPost(t) { return `expand:${t}`; }
}

let tmpRoot = null;

function tmpDir() {
  if (!tmpRoot) tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apb-selftest-'));
  return fs.mkdtempSync(path.join(tmpRoot, 'case-'));
}

function makeBot({ admins = [7], ai = null } = {}) {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'apb.json'));
  const api = new FakeApi();
  const bot = new Bot(api, store, { admins, ai: ai || new FakeAI() });
  return { bot, api, store, dir };
}

function privMsg(text, extra = {}) {
  return { chat: { id: 7, type: 'private' }, from: { id: 7, first_name: 'Tester' }, text, ...extra };
}

async function send(bot, msg) {
  bot.dispatch({ message: msg });
  await bot.idle();
  await sleep(5);
}

async function waitUntil(cond, timeoutMs = 8000, step = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(step);
  }
  return false;
}

// ------------------------------------------------------------------- suites

function testUtils() {
  section('utils — time, intervals, buttons');
  const now = new Date(2026, 8, 25, 12, 0, 0);   // Fri 25 Sep 2026 12:00 local
  const near = (value, expected) => Math.abs(value - expected) < 2;

  check('parseWhen +30m', near(parseWhen('+30m', now), now.getTime() / 1000 + 1800));
  check('parseWhen +2h', near(parseWhen('+2h', now), now.getTime() / 1000 + 7200));
  check('parseWhen +1d', near(parseWhen('+1d', now), now.getTime() / 1000 + 86400));
  check('parseWhen bare +90 = minutes', near(parseWhen('+90', now), now.getTime() / 1000 + 5400));
  check('parseWhen +1d12h', near(parseWhen('+1d12h', now), now.getTime() / 1000 + 36 * 3600));
  check('parseWhen 21:30 today', near(parseWhen('21:30', now), new Date(2026, 8, 25, 21, 30).getTime() / 1000));
  check('parseWhen 09:00 rolls to tomorrow', near(parseWhen('09:00', now), new Date(2026, 8, 26, 9, 0).getTime() / 1000));
  check('parseWhen tomorrow = 09:00', near(parseWhen('tomorrow', now), new Date(2026, 8, 26, 9, 0).getTime() / 1000));
  check('parseWhen tmr 10:15', near(parseWhen('tmr 10:15', now), new Date(2026, 8, 26, 10, 15).getTime() / 1000));
  check('parseWhen ISO datetime', near(parseWhen('2026-12-25 10:00', now), new Date(2026, 11, 25, 10, 0).getTime() / 1000));
  check('parseWhen ISO with T', near(parseWhen('2026-12-25T10:00', now), new Date(2026, 11, 25, 10, 0).getTime() / 1000));
  check('parseWhen past ISO → null', parseWhen('2020-01-01 10:00', now) === null);
  check('parseWhen invalid → null', parseWhen('sometime soon', now) === null);
  check('parseWhen empty → null', parseWhen('', now) === null);
  check('parseWhen Feb 31 → null', parseWhen('2027-02-31 10:00', now) === null);
  check('fmtWhen shape', /^[A-Z][a-z]{2} \d{2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}$/.test(fmtWhen(now.getTime() / 1000 + 3600)));

  eq('parseInterval 6h', parseInterval('6h'), 21600);
  eq('parseInterval every 6h', parseInterval('every 6h'), 21600);
  eq('parseInterval 90m', parseInterval('90m'), 5400);
  eq('parseInterval 2d', parseInterval('2d'), 172800);
  eq('parseInterval 30s → below the 1-minute repeat floor', parseInterval('30s'), null);
  eq('parseInterval 1m', parseInterval('1m'), 60);
  eq('parseDelay 5s', parseDelay('5s'), 5);
  eq('parseDelay bare 5 = seconds', parseDelay('5'), 5);
  eq('parseDelay 2m', parseDelay('2m'), 120);
  eq('parseDelay 1h30m', parseDelay('1h30m'), 5400);
  eq('parseDelay junk → null', parseDelay('soon'), null);
  eq('parseInterval bare 45 = minutes', parseInterval('45'), 2700);
  eq('parseInterval 10s → below 1 min floor', parseInterval('10s'), null);
  eq('parseInterval junk → null', parseInterval('soon-ish'), null);

  const parsed = parseButtonRows('Read more | https://example.com | primary\n👍 Like | cb:like ;; 🔄 Share | cb:share\nDelete | cb:delete | danger');
  eq('button rows parsed', parsed.rows.length, 3);
  eq('row 2 has two buttons', parsed.rows[1].length, 2);
  eq('url button', parsed.rows[0][0].url, 'https://example.com');
  eq('style', parsed.rows[0][0].style, 'primary');
  eq('callback button', parsed.rows[1][0].callback_data, 'like');
  eq('no parse errors', parsed.errors.length, 0);
  check('bad style reports error', parseButtonRows('x | cb:y | rainbow').errors.length === 1);
  check('missing action reports error', parseButtonRows('just a label').errors.length === 1);
  check('comment lines ignored', parseButtonRows('# hi\na | cb:b').rows.length === 1);
  eq('kb shape', kb([[{ text: 'x' }]]).inline_keyboard[0][0].text, 'x');
  eq('resolvePort numeric', resolvePort('8080', null), 8080);
  eq('resolvePort junk → fallback', resolvePort('abc', 4321), 4321);
}

function testRich() {
  section('rich — builders & limits');
  eq('bold shape', R.bold('x'), { type: 'bold', text: 'x' });
  eq('link shape', R.link('t', 'https://e.com'), { type: 'url', text: 't', url: 'https://e.com' });
  eq('heading clamps size', R.heading('h', 9).size, 6);
  eq('divider', R.divider(), { type: 'divider' });
  eq('paragraph normalizes', R.paragraph(['a', R.bold('b')]).text.length, 2);
  eq('checklist is a list', R.checklist([['a', true]]).type, 'list');
  eq('checklist checked flag', R.checklist([['a', true]]).items[0].is_checked, true);
  eq('ordered list values', R.orderedList(['a', 'b'], { start: 3 }).items[0].value, 3);
  eq('blockquote credit', R.blockquote(['q'], 'me').credit, 'me');
  eq('table header cells', R.table([['A', 'B'], ['1', '2']]).cells[0][0].is_header, true);
  eq('table aligns', R.table([['A']], { aligns: ['right'] }).cells[0][0].align, 'right');
  eq('table rows', R.table([['A'], ['B'], ['C']]).cells.length, 3);
  check('table column guard', (() => {
    try {
      R.table([new Array(25).fill('x')]);
      return false;
    } catch {
      return true;
    }
  })());
  eq('details blocks', R.details('s', ['p']).blocks[0].type, 'paragraph');
  eq('map defaults', R.mapBlock(1, 2).zoom, 13);
  eq('photo block', R.photoBlock('file_id').photo.media, 'file_id');
  eq('video block streaming flag', R.videoBlock('v').video.media, 'v');
  eq('collage blocks', R.collage([R.photoBlock('a')]).blocks.length, 1);
  eq('slideshow type', R.slideshow([R.photoBlock('a')]).type, 'slideshow');
  eq('rbutton url', R.rbutton('go', { url: 'https://e.com' }).url, 'https://e.com');
  eq('rbutton style', R.rbutton('go', { callbackData: 'x', style: 'danger' }).style, 'danger');
  check('rbutton needs exactly one action', (() => {
    try {
      R.rbutton('x', {});
      return false;
    } catch {
      return true;
    }
  })());
  check('rbutton rejects long callback', (() => {
    try {
      R.rbutton('x', { callbackData: 'z'.repeat(65) });
      return false;
    } catch {
      return true;
    }
  })());
  eq('buttons row', R.buttonsRow([R.rbutton('a', { callbackData: 'a' })]).buttons.length, 1);
  check('buttons row limit', (() => {
    try {
      R.buttonsRow(new Array(9).fill(R.rbutton('a', { callbackData: 'a' })));
      return false;
    } catch {
      return true;
    }
  })());
  eq('thinking block', R.thinking('…').type, 'thinking');
  eq('media ref', R.mediaRef('m1', 'file_id', 'photo').media.media, 'file_id');
  check('media ref slot guard', (() => {
    try {
      R.mediaRef('bad slot!', 'x', 'photo');
      return false;
    } catch {
      return true;
    }
  })());
  check('media ref kind guard', (() => {
    try {
      R.mediaRef('m1', 'x', 'hologram');
      return false;
    } catch {
      return true;
    }
  })());

  const irm = R.richMessage({ markdown: 'hi' });
  eq('rich message markdown mode', irm.markdown, 'hi');
  check('rich message rejects two modes', (() => {
    try {
      R.richMessage({ markdown: 'a', html: 'b' });
      return false;
    } catch {
      return true;
    }
  })());

  const nested = [R.paragraph('a'), R.details('s', [R.paragraph('b'), R.paragraph('c')]), R.bulletList(['x', 'y'])];
  eq('countBlocks counts nesting', R.countBlocks(nested), 9);
  eq('nestingDepth', R.nestingDepth(nested), 2);
  eq('checkLimits clean', R.checkLimits(R.richMessage({ markdown: 'hello' })), []);
  check('checkLimits blocks too long', R.checkLimits(R.richMessage({
    blocks: Array.from({ length: 501 }, () => R.paragraph('x')),
  })).length > 0);
  eq('stripMarkdown', R.stripMarkdown('**bold** and [link](https://x)'), 'bold and link');
  check('plainText from blocks', R.plainText([R.heading('Hi', 2), R.paragraph('there')]).includes('Hi'));
  check('irmPlainText from markdown', R.irmPlainText({ markdown: '**x**' }) === 'x');
  eq('MAX_BLOCKS constant', R.MAX_BLOCKS, 500);

  // regression: inline-only RichText entities (bold, reference, reference_link,
  // anchor_link, …) accidentally placed at block level must be auto-wrapped in
  // a paragraph so Telegram does not reject the message with
  // "can't parse InputRichBlock: type \"reference\" is unsupported".
  const wrapped = R.asBlocks([R.reference('src text', '1'), R.bold('b')]);
  eq('asBlocks wraps inline-only reference in paragraph', wrapped[0].type, 'paragraph');
  eq('wrapped reference preserved', wrapped[0].text.type, 'reference');
  eq('asBlocks wraps inline-only bold in paragraph', wrapped[1].type, 'paragraph');
  // valid block types that share a type with inline RichText must NOT be wrapped
  eq('anchor block is left alone', R.asBlocks(R.anchor('top'))[0].type, 'anchor');
  eq('math block is left alone', R.asBlocks(R.mathBlock('x'))[0].type, 'mathematical_expression');
  // a single inline-only object (not in array) is wrapped too
  eq('single inline-only wraps', R.asBlocks(R.referenceLink('[1]', '1'))[0].type, 'paragraph');
}

function testMdBlocks() {
  section('mdblocks — Markdown → rich blocks');
  const blocks = mdToBlocks('# Title\n\nHello **bold** world\n\n- one\n- [x] two\n\n1. first\n\n> quoted\n\n```js\nconst a = 1;\n```\n\n---\n\n| A | B |\n| :- | -: |\n| 1 | 2 |');
  const types = blocks.map((b) => b.type);
  check('heading block', types.includes('heading'));
  check('pre block', types.includes('pre'));
  check('divider block', types.includes('divider'));
  check('blockquote block', types.includes('blockquote'));
  check('table block', types.includes('table'));
  eq('code language', blocks.find((b) => b.type === 'pre').language, 'js');
  const list = blocks.find((b) => b.type === 'list');
  eq('list items', list.items.length, 2);
  eq('checkbox parsed', list.items[1].is_checked, true);
  const tbl = blocks.find((b) => b.type === 'table');
  eq('table cells', tbl.cells.length, 2);
  eq('table right align', tbl.cells[0][1].align, 'right');
  const inlineOut = inline('a **b** `c` ==d== ||e|| [f](https://g.com)');
  check('inline produces rich text array', Array.isArray(inlineOut));
  check('inline has bold', inlineOut.some((x) => x?.type === 'bold'));
  check('inline has link', inlineOut.some((x) => x?.type === 'url'));
  check('inline drops images', !JSON.stringify(inline('![a](https://x/y.png)hi')).includes('y.png'));
  eq('plain text untouched', inline('just words'), 'just words');
}

function testStore() {
  section('store — atomic JSON persistence');
  const dir = tmpDir();
  const file = path.join(dir, 'apb.json');
  const store = new Store(file);
  store.chatEnsure(7, 'Tester', 'private');
  eq('chat recorded', store.chats(), ['7']);
  store.addChannel('@mychan', { title: 'My Chan', signature: 'sig', delay: 5 });
  eq('channel title', store.channel('@mychan').title, 'My Chan');
  eq('channel signature', store.channel('@mychan').signature, 'sig');
  eq('channels count', Object.keys(store.channels()).length, 1);
  store.addChannel('@mychan', { title: 'My Chan', delay: 9 });
  eq('channel updated in place', store.channel('@mychan').delay, 9);
  check('channel deleted', store.delChannel('@mychan'));
  eq('channels empty', Object.keys(store.channels()).length, 0);

  const tid = store.addTemplate('tpl', '# hi', { buttons: [[{ text: 'a' }]], signature: 's' });
  eq('template stored', store.template(tid).name, 'tpl');
  eq('templates sorted', store.templates()[0][0], tid);
  check('template deleted', store.delTemplate(tid));

  const did = store.addDraft('draft', '# hi');
  eq('draft stored', store.draft(did).markdown, '# hi');
  check('draft deleted', store.delDraft(did));

  const now = Date.now() / 1000;
  const jid = store.addScheduled(now - 1, { kind: 'here', chat_id: 7 }, 'later', { repeat: 'hourly' });
  eq('due job returned', store.dueScheduled(now).length, 1);
  eq('job marked running', store.dueScheduled(now).length, 0);
  check('recurring reschedule', store.rescheduleRecurring(jid, now));
  eq('next run in the future', store.scheduled()[0][1].run_at > now, true);
  eq('repeat interval', store.repeatInterval({ repeat: 'every:3600' }), 3600);
  eq('repeat daily', store.repeatInterval({ repeat: 'daily' }), 86400);
  eq('repeat none', store.repeatInterval({ repeat: 'none' }), null);
  store.finishScheduled(jid, { ok: true });
  eq('job finished', store.scheduled().length, 0);

  const jid2 = store.addScheduled(now, { kind: 'here', chat_id: 7 }, 'x');
  store.finishScheduled(jid2, { ok: false, error: 'boom' });
  eq('failed job kept with status', store.data.scheduled[jid2].status, 'failed');

  store.setSetting('turbo', true);
  eq('setting round trip', store.setting('turbo'), true);
  eq('setting default', store.setting('nope', 'fallback'), 'fallback');
  store.bump(true);
  store.bump(false);
  eq('stats counts', { sent: store.stats().sent, failed: store.stats().failed }, { sent: 1, failed: 1 });

  const reloaded = new Store(file);
  eq('state reloaded from disk', reloaded.setting('turbo'), true);
  eq('chats reloaded', reloaded.chats().length, 1);

  fs.writeFileSync(file, '{ not json ');
  const recovered = new Store(file);
  eq('corrupt file recovers to defaults', recovered.chats().length, 0);
  const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
  eq('corrupt file archived', backups.length, 1);
}

async function testSmooth() {
  section('smooth — debounced editing & streaming');
  let runs = 0;
  const deb = new Debouncer(120, () => { runs += 1; });
  deb.call();
  deb.call();
  deb.call();
  await sleep(20);
  eq('debouncer coalesces bursts', runs, 1);
  await sleep(200);
  eq('debouncer delivers the queued burst once', runs, 2);
  deb.call();
  await sleep(200);
  eq('debouncer runs again later', runs, 3);
  await deb.flush(500);
  deb.close();

  const calls = [];
  const fakeApi = {
    async editRich(chatId, messageId, irm, kwargs = {}) {
      calls.push({ chatId, messageId, irm, kwargs });
      return {};
    },
    async call(method, params) {
      calls.push({ method, params });
      return {};
    },
  };
  const editor = new SmoothEditor(fakeApi, 7, 42, { minInterval: 80 });
  editor.update({ richMessage: R.markdownMessage('one') });
  editor.update({ richMessage: R.markdownMessage('two') });
  await sleep(200);
  eq('editor coalesced to one edit', calls.length, 1);
  eq('editor sent the last payload', calls[0].irm.markdown, 'two');
  editor.update({ richMessage: R.markdownMessage('two') });
  await sleep(200);
  eq('identical payload skipped', calls.length, 1);
  await editor.close();

  // "message is not modified" is swallowed
  let notModCalls = 0;
  const notModApi = {
    async editRich() {
      notModCalls += 1;
      throw new TelegramError('editMessageText', 'Bad Request: message is not modified', 400);
    },
  };
  const editor2 = new SmoothEditor(notModApi, 1, 2, { minInterval: 50 });
  editor2.update({ richMessage: R.markdownMessage('a') });
  await sleep(150);
  eq('not-modified handled', notModCalls, 1);
  check('not-modified not rethrown', editor2.lastError === null || editor2.lastError.message.includes('not modified'));
  await editor2.close();

  const drafts = [];
  const stream = new SmoothStream({
    async sendDraft(chatId, draftId, irm) { drafts.push(irm); return true; },
    async sendRich(chatId, irm) { return { message_id: 1, irm }; },
    async editRich() { return {}; },
    async call() { return {}; },
  }, 7, { draftId: 99, privateChat: true, draftInterval: 60 });
  await stream.begin({ thinkingText: 'Thinking…' });
  eq('draft begin has thinking block', drafts[0].blocks[0].type, 'thinking');
  stream.update(R.markdownMessage('partial'));
  await sleep(150);
  check('draft updated with content', drafts.some((d) => d.markdown === 'partial'));
  const final = await stream.finalize(R.markdownMessage('final'));
  eq('finalize sends the real message', final.irm.markdown, 'final');
}

async function testTelegram() {
  section('telegram — API client (mocked fetch)');
  const realFetch = globalThis.fetch;
  const seen = [];

  try {
    globalThis.fetch = async (url, opts) => {
      seen.push({ url: String(url), opts });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    const tg = new Telegram('123:ABC');
    const res = await tg.call('sendMessage', { chat_id: 7, text: 'hi', unused: null });
    eq('call returns result', res.message_id, 5);
    check('call posts to the right url', seen[0].url === 'https://api.telegram.org/bot123:ABC/sendMessage');
    eq('null params dropped', JSON.parse(seen[0].opts.body).unused, undefined);
    eq('json body sent', JSON.parse(seen[0].opts.body).text, 'hi');

    // error mapping
    globalThis.fetch = async () => new Response(
      JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
    let caught = null;
    try {
      await tg.call('sendMessage', { chat_id: 1, text: 'x' });
    } catch (err) {
      caught = err;
    }
    check('TelegramError raised', caught instanceof TelegramError);
    eq('error code preserved', caught.errorCode, 400);
    check('matches() helper', caught.matches('chat not found'));

    // 429 retry then success
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({
          ok: false, error_code: 429, description: 'Too Many Requests: retry later',
          parameters: { retry_after: 0 },
        }), { status: 429, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true, result: 'done' }), { status: 200 });
    };
    const retryTg = new Telegram('123:ABC');
    eq('429 retried successfully', await retryTg.call('sendMessage', {}), 'done');
    eq('one retry was made', attempts, 2);

    // getUpdates offset bookkeeping
    globalThis.fetch = async () => new Response(JSON.stringify({
      ok: true, result: [{ update_id: 10 }, { update_id: 11 }],
    }), { status: 200 });
    const poller = new Telegram('123:ABC');
    const batch = await poller.getUpdates({ pollTimeout: 1 });
    eq('updates returned', batch.length, 2);
    eq('offset advanced', poller.offset, 12);

    // EFFECT_ID_INVALID: the message must still arrive, just without the effect
    const effectAttempts = [];
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      effectAttempts.push(body);
      if (body.message_effect_id) {
        return new Response(JSON.stringify({
          ok: false, error_code: 400,
          description: 'Bad Request: EFFECT_ID_INVALID',
        }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    };
    const effTg = new Telegram('123:ABC');
    const effRes = await effTg.call('sendRichMessage', {
      chat_id: 7, rich_message: { markdown: 'hi' }, message_effect_id: '5044134455711629726',
    });
    eq('effect error still delivers the message', effRes.message_id, 42);
    eq('exactly one retry was made', effectAttempts.length, 2);
    eq('first attempt carried the effect', effectAttempts[0].message_effect_id, '5044134455711629726');
    eq('retry dropped the effect', effectAttempts[1].message_effect_id, undefined);
    check('the rejected id is remembered', effTg.deadEffectIds.has('5044134455711629726'));

    effectAttempts.length = 0;
    await effTg.call('sendRichMessage', {
      chat_id: 7, rich_message: { markdown: 'again' }, message_effect_id: '5044134455711629726',
    });
    eq('known-dead effect is skipped up front', effectAttempts.length, 1);
    eq('and it is not sent at all', effectAttempts[0].message_effect_id, undefined);

    check('isEffectError recognises EFFECT_ID_INVALID',
      isEffectError(new TelegramError('x', 'Bad Request: EFFECT_ID_INVALID', 400)));
    check('isEffectError ignores other 400s',
      !isEffectError(new TelegramError('x', 'Bad Request: chat not found', 400)));

    // multipart fallback (a media post with a stale effect)
    let multipartEffectParams = null;
    let multipartSawFile = false;
    globalThis.fetch = async (url, opts) => {
      const hasEffect = opts.body.get('message_effect_id') !== null;
      multipartEffectParams = opts.body.get('message_effect_id');
      multipartSawFile = multipartSawFile || opts.body.get('wmm1') !== null;
      if (hasEffect) {
        return new Response(JSON.stringify({
          ok: false, error_code: 400, description: 'Bad Request: EFFECT_ID_INVALID',
        }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 43 } }), { status: 200 });
    };
    const effMedia = await new Telegram('123:ABC').callMultipart('sendRichMessage', {
      wmm1: { filename: 'w.jpg', bytes: Buffer.from('abc'), contentType: 'image/jpeg' },
    }, { chat_id: 7, rich_message: { markdown: 'hi' }, message_effect_id: '9999' });
    eq('multipart effect error still delivers', effMedia.message_id, 43);
    eq('multipart retry dropped the effect', multipartEffectParams, null);
    check('multipart retry kept the upload', multipartSawFile);

    // multipart
    globalThis.fetch = async (url, opts) => {
      seen.push({ url: String(url), opts });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 });
    };
    const multiparter = new Telegram('123:ABC');
    const out = await multiparter.callMultipart('sendRichMessage', {
      wmm1: { filename: 'w.jpg', bytes: Buffer.from('abc'), contentType: 'image/jpeg' },
    }, { chat_id: 7, rich_message: { markdown: 'hi' } });
    eq('multipart result', out.message_id, 9);
    const last = seen[seen.length - 1];
    check('multipart uses FormData', last.opts.body instanceof FormData);
    check('multipart carries the file', last.opts.body.get('wmm1') !== null);
    eq('multipart stringifies objects', last.opts.body.get('rich_message'), JSON.stringify({ markdown: 'hi' }));
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function testNvidia() {
  section('nvidia — NIM client (mocked fetch)');
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      check('nvidia uses the NIM endpoint', String(url).startsWith('https://integrate.api.nvidia.com/v1'));
      eq('nvidia sends the model', body.model, 'nvidia/nemotron-3-super-120b-a12b');
      check('nvidia sends a bearer key', String(opts.headers.authorization).startsWith('Bearer '));
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Hello from NIM' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const ai = new NVIDIA('nvapi-test');
    eq('complete returns text', await ai.complete('hi'), 'Hello from NIM');
    check('enabled with key', ai.enabled);

    const streamChunks = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        for (const chunk of streamChunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }), { status: 200 });
    let text = '';
    for await (const chunk of ai.stream('hi')) text += chunk;
    eq('streaming concatenates deltas', text, 'Hello');

    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401 });
    let authErr = null;
    try {
      await ai.complete('x');
    } catch (err) {
      authErr = err;
    }
    check('401 → AIError', authErr instanceof AIError && authErr.message.includes('401'));

    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'rate limited' }), { status: 429 });
    let rateErr = null;
    try {
      await ai.complete('x');
    } catch (err) {
      rateErr = err;
    }
    check('429 → friendly AIError', rateErr instanceof AIError && /rate limit/i.test(rateErr.message));

    const off = new NVIDIA('');
    check('disabled without key', !off.enabled);
    check('status line explains setup', off.statusLine().includes('APB_NVIDIA_KEY'));
    let noKeyErr = null;
    try {
      await off.complete('x');
    } catch (err) {
      noKeyErr = err;
    }
    check('missing key → AIError', noKeyErr instanceof AIError);
  } finally {
    globalThis.fetch = realFetch;
  }
}

function testContent() {
  section('content — welcome/help/demo');
  const welcome = R.richMessage({ blocks: content.welcomeBlocks() });
  eq('welcome validates', R.checkLimits(welcome), []);
  const demo = R.richMessage({ blocks: content.demoBlocks() });
  eq('demo validates', R.checkLimits(demo), []);
  check('demo under the block budget', R.countBlocks(demo.blocks) < R.MAX_BLOCKS);
  check('help mentions /post', content.helpMarkdown().includes('/post'));
  check('help mentions /bulk', content.helpMarkdown().includes('/bulk'));
  check('composer help mentions preview', content.composerHelpMarkdown().includes('/preview'));
  check('effects table has ❤️', Boolean(content.EFFECTS['❤️']));
  check('dead ❤️ effect id was replaced',
    content.EFFECTS['❤️'] !== '5044134455711629726');
  check('every effect id is numeric', Object.values(content.EFFECTS).every((v) => /^\d{4,}$/.test(v)));
  const savedEffectEnv = process.env.APB_EFFECT_IDS;
  delete process.env.APB_EFFECT_IDS;
  eq('effectId resolves a known emoji', content.effectId('🔥'), content.EFFECTS['🔥']);
  eq('effectId → null for unknown emoji', content.effectId('🦄'), null);
  eq('effectId ignores a malformed override',
    content.effectId('🔥', { '🔥': 'not-an-id' }), content.EFFECTS['🔥']);
  eq('effectId honours a valid override',
    content.effectId('🔥', { '🔥': '1234567890' }), '1234567890');
  process.env.APB_EFFECT_IDS = '{"🔥":"1111111111"}';
  eq('APB_EFFECT_IDS overrides the table', content.effectId('🔥'), '1111111111');
  eq('APB_EFFECT_IDS ignores other emoji', content.effectId('❤️'), content.EFFECTS['❤️']);
  eq('bad JSON override is ignored', (() => {
    process.env.APB_EFFECT_IDS = '{oops';
    return content.effectId('🔥');
  })(), content.EFFECTS['🔥']);
  if (savedEffectEnv === undefined) delete process.env.APB_EFFECT_IDS;
  else process.env.APB_EFFECT_IDS = savedEffectEnv;
  check('stream text non-empty', content.STREAM_TEXT.length > 100);
  eq('demo keyboard is a keyboard', content.demoFooterKeyboard().inline_keyboard.length, 3);
}

async function testComposerFlow() {
  section('bot — composer, preview, publish');
  const { bot, api, store } = makeBot();

  await send(bot, privMsg('/start'));
  check('/start sends a rich message', api.messages.length > 0);

  await send(bot, privMsg('/post'));
  check('composer created', bot.composers.has(7));
  const comp = bot.composers.get(7);
  check('panel message tracked', comp.panel_msg !== null);

  await send(bot, privMsg(''));
  await send(bot, privMsg('# Hello world\n\nThis is **bold** and ==marked==.'));
  eq('markdown part recorded', comp.parts.length, 1);
  check('panel updated', comp.panel_editor.lastPayload !== null || comp.parts.length === 1);

  await send(bot, privMsg('/preview'));
  check('preview message tracked', comp.preview_msg !== null);

  await send(bot, privMsg('/buttons'));
  eq('awaiting buttons', comp.state, 'await_buttons');
  await send(bot, privMsg('Read more | https://example.com | primary\n👍 Like | cb:like'));
  eq('buttons saved', comp.buttons.length, 2);
  eq('state back to content', comp.state, 'content');

  await send(bot, privMsg('/done'));
  eq('publish panel state', comp.state, 'published_panel');

  await bot.onCallback({
    id: 'cb1', data: 'apb:pub:here', from: { id: 7 },
    message: { chat: { id: 7, type: 'private' }, message_id: comp.panel_msg },
  });
  check('published to this chat', comp.published && comp.published.message_id > 0);
  eq('sent counter bumped', store.stats().sent, 1);

  // turbo mode publishes instantly
  await send(bot, privMsg('/turbo'));
  eq('turbo enabled', store.setting('turbo'), true);
  await send(bot, privMsg('/post'));
  const comp2 = bot.composers.get(7);
  await send(bot, privMsg('Turbo post body'));
  await send(bot, privMsg('/done'));
  eq('turbo published directly', store.stats().sent, 2);
  check('turbo kept the composer', comp2.parts.length === 1);
  await send(bot, privMsg('/turbo'));
  eq('turbo disabled again', store.setting('turbo'), false);

  // cancel
  await send(bot, privMsg('/cancel'));
  check('composer closed', !bot.composers.has(7));

  // drafts
  await send(bot, privMsg('/post'));
  await send(bot, privMsg('A draft worth keeping'));
  await bot.onCallback({
    id: 'cb2', data: 'apb:save', from: { id: 7 },
    message: { chat: { id: 7, type: 'private' }, message_id: 101 },
  });
  await sleep(20);
  eq('draft saved', store.drafts().length, 1);
  await send(bot, privMsg('/drafts'));
  const [did] = store.drafts()[0];
  await bot.onCallback({
    id: 'cb3', data: `apb:draft:load:${did}`, from: { id: 7 },
    message: { chat: { id: 7, type: 'private' }, message_id: 101 },
  });
  await sleep(20);
  check('draft loaded into a composer', bot.composers.get(7).parts[0].includes('A draft worth keeping'));

  // scheduling flow
  await bot.onCallback({
    id: 'cb4', data: 'apb:sched', from: { id: 7 },
    message: { chat: { id: 7, type: 'private' }, message_id: 101 },
  });
  await sleep(20);
  eq('awaiting schedule time', bot.composers.get(7).state, 'await_time');
  await send(bot, privMsg('+90m'));
  eq('awaiting repeat choice', bot.composers.get(7).state, 'await_repeat');
  await bot.onCallback({
    id: 'cb5', data: 'apb:rep:daily', from: { id: 7 },
    message: { chat: { id: 7, type: 'private' }, message_id: 101 },
  });
  await sleep(20);
  eq('job scheduled', store.scheduled().length, 1);
  eq('repeat stored', store.scheduled()[0][1].repeat, 'daily');
  await send(bot, privMsg('/schedule'));
  check('/schedule lists jobs', api.messages.some((m) => JSON.stringify(m.irm).includes('Scheduled posts')));
  await send(bot, privMsg('/cancel'));

  // admin gating
  const outsider = makeBot({ admins: [999] });
  outsider.bot.dispatch({
    message: { chat: { id: 5, type: 'private' }, from: { id: 5, first_name: 'Nope' }, text: '/post' },
  });
  await outsider.bot.idle();
  check('non-admin blocked', !outsider.bot.composers.has(5));

  // first /post claims ownership when no admins configured
  const claim = makeBot({ admins: [] });
  claim.bot.dispatch({
    message: { chat: { id: 5, type: 'private' }, from: { id: 5, first_name: 'Boss' }, text: '/post' },
  });
  await claim.bot.idle();
  check('first /post claims ownership', claim.bot.admins.includes(5));
  eq('claim persisted', claim.store.data.admins, [5]);

  // plain mode + media + stats
  await send(bot, privMsg('/post'));
  const comp3 = bot.composers.get(7);
  await send(bot, privMsg('', { photo: [{ file_id: 'small' }, { file_id: 'big' }], message_id: 55 }));
  eq('photo collected', comp3.media.length, 1);
  eq('largest photo chosen', comp3.media[0].media, 'big');
  await bot.onCallback({
    id: 'cb6', data: 'apb:mode', from: { id: 7 },
    message: { chat: { id: 7, type: 'private' }, message_id: comp3.panel_msg },
  });
  await sleep(20);
  eq('mode toggled to plain', comp3.mode, 'plain');
  await send(bot, privMsg('/stats'));
  check('/stats renders', api.messages.some((m) => JSON.stringify(m.irm).includes('Delivery stats')));
  await send(bot, privMsg('/cancel'));
}

async function testPostoFlow() {
  section('posto — channels, bulk, slideshow, AI, templates');
  const { bot, api, store } = makeBot();

  // channels
  await send(bot, privMsg('/channels'));
  check('channels panel sent', api.messages.length > 0);
  await bot.onCallback({
    id: 'c1', data: 'apb:chadd', from: { id: 7 },
    message: { chat: { id: 7, type: 'private' }, message_id: 101 },
  });
  await sleep(10);
  check('channel session opened', bot.chanSessions.has(7));
  await send(bot, privMsg('@mychannel'));
  await waitUntil(() => Object.keys(store.channels()).length === 1);
  eq('channel added', Object.keys(store.channels()), ['@mychannel']);
  eq('channel title from getChat', store.channel('@mychannel').title, 'Fake Channel');

  await bot.onCallback({
    id: 'c2', data: 'apb:chsig:@mychannel', from: { id: 7 },
    message: { chat: { id: 7, type: 'private' }, message_id: 101 },
  });
  await sleep(10);
  await send(bot, privMsg('— my signature'));
  await waitUntil(() => store.channel('@mychannel').signature === '— my signature');
  eq('signature stored', store.channel('@mychannel').signature, '— my signature');

  await bot.onCallback({
    id: 'c3', data: 'apb:chdelay:@mychannel', from: { id: 7 },
    message: { chat: { id: 7, type: 'private' }, message_id: 101 },
  });
  await sleep(10);
  await send(bot, privMsg('2s'));
  await waitUntil(() => store.channel('@mychannel').delay === 2);
  eq('delay stored', store.channel('@mychannel').delay, 2);

  // signatures are applied on publish
  eq('signature applied', bot.applySignature('body', 'sig'), 'body\n\n— _sig_');
  eq('no signature → unchanged', bot.applySignature('body', ''), 'body');

  // templates
  const tid = store.addTemplate('promo', '# Promo\n\nBuy stuff');
  await send(bot, privMsg('/templates'));
  await bot.onCallback({
    id: 'c4', data: `apb:tplnew:${tid}`, from: { id: 7 },
    message: { chat: { id: 7, type: 'private' }, message_id: 101 },
  });
  await sleep(30);
  check('template opened in composer', bot.composers.get(7)?.parts[0].includes('Promo'));
  await send(bot, privMsg('/cancel'));

  // slideshow
  await send(bot, privMsg('/slideshow'));
  check('slideshow session opened', bot.slides.has(7));
  await send(bot, privMsg('', { photo: [{ file_id: 'p1' }], message_id: 61 }));
  await send(bot, privMsg('', { photo: [{ file_id: 'p2' }], message_id: 62 }));
  await waitUntil(() => bot.slides.get(7)?.media.length === 2);
  await send(bot, privMsg('Slideshow caption'));
  const slideMsg = await waitUntil(() => api.messages.some(
    (m) => JSON.stringify(m.irm).includes('"type":"slideshow"'),
  ));
  check('slideshow message built', slideMsg);
  await waitUntil(() => !bot.slides.has(7));

  // bulk
  await send(bot, privMsg('/bulk'));
  check('bulk session opened', bot.bulks.has(7));
  await send(bot, privMsg('First bulk post'));
  await send(bot, privMsg('Second bulk post'));
  await waitUntil(() => bot.bulks.get(7)?.items.length === 2);
  eq('bulk collected two posts', bot.bulks.get(7).items.length, 2);
  await bot.onCallback({
    id: 'c5', data: 'apb:bulkgo', from: { id: 7 },
    message: { chat: { id: 7, type: 'private' }, message_id: 101 },
  });
  await sleep(20);
  await bot.onCallback({
    id: 'c6', data: 'apb:bulk:here', from: { id: 7 },
    message: { chat: { id: 7, type: 'private' }, message_id: 101 },
  });
  const bulkDone = await waitUntil(() => !bot.bulks.has(7), 9000);
  check('bulk finished', bulkDone);
  check('bulk delivered both posts', store.stats().sent >= 2);

  // bulk → auto-schedule
  await send(bot, privMsg('/bulk'));
  await send(bot, privMsg('Scheduled bulk item'));
  await waitUntil(() => bot.bulks.get(7)?.items.length === 1);
  await bot.onCallback({
    id: 'c7', data: 'apb:bulksched:here', from: { id: 7 },
    message: { chat: { id: 7, type: 'private' }, message_id: 101 },
  });
  await sleep(20);
  await send(bot, privMsg('6h'));
  await send(bot, privMsg('now'));
  await waitUntil(() => store.scheduled().length >= 1);
  check('bulk auto-scheduled', store.scheduled().length >= 1);

  // AI flow (start a composer first — the AI buttons live in the panel)
  await send(bot, privMsg('/post'));
  await send(bot, privMsg('Draft to be rewritten by AI'));
  await bot.onCallback({
    id: 'c8', data: 'apb:aiw', from: { id: 7 },
    message: { chat: { id: 7, type: 'private' }, message_id: 101 },
  });
  await sleep(20);
  eq('AI write awaits a prompt', bot.composers.get(7)?.state, 'await_ai_prompt');
  await send(bot, privMsg('coffee specials'));
  const gotAi = await waitUntil(() => bot.aiResults.has(7));
  check('AI result stored', gotAi);
  const aiRes = bot.aiResults.get(7);
  check('AI text streamed', Boolean(aiRes?.text?.includes('Hello')), JSON.stringify(aiRes?.text));
  await bot.onCallback({
    id: 'c9', data: 'apb:aiuse', from: { id: 7 },
    message: { chat: { id: 7, type: 'private' }, message_id: 101 },
  });
  await sleep(50);
  check('AI text loaded into the composer', bot.composers.get(7).parts.some((p) => p.includes('Hello world')));
  await send(bot, privMsg('/cancel'));

  // AI that is switched off
  const off = makeBot({ ai: { enabled: false, model: 'x', statusLine: () => 'off' } });
  await off.bot.onCallback({
    id: 'c10', data: 'apb:air', from: { id: 7 },
    message: { chat: { id: 7, type: 'private' }, message_id: 101 },
  });
  check('AI off shows the setup hint', off.api.messages.some(
    (m) => JSON.stringify(m.irm).includes('APB_NVIDIA_KEY'),
  ));

  // paid posts (stars) state machine
  const { bot: paidBot } = makeBot();
  await send(paidBot, privMsg('/post'));
  await send(paidBot, privMsg('', { photo: [{ file_id: 'p1' }], message_id: 70 }));
  await paidBot.onCallback({
    id: 'p1', data: 'apb:star', from: { id: 7 },
    message: { chat: { id: 7, type: 'private' }, message_id: 101 },
  });
  await sleep(20);
  eq('awaiting star price', paidBot.composers.get(7).state, 'await_stars');
  await send(paidBot, privMsg('25'));
  eq('stars stored', paidBot.composers.get(7).stars, 25);
  await send(paidBot, privMsg('/cancel'));

  // watermark/signature states
  const { bot: wmBot, store: wmStore } = makeBot();
  await send(wmBot, privMsg('/post'));
  await send(wmBot, privMsg('watermark me'));
  await wmBot.onCallback({
    id: 'w1', data: 'apb:wm', from: { id: 7 },
    message: { chat: { id: 7, type: 'private' }, message_id: 101 },
  });
  await sleep(20);
  await send(wmBot, privMsg('@mychannel'));
  await waitUntil(() => wmStore.setting('watermark_on') === true);
  eq('watermark text stored', wmStore.setting('watermark_text'), '@mychannel');
  await send(wmBot, privMsg('/cancel'));

  // watermark module degrades without sharp
  const hasSharp = await watermark.available();
  check('watermark availability probe works', typeof hasSharp === 'boolean');
  if (!hasSharp) {
    eq('watermarkBytes returns null without sharp', await watermark.watermarkBytes(Buffer.from('x'), 'txt'), null);
  }

  // prepareMedia passes file_ids through unchanged when watermarking is off
  const comp = bot.newComposer(7);
  comp.media = [{ id: 'm1', kind: 'photo', media: 'file123' }];
  bot.store.setSetting('watermark_on', false);
  const prepared = await bot.prepareMedia(comp);
  eq('media ref built', prepared.refs[0].media.media, 'file123');
  eq('no uploads when clean', Object.keys(prepared.files).length, 0);
}

async function testGracefulDegradation() {
  section('bot — graceful degradation on older API servers');
  check('404 recognised as unknown method',
    isUnknownMethod(new TelegramError('sendRichMessage', 'Not Found', 404)));
  check('"method not found" text recognised',
    isUnknownMethod(new TelegramError('sendRichMessage', 'method not found', 400)));
  check('ordinary error is not an unknown method',
    !isUnknownMethod(new TelegramError('sendMessage', 'chat not found', 400)));

  const { bot, api, store } = makeBot();
  api.sendRich = async () => { throw new TelegramError('sendRichMessage', 'Not Found', 404); };
  const comp = bot.newComposer(7);
  comp.parts = ['**Hello** rich world'];
  await bot.publishTo(comp, { kind: 'here', chat_id: 7 });
  check('classic fallback delivered the post', api.calls.some(
    (c) => c.method === 'sendMessage' && String(c.params.text || '').includes('Hello rich world')));
  eq('fallback recorded in settings', store.setting('rich_unsupported'), true);
}

async function testSchedulerAndHealth() {
  section('scheduler & HTTP status server');
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'apb.json'));
  const delivered = [];
  const scheduler = new Scheduler(store, async (jid, job) => { delivered.push([jid, job.target]); }, { interval: 50 });

  const past = Date.now() / 1000 - 5;
  store.addScheduled(past, { kind: 'here', chat_id: 7 }, 'due now', { repeat: 'hourly', note: 'tick' });
  await scheduler.tick();
  eq('due job delivered', delivered.length, 1);
  eq('recurring job kept', store.scheduled().length, 1);
  check('recurring job moved forward', store.scheduled()[0][1].run_at > Date.now() / 1000);

  const failing = store.addScheduled(past, { kind: 'here', chat_id: 7 }, 'will fail');
  const failingScheduler = new Scheduler(store, async () => { throw new Error('nope'); });
  await failingScheduler.tick();
  eq('failed job marked', store.data.scheduled[failing].status, 'failed');
  check('scheduler survives failures', true);

  scheduler.start();
  await sleep(120);
  scheduler.stop();
  check('scheduler ticks while running', scheduler.ticks > 0);

  // health server
  const health = new HealthServer({ port: 0, stats: () => ({ chats: 3 }) });
  const started = await health.start();
  check('health server bound', started.ok);
  try {
    const base = `http://127.0.0.1:${health.boundPort}`;
    const live = await fetch(`${base}/health`);
    eq('liveness 200', live.status, 200);
    const liveBody = await live.json();
    eq('liveness reports node runtime', liveBody.runtime, 'node');
    eq('stats merged in', liveBody.chats, 3);

    const notReady = await fetch(`${base}/ready`);
    eq('readiness 503 before login', notReady.status, 503);

    health.markReady('polling @selftest_bot');
    const ready = await fetch(`${base}/ready`);
    eq('readiness 200 after login', ready.status, 200);

    const page = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
    eq('status page 200', page.status, 200);
    check('status page is HTML', (await page.text()).includes('<html'));

    const missing = await fetch(`${base}/nope`);
    eq('unknown path 404', missing.status, 404);
  } catch (err) {
    check('loopback requests work', false, err.message);
  } finally {
    await health.stop();
  }
}

function testStorePersistenceThroughBot() {
  section('bot — persistence, stats & misc commands');
  const { bot, store, api } = makeBot();
  return (async () => {
    await send(bot, privMsg('/id'));
    check('/id answers', api.messages.some((m) => JSON.stringify(m.irm).includes('Chat id')));
    await send(bot, privMsg('/ping'));
    check('/ping answers', api.calls.some((c) => c.method === 'sendMessage' && c.params.text === '🏓 pong'));
    await send(bot, privMsg('/help'));
    check('/help answers', api.messages.some((m) => JSON.stringify(m.irm).includes('Commands')));
    await send(bot, privMsg('/demo'));
    check('/demo answers', api.messages.some((m) => JSON.stringify(m.irm).includes('Everything below is FREE')));
    await send(bot, privMsg('/bcast'));
    check('/bcast explains broadcasting', api.messages.some((m) => JSON.stringify(m.irm).includes('Broadcast')));
    await send(bot, privMsg('/unknown-command'));
    check('unknown commands ignored', true);
    await send(bot, privMsg('hello there'));
    check('non-command reply in private chat', api.messages.length > 0);
    await bot.onCallback({
      id: 'z1', data: 'apb:noop', from: { id: 7 },
      message: { chat: { id: 7, type: 'private' }, message_id: 101 },
    });
    check('noop callback answered', api.calls.some((c) => c.method === 'answerCallbackQuery'));
    await bot.onCallback({
      id: 'z2', data: 'apb:pv', from: { id: 7 },
      message: { chat: { id: 7, type: 'private' }, message_id: 101 },
    });
    check('stale composer callback warns', api.calls.some(
      (c) => c.method === 'answerCallbackQuery' && String(c.params.text || '').includes('Composer expired'),
    ));
    await send(bot, privMsg('/stats'));
    check('stats include node runtime', api.messages.some((m) => JSON.stringify(m.irm).includes('Node')));
    eq('store file exists', fs.existsSync(store.path), true);
  })();
}

async function testLiveClassic() {
  section('bot — streaming & ephemeral');
  const { bot, api } = makeBot();
  bot.startStreamDemo(7);
  const streamed = await waitUntil(() => api.drafts.length > 0 && api.messages.length > 0, 12000, 100);
  check('stream demo sent drafts', api.drafts.length > 0);
  check('stream demo finalized', streamed);
  await bot.onCallback({
    id: 'e1', data: 'apb:secret', from: { id: 7 },
    message: { chat: { id: 7, type: 'private' }, message_id: 101 },
  });
  check('ephemeral demo attempted', api.ephemeral.length > 0);
  bot.typewriterEdit(7, 101, 'one two three four five six seven eight');
  await sleep(600);
  check('typewriter edited a message', api.edits.length > 0);
  bot.onGenerationStopped({ chat: { id: 7 } });
  check('generation-stopped handled', true);
}

// --------------------------------------------------------------------- run

export async function run() {
  const t0 = Date.now();
  console.log('Advanced Posting Bot — offline self-test (Node.js)\n');

  const suites = [
    ['utils', testUtils], ['rich', testRich], ['mdblocks', testMdBlocks], ['store', testStore],
    ['smooth', testSmooth], ['telegram', testTelegram], ['nvidia', testNvidia],
    ['content', testContent], ['composer', testComposerFlow], ['posto', testPostoFlow],
    ['degradation', testGracefulDegradation],
    ['scheduler+health', testSchedulerAndHealth], ['misc', testStorePersistenceThroughBot],
    ['streaming', testLiveClassic],
  ];
  for (const [name, suite] of suites) {
    try {
      await suite();
    } catch (err) {
      failures.push(`suite "${name}" threw: ${err?.stack || err}`);
    }
  }

  const failed = failures.length;
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n' + '─'.repeat(64));
  if (failed) {
    console.log(`❌ ${failed} of ${passed + failed} checks failed (${seconds}s):\n`);
    for (const failure of failures) console.log(`   • ${failure}`);
  } else {
    console.log(`✅ all ${passed} checks passed in ${seconds}s`);
  }
  console.log('─'.repeat(64));

  // Timer-based helpers (debounced editors) may still be pending — the test
  // result is what matters, so exit explicitly.
  process.exit(failed ? 1 : 0);
}

export default run;
