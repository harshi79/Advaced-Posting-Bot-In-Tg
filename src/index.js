#!/usr/bin/env node
/**
 * src/index.js — Advanced Posting Bot entry point (100% Node.js).
 *
 *   npm start                      # uses BOT_TOKEN / APB_TOKEN env
 *   node src/index.js --token 123:ABC
 *   node src/index.js --selftest   # offline sanity checks, no network
 *   node src/index.js --no-health  # pure worker, no HTTP socket
 *
 * Designed for web-service platforms (Veroa, Render, Railway, Heroku, Koyeb,
 * Fly, Cloud Run, …): the HTTP server binds $PORT *before* the first Telegram
 * round-trip and answers /health (liveness) + /ready (readiness) immediately,
 * so a slow or failing login can never be mistaken for a crash loop.
 *
 * The process is deliberately hard to kill: login failures, network hiccups
 * and handler crashes are logged and retried forever instead of exiting.
 * Missing token? The bot stays up, keeps /health green and explains exactly
 * what to set — the deploy succeeds, the log tells you the fix.
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { logger, setLevel } from './logger.js';
import { HealthServer, resolvePort } from './health.js';
import { Store, defaultDataDir, ensureWritableDir } from './store.js';
import { Telegram } from './telegram.js';
import { Bot } from './handlers.js';
import { Scheduler } from './scheduler.js';
import { sleep } from './utils.js';

const log = logger('main');

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BANNER = String.raw`
 _   _ _______ ____  __  __ _____ ____      _    _
| | | | ____ / ___||  \/  | ____|  _ \    / \  | |
| |_| |  _| \___ \| |\/| |  _| | |_) |  / _ \ | |
|  _  | |___ ___) | |  | | |___|  _ <  / ___ \| |___
|_| |_|_____|____/|_|  |_|_____|_| \_\/_/   \_\_____|
      Advanced Posting Bot · rich · free · smooth
`;

// ------------------------------------------------------------------- args

function parseArgs(argv) {
  const out = {
    token: null, admins: null, data: null, port: null,
    health: true, selftest: false, verbose: false, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--token' || arg === '-t') out.token = next();
    else if (arg.startsWith('--token=')) out.token = arg.slice(8);
    else if (arg === '--admins' || arg === '-a') out.admins = next();
    else if (arg.startsWith('--admins=')) out.admins = arg.slice(9);
    else if (arg === '--data' || arg === '-d') out.data = next();
    else if (arg.startsWith('--data=')) out.data = arg.slice(7);
    else if (arg === '--port' || arg === '-p') out.port = parseInt(next(), 10);
    else if (arg.startsWith('--port=')) out.port = parseInt(arg.slice(7), 10);
    else if (arg === '--no-health') out.health = false;
    else if (arg === '--selftest' || arg === '--test') out.selftest = true;
    else if (arg === '--verbose' || arg === '-v') out.verbose = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function usage() {
  return `Advanced Posting Bot — Node.js edition

  node src/index.js [options]
  npm start

Options
  -t, --token <token>    bot token from @BotFather (or APB_TOKEN / BOT_TOKEN)
  -a, --admins <ids>     comma-separated admin user ids (or APB_ADMINS)
  -d, --data <dir>       data directory (default $APB_DATA_DIR or ./data)
  -p, --port <port>      HTTP status port (default $PORT, else 8080)
      --no-health        do not open the HTTP socket (pure worker mode)
      --selftest         run offline checks and exit
  -v, --verbose          debug logging
  -h, --help             this text

Environment
  APB_TOKEN / BOT_TOKEN / TELEGRAM_TOKEN   bot token (required to actually run)
  APB_ADMINS                              comma-separated admin user ids
  APB_NVIDIA_KEY                          free NVIDIA key for the AI features
  APB_DATA_DIR                            persistent state directory
  APB_PORT / PORT                         HTTP port used by the platform probe
  APB_LOG_LEVEL                           debug | info | warn | error | silent
`;
}

function adminsFrom(args) {
  const raw = args.admins || process.env.APB_ADMINS || process.env.ADMINS || '';
  const out = [];
  for (const chunk of String(raw).replace(/;/g, ',').split(',')) {
    const value = chunk.trim();
    if (/^-?\d+$/.test(value)) out.push(Number(value));
  }
  return out;
}

function adminsText(admins) {
  return admins.length ? admins.join(', ') : '(none yet — the first /post in private chat claims ownership)';
}

// -------------------------------------------------------------- login loop

async function loginWithRetry(tg, health) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const me = await tg.call('getMe');
      return me;
    } catch (err) {
      const code = err?.errorCode;
      const desc = err?.description || err?.message || String(err);
      const lines = [`Could not log in to Telegram: ${desc}`];
      if ([401, 403, 404].includes(code)) {
        lines.push(
          '  • is APB_TOKEN the full "123456789:AA…" string from @BotFather',
          '    — no quotes, no spaces/newlines around it?',
          '  • was the token revoked or regenerated since you saved it?',
          '  • is the env var set on THIS service (not just on your laptop)?',
        );
      } else if (code === -1) {
        lines.push(
          '  • can this host reach api.telegram.org:443 outbound?',
          '    (locked-down networks, egress firewalls and proxies are the usual suspects)',
          '  • does DNS resolve?  try: node -e "fetch(\'https://api.telegram.org\').catch(e=>console.log(e.message))"',
          '  • behind a proxy? set HTTPS_PROXY and restart.',
        );
      } else {
        lines.push('  • compare the message above with https://core.telegram.org/bots/api');
      }
      const waitSec = Math.min(10 * attempt, 60);
      lines.push(`  retrying in ${waitSec}s — the HTTP server stays up, so the deploy is NOT crash-looping.`);
      log.error(lines.join('\n'));
      if (health) health.markNotReady(`login failed (${desc.slice(0, 80)}) — retrying`);
      await sleep(waitSec * 1000);
    }
  }
}

// ------------------------------------------------------------------- main

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.verbose) setLevel('debug');
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }

  if (args.selftest) {
    const { run } = await import('./selftest.js');
    return run();
  }

  const token = args.token
    || process.env.APB_TOKEN
    || process.env.BOT_TOKEN
    || process.env.TELEGRAM_TOKEN
    || process.env.TG_BOT_TOKEN
    || '';

  // --- data dir -----------------------------------------------------------
  const dataDir = ensureWritableDir(args.data || defaultDataDir(PROJECT_ROOT));
  const storePath = path.join(dataDir, 'apb.json');

  // --- HTTP server FIRST --------------------------------------------------
  let health = null;
  if (args.health) {
    const port = resolvePort(args.port, 8080);
    health = new HealthServer({ port });
    const result = await health.start();
    if (result.ok) {
      log.info(`status page: http://0.0.0.0:${result.port}/  (liveness /health · readiness /ready)`);
    } else {
      log.error('HTTP server could NOT bind — the bot still polls Telegram, but a '
        + 'port-probing platform will report no open port. Set PORT to a free port.');
    }
  } else {
    log.info('running in pure worker mode (--no-health): no HTTP socket at all');
  }

  if (!token) {
    const help = [
      '',
      '  ⚠️  NO BOT TOKEN SET — the bot cannot talk to Telegram yet.',
      '',
      '  Set APB_TOKEN (or BOT_TOKEN / TELEGRAM_TOKEN) on this service:',
      '    1. open @BotFather in Telegram → /newbot → copy 123456789:AA…',
      '    2. dashboard → Environment / Variables → add  APB_TOKEN = <that string>',
      '    3. redeploy (or restart) — no code change needed.',
      '',
      '  Optional extras:  APB_ADMINS=123456789   APB_NVIDIA_KEY=nvapi-…   APB_DATA_DIR=/data',
      '',
      '  This process intentionally stays alive and keeps /health green so the',
      '  deployment succeeds; /ready turns green as soon as the token appears.',
      '',
    ].join('\n');
    log.error(help);
    if (health) {
      health.markNotReady('no APB_TOKEN set');
      health.stats = () => ({
        bot: null,
        hint: 'set APB_TOKEN on the service and restart',
        data_dir: dataDir,
      });
    }
    // Keep the process (and the HTTP port) alive; re-check the env every 30s in
    // case the platform injects the variable without a full restart.
    let lastToken = token;
    // eslint-disable-next-line no-constant-condition
    for (;;) {
      await sleep(30000);
      const fresh = process.env.APB_TOKEN || process.env.BOT_TOKEN || process.env.TELEGRAM_TOKEN || '';
      if (fresh && fresh !== lastToken) {
        log.info('token detected in the environment — starting the bot…');
        return runBot({ token: fresh, dataDir, storePath, health, args });
      }
      lastToken = fresh;
    }
  }

  return runBot({ token, dataDir, storePath, health, args });
}

async function runBot({ token, dataDir, storePath, health, args }) {
  const store = new Store(storePath);
  const tg = new Telegram(token);
  const bot = new Bot(tg, store, { admins: adminsFrom(args) });
  const scheduler = new Scheduler(store, (jid, job) => bot.deliverScheduled(jid, job));

  // --- login (retries forever, never exits) -------------------------------
  const me = await loginWithRetry(tg, health);
  const username = me?.username || '(unknown)';

  setLevel(args.verbose ? 'debug' : 'info');
  process.stdout.write(`${BANNER}\n`);
  console.log(`Logged in as @${username} (id ${me?.id})`);
  console.log(`Runtime : Node ${process.version} — zero npm dependencies`);
  console.log(`Admins  : ${adminsText(bot.admins)}`);
  console.log(`Chats   : ${store.chats().length} · scheduled: ${Object.keys(store.data.scheduled).length}`);
  console.log(`Data dir: ${dataDir}${dataDir.startsWith('/tmp') ? '  (ephemeral — set APB_DATA_DIR to persist)' : ''}`);
  if (health) console.log(`HTTP    : ${health.url}  (status page on /)`);
  console.log(bot.ai.statusLine());
  console.log('Try /demo, /post, /bulk, /channels, /ai — Ctrl+C to stop.\n');

  if (health) {
    health.stats = () => ({
      bot: `@${username}`,
      admins: bot.admins.length,
      chats: store.chats().length,
      channels: Object.keys(store.data.channels).length,
      templates: Object.keys(store.data.templates).length,
      drafts: Object.keys(store.data.drafts).length,
      scheduled: Object.keys(store.data.scheduled).length,
      sent: store.data.sent,
      failed: store.data.failed,
      ai: bot.ai.enabled ? bot.ai.model : 'off',
      data_dir: dataDir,
    });
    health.markReady(`polling @${username}`);
  }

  scheduler.start();

  // --- graceful shutdown (platforms send SIGTERM on redeploy) -------------
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received — shutting down cleanly`);
    scheduler.stop();
    try {
      await bot.idle();
    } catch { /* ignore */ }
    if (health) await health.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGHUP', () => { void shutdown('SIGHUP'); });

  // Never die on a stray async error — log it and keep polling.
  process.on('unhandledRejection', (reason) => {
    log.error(`unhandled rejection (ignored, bot keeps running): ${reason?.stack || reason}`);
  });
  process.on('uncaughtException', (err) => {
    log.error(`uncaught exception (ignored, bot keeps running): ${err?.stack || err}`);
  });

  // --- polling loop -------------------------------------------------------
  const allowedUpdates = ['message', 'callback_query', 'stopped_message_generation'];
  for await (const update of tg.updates({
    pollTimeout: 25,
    allowedUpdates,
    shouldStop: () => stopping,
  })) {
    bot.dispatch(update);
  }

  log.info('polling loop ended');
  if (health) health.markNotReady('polling stopped');
  scheduler.stop();
  return 0;
}

main()
  .then((code) => {
    if (typeof code === 'number' && code !== 0) process.exitCode = code;
  })
  .catch((err) => {
    log.error(`startup failed: ${err?.stack || err}`);
    if (process.argv.includes('--selftest') || process.argv.includes('--test')) {
      process.exit(1);            // tests must fail loudly, not hang
    }
    // Even a fatal startup bug keeps the process (and the port) alive so the
    // platform never books it as a crash loop — the log has the details.
    log.error('staying alive so the deployment is not marked as crash-looping; fix the error above and redeploy.');
    setInterval(() => { /* keep the event loop alive */ }, 1 << 30);
  });
