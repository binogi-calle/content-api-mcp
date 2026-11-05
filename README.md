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

### Claude desktop app: install the bundle (for users)

1. Get `content-api-mcp-<version>.mcpb` and the content-api key from the team.
2. Double-click the file. Claude opens an install dialog.
3. Enter the **Content API key**. It's stored in the system keychain and shown masked. Keep **Content API URL** at the QA default unless told otherwise.
4. In a new chat, check that "Binogi Content API" is enabled under "Search and tools".

Node.js ships with the Claude desktop app; nothing else needs installing. Questions are logged to `~/.content-api-mcp/searchlog.jsonl` on the user's own computer (see [Question log](#question-log)).

### Claude desktop app: from source (for developers)

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

Use the absolute path to `node` (`which node`): the app starts servers without your shell's `PATH`. Then quit the app completely (⌘Q) and reopen it. In a new chat, `content-api` appears under "Search and tools". Don't also install the bundle on the same machine, or Claude sees every tool twice.

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

Most interesting questions span every lesson (about 1,500 on QA). That's far more data than a single tool result can hold. Claude answers them in one of two ways.

### First choice: `get_content_coverage`

`GET /api/lessons/content-coverage` is a content-api endpoint built for this MCP. One call returns, for every lesson:

- `status_id`
- `catalogs`: the countries whose catalog visibly lists the lesson, with subject names
- `totals`: quiz questions, concepts, learning outcomes, video
- `parts`: title, description, video, subtitle, transcript, quiz_text, concept and learning_outcome, each as `{localization: {language: [count, proofread]}}`. `proofread` is set only for subtitles. `video` counts mp4 and m3u8 files, so 2 per language.

The response also has `generated_at` (content-api caches it for up to 15 minutes) and `rules.catalog_targets`, which localization and language each country's catalog lists lessons by. On QA the call takes about 5 seconds, against about 2 minutes for a cold legacy scan.

The tool filters by `lesson_status` (`published` by default, `draft` or `all`), then applies `select` to the lessons map `{code: lesson}`. Without `select`, it returns the shape, the rules and one example lesson instead of 7 MB of data. Examples:

| Question | `select` |
| --- | --- |
| Lessons with German subtitles | ``length(values(@)[?length(values(parts.subtitle \|\| `{}`)[?de]) > `0`])`` |
| …in the German (`DE`) localization | `length(values(@)[?parts.subtitle.DE.de])` |
| …with German subtitles not fully proofread | ``length(values(@)[?length(values(parts.subtitle \|\| `{}`)[?de && de[1] < de[0]]) > `0`])`` |
| In the SE catalog but missing an SE/sv title (codes) | `items(@)[?@[1].catalogs.SE && !(@[1].parts.title.SE.sv)] \| map(&@[0], @)` |
| Swedish quiz text incomplete | ``length(values(@)[?totals.quiz_questions > `0` && (parts.quiz_text.XX.sv[0] \|\| `0`) < totals.quiz_questions])`` |

Swap `de` / `sv` for any language code. Two JMESPath gotchas:
- Guard parts a lesson may lack with ``|| `{}` ``.
- Put negated paths in parentheses: `!(parts.title.SE.sv)`. Without them, `!parts.title.SE.sv` negates only `parts` and silently matches nothing.

The coverage data has counts only, with no URLs or text. Questions about actual content (subtitle URLs, title text, quiz questions) go to the other tools.

### Fallback: legacy scans

If `get_content_coverage` fails, for example in an environment that doesn't have the endpoint yet, its error tells Claude to switch to the legacy tools:

- **`all_lessons: true`** makes the server look up every lesson code and query content-api in batches (25 lessons per request, 3 requests at a time). It works on `legacy_get_lesson_titles`, `legacy_get_lesson_icon_urls`, `legacy_get_lesson_subtitle_urls` and `legacy_get_lesson_videos`. Full lessons and quizzes are too heavy to scan (about 1 GB in total), so those tools only take explicit lesson codes. `lesson_status_id` picks drafts (`1`) or published lessons (`2`, the default).
- **`select`** works as above, on the merged legacy map. That map is keyed by lesson code, then localization (`XX` = international), then language: `{"BAE1985": {"DE": {"de": {...}}}}`. For example, ``length(values(@)[?length(values(@)[?de]) > `0`])`` counts lessons with German subtitles in `legacy_get_lesson_subtitle_urls`.

A cold legacy scan takes about 2 minutes on QA and sends a progress update after each batch, so clients that support it don't time out. On QA, both paths gave the same answers when checked on 2026-11-05: lessons with German subtitles (1,257), those in `DE` (1,213), those not fully proofread (61), and lessons with German video (1,211).

### Caching and large results

This server caches every content-api response in memory for 10 minutes, so follow-up questions in the same session are instant. Restart the server to clear its cache.

Results are compact JSON, cut off at 90,000 characters to fit client limits. A truncated result starts with a note telling Claude how to narrow the request.

## Tools

All 31 tools are read-only and map 1:1 to content-api GET endpoints. Every tool also accepts `select` and `user_question` (see [Question log](#question-log)).

| Area | Tools |
| --- | --- |
| Coverage (all lessons, fast) | `get_content_coverage` |
| Lessons | `list_lesson_codes`, `get_lesson`, `get_lesson_container` |
| Lesson content | `get_concept`, `get_quiz`, `find_quizzes_by_lesson_codes`, `get_video`, `get_video_asset`, `get_video_asset_element`, `list_video_asset_elements` |
| Learning outcomes | `get_learning_outcome`, `list_learning_outcome_assets`, `list_learning_outcome_types`, `get_learning_outcome_type` |
| Reference data | `list_countries`, `get_country`, `list_languages`, `get_language` |
| Legacy lessons (old frontend format) | `legacy_get_lessons`, `legacy_get_lesson`, `legacy_get_lesson_titles`, `legacy_get_lesson_icon_urls`, `legacy_get_lesson_quizzes`, `legacy_get_lesson_subtitle_urls`, `legacy_get_lesson_videos`, `legacy_get_lesson_concepts` |
| Legacy catalog | `legacy_get_catalog_for_country`, `legacy_list_catalog_countries`, `legacy_get_catalog_grade`, `legacy_list_catalog_subjects` |

Each tool's description names its endpoint, for example `(GET /api/lessons/{code})`. Parameters and their meaning come from content-api's OpenAPI spec (`storage/api-docs/api-docs.json` in that repo).

## Question log

Every tool call appends one line to the question log. The bundle writes to `~/.content-api-mcp/searchlog.jsonl` in the user's home folder, so it survives extension updates. When running from source, the log is `searchlog.jsonl` in the project root. `SEARCH_LOG_FILE` overrides the location, and a leading `~` means the home folder. Example line:

```json
{"ts":"2026-11-05T01:21:21.855Z","question":"How many published lessons with Swedish titles do we have?","client":"claude-ai","tool":"legacy_get_lesson_titles","args":{"all_lessons":true,"lesson_status_id":2,"select":"…"},"ok":true,"durationMs":3371}
```

Fields: `ts`, `question`, `client` (`claude-ai` = desktop app), `tool`, `args`, `ok`, `durationMs`, and `error` if the call failed.

How the question gets there: an MCP server never sees the chat, only tool calls. So every tool has a `user_question` parameter, and the server's instructions ask Claude to copy the user's message into it verbatim. This has consequences:

- **Only questions that call a tool are logged.** A follow-up that Claude answers from earlier results in the same chat never reaches the server.
- **One question can produce several lines.** A question that needs three tool calls logs three lines with the same `question`.
- **`question` is `null`** when the client didn't pass it (for example, manual calls in the Inspector).
- **The question appears in the tool call** that the chat app shows, and only in the log. It is never sent to content-api.

The log is gitignored because it holds people's questions verbatim. It lives on the machine that runs the server: with the bundle, that's each user's own computer, and the team only sees a user's questions if that user shares their log.

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
manifest.json         .mcpb bundle manifest (install dialog, how the app starts the server)
scripts/check-read-only.mjs   build-time read-only check
scripts/pack-mcpb.mjs         builds the .mcpb bundle
```

### Building the .mcpb bundle

```bash
npm run pack:mcpb
```

This produces `content-api-mcp-<version>.mcpb` in the project root (gitignored), ready to send to users. The script:

1. checks that `manifest.json` and `package.json` have the same version (bump both for a release),
2. runs `npm run build`, including the read-only check,
3. copies only `manifest.json`, `package.json`, `package-lock.json`, `README.md` and `dist/` to `build/mcpb`, then installs production dependencies there (no dev tools, no `src/`, no `.env`),
4. validates the manifest and packs the bundle with the pinned `@anthropic-ai/mcpb` CLI.

`manifest.json` defines the install dialog (`user_config`: API key, marked sensitive and required; API URL, defaulting to QA) and passes the values to the server as `CONTENT_API_KEY` / `CONTENT_API_URL`.

> **Every installed bundle needs the content-api key, and that key can also write.** Send the key separately from the bundle, and only to people who should have it. A hosted connector would keep the key on a server instead.

### Adding a tool

Add one GET endpoint from content-api's `routes/api.php` with `readTool(name, description, path, inputSchema)` in `src/index.ts`:

- `{placeholders}` in `path` are filled from the matching arguments. Every other argument becomes a query parameter with the same name.
- Arrays are sent as `key[]=a&key[]=b` and booleans as `1`/`0`, which is what Laravel expects.
- Pass `{ bulkLessons: true }` as the fifth argument to support `all_lessons`, but only for lesson-code-keyed endpoints that are light enough to scan.

The read-only check runs on every build. It also rejects the word "fetch" outside `src/contentApi.ts`, so phrase descriptions with "look up" or "get".
