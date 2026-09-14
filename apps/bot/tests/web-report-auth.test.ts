import type { PaymentStore } from "@autodom/storage/payments";
import { afterEach, expect, it, vi } from "vitest";
import { WebReportAuth } from "../src/web-report-auth.js";

function fixture() {
  const sessions = new Map<string, { userId: number; expiresAt: string }>();
  const ledger = {
    createWebSession: vi.fn(async (hash: string, userId: number, expiresAt: string) => {
      sessions.set(hash, { userId, expiresAt });
    }),
    getWebSessionUser: vi.fn(async (hash: string) => {
      const session = sessions.get(hash);
      return session && Date.parse(session.expiresAt) > Date.now() ? session.userId : null;
    }),
    deleteWebSession: vi.fn(async (hash: string) => {
      sessions.delete(hash);
    }),
  };
  const auth = new WebReportAuth(ledger as unknown as PaymentStore, "autodom_fixture_bot");
  return { auth, ledger };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("requires the originating browser secret and a code from the first bound Telegram user", async () => {
  const { auth } = fixture();
  const login = auth.beginLogin();
  await expect(
    auth.completeLogin(login.loginId, login.loginSecret, "ABCDEFGH"),
  ).rejects.toMatchObject({
    status: 409,
  });
  expect(() => auth.issueCode(login.loginId, Number.MAX_SAFE_INTEGER + 1)).toThrow();
  const { code } = auth.issueCode(login.loginId, 42);
  expect(() => auth.issueCode(login.loginId, 43)).toThrow();
  const otherBrowser = auth.beginLogin();
  await expect(
    auth.completeLogin(login.loginId, otherBrowser.loginSecret, code),
  ).rejects.toMatchObject({
    status: 401,
  });
  const session = await auth.completeLogin(login.loginId, login.loginSecret, code);
  expect(await auth.authenticate(session.sessionToken)).toBe(42);
  await expect(auth.completeLogin(login.loginId, login.loginSecret, code)).rejects.toMatchObject({
    status: 410,
  });
});

it("does not refresh expiry when the same user asks for the code again", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-09-14T12:00:00.000Z");
  const { auth } = fixture();
  const login = auth.beginLogin();
  auth.issueCode(login.loginId, 42);
  vi.setSystemTime("2026-09-14T12:09:59.999Z");
  const { code } = auth.issueCode(login.loginId, 42);
  vi.setSystemTime("2026-09-14T12:10:00.000Z");
  await expect(auth.completeLogin(login.loginId, login.loginSecret, code)).rejects.toMatchObject({
    status: 410,
  });
  expect(() => auth.issueCode(login.loginId, 42)).toThrow();
});

it("exhausts the code budget after five failures even if the user repeatedly asks for the code", async () => {
  const { auth } = fixture();
  const login = auth.beginLogin();
  let code = auth.issueCode(login.loginId, 42).code;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    code = auth.issueCode(login.loginId, 42).code;
    const wrongCode = `${code[0] === "A" ? "B" : "A"}${code.slice(1)}`;
    await expect(
      auth.completeLogin(login.loginId, login.loginSecret, wrongCode),
    ).rejects.toMatchObject({
      status: attempt === 5 ? 429 : 401,
    });
  }
  await expect(auth.completeLogin(login.loginId, login.loginSecret, code)).rejects.toMatchObject({
    status: 410,
  });
  expect(() => auth.issueCode(login.loginId, 42)).toThrow();
});

it("consumes a challenge before persistence settles and never restores it after storage failure", async () => {
  const { auth, ledger } = fixture();
  let failPersistence!: (reason: Error) => void;
  ledger.createWebSession.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        failPersistence = reject;
      }),
  );
  const login = auth.beginLogin();
  const { code } = auth.issueCode(login.loginId, 42);
  const first = auth.completeLogin(login.loginId, login.loginSecret, code);
  const failed = expect(first).rejects.toThrow("storage unavailable");
  await expect(auth.completeLogin(login.loginId, login.loginSecret, code)).rejects.toMatchObject({
    status: 410,
  });
  failPersistence(new Error("storage unavailable"));
  await failed;
  await expect(auth.completeLogin(login.loginId, login.loginSecret, code)).rejects.toMatchObject({
    status: 410,
  });
});

it("uses ledger sessions across auth instances, revokes them globally, and fails closed on storage errors", async () => {
  const { auth, ledger } = fixture();
  const login = auth.beginLogin();
  const { code } = auth.issueCode(login.loginId, 42);
  const session = await auth.completeLogin(login.loginId, login.loginSecret, code);
  const restarted = new WebReportAuth(ledger as unknown as PaymentStore, "autodom_fixture_bot");
  expect(await restarted.authenticate(session.sessionToken)).toBe(42);
  ledger.getWebSessionUser.mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(auth.authenticate(session.sessionToken)).rejects.toThrow("storage unavailable");
  await restarted.logout(session.sessionToken);
  expect(await auth.authenticate(session.sessionToken)).toBeNull();
  expect(await restarted.authenticate(session.sessionToken)).toBeNull();
  expect(await auth.authenticate("not-a-token")).toBeNull();
});

it("bounds outstanding challenges without evicting live browser logins and reclaims expired capacity", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-09-14T12:00:00.000Z");
  const { auth } = fixture();
  const first = auth.beginLogin();
  for (let index = 1; index < 1000; index += 1) auth.beginLogin();
  expect(() => auth.beginLogin()).toThrow();
  const { code } = auth.issueCode(first.loginId, 42);
  const session = await auth.completeLogin(first.loginId, first.loginSecret, code);
  expect(await auth.authenticate(session.sessionToken)).toBe(42);
  auth.beginLogin();
  vi.setSystemTime("2026-09-14T12:10:00.000Z");
  const reclaimed = auth.beginLogin();
  const nextCode = auth.issueCode(reclaimed.loginId, 43).code;
  const next = await auth.completeLogin(reclaimed.loginId, reclaimed.loginSecret, nextCode);
  expect(await auth.authenticate(next.sessionToken)).toBe(43);
});
