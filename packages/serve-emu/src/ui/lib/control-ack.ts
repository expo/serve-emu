import { parseWsServerJson } from "../../shared/websocket-contracts";

const CONTROL_REJECTION_PREFIX = "serve-emu control input rejected:";

/** Return a console-ready error for a negative control acknowledgement. */
export function controlAcknowledgementError(raw: string): string | null {
  let message: ReturnType<typeof parseWsServerJson>;
  try {
    message = parseWsServerJson(raw);
  } catch {
    return null;
  }
  if (!("ok" in message) || message.ok !== false) return null;
  const error = message.error.trim();
  return error ? `${CONTROL_REJECTION_PREFIX} ${error}` : null;
}

/** Log a negative control acknowledgement without changing stream state. */
export function logControlAcknowledgement(
  raw: string,
  logError: (message: string) => void = console.error,
): boolean {
  const error = controlAcknowledgementError(raw);
  if (!error) return false;
  logError(error);
  return true;
}
