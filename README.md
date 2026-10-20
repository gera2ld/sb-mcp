# sb-mcp

An MCP server for [SilverBullet](https://silverbullet.md). It exposes a space's pages to any MCP client over stdio or Streamable HTTP, talking to SilverBullet's HTTP API (`/.fs`, `/.ping`, `/.config`, `/.search`).

Runs on Node 24+ (and Bun). No runtime dependencies — the published tarball is a single bundled file, so `npx` starts instantly.

```sh
npx sb-mcp --url https://notes.example.com --token "$SB_AUTH_TOKEN"
```

## Configuration

| Variable         | Required    | Default     | Notes                                                                                             |
| ---------------- | ----------- | ----------- | ------------------------------------------------------------------------------------------------- |
| `SB_URL`         | yes         | —           | Space root, e.g. `https://notes.example.com`. A path prefix (`https://host/space`) works.         |
| `SB_AUTH_TOKEN`  | yes         | —           | Must match the server's `SB_AUTH_TOKEN`.                                                          |
| `SB_TIMEOUT_MS`  | no          | `15000`     | Per-request timeout.                                                                              |
| `SB_READ_ONLY`   | no          | —           | Set to `1` to register only the read-only tools.                                                  |
| `SB_PREFIX`      | no          | space root  | Folder that all access is confined to, e.g. `notes` or `notes/`. See [Root prefix](#root-prefix). |
| `MCP_TRANSPORT`  | no          | `stdio`     | `http` serves Streamable HTTP on `/mcp` instead of stdio.                                         |
| `MCP_HOST`       | no          | `127.0.0.1` | HTTP bind address.                                                                                |
| `MCP_PORT`       | no          | `3001`      | HTTP port.                                                                                        |
| `MCP_HTTP_TOKEN` | with `http` | —           | Required by the HTTP transport; clients send it as `Authorization: Bearer <token>`.               |

The token is read from the environment and used by this process only; it is never exposed as a tool argument or sent to the model.

Every setting also has a flag — `--url`, `--token`, `--timeout`, `--read-only`, `--prefix`, `--http`, `--host`, `--port`, `--http-token` — and flags win when both are set. Run `npx sb-mcp --help` for the list.

## Connect

Claude Code:

```sh
claude mcp add silverbullet \
  -e SB_URL=https://notes.example.com \
  -e SB_AUTH_TOKEN=... \
  -- npx -y sb-mcp
```

Any client that takes a JSON config:

```json
{
  "mcpServers": {
    "silverbullet": {
      "command": "npx",
      "args": ["-y", "sb-mcp"],
      "env": {
        "SB_URL": "https://notes.example.com",
        "SB_AUTH_TOKEN": "..."
      }
    }
  }
}
```

## HTTP transport

```sh
npx sb-mcp --http --port 3001 --http-token "$MCP_HTTP_TOKEN"
# MCP endpoint: http://127.0.0.1:3001/mcp
# health check: http://127.0.0.1:3001/health
```

Stateless Streamable HTTP — a fresh server instance per request, no session state to expire. The endpoint requires `Authorization: Bearer $MCP_HTTP_TOKEN` on every request; there is no unauthenticated mode, because these tools can write to your space. Keep the default `127.0.0.1` bind unless something in front of it terminates TLS and authenticates.

```json
{
  "mcpServers": {
    "silverbullet": {
      "type": "http",
      "url": "http://127.0.0.1:3001/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

## Tools

| Tool                 | What it does                                                                            |
| -------------------- | --------------------------------------------------------------------------------------- |
| `sb_status`          | Verifies URL + token and reports space name, index page, read-only flag, revision mode. |
| `sb_list_pages`      | Lists pages with size and mtime; filter by prefix, sort by name or recency.             |
| `sb_read_page`       | Reads markdown with its ETag; optional line range.                                      |
| `sb_search`          | Word, phrase or semantic search via the server's backend.                               |
| `sb_write_page`      | Full replace; `mode: "create"` refuses to overwrite, `ifMatch` refuses stale writes.    |
| `sb_append_to_page`  | Appends (creates if missing), retrying on concurrent edits.                             |
| `sb_replace_in_page` | Exact-snippet replacement; refuses ambiguous matches unless `all`.                      |
| `sb_delete_page`     | Deletes exactly one page, optionally guarded by `ifMatch`.                              |

`sb_write_page`, `sb_append_to_page`, `sb_replace_in_page` and `sb_delete_page` are not registered when `SB_READ_ONLY=1`.

## Root prefix

By default the server sees the whole space, including SilverBullet's own `CONFIG`, `SETTINGS` and `Library/*` pages. Set `SB_PREFIX` (or `--prefix`) to confine it to one folder:

```sh
npx sb-mcp --prefix notes
```

The trailing slash is optional — `notes`, `notes/` and `/notes/` all resolve to the same root; it is normalized once, so every tool sees `notes/`.

With that root, `sb_read_page { page: "Projects/Alpha" }` reads `notes/Projects/Alpha.md`, `sb_list_pages` returns only names under `notes/` (already stripped of the prefix), and search results outside it are dropped. Anything that would resolve outside the root — `../`, a leading `/`, a path that escapes the folder — is rejected, so the tools cannot reach the rest of the space.

## Behavior notes

- **Search scope** follows the space: `scope` defaults to all pages, so meta pages appear unless you narrow it with `scope: "pages"` or set a root prefix.
- **Page names** omit the `.md` extension: `Projects/Alpha`. `[[Projects/Alpha]]`, `Projects/Alpha#Status` and a leading `/` are accepted and normalized.
- **Conflicts, not clobbers.** Reads return an ETag; writes pass it as `If-Match`. A concurrent edit surfaces as `412` and is reported as "the page changed since it was read" instead of overwriting it. `sb_append_to_page` re-reads and retries.
- **Attribution.** Writes send `X-Source: external` so the space records them correctly.
- **Search** needs a search backend on the server. Without one the tool returns a clear message rather than failing silently.
- **Not exposed:** `/.shell` (arbitrary server-side command execution), `/.proxy` (SSRF surface) and revisions.

## Development

```sh
bun install
bun run build     # bundles src/main.ts -> dist/main.js for Node
bun run check     # tsc --noEmit
node dist/main.js --help
```
