import { normalizeRoot, type SilverBulletConfig } from "./config";

const CLIENT_ID = "silverbullet-mcp";
const PAGE_EXTENSION = ".md";
const MAX_ERROR_BODY = 300;

export type SbErrorKind = "auth" | "not_found" | "conflict" | "http" | "network" | "invalid";

export class SbError extends Error {
  override name = "SbError";
  readonly kind: SbErrorKind;
  readonly status: number | undefined;

  constructor(message: string, kind: SbErrorKind, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface FileMeta {
  name: string;
  created?: number;
  lastModified?: number;
  contentType?: string;
  size?: number;
  perm?: string;
}

export interface SpaceConfig {
  spaceName?: string;
  spaceFolderPath?: string;
  indexPage?: string;
  readOnly?: boolean;
  revisions?: string;
  syncProtocolVersion?: number;
  shellBackend?: string;
}

export interface PageContent {
  /** Page name as addressed by the caller, e.g. `Projects/Alpha`. */
  page: string;
  /** File path inside the space, e.g. `Projects/Alpha.md`. */
  path: string;
  content: string;
  etag?: string;
  lastModified?: number;
  size: number;
}

export interface WriteResult {
  page: string;
  path: string;
  size: number;
  etag?: string;
}

export interface AppendResult extends WriteResult {
  created: boolean;
  previousSize: number;
}

export interface ReplaceResult extends WriteResult {
  occurrences: number;
}

export interface SearchItem {
  page: string;
  pos?: number;
  line?: number;
  heading?: string;
  excerpt?: string;
  highlights?: string[];
}

export interface SearchResponse {
  items: SearchItem[];
  total?: number;
  partial?: boolean;
  notice?: string;
}

export interface SearchOptions {
  mode?: "words" | "phrase" | "natural";
  scope?: "pages" | "meta" | "all";
  limit?: number;
}

export interface WriteOptions {
  /** Refuse to overwrite an existing page (`If-None-Match: *`). */
  createOnly?: boolean;
  /** Only write if the page still matches this ETag (`If-Match`). */
  ifMatch?: string;
}

/**
 * Turns what a person would type into a path inside the space: strips
 * `[[wiki links]]`, `#anchors` and `^block refs`, then adds `.md` unless the
 * name already carries it.
 */
export function toPagePath(page: string): string {
  const trimmed = page.trim();
  if (!trimmed) throw new SbError("A page name is required.", "invalid");

  const cleaned = trimmed
    .replace(/^\[\[/, "")
    .replace(/\]\]$/, "")
    .split(/[|#^]/)[0]!
    .trim()
    .replace(/^\.?\//, "")
    .replace(/^\/+/, "");

  if (!cleaned) throw new SbError(`"${page}" does not contain a page name.`, "invalid");
  if (cleaned.includes("\0"))
    throw new SbError("Page names must not contain NUL bytes.", "invalid");

  const segments = cleaned.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new SbError(`"${page}" is not a valid page path.`, "invalid");
  }

  return /\.md$/i.test(cleaned) ? cleaned : `${cleaned}${PAGE_EXTENSION}`;
}

export function pageNameFromPath(path: string): string {
  return path.replace(/\.md$/i, "");
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function intHeader(response: Response, name: string): number | undefined {
  const raw = response.headers.get(name);
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

async function bodySnippet(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/g, " ").trim();
    return text.length > MAX_ERROR_BODY ? `${text.slice(0, MAX_ERROR_BODY)}…` : text;
  } catch {
    return "";
  }
}

function describeFetchError(err: unknown, timeoutMs: number): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === "TimeoutError" || err.name === "AbortError") {
    return `timed out after ${timeoutMs} ms`;
  }
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) return `${err.message} (${cause.message})`;
  return err.message;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function replaceOnce(haystack: string, find: string, replacement: string): string {
  const index = haystack.indexOf(find);
  if (index === -1) return haystack;
  return haystack.slice(0, index) + replacement + haystack.slice(index + find.length);
}

function joinForAppend(existing: string, addition: string, separator: string): string {
  const base = existing.replace(/\s+$/, "");
  if (!base) return addition;
  return `${base}${separator}${addition}`;
}

/** Thin client over the SilverBullet HTTP API (`/.fs`, `/.ping`, `/.config`, `/.search`). */
export class SilverBulletClient {
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly timeoutMs: number;
  /** `""` for the whole space, or a `notes/`-style root that all access is confined to. */
  private readonly root: string;

  constructor(config: Pick<SilverBulletConfig, "baseUrl" | "authToken" | "timeoutMs" | "prefix">) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.authToken = config.authToken;
    this.timeoutMs = config.timeoutMs;
    // Always normalized, so `notes` and `notes/` behave identically.
    this.root = normalizeRoot(config.prefix);
  }

  get url(): string {
    return this.baseUrl;
  }

  get prefix(): string {
    return this.root;
  }

  /** Maps a caller-supplied page name onto the root, refusing anything outside it. */
  private resolve(page: string): { fullPath: string; path: string } {
    let path = toPagePath(page);
    if (this.root && path.toLowerCase().startsWith(this.root.toLowerCase())) {
      path = path.slice(this.root.length);
    }
    return { fullPath: `${this.root}${path}`, path };
  }

  /** Strips the root from a space-wide page name, or returns undefined when outside it. */
  private relativize(page: string): string | undefined {
    if (!this.root) return page;
    if (!page.toLowerCase().startsWith(this.root.toLowerCase())) return undefined;
    return page.slice(this.root.length);
  }

  private async request(
    path: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? "GET",
        body: init.body,
        headers: {
          Authorization: `Bearer ${this.authToken}`,
          "X-Sync-Mode": "true",
          "X-Client-Id": CLIENT_ID,
          ...init.headers,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SbError(
        `Could not reach SilverBullet at ${this.baseUrl}: ${describeFetchError(err, this.timeoutMs)}`,
        "network",
      );
    }
  }

  private async fail(
    response: Response,
    action: string,
    options: { conflict?: string } = {},
  ): Promise<never> {
    const status = response.status;
    const detail = await bodySnippet(response);
    switch (status) {
      case 401:
      case 403:
        throw new SbError(
          `${action}: SilverBullet rejected the credentials (HTTP ${status}). Check that SB_AUTH_TOKEN matches the server's SB_AUTH_TOKEN and that SB_URL points at the space.`,
          "auth",
          status,
        );
      case 404:
        throw new SbError(`${action}: not found (HTTP 404).`, "not_found", status);
      case 412:
        throw new SbError(
          options.conflict ??
            `${action}: the page changed since it was read (HTTP 412). Re-read it and retry.`,
          "conflict",
          status,
        );
      case 429:
        throw new SbError(`${action}: rate limited (HTTP 429). Retry in a moment.`, "http", status);
      case 405:
        throw new SbError(
          `${action}: not allowed (HTTP 405). The space may be read-only.`,
          "http",
          status,
        );
      default:
        throw new SbError(
          `${action} failed (HTTP ${status})${detail ? `: ${detail}` : ""}`,
          "http",
          status,
        );
    }
  }

  async ping(): Promise<void> {
    const response = await this.request("/.ping");
    if (!response.ok) await this.fail(response, "Ping");
    await response.text();
  }

  async getConfig(): Promise<SpaceConfig> {
    const response = await this.request("/.config", { headers: { Accept: "application/json" } });
    if (!response.ok) await this.fail(response, "Read space config");
    return (await response.json()) as SpaceConfig;
  }

  /** Files under the root, with the root stripped from each name. */
  async listFiles(): Promise<FileMeta[]> {
    const response = await this.request("/.fs");
    if (!response.ok) await this.fail(response, "List files");
    const data: unknown = await response.json();
    if (!Array.isArray(data)) {
      throw new SbError(
        "List files: unexpected response from SilverBullet (expected an array).",
        "invalid",
      );
    }
    const files = data as FileMeta[];
    if (!this.root) return files;
    return files.flatMap((file) => {
      const name = this.relativize(file.name);
      return name === undefined ? [] : [{ ...file, name }];
    });
  }

  async readPage(page: string): Promise<PageContent> {
    const { fullPath, path } = this.resolve(page);
    const name = pageNameFromPath(path);
    const response = await this.request(`/.fs/${encodePath(fullPath)}`);
    if (!response.ok) await this.fail(response, `Read page "${name}"`);

    const content = await response.text();
    return {
      page: name,
      path,
      content,
      etag: response.headers.get("etag") ?? undefined,
      lastModified: intHeader(response, "x-last-modified"),
      size: intHeader(response, "x-content-length") ?? byteLength(content),
    };
  }

  async writePage(page: string, content: string, options: WriteOptions = {}): Promise<WriteResult> {
    const { fullPath, path } = this.resolve(page);
    const name = pageNameFromPath(path);
    const headers: Record<string, string> = {
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Source": "external",
    };
    if (options.ifMatch) headers["If-Match"] = options.ifMatch;
    else if (options.createOnly) headers["If-None-Match"] = "*";

    const response = await this.request(`/.fs/${encodePath(fullPath)}`, {
      method: "PUT",
      body: content,
      headers,
    });
    if (!response.ok) {
      await this.fail(response, `Write page "${name}"`, {
        conflict: options.createOnly
          ? `Create page "${name}": it already exists (HTTP 412). Use mode "overwrite" to replace it, or sb_append_to_page to add to it.`
          : `Write page "${name}": it changed since it was read (HTTP 412). Re-read the page and retry.`,
      });
    }

    return {
      page: name,
      path,
      size: byteLength(content),
      etag: response.headers.get("etag") ?? undefined,
    };
  }

  async deletePage(
    page: string,
    options: { ifMatch?: string } = {},
  ): Promise<{ page: string; path: string }> {
    const { fullPath, path } = this.resolve(page);
    const name = pageNameFromPath(path);
    const headers: Record<string, string> = { "X-Source": "external" };
    if (options.ifMatch) headers["If-Match"] = options.ifMatch;

    const response = await this.request(`/.fs/${encodePath(fullPath)}`, {
      method: "DELETE",
      headers,
    });
    if (!response.ok) {
      await this.fail(response, `Delete page "${name}"`, {
        conflict: `Delete page "${name}": it changed since it was read (HTTP 412). Re-read the page and retry.`,
      });
    }
    return { page: name, path };
  }

  /**
   * Appends to a page, creating it when missing. Re-reads and retries on a
   * write conflict, since appending is safe to repeat against fresh content.
   */
  async appendToPage(
    page: string,
    addition: string,
    options: { separator?: string; attempts?: number } = {},
  ): Promise<AppendResult> {
    const separator = options.separator ?? "\n\n";
    const maxAttempts = options.attempts ?? 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let existing: PageContent | undefined;
      try {
        existing = await this.readPage(page);
      } catch (err) {
        if (!(err instanceof SbError) || err.kind !== "not_found") throw err;
      }

      const next = existing ? joinForAppend(existing.content, addition, separator) : addition;
      try {
        const result = await this.writePage(
          page,
          next,
          existing?.etag ? { ifMatch: existing.etag } : { createOnly: true },
        );
        return { ...result, created: !existing, previousSize: existing?.size ?? 0 };
      } catch (err) {
        const retryable = err instanceof SbError && err.kind === "conflict";
        if (!retryable || attempt === maxAttempts) throw err;
      }
    }

    throw new SbError(
      `Append to page "${page}": gave up after ${maxAttempts} conflicting writes.`,
      "conflict",
    );
  }

  /** Replaces one occurrence (or all) of `find`, refusing ambiguous edits. */
  async replaceInPage(
    page: string,
    find: string,
    replacement: string,
    options: { all?: boolean } = {},
  ): Promise<ReplaceResult> {
    if (!find) throw new SbError("The text to find must not be empty.", "invalid");

    const current = await this.readPage(page);
    const occurrences = countOccurrences(current.content, find);
    if (occurrences === 0) {
      throw new SbError(
        `Text not found in page "${current.page}". Nothing was changed.`,
        "invalid",
      );
    }
    if (occurrences > 1 && !options.all) {
      throw new SbError(
        `The text appears ${occurrences} times in page "${current.page}". Pass all=true to replace every occurrence, or use a longer snippet that appears once. Nothing was changed.`,
        "invalid",
      );
    }

    const next = options.all
      ? current.content.split(find).join(replacement)
      : replaceOnce(current.content, find, replacement);
    const result = await this.writePage(page, next, current.etag ? { ifMatch: current.etag } : {});
    return { ...result, occurrences };
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const body: Record<string, unknown> = { query };
    if (options.mode) body.mode = options.mode;
    if (options.scope) body.scope = options.scope;
    if (options.limit) body.limit = options.limit;

    const response = await this.request("/.search/query", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    if (response.status === 404) {
      throw new SbError(
        "Search is not available on this SilverBullet server (no search backend is configured). Use sb_list_pages and sb_read_page instead.",
        "not_found",
        404,
      );
    }
    if (!response.ok) await this.fail(response, "Search");

    const data = (await response.json()) as SearchResponse;
    const items = Array.isArray(data.items) ? data.items : [];
    const scoped = items.flatMap((item) => {
      const page = this.relativize(item.page);
      return page === undefined ? [] : [{ ...item, page }];
    });

    return {
      items: scoped,
      total: this.root ? scoped.length : data.total,
      partial: data.partial,
      notice: data.notice,
    };
  }

  /** Best-effort: what the search backend can do, used to explain failures. */
  async searchStatus(): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await this.request("/.search/status");
      if (!response.ok) return undefined;
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
}
