import { SaucerSwapError } from "../errors";

/**
 * Shared error formatter for the V3 orderbook tools — mirrors the
 * handleError pattern of the existing V2 tools. Never logs keys, JWTs, or
 * signatures: only Error messages/codes reach the log line.
 */
export const formatOrderbookToolError = (toolTag: string, desc: string, error: unknown) => {
  let message: string;
  if (error instanceof SaucerSwapError) {
    message = `${desc}: ${error.message} (code: ${error.code})`;
  } else if (error instanceof Error) {
    message = `${desc}: ${error.message}`;
  } else {
    message = `${desc}: Unknown error occurred`;
  }
  console.error(`[${toolTag}]`, message);
  return { raw: { error: message }, humanMessage: message };
};
