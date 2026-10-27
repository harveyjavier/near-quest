/** Tiny leveled logger. Keeps deploy logs greppable without pulling a dependency. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function emit(level, stream, args) {
  if (LEVELS[level] < threshold) return;
  stream(`[${new Date().toISOString()}] [${level.toUpperCase()}]`, ...args);
}

export const log = {
  debug: (...args) => emit('debug', console.debug, args),
  info: (...args) => emit('info', console.log, args),
  warn: (...args) => emit('warn', console.warn, args),
  error: (...args) => emit('error', console.error, args),
};
