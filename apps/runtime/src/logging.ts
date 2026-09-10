import { destination, type Logger, pino } from "pino";

export function createLogger(env: NodeJS.ProcessEnv = process.env): Logger {
  const secrets = Object.entries(env)
    .filter(
      ([key, value]) =>
        value &&
        (key === "AUTODOM_BOT_TOKEN" ||
          key === "AUTODOM_DATABASE_URL" ||
          key === "AUTODOM_REDIS_URL" ||
          (key.startsWith("SMARTPROXY_") && /(?:PASSWORD|USERNAME)$/u.test(key))),
    )
    .map(([, value]) => value ?? "");
  return pino(
    {
      name: "autodom",
      level: env.AUTODOM_LOG_LEVEL ?? "info",
      redact: [
        "token",
        "password",
        "authorization",
        "proxy.authorization",
        "profile",
        "chat_id",
        "user_id",
      ],
      serializers: {
        err(error: unknown) {
          if (!(error instanceof Error)) return { type: "Error" };
          let message = error.message.replace(/\nparams:[\s\S]*$/u, "\nparams: [redacted]");
          for (const secret of secrets) message = message.split(secret).join("[redacted]");
          message = message
            .replace(/(?:postgres(?:ql)?|rediss?):\/\/[^\s]+/gu, "[redacted backend URL]")
            .replace(/bot\d+:[A-Za-z0-9_-]+/gu, "bot[redacted]");
          return { type: error.name, message };
        },
      },
    },
    destination(2),
  );
}
