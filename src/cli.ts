import { Command } from "commander";

export interface CliOptions {
  url?: string;
  token?: string;
  timeout?: string;
  readOnly?: boolean;
  prefix?: string;
  http?: boolean;
  host?: string;
  port?: string;
  httpToken?: string;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const program = new Command()
    .name("sb-mcp")
    .description("MCP server for SilverBullet")
    .option("-u, --url <url>", "SilverBullet space URL (env: SB_URL)")
    .option("-t, --token <token>", "SilverBullet bearer token (env: SB_AUTH_TOKEN)")
    .option("--timeout <ms>", "request timeout in milliseconds (env: SB_TIMEOUT_MS, default 15000)")
    .option("--read-only", "register read-only tools only (env: SB_READ_ONLY=1)")
    .option(
      "-p, --prefix <path>",
      "root folder that all access is confined to, e.g. notes or notes/ (env: SB_PREFIX)",
    )
    .option("--http", "serve over Streamable HTTP instead of stdio (env: MCP_TRANSPORT=http)")
    .option("--host <host>", "HTTP bind address (env: MCP_HOST, default 127.0.0.1)")
    .option("--port <port>", "HTTP port (env: MCP_PORT, default 3001)")
    .option(
      "--http-token <token>",
      "bearer token required by the HTTP endpoint (env: MCP_HTTP_TOKEN)",
    )
    .allowExcessArguments(false);

  program.parse(argv, { from: "user" });
  return program.opts<CliOptions>();
}

/** Flags win over environment variables. */
export function applyCliOptions(
  env: Record<string, string | undefined>,
  options: CliOptions,
): Record<string, string | undefined> {
  return {
    ...env,
    ...(options.url ? { SB_URL: options.url } : {}),
    ...(options.token ? { SB_AUTH_TOKEN: options.token } : {}),
    ...(options.timeout ? { SB_TIMEOUT_MS: options.timeout } : {}),
    ...(options.readOnly ? { SB_READ_ONLY: "1" } : {}),
    ...(options.prefix ? { SB_PREFIX: options.prefix } : {}),
    ...(options.http ? { MCP_TRANSPORT: "http" } : {}),
    ...(options.host ? { MCP_HOST: options.host } : {}),
    ...(options.port ? { MCP_PORT: options.port } : {}),
    ...(options.httpToken ? { MCP_HTTP_TOKEN: options.httpToken } : {}),
  };
}
