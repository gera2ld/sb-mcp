import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface HttpTransportOptions {
  host: string;
  port: number;
  token: string;
  createServer: () => McpServer;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== "POST") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Serves MCP over Streamable HTTP on `/mcp`, one server instance per request
 * (stateless). Every request must carry `Authorization: Bearer <token>`.
 * Built on `node:http`, so it runs on both Node and Bun.
 */
export function startHttpTransport({ host, port, token, createServer }: HttpTransportOptions) {
  const server = createHttpServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (pathname !== "/mcp") {
      res.writeHead(404).end("Not found");
      return;
    }

    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("Unauthorized");
      return;
    }

    const mcp = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });

    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, await readJsonBody(req));
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end("Internal error");
      console.error("sb-mcp: request failed", err);
    }
  });

  server.listen(port, host);
  return server;
}
