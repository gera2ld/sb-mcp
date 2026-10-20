import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SilverBulletClient } from "./sb-client";
import { registerTools } from "./tools";

export const SERVER_NAME = "silverbullet";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = [
  "Tools for reading and writing pages in a SilverBullet space.",
  'Pages are addressed without the .md extension ("Projects/Alpha"), and nested pages use "/" ("Journal/2026-10-20").',
  'Page names are relative to the server\'s configured root: with a root of notes/, "Alpha" means notes/Alpha.md, and nothing outside that root is reachable.',
  "Prefer sb_search or sb_list_pages to find a page before reading it, and prefer sb_append_to_page / sb_replace_in_page over sb_write_page so you never overwrite content you have not seen.",
  "sb_write_page and sb_delete_page are destructive: pass ifMatch with the ETag from sb_read_page when the page must not have changed since you read it.",
].join("\n");

export interface CreateServerOptions {
  client: SilverBulletClient;
  readOnly?: boolean;
}

export function createServer({ client, readOnly = false }: CreateServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, client, { readOnly });
  return server;
}
