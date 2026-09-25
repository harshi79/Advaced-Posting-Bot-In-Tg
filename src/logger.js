/**
 * src/logger.js — a 30-line leveled logger (no dependencies).
 *
 *   LOG_LEVEL / APB_LOG_LEVEL = debug | info | warn | error | silent
 *
 * Every line is prefixed with a UTC timestamp and the module name so platform
 * log viewers (Veroa, Railway, Render …) stay readable.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

let threshold = LEVELS[String(process.env.APB_LOG_LEVEL || process.env.LOG_LEVEL || 'info').toLowerCase()];
if (threshold === undefined) threshold = LEVELS.info;

export function setLevel(name) {
  const next = LEVELS[String(name || '').toLowerCase()];
  if (next !== undefined) threshold = next;
}

function stamp() {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm (UTC)
}

function render(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function emit(level, name, args) {
  if (LEVELS[level] < threshold) return;
  const line = `${stamp()} ${level.toUpperCase().padEnd(7)} ${name}: ${args.map(render).join(' ')}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function logger(name = 'apb') {
  return {
    debug: (...a) => emit('debug', name, a),
    info: (...a) => emit('info', name, a),
    warn: (...a) => emit('warn', name, a),
    error: (...a) => emit('error', name, a),
    child: (suffix) => logger(`${name}:${suffix}`),
  };
}

export const log = logger('apb');
export default log;
