import { z } from "zod";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_HTTP_PORT = 3001;

export class ConfigError extends Error {
  override name = "ConfigError";
}

const envSchema = z.object({
  SB_URL: z.url(),
  SB_AUTH_TOKEN: z.string().min(1),
  SB_TIMEOUT_MS: z.coerce.number().default(DEFAULT_TIMEOUT_MS),
  SB_READ_ONLY: z.literal("1").optional(),
  SB_PREFIX: z.string().optional(),
  MCP_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  MCP_HOST: z.string().default("127.0.0.1"),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_HTTP_PORT),
  MCP_HTTP_TOKEN: z.string().min(1).optional(),
});

/** `notes`, `/notes/` and `notes/` all become `notes/`; empty means the space root. */
export function normalizeRoot(prefix: string | undefined): string {
  const trimmed = prefix?.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ConfigError(`SB_PREFIX must be a plain folder path, got "${prefix}".`);
  }
  return `${trimmed}/`;
}

export interface HttpConfig {
  host: string;
  port: number;
  token: string;
}

export interface SilverBulletConfig {
  /** Space root URL, without a trailing slash, e.g. `https://notes.example.com`. */
  baseUrl: string;
  /** Bearer token matching the server's `SB_AUTH_TOKEN`. */
  authToken: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** When true, mutating tools are not registered at all. */
  readOnly: boolean;
  /** `""` for the whole space, or a `notes/`-style root that all access is confined to. */
  prefix: string;
  /** Set when serving over Streamable HTTP; absent means stdio. */
  http?: HttpConfig;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): SilverBulletConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid SilverBullet MCP configuration:\n${z.prettifyError(parsed.error)}`,
    );
  }

  const {
    SB_URL,
    SB_AUTH_TOKEN,
    SB_TIMEOUT_MS,
    SB_READ_ONLY,
    SB_PREFIX,
    MCP_TRANSPORT,
    MCP_HOST,
    MCP_PORT,
    MCP_HTTP_TOKEN,
  } = parsed.data;

  if (MCP_TRANSPORT === "http" && !MCP_HTTP_TOKEN) {
    throw new ConfigError(
      "MCP_HTTP_TOKEN is required when serving over HTTP: the endpoint can write to your space, so it must not be open.",
    );
  }

  return {
    baseUrl: SB_URL.replace(/\/+$/, ""),
    authToken: SB_AUTH_TOKEN,
    timeoutMs: SB_TIMEOUT_MS,
    readOnly: SB_READ_ONLY === "1",
    prefix: normalizeRoot(SB_PREFIX),
    http:
      MCP_TRANSPORT === "http"
        ? { host: MCP_HOST, port: MCP_PORT, token: MCP_HTTP_TOKEN! }
        : undefined,
  };
}
