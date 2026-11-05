// Appends one JSON line per tool call to the question log.
// Holds users' questions verbatim, so it stays local and is gitignored.
//
// Location: SEARCH_LOG_FILE if set (a leading `~` means the user's home
// folder; the .mcpb bundle uses ~/.content-api-mcp/searchlog.jsonl so the log
// survives extension updates), otherwise <project root>/searchlog.jsonl.
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const configured = process.env.SEARCH_LOG_FILE;
export const LOG_FILE = configured
  ? configured.replace(/^~(?=$|[\\/])/, homedir())
  : fileURLToPath(new URL("../searchlog.jsonl", import.meta.url));

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

let dirReady: Promise<unknown> | undefined;

export async function logSearch(entry: SearchLogEntry): Promise<void> {
  try {
    dirReady ??= mkdir(dirname(LOG_FILE), { recursive: true });
    await dirReady;
    await appendFile(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch (error) {
    // Logging must never break a tool call; stdout is the protocol, so stderr.
    console.error(`searchlog write to ${LOG_FILE} failed: ${error}`);
  }
}
