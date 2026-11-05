#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { search } from "@jmespath-community/jmespath";
import { z } from "zod";
import { get, type Query } from "./contentApi.js";

const server = new McpServer(
  { name: "content-api", version: "0.3.0" },
  {
    instructions:
      "Read-only access to content-api. No tool can create, update or delete content.\n" +
      "To answer questions across many lessons (counts, coverage, which lessons have X), call a legacy_* bulk " +
      "tool with all_lessons: true and a JMESPath `select` that reduces the data to the answer, instead of " +
      "pulling raw data. Legacy per-lesson maps are keyed lesson code -> localization (country code; XX = " +
      "international) -> language code. Start with one or two lessonCodes and no select to learn the exact " +
      "shape, then run the full query. State in the answer which lesson statuses were included.",
  },
);

const selectParam = z
  .string()
  .optional()
  .describe(
    "JMESPath expression applied to the response before it is returned; use it to count, filter or project " +
      "large results down to the answer. Examples on a legacy lesson map: " +
      "count lessons with any German track: length(values(@)[?length(values(@)[?de]) > `0`]); " +
      "list those lesson codes: items(@)[?length(values(@[1])[?de]) > `0`] | map(&@[0], @); " +
      "count lessons: length(keys(@)).",
  );

// Some endpoints (legacy catalogs, multi-language quizzes) return megabytes.
// MCP clients cap tool output (~25k tokens in Claude Code), so cap it here and
// tell the model how to narrow the request instead of failing in the client.
const MAX_RESPONSE_CHARS = 90_000;

function toText(result: unknown): string {
  const text = JSON.stringify(result);
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  return (
    `[Truncated: response is ${text.length} chars, showing the first ${MAX_RESPONSE_CHARS}. ` +
    `Narrow the request (fewer codes, country/language filters, fewer includes, pagination) for the full data.]\n` +
    text.slice(0, MAX_RESPONSE_CHARS)
  );
}

// QA's load balancer cuts requests at 60s, and a cold (server-uncached)
// subtitle batch costs ~0.25s per lesson, more under parallel load. Small
// batches keep every request far below that limit.
const BULK_BATCH_SIZE = 25;
const BULK_CONCURRENCY = 3;

type OnProgress = (done: number, total: number) => Promise<void>;

/**
 * Run a lesson-code-keyed legacy endpoint over every lesson: get all codes,
 * query in batches, and merge the per-batch maps into one map. Reports
 * progress after each batch so clients can keep long scans alive.
 */
async function getForAllLessons(
  path: string,
  query: Query,
  statusId: number | undefined,
  onProgress: OnProgress,
) {
  const { data: codes } = (await get("lessons/codes", { status_id: statusId })) as { data: string[] };
  const batches: string[][] = [];
  for (let i = 0; i < codes.length; i += BULK_BATCH_SIZE) batches.push(codes.slice(i, i + BULK_BATCH_SIZE));

  const merged: Record<string, unknown> = {};
  let next = 0;
  let done = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < batches.length) {
      const batch = batches[next++];
      try {
        Object.assign(merged, await get(path, { ...query, lessonCodes: batch, skipLessonValidation: true }));
        await onProgress(++done, batches.length);
      } catch (error) {
        failed = true; // stop the other workers instead of letting them run on
        throw new Error(`Scan of all ${codes.length} lessons failed at batch starting ${batch[0]}: ${error}`);
      }
    }
  };
  await Promise.all(Array.from({ length: BULK_CONCURRENCY }, worker));
  return merged;
}

type ToolOptions = { bulkLessons?: boolean };

/**
 * Register a read-only tool for one content-api GET endpoint. `{name}`
 * placeholders in `path` are filled from the matching tool arguments; all
 * other arguments are sent as query parameters under their own name, except
 * `select` (applied locally) and, for bulk lesson tools, `all_lessons` and
 * `lesson_status_id`.
 */
function readTool(
  name: string,
  description: string,
  path: string,
  inputSchema: z.ZodRawShape = {},
  { bulkLessons = false }: ToolOptions = {},
) {
  server.registerTool(
    name,
    {
      description: `${description} (GET /api/${path})`,
      inputSchema: { ...inputSchema, select: selectParam },
      annotations: { readOnlyHint: true },
    },
    async (args: Record<string, unknown>, extra) => {
      const { select, all_lessons, lesson_status_id, ...rest } = args;
      const progressToken = extra._meta?.progressToken;
      const onProgress: OnProgress = async (progress, total) => {
        if (progressToken === undefined) return;
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress, total, message: `Scanned batch ${progress} of ${total}` },
        });
      };
      const query: Query = { ...(rest as Query) };
      const resolvedPath = path.replace(/\{(\w+)\}/g, (_, key: string) => {
        const value = query[key];
        delete query[key];
        return encodeURIComponent(String(value));
      });
      try {
        let result: unknown;
        if (bulkLessons && all_lessons) {
          result = await getForAllLessons(resolvedPath, query, lesson_status_id as number | undefined, onProgress);
        } else if (bulkLessons && !query.lessonCodes) {
          throw new Error("Pass lessonCodes, or all_lessons: true.");
        } else {
          result = await get(resolvedPath, query);
        }
        if (typeof select === "string") result = search(result as never, select);
        return { content: [{ type: "text" as const, text: toText(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: String(error) }] };
      }
    },
  );
}

// Shared parameter shapes.
const id = (what: string) => z.number().int().positive().describe(`The ${what} ID`);
const lessonCode = z.string().min(1).describe("Lesson code, e.g. TEH114");
const statusId = z.number().int().optional().describe("Status ID filter: 1 = draft, 2 = published");
const include = (relations: string) =>
  z.string().optional().describe(`Comma-separated relations to include: ${relations}`);
const codeList = (what: string) => z.array(z.string()).min(1).describe(what);
const optionalCodeList = (what: string) => z.array(z.string()).optional().describe(what);

// --- Lessons -----------------------------------------------------------------

readTool(
  "list_lesson_codes",
  "List lesson codes, sorted alphabetically. Defaults to published lessons; soft-deleted lessons are excluded.",
  "lessons/codes",
  { status_id: statusId },
);

readTool("get_lesson", "Get a lesson by code (cached, public read).", "lessons/{code}", {
  code: lessonCode,
  include: include("status, components, learning_outcomes"),
  status_id: statusId,
  component_type_id: z
    .number()
    .int()
    .optional()
    .describe("Filter components by type: 1 = concept, 2 = video, 3 = quiz. Requires include=components"),
});

readTool(
  "get_lesson_container",
  "Get the raw, uncached lesson container by code, including its linked components (concepts, videos, quizzes, learning outcomes).",
  "lesson-containers/{code}",
  { code: lessonCode },
);

// --- Components --------------------------------------------------------------

readTool("get_concept", "Get a concept component by ID.", "concepts/{id}", {
  id: id("concept"),
  include: include("status, assets, relations"),
  status_id: statusId,
});

readTool("get_quiz", "Get a quiz component by ID.", "quizzes/{id}", {
  id: id("quiz"),
  include: include("status, attributes, questions"),
  status_id: statusId,
});

readTool(
  "find_quizzes_by_lesson_codes",
  "Find the quiz components linked to one or more lessons, to learn their quiz IDs and current state.",
  "quizzes",
  {
    lesson_codes: codeList("Lesson codes to resolve quizzes for"),
    country_codes: optionalCodeList("Country codes to scope localized assets to"),
  },
);

readTool("get_video", "Get a video component by ID.", "videos/{id}", {
  id: id("video"),
  include: include("status, assets"),
  status_id: statusId,
});

readTool("get_video_asset", "Get a video asset by ID.", "video-assets/{id}", { id: id("video asset") });

readTool("get_video_asset_element", "Get a video asset element by ID.", "video-asset-elements/{id}", {
  id: id("video asset element"),
  include: include("type, status, attributes, parent, children"),
});

readTool(
  "list_video_asset_elements",
  "List and filter video asset elements (paginated). Filters are OR within a list and AND across filters.",
  "video-asset-elements",
  {
    asset_ids: z.array(z.number().int()).optional().describe("Filter by video asset IDs"),
    type_ids: z.array(z.number().int()).optional().describe("Filter by element type IDs (1 = mp4_url)"),
    languages: optionalCodeList("Filter by language codes"),
    localizations: optionalCodeList("Filter by localization codes"),
    status_ids: z.array(z.number().int()).optional().describe("Filter by status IDs: 1 = draft, 2 = published"),
    parent_ids: z.array(z.number().int()).optional().describe("Filter by parent element IDs"),
    without_asset: z.boolean().optional().describe("Only elements not attached to any video asset"),
    order_by: z.string().optional().describe("Column to sort by (default: id)"),
    direction: z.enum(["asc", "desc"]).optional().describe("Sort direction (default: asc)"),
    per_page: z.number().int().min(1).max(500).optional().describe("Results per page (default 200, max 500)"),
    page: z.number().int().min(1).optional().describe("Page number (default 1)"),
  },
);

// --- Learning outcomes -------------------------------------------------------

readTool("get_learning_outcome", "Get a learning outcome by ID.", "learning-outcomes/{id}", {
  id: id("learning outcome"),
  include: include("status, type, assets"),
  status_id: statusId,
});

readTool(
  "list_learning_outcome_assets",
  "List the assets of a learning outcome.",
  "learning-outcomes/{learning_outcome_id}/assets",
  {
    learning_outcome_id: id("learning outcome"),
    country_codes: optionalCodeList("Filter by localization codes"),
  },
);

readTool("list_learning_outcome_types", "List all learning outcome types.", "learning-outcome-types", {
  include: include("outcomes"),
});

readTool("get_learning_outcome_type", "Get a learning outcome type by ID.", "learning-outcome-types/{id}", {
  id: id("learning outcome type"),
  include: include("outcomes"),
});

// --- Reference data ----------------------------------------------------------

readTool("list_countries", "List all countries.", "countries");
readTool("get_country", "Get a country by ID.", "countries/{id}", { id: id("country") });
readTool("list_languages", "List all languages.", "languages");
readTool("get_language", "Get a language by ID.", "languages/{id}", { id: id("language") });

// --- Legacy (old frontend's response shapes) ---------------------------------

const countryCode = z.string().optional().describe("Single country code to filter assets by, e.g. se");
const countryCodes = optionalCodeList("Country codes (localizations) to filter assets by");
const skipLessonValidation = z.boolean().optional().describe("Skip checking that the lesson codes exist");
const bulkLessons = {
  lessonCodes: codeList("Lesson codes to look up"),
  countryCode,
  countryCodes,
  skipLessonValidation,
};

// Light enough to scan every lesson (measured on QA: 0.4-1.3 MB per 100 lessons).
// Quizzes (~43 MB) and full lessons (~96 MB per 100 lessons) are not.
const allLessonsScan = {
  lessonCodes: codeList("Lesson codes to look up; omit when all_lessons is true").optional(),
  all_lessons: z
    .boolean()
    .optional()
    .describe("Query every lesson (batched; a cold scan can take minutes). Combine with select to get just the answer"),
  lesson_status_id: z
    .number()
    .int()
    .optional()
    .describe("With all_lessons: lesson status to include, 1 = draft, 2 = published (default)"),
};
const scannable = { ...bulkLessons, ...allLessonsScan };
const scan: ToolOptions = { bulkLessons: true };

readTool(
  "legacy_get_lessons",
  "Legacy: full lessons keyed by lesson code. Very large per lesson; for questions across many lessons use the titles/videos/subtitle tools.",
  "legacy/lessons",
  bulkLessons,
);
readTool(
  "legacy_get_lesson_titles",
  "Legacy: lesson titles keyed by lesson code -> localization -> language.",
  "legacy/lessons/titles",
  scannable,
  scan,
);
readTool(
  "legacy_get_lesson_icon_urls",
  "Legacy: lesson icon URLs keyed by lesson code.",
  "legacy/lessons/iconUrls",
  { lessonCodes: allLessonsScan.lessonCodes, all_lessons: allLessonsScan.all_lessons, lesson_status_id: allLessonsScan.lesson_status_id },
  scan,
);
readTool(
  "legacy_get_lesson_quizzes",
  "Legacy: quiz data keyed by lesson code (null for lessons without a quiz). Very large per lesson.",
  "legacy/lessons/quiz",
  bulkLessons,
);
readTool(
  "legacy_get_lesson_subtitle_urls",
  "Legacy: subtitle tracks keyed by lesson code -> localization -> language -> {url, hasBeenProofread}. " +
    "A lesson has subtitles in a language when that language key appears under any localization.",
  "legacy/lessons/subtitleUrls",
  scannable,
  scan,
);
readTool(
  "legacy_get_lesson_videos",
  "Legacy: video files keyed by lesson code -> localization -> language -> {mp4Url, m3u8Url, thumbnailUrl}.",
  "legacy/lessons/videos",
  scannable,
  scan,
);
readTool("legacy_get_lesson", "Legacy: a single lesson object.", "legacy/lessons/{lessonCode}", {
  lessonCode,
  countryCode,
  countryCodes,
});
readTool("legacy_get_lesson_concepts", "Legacy: the concepts of a single lesson.", "legacy/lessons/{lessonCode}/concepts", {
  lessonCode,
});
readTool(
  "legacy_get_catalog_for_country",
  "Legacy: catalog for a country (subjects with nested chapters, sections and lessons). Empty when the country is unknown. Large response.",
  "legacy/catalog/country/{countryCode}",
  {
    countryCode: z.string().min(1).describe("Country code, e.g. se"),
    translationsToInclude: optionalCodeList("Translation keys to include"),
  },
);
readTool(
  "legacy_list_catalog_countries",
  "Legacy: countries with nested school types and grades.",
  "legacy/catalog/countries",
);
readTool(
  "legacy_get_catalog_grade",
  "Legacy: one grade's taxonomy (subjects with nested chapters, sections and lessons).",
  "legacy/catalog/grade/{gradeId}",
  { gradeId: z.number().int().positive().describe("Legacy taxonomy grade ID") },
);
readTool(
  "legacy_list_catalog_subjects",
  "Legacy: all subjects with titles, alternate codes and the countries they are published in.",
  "legacy/catalog/subjects",
);

await server.connect(new StdioServerTransport());
console.error("content-api MCP server running on stdio");
