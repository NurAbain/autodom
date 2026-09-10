import { lstat, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Settings } from "@autodom/core";
import { backup, type Store } from "@autodom/storage";

export async function pruneSnapshots(directory: string, now = Date.now() / 1000): Promise<void> {
  for (const name of await readdir(directory)) {
    if (!/^autodom-(?:\d{4}-\d{2}-\d{2}T[\d-]+Z\.ndjson|\d{8}T\d{12}\.sqlite3)$/u.test(name))
      continue;
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isFile() && info.mtimeMs / 1000 < now - 7 * 86_400) await unlink(path);
  }
}

export async function maintain(
  store: Store,
  settings: Settings,
  role: "bot" | "worker",
  signal: AbortSignal,
): Promise<void> {
  if (role === "bot") await mkdir(settings.backup_directory, { recursive: true, mode: 0o700 });
  while (!signal.aborted) {
    const now = Date.now() / 1000;
    await store.setMeta(`${role}_heartbeat`, String(now));
    if (role === "bot") {
      await store.setMeta("runtime_heartbeat", String(now));
      await store.tryWithLock("autodom:backup", async () => {
        const lastBackup = Number(await store.getMeta("last_backup_at", "0"));
        if (now - lastBackup >= 86_400) {
          const name = `autodom-${new Date().toISOString().replace(/[:.]/gu, "-")}.ndjson`;
          await backup(store, join(settings.backup_directory, name));
          await store.setMeta("last_backup_at", String(now));
        }
        await pruneSnapshots(settings.backup_directory, now);
      });
    }
    await delay(30_000, undefined, { signal });
  }
}
