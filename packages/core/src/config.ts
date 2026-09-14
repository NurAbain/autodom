import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SOURCES } from "./source-catalog.js";

export const SOURCE_IDS: readonly string[] = SOURCES.filter(
  (source) => source.adapter === "implemented",
).map((source) => source.id);
type Environment = Readonly<Record<string, string | undefined>>;
const execute = promisify(execFile);

export function approvedSources(env: Environment = process.env): readonly string[] {
  const selected = (env.AUTODOM_APPROVED_SOURCES ?? "mashina.kg")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (
    selected.length === 0 ||
    new Set(selected).size !== selected.length ||
    selected.some((id) => !(SOURCE_IDS as readonly string[]).includes(id))
  ) {
    throw new Error("AUTODOM_APPROVED_SOURCES must contain unique known source IDs");
  }
  return selected;
}

export function miniAppUrl(env: Environment = process.env): string | undefined {
  const configured = env.AUTODOM_MINI_APP_URL?.trim();
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["/miniapp", "/miniapp/", "/full/miniapp", "/full/miniapp/"].includes(url.pathname)
    )
      throw new Error();
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.href;
  } catch {
    throw new Error("AUTODOM_MINI_APP_URL must be an HTTPS URL ending in /miniapp/");
  }
}

export interface BotSettings {
  database_url: string;
  monitor_seconds: number;
  backup_directory: string;
}

export interface Settings extends BotSettings {
  redis_url: string;
  data_dir: string;
  refresh_seconds: number;
  refresh_pages: number;
  crawl_delay: number;
  full_refresh_seconds: number;
}

function interval(env: Environment, key: string, fallback: string, integer = true): number {
  const text = (env[key] ?? fallback).trim();
  if (!(integer ? /^[+-]?\d+$/u : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu).test(text)) {
    throw new Error(`Invalid ${key}`);
  }
  const value = Number(text);
  if (!Number.isFinite(value) || (integer && !Number.isSafeInteger(value)))
    throw new Error(`Invalid ${key}`);
  return value;
}

function backendUrl(env: Environment, key: string, protocols: readonly string[]): string {
  const value = env[key]?.trim();
  try {
    if (!value) throw new Error();
    const parsed = new URL(value);
    if (!protocols.includes(parsed.protocol) || !parsed.hostname) throw new Error();
    return value;
  } catch {
    throw new Error(`A valid ${key} is required; credentials are not logged`);
  }
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function loadBotSettings(env: Environment = process.env): BotSettings {
  approvedSources(env);
  const monitor_seconds = interval(env, "AUTODOM_MONITOR_SECONDS", "30");
  if (monitor_seconds < 10 || monitor_seconds > 3600) {
    throw new Error("Invalid monitoring interval: monitor 10..3600s");
  }
  return {
    database_url: backendUrl(env, "AUTODOM_DATABASE_URL", ["postgres:", "postgresql:"]),
    monitor_seconds,
    backup_directory: expandHome(
      env.AUTODOM_BACKUP_DIR ?? join(env.AUTODOM_DATA_DIR ?? ".local", "backups"),
    ),
  };
}

export function loadSettings(env: Environment = process.env): Settings {
  const bot = loadBotSettings(env);
  const redis_url = backendUrl(env, "AUTODOM_REDIS_URL", ["redis:", "rediss:"]);
  const data_dir = expandHome(env.AUTODOM_DATA_DIR ?? ".local");
  const refresh_seconds = interval(env, "AUTODOM_REFRESH_SECONDS", "300");
  const refresh_pages = interval(env, "AUTODOM_REFRESH_PAGES", "3");
  const crawl_delay = interval(env, "AUTODOM_CRAWL_DELAY", "2", false);
  if (
    refresh_seconds < 60 ||
    refresh_pages < 1 ||
    refresh_pages > 20 ||
    crawl_delay < 1 ||
    crawl_delay > 60
  ) {
    throw new Error("Invalid crawl settings: refresh >=60s, pages 1..20, delay 1..60s");
  }
  const full_refresh_seconds = interval(env, "AUTODOM_FULL_REFRESH_SECONDS", "86400");
  if (full_refresh_seconds < refresh_seconds || full_refresh_seconds > 86400) {
    throw new Error("Invalid full refresh interval: refresh..86400s");
  }
  return {
    ...bot,
    redis_url,
    data_dir,
    refresh_seconds,
    refresh_pages,
    crawl_delay,
    full_refresh_seconds,
  };
}

export async function loadToken(env: Environment = process.env): Promise<string> {
  let token = (env.AUTODOM_BOT_TOKEN ?? "").trim();
  if (!token) {
    try {
      const result = await execute("pass", ["show", "autodom/telegram/bot-token"], {
        timeout: 15000,
        encoding: "utf8",
      });
      token = result.stdout.trim();
    } catch {
      throw new Error("Set AUTODOM_BOT_TOKEN or save autodom/telegram/bot-token in pass");
    }
  }
  if (!/^[0-9]+:[A-Za-z0-9_-]{30,}$/u.test(token)) {
    throw new Error("A valid Telegram bot token is required; token value is not logged");
  }
  return token;
}
