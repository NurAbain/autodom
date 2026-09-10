import { mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { pruneSnapshots } from "../src/maintenance.js";

it("expires recognized legacy and current snapshots without deleting imported databases or symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autodom-retention-"));
  const now = Date.now() / 1000;
  const expired = [
    "autodom-20260101T000000000000.sqlite3",
    "autodom-2026-01-01T00-00-00-000Z.ndjson",
  ];
  const kept = ["autodom.sqlite3", "autodom-20260102T000000000000.sqlite3", "notes.ndjson"];
  const link = "autodom-20260103T000000000000.sqlite3";
  try {
    for (const name of [...expired, ...kept])
      await writeFile(join(directory, name), "private fixture", { mode: 0o600 });
    for (const name of [...expired, "autodom.sqlite3", "notes.ndjson"])
      await utimes(join(directory, name), now - 8 * 86400, now - 8 * 86400);
    await symlink(join(directory, "autodom.sqlite3"), join(directory, link));
    await pruneSnapshots(directory, now);
    expect((await readdir(directory)).sort()).toEqual([...kept, link].sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
