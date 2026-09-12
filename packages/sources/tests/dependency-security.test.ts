import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");
const { parser } = require("stream-json");
const { pick } = require("stream-json/filters/Pick");
const StreamArray = require("stream-json/streamers/StreamArray");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("source dependency security boundaries", () => {
  it("refuses ZIP extraction through a destination symlink without modifying its target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autodom-zip-security-"));
    directories.push(directory);
    const destination = join(directory, "destination");
    const outside = join(directory, "outside");
    await Promise.all([mkdir(destination), mkdir(outside)]);
    const protectedFile = join(outside, "sentinel.txt");
    await writeFile(protectedFile, "unchanged");
    await symlink(outside, join(destination, "link"), "dir");
    const zip = new AdmZip();
    zip.addFile("link/sentinel.txt", Buffer.from("overwritten"));
    expect(() => zip.extractAllTo(destination, true)).toThrow();
    expect(await readFile(protectedFile, "utf8")).toBe("unchanged");
  });

  it("rejects excessive nesting before path filtering can monopolize the event loop", async () => {
    const input = '{"meta":'.repeat(2_000) + "1" + "}".repeat(2_000);
    await expect(
      pipeline(
        Readable.from([input]),
        parser(),
        pick({ filter: "data" }),
        new Writable({
          objectMode: true,
          write(_chunk, _encoding, done) {
            done();
          },
        }),
      ),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("keeps the streaming array API used by Crawlee lossless after security updates", async () => {
    const requests = [
      {
        url: "https://bid.cars/en/automobile/page/7",
        uniqueKey: "catalog:7",
        userData: { page: 7 },
      },
      {
        url: "https://mashina.kg/catalog/passenger",
        userData: { label: "Цена неизвестна", price: null },
      },
    ];
    const decoded: unknown[] = [];
    await pipeline(
      Readable.from([JSON.stringify(requests)]),
      StreamArray.withParser(),
      new Writable({
        objectMode: true,
        write(chunk, _encoding, done) {
          decoded.push(chunk.value);
          done();
        },
      }),
    );
    expect(decoded).toEqual(requests);
  });
});
