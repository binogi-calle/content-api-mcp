# content-api-mcp

Ask questions about Binogi's lesson content in plain language, in Claude.

This is an [MCP](https://modelcontextprotocol.io) server that gives Claude **read-only** access to [content-api](https://github.com/Binogi/content-api): lessons, videos, subtitles, quizzes, concepts, learning outcomes and the catalog. Connect it to the Claude desktop app or Claude Code and ask things like:

- *How many lessons have videos with German subtitles?*
- *Which published lessons are missing a Swedish title?*
- *How many lessons have German subtitles that aren't proofread yet?*
- *Show me lesson TEH114 with its components.*
- *What does the Swedish catalog look like for grade 7?*

Claude picks the right tool, queries content-api, and answers. The server can't change any content: every tool only reads.

## Quick start

Requires Node.js 20.12 or newer.

```bash
git clone https://github.com/binogi-calle/content-api-mcp.git
cd content-api-mcp
npm install
npm run build
cp .env.example .env    # then set CONTENT_API_KEY
```

### Configuration

Settings live in `.env` in the project root. It's gitignored; never commit it.

| Variable          | Default                     | Notes                                                                 |
| ----------------- | --------------------------- | --------------------------------------------------------------------- |
| `CONTENT_API_URL` | `http://localhost:1337/api` | content-api base URL, including `/api`. QA: `https://qa-content.binogi.net/api` |
| `CONTENT_API_KEY` | none                        | Must equal `AUTH_API_KEY` of that content-api environment             |

> **Treat the key as a write key.** The MCP only reads, but content-api has a single key for reads and writes. Anyone holding it can change content outside this MCP.

The server loads `.env` from its own folder, whichever directory a client launches it from. A variable already set in the server's environment takes precedence over `.env`.

## Connect it

### Claude desktop app

Add the server to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), alongside any existing keys:

```json
{
  "mcpServers": {
    "content-api": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/content-api-mcp/dist/index.js"]
    }
  }
}
```

Use the absolute path to `node` (`which node`): the app starts servers without your shell's `PATH`. Then quit the app completely (⌘Q) and reopen it. In a new chat, `content-api` appears under "Search and tools".

### Claude Code

From the repo root:

```bash
claude mcp add content-api -- node "$PWD/dist/index.js"
```

### MCP Inspector (manual testing)

```bash
npm run inspect
```

This opens a browser UI where you call tools by hand. There is no natural language, so you fill in each tool's arguments yourself. See [Questions across all lessons](#questions-across-all-lessons) for ready-made `select` expressions.

After changing `src/`, run `npm run build` and restart the client (quit and reopen the desktop app, or start a new Claude Code session).

## Questions across all lessons

Most interesting questions span every lesson (about 1,500 on QA). That's far more data than a single tool result can hold. Two parameters let Claude answer them anyway:

- **`all_lessons: true`** makes the server look up every lesson code and query content-api in batches (25 lessons per request, 3 requests at a time). It works on `legacy_get_lesson_titles`, `legacy_get_lesson_icon_urls`, `legacy_get_lesson_subtitle_urls` and `legacy_get_lesson_videos`. Full lessons and quizzes are too heavy to scan (about 1 GB in total), so those tools only take explicit lesson codes. `lesson_status_id` picks drafts (`1`) or published lessons (`2`, the default).
- **`select`** (on every tool) is a [JMESPath](https://jmespath.org) expression the server applies before returning the result. Only the answer goes back to Claude, not megabytes of raw data. JMESPath only reshapes data; it can't make requests.

The legacy per-lesson data is keyed by lesson code, then localization (country code; `XX` = international), then language: `{"BAE1985": {"DE": {"de": {...}}, "XX": {"en": {...}}}}`. Useful expressions for `legacy_get_lesson_subtitle_urls` (or `_videos` / `_titles`):

| Question | `select` |
| --- | --- |
| Lessons with German subtitles | ``length(values(@)[?length(values(@)[?de]) > `0`])`` |
| Which lessons those are | ``items(@)[?length(values(@[1])[?de]) > `0`] \| map(&@[0], @)`` |
| Only in the German (`DE`) localization | `length(values(@)[?DE.de])` |
| German subtitles not yet proofread | ``length(values(@)[?length(values(@)[?de && de.hasBeenProofread == `false`]) > `0`])`` |
| Total lessons scanned | `length(keys(@))` |

Swap `de` for any language code (`sv`, `en`, `fr`, …).

**Speed:** content-api caches lessons, so a scan of lessons it hasn't cached takes about 2 minutes on QA, and a cached scan takes seconds. This server also caches every response in memory for 10 minutes, so follow-up questions in the same session are instant. Restart the server to clear its cache. Long scans send a progress update after each batch, so clients that support it don't time out.

**Large results:** results are compact JSON, cut off at 90,000 characters to fit client limits. A truncated result starts with a note telling Claude how to narrow the request.

## Tools

All 30 tools are read-only and map 1:1 to content-api GET endpoints. Every tool also accepts `select` and `user_question` (see [Question log](#question-log)).

| Area | Tools |
| --- | --- |
| Lessons | `list_lesson_codes`, `get_lesson`, `get_lesson_container` |
| Lesson content | `get_concept`, `get_quiz`, `find_quizzes_by_lesson_codes`, `get_video`, `get_video_asset`, `get_video_asset_element`, `list_video_asset_elements` |
| Learning outcomes | `get_learning_outcome`, `list_learning_outcome_assets`, `list_learning_outcome_types`, `get_learning_outcome_type` |
| Reference data | `list_countries`, `get_country`, `list_languages`, `get_language` |
| Legacy lessons (old frontend format) | `legacy_get_lessons`, `legacy_get_lesson`, `legacy_get_lesson_titles`, `legacy_get_lesson_icon_urls`, `legacy_get_lesson_quizzes`, `legacy_get_lesson_subtitle_urls`, `legacy_get_lesson_videos`, `legacy_get_lesson_concepts` |
| Legacy catalog | `legacy_get_catalog_for_country`, `legacy_list_catalog_countries`, `legacy_get_catalog_grade`, `legacy_list_catalog_subjects` |

Each tool's description names its endpoint, for example `(GET /api/lessons/{code})`. Parameters and their meaning come from content-api's OpenAPI spec (`storage/api-docs/api-docs.json` in that repo).

## Question log

Every tool call appends one line to `searchlog.jsonl` in the project root:

```json
{"ts":"2026-11-05T01:21:21.855Z","question":"How many published lessons with Swedish titles do we have?","client":"claude-ai","tool":"legacy_get_lesson_titles","args":{"all_lessons":true,"lesson_status_id":2,"select":"…"},"ok":true,"durationMs":3371}
```

Fields: `ts`, `question`, `client` (`claude-ai` = desktop app), `tool`, `args`, `ok`, `durationMs`, and `error` if the call failed.

How the question gets there: an MCP server never sees the chat, only tool calls. So every tool has a `user_question` parameter, and the server's instructions ask Claude to copy the user's message into it verbatim. This has consequences:

- **Only questions that call a tool are logged.** A follow-up that Claude answers from earlier results in the same chat never reaches the server.
- **One question can produce several lines.** A question that needs three tool calls logs three lines with the same `question`.
- **`question` is `null`** when the client didn't pass it (for example, manual calls in the Inspector).
- **The question appears in the tool call** that the chat app shows, and only in the log. It is never sent to content-api.

The log is gitignored because it holds people's questions verbatim. It lives on the machine that runs the server.

## Read-only guarantee

The server never creates, updates or deletes content, in any environment. Two mechanisms enforce this:

- **One way to call the API:** `src/contentApi.ts` is the only code that talks to content-api, and it exposes only `get()`. It hard-codes `GET`, takes no method or request body, and refuses redirects (so a redirect can't make the request use a different method).
- **A check on every build:** `npm run build` runs `scripts/check-read-only.mjs` first. The build fails if any other file makes HTTP calls, if any file mentions a write method or a request body, or if a tool isn't marked `readOnlyHint: true`.

Read endpoints that use `POST` (such as `legacy/catalog/suggestedLessons`) are excluded too. The rule is simply "GET only".

## Development

```
src/index.ts          tools, all_lessons scan, select, output cap
src/contentApi.ts     the only HTTP client: GET-only, .env loading, response cache
src/searchLog.ts      question log
scripts/check-read-only.mjs   build-time read-only check
```

### Adding a tool

Add one GET endpoint from content-api's `routes/api.php` with `readTool(name, description, path, inputSchema)` in `src/index.ts`:

- `{placeholders}` in `path` are filled from the matching arguments. Every other argument becomes a query parameter with the same name.
- Arrays are sent as `key[]=a&key[]=b` and booleans as `1`/`0`, which is what Laravel expects.
- Pass `{ bulkLessons: true }` as the fifth argument to support `all_lessons`, but only for lesson-code-keyed endpoints that are light enough to scan.

The read-only check runs on every build. It also rejects the word "fetch" outside `src/contentApi.ts`, so phrase descriptions with "look up" or "get".
