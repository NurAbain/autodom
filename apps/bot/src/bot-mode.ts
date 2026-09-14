export type BotMode = "full" | "vin";

type Environment = Readonly<Record<string, string | undefined>>;

export function loadBotMode(env: Environment = process.env): BotMode {
  const mode = env.AUTODOM_BOT_MODE ?? "full";
  if (mode !== "full" && mode !== "vin") throw new Error("AUTODOM_BOT_MODE must be full or vin");
  return mode;
}

export function loadReportBotUrl(env: Environment = process.env): string | undefined {
  const value = env.AUTODOM_REPORT_BOT_URL?.trim();
  if (!value) return undefined;
  if (!/^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{4,31}$/u.test(value))
    throw new Error("AUTODOM_REPORT_BOT_URL must be an HTTPS t.me bot URL");
  if (loadBotMode(env) !== "full")
    throw new Error("Only the full bot may delegate report purchases");
  return value;
}

export function loadFullBotUrl(env: Environment = process.env): string | undefined {
  const value = env.AUTODOM_FULL_BOT_URL?.trim();
  if (!value) return undefined;
  const url = new URL(value);
  if (
    loadBotMode(env) !== "vin" ||
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("AUTODOM_FULL_BOT_URL must be a private HTTP origin on the VIN bot");
  return url.origin;
}

export function telegramIdentity(token: string): string {
  const id = /^(\d+):/u.exec(token)?.[1];
  if (!id) throw new Error("Telegram token must include a bot ID");
  return id;
}

export function telegramRecipientKey(botId: string, userId: number): string {
  return `autodom:telegram:${botId}:user:${userId}`;
}
