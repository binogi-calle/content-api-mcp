# content-api-mcp

MCP server (stdio) that exposes [content-api](../content-api) endpoints as tools.

## Configuration

Settings live in `.env` in the project root (gitignored). Start from the example:

```bash
cp .env.example .env   # then fill in CONTENT_API_KEY
```

| Variable          | Default                     | Notes                                                  |
| ----------------- | --------------------------- | ------------------------------------------------------ |
| `CONTENT_API_URL` | `http://localhost:1337/api` | content-api base URL, including `/api`                 |
| `CONTENT_API_KEY` | none                        | Sent as the `api-key` header; must equal content-api's `AUTH_API_KEY` |

The server loads `.env` from its own folder, whichever directory a client launches it from. A variable already set in the server's environment wins over `.env`, so a client can still override a setting for one registration.

## Run locally

```bash
npm install
npm run build
```

Test in the MCP Inspector (a browser UI for calling tools by hand):

```bash
npm run inspect
```

Register with Claude Code:

```bash
claude mcp add content-api -- node /Users/calle/Binogi/projects/content-api-mcp/dist/index.js
```

Both pick up `.env` automatically. The startup log line `content-api base URL: ...` (stderr) shows which API is in use.

Rebuild (`npm run build`) after changing `src/`, then restart the client session so it picks up the new build.

## Asking questions across all lessons

Questions like "How many lessons have videos with German subtitles?" need data from every lesson, which is far more than a tool result can hold. Two parameters handle this:

- `all_lessons: true` (on the titles, icon URLs, subtitle URLs and videos tools): the server gets every lesson code and queries in batches of 25. Full lessons and quizzes are too heavy (about 1 GB per scan) and don't support it.
- `select` (on every tool): a [JMESPath](https://jmespath.org) expression applied before the result is returned, so only the answer goes back to the model. For example, `length(values(@)[?length(values(@)[?de]) > \`0\`])` counts lessons with any German track.

In the MCP Inspector (no natural language, you fill in the call yourself): Tools → `legacy_get_lesson_subtitle_urls` → `all_lessons` on, `select` = the expression → Run. Scans report progress after each batch. If the Inspector's settings have an option to reset the timeout on progress, turn it on, so a cold scan isn't cut off at the default 60s.

Responses are cached in memory for 10 minutes. A cold scan of every lesson takes about 2 minutes on QA, and follow-up questions in the same session are instant. Restart the server to clear the cache.

## Read-only

This server only reads from content-api. It never creates, updates or deletes, in any environment.

- `src/contentApi.ts` exposes only `get()`. It hard-codes `GET`, takes no method or body, and refuses redirects.
- `npm run build` runs `scripts/check-read-only.mjs` first. The build fails if any other file makes HTTP calls, if any file mentions a write method or a request body, or if a tool is marked `readOnlyHint: false`.

Read endpoints that use `POST` (such as `legacy/catalog/suggestedLessons`) are out of scope too.

## Adding a tool

Each tool maps 1:1 to a content-api GET endpoint. Declare it in `src/index.ts` with `readTool(name, description, path, inputSchema)`:

- `{placeholders}` in `path` are filled from the matching arguments. Every other argument becomes a query parameter, using the argument name as the parameter name.
- Arrays are sent as `key[]=a&key[]=b` and booleans as `1`/`0`.
- Results are compact JSON, truncated at 90k chars (to fit MCP client output limits). A truncated result starts with a note telling the model how to narrow the request.

The endpoint's parameters and their meaning are in content-api's OpenAPI spec (`storage/api-docs/api-docs.json`). Only GET endpoints from `routes/api.php` are allowed.
