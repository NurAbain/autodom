import { spawn } from "node:child_process";
import { z } from "zod";

const sessionSchema = z.record(z.string(), z.unknown());
const mediaSchema = z
  .object({
    id: z.string().min(1).max(200),
    code: z.string().min(1).max(100),
    url: z.string().url().max(2000),
    mediaType: z.enum(["photo", "video"]),
    takenAt: z.string().datetime(),
  })
  .strict();
const successSchema = z
  .object({
    ok: z.literal(true),
    session: sessionSchema,
  })
  .passthrough();
const failureSchema = z
  .object({
    ok: z.literal(false),
    kind: z.enum(["auth", "challenge", "rejected", "unknown"]),
    message: z.string().min(1).max(500),
  })
  .strict();

export interface InstagramCredentials {
  username: string;
  password: string;
  session: Record<string, unknown> | null;
}
export type InstagramMedia = z.infer<typeof mediaSchema>;
export type InstagramWorkerFailure = z.infer<typeof failureSchema>["kind"];

export class InstagramPrivateError extends Error {
  constructor(
    message: string,
    readonly kind: InstagramWorkerFailure,
  ) {
    super(message);
    this.name = "InstagramPrivateError";
  }
}

export interface InstagramPrivateClient {
  check(credentials: InstagramCredentials): Promise<{ session: Record<string, unknown> }>;
  discover(
    credentials: InstagramCredentials,
    targetUsername: string,
  ): Promise<{ session: Record<string, unknown>; media: InstagramMedia[] }>;
  comment(
    credentials: InstagramCredentials,
    mediaId: string,
    text: string,
  ): Promise<{ session: Record<string, unknown>; remoteId: string }>;
}

export class InstagramPrivateWorker implements InstagramPrivateClient {
  constructor(
    private readonly executable: string,
    private readonly script: string,
    private readonly timeoutMs = 40_000,
  ) {}

  private run<T extends z.ZodTypeAny>(payload: unknown, schema: T): Promise<z.infer<T>> {
    const { promise, resolve, reject } = Promise.withResolvers<z.infer<T>>();
    const child = spawn(this.executable, [this.script], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      return true;
    };
    const fail = (error: Error) => {
      if (settle()) reject(error);
    };
    const succeed = (result: z.infer<T>) => {
      if (settle()) resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new InstagramPrivateError("Instagram не ответил за отведённое время", "unknown"));
    }, this.timeoutMs);
    child.once("error", () =>
      fail(new InstagramPrivateError("Worker Instagram недоступен", "unknown")),
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 2_000_000) {
        child.kill("SIGKILL");
        fail(new InstagramPrivateError("Worker Instagram вернул слишком большой ответ", "unknown"));
      }
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0)
        return fail(new InstagramPrivateError("Worker Instagram завершился с ошибкой", "unknown"));
      let raw: unknown;
      try {
        raw = JSON.parse(stdout);
      } catch {
        return fail(
          new InstagramPrivateError("Worker Instagram вернул некорректный ответ", "unknown"),
        );
      }
      const failed = failureSchema.safeParse(raw);
      if (failed.success)
        return fail(new InstagramPrivateError(failed.data.message, failed.data.kind));
      const parsed = schema.safeParse(raw);
      if (!parsed.success)
        return fail(
          new InstagramPrivateError("Worker Instagram нарушил контракт ответа", "unknown"),
        );
      succeed(parsed.data);
    });
    child.stdin.once("error", () => undefined);
    child.stdin.end(JSON.stringify(payload));
    return promise;
  }

  check(credentials: InstagramCredentials): Promise<{ session: Record<string, unknown> }> {
    return this.run({ operation: "check", ...credentials }, successSchema);
  }

  discover(
    credentials: InstagramCredentials,
    targetUsername: string,
  ): Promise<{ session: Record<string, unknown>; media: InstagramMedia[] }> {
    return this.run(
      { operation: "discover", ...credentials, targetUsername },
      successSchema.extend({ media: z.array(mediaSchema).max(50) }).passthrough(),
    );
  }

  comment(
    credentials: InstagramCredentials,
    mediaId: string,
    text: string,
  ): Promise<{ session: Record<string, unknown>; remoteId: string }> {
    return this.run(
      { operation: "comment", ...credentials, mediaId, text },
      successSchema.extend({ remoteId: z.string().min(1).max(200) }).passthrough(),
    );
  }
}
