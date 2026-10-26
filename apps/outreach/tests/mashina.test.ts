import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Candidate, OutreachImage } from "../src/contracts.js";
import { MashinaMessenger } from "../src/mashina.js";

const candidate: Candidate = {
  listingId: "internal-database-id",
  source: "mashina.kg",
  title: "Test listing",
  url: "https://mashina.kg/details/toyota-camry-456",
  city: "Бишкек",
  year: 2020,
  price: 20000,
  currency: "USD",
};
const recipient = { id: "123", listingId: "toyota-camry-456" };
const activeListing = {
  id: 456,
  user_id: 123,
  slug: recipient.listingId,
  status: "active",
  is_owner: false,
  is_my_ad: false,
};
const image: OutreachImage = {
  id: "photo",
  mime: "image/png",
  bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
};
let listing = { ...activeListing };
let preparePhoto: (() => void | Promise<void>) | null;

const state = vi.hoisted(() => ({
  ack: { ok: true } as unknown,
  error: null as Error | null,
  sends: 0,
  onConnect: null as (() => void) | null,
  socketCookie: "",
}));
vi.mock("socket.io-client", async () => {
  // The mock factory is hoisted before static imports; load its emitter inside that boundary.
  const { EventEmitter } = await import("node:events");
  return {
    io: (_url: string, options: { extraHeaders: { Cookie: string } }) => {
      state.socketCookie = options.extraHeaders.Cookie;
      const socket = new EventEmitter();
      return Object.assign(socket, {
        connect() {
          queueMicrotask(() => {
            state.onConnect?.();
            socket.emit("connect");
          });
        },
        disconnect() {
          socket.removeAllListeners();
        },
        timeout() {
          return {
            emit(
              _event: string,
              _body: unknown,
              callback: (error: Error | null, ack: unknown) => void,
            ) {
              state.sends++;
              callback(state.error, state.ack);
            },
          };
        },
      });
    },
  };
});
let directory: string;
let client: MashinaMessenger;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "outreach-session-"));
  const path = join(directory, "session.json");
  await writeFile(path, JSON.stringify({ accessToken: "isolated-test-session-only" }), {
    mode: 0o600,
  });
  client = new MashinaMessenger(path);
  state.ack = { ok: true };
  state.error = null;
  state.sends = 0;
  state.onConnect = null;
  state.socketCookie = "";
  listing = { ...activeListing };
  preparePhoto = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const path = new URL(url).pathname;
      if (path === `/api/mbank-proxy/v1/ads/${recipient.listingId}/detail`)
        return Response.json(listing);
      if (path.endsWith("/presign"))
        return Response.json({
          images: [{ image_id: 42, upload_url: "https://images.mashina.kg/test-upload" }],
        });
      if (path.endsWith("/confirm")) {
        await preparePhoto?.();
        return Response.json({});
      }
      if (new URL(url).href === "https://images.mashina.kg/test-upload")
        return new Response(null, { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

it("accepts a positive provider acknowledgement without inventing a remote message ID", async () => {
  expect(await client.send(recipient, "Test", null)).toEqual({
    remoteId: null,
  });
});
it("treats a timeout after emit as unknown and never retransmits", async () => {
  state.error = new Error("Socket acknowledgement timed out");
  await expect(client.send(recipient, "Test", null)).rejects.toMatchObject({
    outcome: "unknown",
    pause: true,
  });
  expect(state.sends).toBe(1);
});
it("distinguishes explicit rejection from a malformed acknowledgement", async () => {
  state.ack = { ok: false };
  await expect(client.send(recipient, "Test", null)).rejects.toMatchObject({
    outcome: "failed",
  });
  state.ack = { success: true };
  await expect(client.send(recipient, "Test", null)).rejects.toMatchObject({
    outcome: "unknown",
  });
});
it("never sends the text if marketplace image confirmation fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const path = new URL(url).pathname;
      if (path === `/api/mbank-proxy/v1/ads/${recipient.listingId}/detail`)
        return Response.json(listing);
      if (path.endsWith("/presign"))
        return Response.json({
          images: [{ image_id: 42, upload_url: "https://images.mashina.kg/test-upload" }],
        });
      if (path.endsWith("/confirm")) return new Response(null, { status: 429 });
      return new Response(null, { status: 200 });
    }),
  );
  await expect(client.send(recipient, "Test", image)).rejects.toMatchObject({
    outcome: "failed",
    pause: true,
  });
  expect(state.sends).toBe(0);
});

it("resolves the canonical slug needed to revalidate a recipient before sending", async () => {
  const resolved = await client.resolve(candidate);
  expect(resolved).toEqual(recipient);
  await expect(client.send(resolved, "Test", null)).resolves.toEqual({ remoteId: null });
  expect(state.sends).toBe(1);
});

it.each([
  ["changed seller", { user_id: 789 }],
  ["inactive ad", { status: "inactive" }],
  ["owner flag", { is_owner: true }],
  ["own-ad flag", { is_my_ad: true }],
] as const)("does not upload or emit for a %s after resolution", async (_name, change) => {
  const resolved = await client.resolve(candidate);
  Object.assign(listing, change);
  let prepared = false;
  preparePhoto = () => {
    prepared = true;
  };
  await expect(client.send(resolved, "Test", image)).rejects.toMatchObject({
    outcome: "failed",
    pause: false,
  });
  expect(state.sends).toBe(0);
  expect(prepared).toBe(false);
  expect(
    vi
      .mocked(fetch)
      .mock.calls.every(([, options]) => !options?.method || options.method === "GET"),
  ).toBe(true);
});

it("does not emit when the detail endpoint no longer confirms the exact slug", async () => {
  const resolved = await client.resolve(candidate);
  listing.slug = "another-ad-789";
  await expect(client.send(resolved, "Test", null)).rejects.toMatchObject({ outcome: "failed" });
  expect(state.sends).toBe(0);
});

it("checks ownership using the replacement session before preparing a photo", async () => {
  const resolved = await client.resolve(candidate);
  await writeFile(
    join(directory, "session.json"),
    JSON.stringify({ accessToken: "replacement-session-token" }),
    { mode: 0o600 },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL, options?: RequestInit) =>
      Response.json({
        ...listing,
        is_owner:
          new Headers(options?.headers).get("Cookie") === "access_token=replacement-session-token",
      }),
    ),
  );
  await expect(client.send(resolved, "Test", image)).rejects.toMatchObject({
    outcome: "failed",
    pause: false,
  });
  expect(state.sends).toBe(0);
});

it("does not emit if the seller changes during photo preparation", async () => {
  const resolved = await client.resolve(candidate);
  preparePhoto = () => {
    listing.user_id = 789;
  };
  await expect(client.send(resolved, "Test", image)).rejects.toMatchObject({
    outcome: "failed",
    pause: false,
  });
  expect(state.sends).toBe(0);
});

it("does not emit if the ad becomes inactive while connecting the socket", async () => {
  const resolved = await client.resolve(candidate);
  state.onConnect = () => {
    listing.status = "inactive";
  };
  await expect(client.send(resolved, "Test", null)).rejects.toMatchObject({
    outcome: "failed",
    pause: false,
  });
  expect(state.sends).toBe(0);
});

it("uses the socket session for the final ownership check", async () => {
  const resolved = await client.resolve(candidate);
  preparePhoto = async () => {
    await writeFile(
      join(directory, "session.json"),
      JSON.stringify({ accessToken: "replacement-session-token" }),
      { mode: 0o600 },
    );
  };
  state.onConnect = () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, options?: RequestInit) =>
        Response.json({
          ...listing,
          is_my_ad: new Headers(options?.headers).get("Cookie") === state.socketCookie,
        }),
      ),
    );
  };
  await expect(client.send(resolved, "Test", image)).rejects.toMatchObject({
    outcome: "failed",
    pause: false,
  });
  expect(state.sends).toBe(0);
});
