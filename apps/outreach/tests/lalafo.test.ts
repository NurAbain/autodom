import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Candidate, OutreachImage } from "../src/contracts.js";
import { LalafoMessenger } from "../src/lalafo.js";

const state = vi.hoisted(() => ({
  session: {
    token: "isolated-test-jwt",
    accessToken: "isolated-test-socket-token",
    userId: 42,
    userHash: "isolated-test-user-hash",
    deviceFingerprint: "00000000000000000000000000000000",
    proxyUrl: "http://127.0.0.1:18080",
    userAgent: "Isolated test",
    cookies: {},
    createdAt: "2026-09-16T00:00:00Z",
  },
  listing: {} as Record<string, unknown>,
  replies: [] as Array<{ status: number; body: unknown } | Error>,
  uploadStatus: 200,
  handshake: true,
  disconnected: 0,
  requests: [] as Array<{
    path: string;
    method: string;
    body: unknown;
    headers: Record<string, string>;
  }>,
}));

vi.mock("../src/lalafo-session.js", () => ({
  readLalafoSession: async () => structuredClone(state.session),
  createLalafoClient: async (session: { userId: number }) => {
    return {
      fetch: async (
        url: string,
        init: { method: string; body?: string | FormData; headers: Record<string, string> },
      ) => {
        const path = new URL(url).pathname;
        const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
        state.requests.push({ path, method: init.method, body, headers: init.headers });
        if (path === "/api/user/v3/profiles") return Response.json({ id: session.userId });
        if (path === "/api/search/v3/feed/details/456") return Response.json(state.listing);
        if (path === "/api/upload/upload/v3/chats/upload") {
          if (state.uploadStatus !== 200) return new Response(null, { status: state.uploadStatus });
          return Response.json([
            {
              name: "test.png",
              link: "https://img.lalafo.com/test.png",
              thumbnail: "https://img.lalafo.com/test-small.png",
              width: 100,
              height: 80,
            },
          ]);
        }
        if (path === "/api/chat/v4/message/send") {
          const reply = state.replies.shift();
          if (reply instanceof Error) throw reply;
          if (reply) return Response.json(reply.body, { status: reply.status });
          throw new Error("Unexpected extra message: no acknowledgement was configured");
        }
        throw new Error("Unexpected transport endpoint");
      },
    };
  },
}));

vi.mock("socket.io-client", async () => {
  // Vitest hoists this factory before static imports; the emitter must load inside that boundary.
  const { EventEmitter } = await import("node:events");
  return {
    io: () => {
      const emitter = new EventEmitter();
      const socket = Object.assign(emitter, {
        id: "engine-io-id-is-not-the-chat-id",
        connected: false,
        connect() {
          socket.connected = true;
          queueMicrotask(() => {
            socket.emit("connect");
            if (state.handshake)
              socket.emit("message", { ref: "SocketConnection", socketId: "first-party-chat-id" });
          });
        },
        disconnect() {
          state.disconnected++;
          socket.connected = false;
          socket.removeAllListeners();
        },
      });
      return socket;
    },
  };
});

const candidate: Candidate = {
  listingId: "internal-database-id",
  source: "lalafo.kg",
  title: "Test listing",
  url: "https://lalafo.kg/bishkek/ads/test-car-id-456",
  city: "Бишкек",
  year: null,
  price: null,
  currency: "KGS",
};
const recipient = { id: "123", listingId: "456" };
const image: OutreachImage = {
  id: "test-photo",
  mime: "image/png",
  bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
};
let client: LalafoMessenger;
const sends = () =>
  state.requests.filter((request) => request.path === "/api/chat/v4/message/send");
const mutations = () => state.requests.filter((request) => request.method !== "GET");

beforeEach(() => {
  client = new LalafoMessenger("/isolated-private-session.json");
  state.session.userId = 42;
  state.listing = {
    id: 456,
    user_id: 123,
    country_id: 12,
    status_id: 2,
    hide_chat: false,
    submit_request: null,
    url: candidate.url,
  };
  state.uploadStatus = 200;
  state.handshake = true;
  state.disconnected = 0;
  state.replies = [];
  state.requests = [];
});
afterEach(() => {
  vi.useRealTimers();
});

it("checks the profile and first-party socket handshake without creating or touching a seller chat", async () => {
  expect(await client.check()).toMatchObject({ ready: true });
  expect(await client.resolve(candidate)).toEqual(recipient);
  expect(mutations()).toEqual([]);
  expect(state.disconnected).toBe(1);
});

it("does not consider the generic socket connection an authenticated chat handshake", async () => {
  vi.useFakeTimers();
  state.handshake = false;
  const pending = client.check();
  await vi.advanceTimersByTimeAsync(20_001);
  expect(await pending).toMatchObject({ ready: false });
  expect(mutations()).toEqual([]);
  expect(state.disconnected).toBe(1);
});

it("sends no message when the photo upload fails", async () => {
  state.uploadStatus = 429;
  await expect(client.send(recipient, "Test", image)).rejects.toMatchObject({
    outcome: "failed",
    pause: true,
  });
  expect(sends()).toEqual([]);
  expect(state.disconnected).toBe(1);
});

it("marks an explicit photo rejection after acknowledged text as partial, unknown delivery", async () => {
  state.replies = [
    { status: 200, body: { message: { kind: 1, payload: "Test", created: 100 } } },
    { status: 403, body: { error: "rejected" } },
  ];
  await expect(client.send(recipient, "Test", image)).rejects.toMatchObject({
    outcome: "unknown",
    pause: true,
  });
  expect(sends()).toHaveLength(2);
  expect(
    state.requests.filter((request) => request.method === "POST").map((request) => request.path),
  ).toEqual([
    "/api/upload/upload/v3/chats/upload",
    "/api/chat/v4/message/send",
    "/api/chat/v4/message/send",
  ]);
});

it.each([
  { name: "malformed", reply: { status: 200, body: { success: true } } },
  {
    name: "unrelated",
    reply: {
      status: 200,
      body: { message: { kind: 1, payload: "Another message", created: 100 } },
    },
  },
  {
    name: "lost",
    reply: new Error("Transport closed with private credentials that must not escape"),
  },
  { name: "server failure", reply: { status: 503, body: { error: "private server details" } } },
])("never replays text after a $name acknowledgement or sends the photo", async ({ reply }) => {
  state.replies = [reply];
  await expect(client.send(recipient, "Test", image)).rejects.toMatchObject({
    outcome: "unknown",
    pause: true,
  });
  expect(sends()).toHaveLength(1);
  expect(state.disconnected).toBe(1);
});

it("acknowledges a complete text/photo pair without inventing a message ID", async () => {
  state.replies = [
    { status: 200, body: { message: { kind: 1, payload: "Test", created: 100 } } },
    {
      status: 200,
      body: { message: { kind: 2, payload: "https://img.lalafo.com/test.png", created: 101 } },
    },
  ];
  expect(await client.send(recipient, "Test", image)).toEqual({ remoteId: null });
  expect(sends()).toHaveLength(2);
});

it("returns an observed remote ID only after its matching positive acknowledgement", async () => {
  state.replies = [
    {
      status: 200,
      body: { message: { id: "observed-id", kind: 1, payload: "Test", created: 100 } },
    },
  ];
  expect(await client.send(recipient, "Test", null)).toEqual({ remoteId: "observed-id" });
});

it("pauses on an explicit first-message rate-limit rejection without retrying", async () => {
  state.replies = [{ status: 429, body: { error: "rate limited" } }];
  await expect(client.send(recipient, "Test", null)).rejects.toMatchObject({
    outcome: "failed",
    pause: true,
  });
  expect(sends()).toHaveLength(1);
});

it.each([
  "https://lalafo.kg:443/bishkek/ads/test-car-id-456",
  "https://user:password@lalafo.kg/bishkek/ads/test-car-id-456",
  "https://lalafo.kg.example/bishkek/ads/test-car-id-456",
])("rejects noncanonical listing authority before any request: %s", async (url) => {
  await expect(client.resolve({ ...candidate, url })).rejects.toMatchObject({ outcome: "failed" });
  expect(state.requests).toEqual([]);
});

it.each([
  ["own listing", { user_id: 42 }],
  ["closed chat", { hide_chat: true }],
  ["contact form", { submit_request: { enabled: true } }],
  ["inactive listing", { status_id: 3 }],
  ["another country", { country_id: 1 }],
  ["mismatched listing", { id: 999 }],
  ["mismatched canonical identity", { url: "https://lalafo.kg/bishkek/ads/test-car-id-999" }],
])(
  "rejects %s at resolution and again at the send boundary without mutations",
  async (_name, override) => {
    Object.assign(state.listing, override);
    await expect(client.resolve(candidate)).rejects.toMatchObject({ outcome: "failed" });
    await expect(client.send(recipient, "Test", image)).rejects.toMatchObject({
      outcome: "failed",
    });
    expect(mutations()).toEqual([]);
  },
);

it("does not contact the previously resolved seller when the listing owner changes", async () => {
  const resolved = await client.resolve(candidate);
  state.listing.user_id = 999;
  await expect(client.send(resolved, "Test", image)).rejects.toMatchObject({
    outcome: "failed",
    pause: true,
  });
  expect(mutations()).toEqual([]);
});

it("re-reads a replaced session instead of sending to its new account's own listing", async () => {
  const resolved = await client.resolve(candidate);
  state.session.userId = 123;
  await expect(client.send(resolved, "Test", image)).rejects.toMatchObject({ outcome: "failed" });
  expect(mutations()).toEqual([]);
});
