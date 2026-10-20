import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SbError, type SilverBulletClient } from "./sb-client";

const MAX_EXCERPT = 400;

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function errorText(err: unknown): string {
  if (err instanceof SbError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

async function attempt(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return errorResult(errorText(err));
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return "unknown";
  return new Date(ms).toISOString();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function normalizePrefix(prefix: string): string {
  return prefix.trim().replace(/^\/+/, "");
}

export interface RegisterToolsOptions {
  readOnly: boolean;
}

/**
 * Registers the SilverBullet tool surface. Mutating tools are not registered at
 * all in read-only mode, so a model can't call them by accident.
 */
export function registerTools(
  server: McpServer,
  client: SilverBulletClient,
  options: RegisterToolsOptions,
): void {
  server.registerTool(
    "sb_status",
    {
      title: "SilverBullet status",
      description:
        "Check the connection to the configured SilverBullet space: verifies SB_URL and SB_AUTH_TOKEN and reports the space name, index page, server read-only flag and revision mode. Call this first when other SilverBullet tools fail.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      attempt(async () => {
        await client.ping();
        const config = await client.getConfig();
        const lines = [
          `Connected to ${client.url}`,
          `Space: ${config.spaceName ?? "(unnamed)"}${config.spaceFolderPath ? ` — ${config.spaceFolderPath}` : ""}`,
          `Root: ${client.prefix || "/"}${client.prefix ? " (page names are relative to it)" : " (the whole space)"}`,
          `Index page: ${config.indexPage ?? "index"}`,
          `Server read-only: ${config.readOnly ? "yes" : "no"}`,
          `Revisions: ${config.revisions ?? "disabled"}`,
          `Bearer token: accepted`,
          `Writes from this server: ${options.readOnly ? "disabled (SB_READ_ONLY is set)" : "enabled"}`,
        ];
        return textResult(lines.join("\n"));
      }),
  );

  server.registerTool(
    "sb_list_pages",
    {
      title: "List pages",
      description:
        'List pages in the space with size and last-modified time. Use this to discover page names before reading, or with sort="modified" to see what changed recently. Markdown pages only unless includeAttachments is set, and SilverBullet\'s own pages (Library/*, _plug/*, CONFIG, SETTINGS) are hidden unless includeSystem is set.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        prefix: z
          .string()
          .optional()
          .describe(
            'Only include pages whose name starts with this prefix, e.g. "Projects/" (case-insensitive).',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(100)
          .describe("Maximum number of pages to return (1-1000, default 100)."),
        sort: z
          .enum(["name", "modified"])
          .default("name")
          .describe(
            'Sort order: "name" (alphabetical) or "modified" (most recently changed first).',
          ),
        includeAttachments: z
          .boolean()
          .default(false)
          .describe("Include non-markdown files such as images and PDFs. Off by default."),
      },
    },
    async ({ prefix, limit, sort, includeAttachments }) =>
      attempt(async () => {
        const files = await client.listFiles();
        const wanted = includeAttachments
          ? files
          : files.filter((file) => /\.md$/i.test(file.name));
        const normalized = prefix ? normalizePrefix(prefix).toLowerCase() : "";
        const matched = wanted.filter(
          (file) => !normalized || file.name.toLowerCase().startsWith(normalized),
        );

        matched.sort((a, b) =>
          sort === "modified"
            ? (b.lastModified ?? 0) - (a.lastModified ?? 0)
            : a.name.localeCompare(b.name),
        );

        if (matched.length === 0) {
          const hint = normalized ? ` starting with "${prefix}"` : "";
          return textResult(`No pages found${hint}.`);
        }

        const shown = matched.slice(0, limit);
        const truncated = matched.length > shown.length;
        const header = truncated
          ? `Showing ${shown.length} of ${matched.length} pages (sorted by ${sort}). Raise limit or narrow prefix to see more.`
          : `Showing ${matched.length} page${matched.length === 1 ? "" : "s"} (sorted by ${sort}).`;

        const rows = shown.map((file) => {
          const name = /\.md$/i.test(file.name) ? file.name.replace(/\.md$/i, "") : file.name;
          const size = formatBytes(file.size ?? 0);
          const modified = formatTimestamp(file.lastModified);
          const readOnly = file.perm === "ro" ? "\tread-only" : "";
          return `${name}\t${size}\t${modified}${readOnly}`;
        });

        return textResult([header, "", ...rows].join("\n"));
      }),
  );

  server.registerTool(
    "sb_read_page",
    {
      title: "Read page",
      description:
        'Read a page\'s markdown. Page names omit the .md extension ("Projects/Alpha", not "Projects/Alpha.md"); wiki-link syntax and #anchors are accepted and stripped. Returns the content plus its ETag, which sb_write_page accepts as ifMatch for conflict-safe updates.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        page: z
          .string()
          .min(1)
          .describe('Page name, e.g. "index", "Projects/Alpha" or "Journal/2026-10-20".'),
        fromLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("First line to return (1-based). Omit to start at the beginning."),
        toLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Last line to return (inclusive). Omit for the end."),
      },
    },
    async ({ page, fromLine, toLine }) =>
      attempt(async () => {
        const result = await client.readPage(page);
        const total = lineCount(result.content);

        let content = result.content;
        let range: string | undefined;
        if (fromLine !== undefined || toLine !== undefined) {
          const lines = result.content.split("\n");
          const start = Math.min(Math.max(fromLine ?? 1, 1), Math.max(total, 1));
          const end = Math.min(toLine ?? total, total);
          if (fromLine !== undefined && fromLine > total) {
            throw new SbError(`Page "${result.page}" has only ${total} lines.`, "invalid");
          }
          if (end < start) {
            throw new SbError(`toLine (${end}) must not be before fromLine (${start}).`, "invalid");
          }
          content = lines.slice(start - 1, end).join("\n");
          range = `lines: ${start}-${end} of ${total}`;
        }

        const header = [
          `page: ${result.path}`,
          `modified: ${formatTimestamp(result.lastModified)}`,
          `size: ${formatBytes(result.size)}`,
          ...(range ? [range] : []),
          ...(result.etag ? [`etag: ${result.etag}`] : []),
        ];

        return textResult(`${header.join("\n")}\n---\n${content}`);
      }),
  );

  server.registerTool(
    "sb_search",
    {
      title: "Search pages",
      description:
        "Full-text search across the space via the server's search backend (word, phrase or semantic mode). Returns matching pages with line numbers, section headings and excerpts. Results are limited to the configured root, if any. Fails clearly when the server has no search backend configured — use sb_list_pages in that case.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        query: z.string().min(1).describe("What to search for."),
        mode: z
          .enum(["words", "phrase", "natural"])
          .optional()
          .describe(
            '"words" matches individual terms, "phrase" requires an exact phrase, "natural" is semantic search. Omit for the server default.',
          ),
        scope: z
          .enum(["pages", "meta", "all"])
          .optional()
          .describe(
            'Where to search: "pages" (regular pages), "meta" (meta pages such as CONFIG, SETTINGS and Library/*) or "all". Defaults to all.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Maximum number of results (1-50, default 10)."),
      },
    },
    async ({ query, mode, scope, limit }) =>
      attempt(async () => {
        const response = await client.search(query, { mode, scope, limit });
        const items = response.items.slice(0, limit);
        if (items.length === 0) {
          return textResult(
            `No results for "${query}".${response.notice ? `\n${response.notice}` : ""}`,
          );
        }

        const header = `Found ${response.total ?? items.length} result${items.length === 1 ? "" : "s"} for "${query}".`;
        const rows = items.map((item, index) => {
          const meta = [`${index + 1}. ${item.page}`];
          if (item.line) meta.push(`line ${item.line}`);
          if (item.heading) meta.push(`section "${item.heading}"`);
          const excerpt = item.excerpt?.replace(/\s+/g, " ").trim();
          return `${meta.join(" · ")}${excerpt ? `\n   ${truncate(excerpt, MAX_EXCERPT)}` : ""}`;
        });

        const footer = response.notice ? ["", response.notice] : [];
        return textResult([header, "", ...rows, ...footer].join("\n"));
      }),
  );

  if (options.readOnly) return;

  server.registerTool(
    "sb_write_page",
    {
      title: "Write page",
      description:
        'Replace a page\'s entire content, creating it if it does not exist. For appending use sb_append_to_page; for a small edit use sb_replace_in_page. Pass mode="create" to fail instead of overwriting an existing page, or ifMatch (an ETag from sb_read_page) to fail if the page changed since you read it.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        page: z.string().min(1).describe('Page name without extension, e.g. "Projects/Alpha".'),
        content: z.string().describe("Full markdown content of the page."),
        mode: z
          .enum(["overwrite", "create"])
          .default("overwrite")
          .describe(
            '"overwrite" replaces the page (default); "create" fails if the page already exists.',
          ),
        ifMatch: z
          .string()
          .optional()
          .describe("ETag from sb_read_page. The write fails if the page changed since then."),
      },
    },
    async ({ page, content, mode, ifMatch }) =>
      attempt(async () => {
        if (mode === "create" && ifMatch) {
          throw new SbError('ifMatch cannot be combined with mode="create".', "invalid");
        }
        const result = await client.writePage(page, content, {
          createOnly: mode === "create",
          ifMatch,
        });
        const action = mode === "create" ? "Created" : "Wrote";
        return textResult(
          `${action} ${result.path} (${formatBytes(result.size)}, ${lineCount(content)} lines)${result.etag ? `\netag: ${result.etag}` : ""}`,
        );
      }),
  );

  server.registerTool(
    "sb_append_to_page",
    {
      title: "Append to page",
      description:
        "Append markdown to the end of a page, creating the page when it does not exist yet. Safe against concurrent edits: it re-reads and retries if the page changes mid-write. Good for journal entries, meeting notes and logs.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        page: z.string().min(1).describe('Page name without extension, e.g. "Journal/2026-10-20".'),
        content: z.string().min(1).describe("Markdown to append."),
        separator: z
          .string()
          .default("\n\n")
          .describe(
            'Inserted between existing content and the addition. Defaults to a blank line ("\\n\\n"); use "\\n" for a single newline.',
          ),
      },
    },
    async ({ page, content, separator }) =>
      attempt(async () => {
        const result = await client.appendToPage(page, content, { separator });
        const action = result.created ? "Created" : "Appended to";
        return textResult(
          `${action} ${result.path} (${formatBytes(result.previousSize)} → ${formatBytes(result.size)})${result.etag ? `\netag: ${result.etag}` : ""}`,
        );
      }),
  );

  server.registerTool(
    "sb_replace_in_page",
    {
      title: "Replace text in page",
      description:
        "Replace an exact snippet of text inside a page without rewriting the whole file. Refuses to act when the snippet is missing, and refuses ambiguous edits unless all=true. The write fails rather than clobbering a concurrent change.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        page: z.string().min(1).describe('Page name without extension, e.g. "Projects/Alpha".'),
        find: z
          .string()
          .min(1)
          .describe("Exact text to replace, including whitespace. Must match verbatim."),
        replace: z
          .string()
          .describe("Replacement text. Use an empty string to delete the snippet."),
        all: z
          .boolean()
          .default(false)
          .describe("Replace every occurrence instead of requiring exactly one match."),
      },
    },
    async ({ page, find, replace, all }) =>
      attempt(async () => {
        const result = await client.replaceInPage(page, find, replace, { all });
        return textResult(
          `Replaced ${result.occurrences} occurrence${result.occurrences === 1 ? "" : "s"} in ${result.path} (now ${formatBytes(result.size)})${result.etag ? `\netag: ${result.etag}` : ""}`,
        );
      }),
  );

  server.registerTool(
    "sb_delete_page",
    {
      title: "Delete page",
      description:
        "Permanently delete a page. Only the exact page name is affected — no wildcards or folders. Pass ifMatch (an ETag from sb_read_page) to avoid deleting a page that changed since you read it.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        page: z.string().min(1).describe('Page name without extension, e.g. "Scratch".'),
        ifMatch: z
          .string()
          .optional()
          .describe("ETag from sb_read_page; the delete fails if the page changed."),
      },
    },
    async ({ page, ifMatch }) =>
      attempt(async () => {
        const result = await client.deletePage(page, { ifMatch });
        return textResult(`Deleted ${result.path}.`);
      }),
  );
}
