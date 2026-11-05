// Appends one JSON line per tool call to <project root>/searchlog.jsonl.
// Local-only (gitignored): it holds users' questions verbatim.
import { appendFile } from "node:fs/promises";

const LOG_FILE = new URL("../searchlog.jsonl", import.meta.url);

export type SearchLogEntry = {
  ts: string;
  question: string | null; // the user's chat message, as passed by the model; null if it didn't
  client: string | null; // e.g. "claude-ai", "claude-code", "inspector"
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  error?: string;
};

export async function logSearch(entry: SearchLogEntry): Promise<void> {
  try {
    await appendFile(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch (error) {
    // Logging must never break a tool call; stdout is the protocol, so stderr.
    console.error(`searchlog write failed: ${error}`);
  }
}
