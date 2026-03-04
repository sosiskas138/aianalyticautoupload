type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 4,
};

function getLevel(): number {
  const env = (process.env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
  return LEVELS[env] ?? LEVELS.info;
}

function ts(): string {
  return new Date().toISOString();
}

export const log = {
  debug(...args: unknown[]) {
    if (getLevel() <= LEVELS.debug) console.log(`[${ts()}] DEBUG`, ...args);
  },
  info(...args: unknown[]) {
    if (getLevel() <= LEVELS.info) console.log(`[${ts()}] INFO`, ...args);
  },
  warn(...args: unknown[]) {
    if (getLevel() <= LEVELS.warn) console.warn(`[${ts()}] WARN`, ...args);
  },
  error(...args: unknown[]) {
    if (getLevel() <= LEVELS.error) console.error(`[${ts()}] ERROR`, ...args);
  },
};
