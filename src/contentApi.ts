// Read-only HTTP client for content-api. Every tool goes through `get`.
//
// READ-ONLY BY DESIGN: this module only ever sends GET requests, and it is the
// only place in the server that talks to content-api. Tools that create, update
// or delete must not be added; there is deliberately no way to pass a method or
// a request body.

// Load <project root>/.env, resolved from this file rather than the cwd, since
// clients launch the server from arbitrary directories. Variables already set
// in the environment (e.g. `claude mcp add -e`) take precedence over the file.
try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

// `||` rather than `??`: treat empty values as unset.
const baseUrl = (process.env.CONTENT_API_URL || "http://localhost:1337/api").replace(/\/$/, "");
const apiKey = process.env.CONTENT_API_KEY || undefined;

// stdout is reserved for the MCP protocol; diagnostics go to stderr.
console.error(`content-api base URL: ${baseUrl}`);
if (!apiKey) {
  console.error("CONTENT_API_KEY is not set; api-key protected endpoints will return 403.");
}

type Scalar = string | number | boolean;
export type Query = Record<string, Scalar | Scalar[] | undefined>;

// Laravel conventions: arrays as `key[]=a&key[]=b`, booleans as 1/0.
const toParam = (value: Scalar) => (typeof value === "boolean" ? (value ? "1" : "0") : String(value));

// Per-process response cache, so follow-up questions in a chat don't re-run a
// multi-minute scan of every lesson. Content changes rarely within 10 minutes.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

export function get(path: string, query: Query = {}): Promise<unknown> {
  const url = new URL(`${baseUrl}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(`${key}[]`, toParam(v)));
    else url.searchParams.set(key, toParam(value));
  }

  const hit = cache.get(url.href);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = fetchJson(url);
  cache.set(url.href, { at: Date.now(), value });
  value.catch(() => cache.delete(url.href)); // never cache failures
  return value;
}

async function fetchJson(url: URL): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "error", // a redirect could otherwise be replayed with another method
      headers: {
        Accept: "application/json",
        ...(apiKey ? { "api-key": apiKey } : {}),
      },
    });
  } catch (error) {
    throw new Error(`Cannot reach content-api at ${baseUrl} (is it running?): ${error}`);
  }

  const body = await response.text();
  if (!response.ok) {
    // Keep Laravel's `message` (and validation `errors`); drop debug traces and HTML error pages.
    let detail = response.statusText;
    try {
      const parsed = JSON.parse(body);
      detail = JSON.stringify({ message: parsed.message, errors: parsed.errors });
    } catch {}
    throw new Error(`GET ${url.host}${url.pathname} failed: ${response.status} ${detail}`);
  }
  return body ? JSON.parse(body) : null;
}
