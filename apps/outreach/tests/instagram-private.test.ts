import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InstagramPrivateWorker } from "../src/instagram-private.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Instagram private worker boundary", () => {
  it("passes credentials through stdin and returns refreshed session with discovered media", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autodom-instagram-worker-"));
    directories.push(directory);
    const workerPath = join(directory, "fake-worker.mjs");
    await writeFile(
      workerPath,
      `let body=""; for await (const chunk of process.stdin) body += chunk;\n` +
        `const input=JSON.parse(body);\n` +
        `process.stdout.write(JSON.stringify({ok:true,session:{device_id:"device-1"},media:[{id:"m1",code:"p1",url:"https://www.instagram.com/p/p1/",mediaType:"photo",takenAt:"2026-09-17T10:00:00.000Z"}],received:{operation:input.operation,username:input.username,password:input.password,targetUsername:input.targetUsername}}));\n`,
      { mode: 0o700 },
    );
    const worker = new InstagramPrivateWorker(process.execPath, workerPath);
    const result = await worker.discover(
      { username: "brand.account", password: "private-password", session: null },
      "dealer_one",
    );
    expect(result).toMatchObject({
      session: { device_id: "device-1" },
      media: [{ id: "m1", mediaType: "photo" }],
      received: {
        operation: "discover",
        username: "brand.account",
        password: "private-password",
        targetUsername: "dealer_one",
      },
    });
  });
});
