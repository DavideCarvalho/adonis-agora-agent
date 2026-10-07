const PREFIX = '[@adonis-agora/agent/opencode]';

/** The engine's console voice — the same `[package] message` lines the rest of the library writes. */
export const openCodeLog = {
  info: (message: string): void => console.info(`${PREFIX} ${message}`),
  warn: (message: string): void => console.warn(`${PREFIX} ${message}`),
  error: (message: string): void => console.error(`${PREFIX} ${message}`),
};

/** The message of whatever was thrown, or `fallback`. */
export function errorText(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.length > 0) return error;
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' && message.length > 0 ? message : fallback;
}
