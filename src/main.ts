#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { applyCliOptions, parseCliArgs } from "./cli";
import { ConfigError, loadConfig, type SilverBulletConfig } from "./config";
import { startHttpTransport } from "./http";
import { SilverBulletClient } from "./sb-client";
import { createServer } from "./server";

function loadConfigOrExit(env: Record<string, string | undefined>): SilverBulletConfig {
  try {
    return loadConfig(env);
  } catch (err) {
    const message = err instanceof ConfigError ? err.message : String(err);
    console.error(`sb-mcp: ${message}`);
    console.error("Run `sb-mcp --help` for CLI options.");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const config = loadConfigOrExit(applyCliOptions(process.env, options));
  const client = new SilverBulletClient(config);

  if (config.http) {
    startHttpTransport({
      ...config.http,
      createServer: () => createServer({ client, readOnly: config.readOnly }),
    });
    console.error(
      `sb-mcp listening on http://${config.http.host}:${config.http.port}/mcp${config.readOnly ? " (read-only)" : ""}`,
    );
    return;
  }

  const server = createServer({ client, readOnly: config.readOnly });
  await server.connect(new StdioServerTransport());
  console.error(`sb-mcp connected to ${config.baseUrl}${config.readOnly ? " (read-only)" : ""}`);
}

main().catch((err) => {
  console.error("sb-mcp: fatal error", err);
  process.exit(1);
});
