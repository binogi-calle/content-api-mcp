// Build guard: the server is read-only. Fails the build if anything outside
// src/contentApi.ts makes HTTP calls, or if contentApi.ts sends a non-GET method.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const srcDir = new URL("../src/", import.meta.url).pathname;
const problems = [];

for (const file of readdirSync(srcDir, { recursive: true })) {
  if (!file.endsWith(".ts")) continue;
  const text = readFileSync(join(srcDir, file), "utf8");

  if (file !== "contentApi.ts" && /\b(fetch|XMLHttpRequest|axios|node:https?|undici)\b/.test(text)) {
    problems.push(`${file}: HTTP calls are only allowed in src/contentApi.ts`);
  }
  if (/\b(POST|PUT|PATCH|DELETE)\b|\bbody\s*:/.test(text)) {
    problems.push(`${file}: write methods or request bodies are not allowed`);
  }
  if (/readOnlyHint\s*:\s*false/.test(text)) {
    problems.push(`${file}: every tool must be readOnlyHint: true`);
  }
}

if (problems.length) {
  console.error("Read-only check failed: this MCP must never write to content-api.\n" + problems.join("\n"));
  process.exit(1);
}
