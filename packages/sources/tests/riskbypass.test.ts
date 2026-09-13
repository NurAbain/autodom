import { setImmediate } from "node:timers/promises";
import { SourceError } from "@autodom/core";
import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RiskBypass, RiskBypassError } from "../src/riskbypass.js";

const target = new URL("https://bid.cars/en/lot/1-12345678");
const proxy = new URL("http://user:private-password@192.0.2.1:7000");
const session = {
  cookies: { cf_clearance: "clearance-token" },
  user_agent: "Mozilla/5.0 Chrome/144.0.0.0",
};
const agents: MockAgent[] = [];

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  vi.clearAllTimers();
  vi.useRealTimers();
});

function fixture() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agents.push(agent);
  const pool = agent.get("https://riskbypass.com");
  const solver = new RiskBypass({ apiKey: "private-api-key", dispatcher: agent });
  return { agent, pool, solver };
}

async function settle() {
  await setImmediate();
  await setImmediate();
}

describe("RiskBypass paid-task lifecycle", () => {
  it("submits once and polls queued and running tasks at five-second intervals", async () => {
    const { pool, solver, agent } = fixture();
    let submissions = 0;
    let polls = 0;
    pool.intercept({ path: "/task/submit", method: "POST" }).reply(() => {
      submissions += 1;
      return { statusCode: 200, data: { ok: true, task_id: "task-1" } };
    });
    for (const status of [" queued ", "running", "SUCCESS"]) {
      pool.intercept({ path: "/task/result/task-1", method: "GET" }).reply(() => {
        polls += 1;
        return {
          statusCode: 200,
          data: { status, result: { ...session, ua: "legacy-user-agent" } },
        };
      });
    }
    const solved = solver.solve(target, proxy, new AbortController().signal);
    await settle();
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(polls).toBe(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await solved).toEqual({ cookies: session.cookies, userAgent: session.user_agent });
    expect(submissions).toBe(1);
    agent.assertNoPendingInterceptors();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("establishes a session with a provider accepting proxy endpoints without a URL path", async () => {
    const { pool, solver, agent } = fixture();
    let reachable = false;
    pool.intercept({ path: "/task/submit", method: "POST" }).reply(({ body }) => {
      reachable = typeof body === "string" && !JSON.parse(body).proxy.endsWith("/");
      return { statusCode: 200, data: { ok: true, task_id: "proxy-endpoint" } };
    });
    pool.intercept({ path: "/task/result/proxy-endpoint", method: "GET" }).reply(() => ({
      statusCode: 200,
      data: reachable
        ? { status: "SUCCESS", result: session }
        : { status: "FAILED", error: "Failed to reach the target site, please check your proxy." },
    }));
    await expect(solver.solve(target, proxy, new AbortController().signal)).resolves.toEqual({
      cookies: session.cookies,
      userAgent: session.user_agent,
    });
    agent.assertNoPendingInterceptors();
  });

  it("reports an unsuccessful target solve without resubmitting it", async () => {
    const { pool, solver, agent } = fixture();
    const submit = vi.fn(() => ({ statusCode: 200, data: { ok: true, task_id: "task-1" } }));
    pool.intercept({ path: "/task/submit", method: "POST" }).reply(submit).persist();
    pool
      .intercept({ path: "/task/result/task-1", method: "GET" })
      .reply(200, { status: "FAILED", error: "private-api-key" });
    const result = await solver
      .solve(target, proxy, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(SourceError);
    expect(result).not.toBeInstanceOf(RiskBypassError);
    expect(String(result)).not.toContain("private-api-key");
    expect(submit).toHaveBeenCalledTimes(1);
    agent.assertNoPendingInterceptors();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry an ambiguous submission failure or expose its body", async () => {
    const { pool, solver } = fixture();
    let submissions = 0;
    pool
      .intercept({ path: "/task/submit", method: "POST" })
      .reply(() => {
        submissions += 1;
        return { statusCode: 502, data: "private-password private-api-key" };
      })
      .persist();
    const result = await solver
      .solve(target, proxy, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(RiskBypassError);
    expect(String(result)).not.toContain("private-");
    expect(submissions).toBe(1);
  });

  it("never follows a vendor redirect to submit another paid task", async () => {
    const { pool, solver } = fixture();
    pool.intercept({ path: "/task/submit", method: "POST" }).reply(307, "", {
      headers: { location: "https://riskbypass.com/task/submit-again" },
    });
    const redirected = vi.fn(() => ({ statusCode: 200, data: { ok: true, task_id: "task-1" } }));
    pool.intercept({ path: "/task/submit-again", method: "POST" }).reply(redirected);
    await expect(solver.solve(target, proxy, new AbortController().signal)).rejects.toBeInstanceOf(
      RiskBypassError,
    );
    expect(redirected).not.toHaveBeenCalled();
  });

  it("aborts a queued task without polling or submitting again", async () => {
    const { pool, solver } = fixture();
    let polls = 0;
    pool
      .intercept({ path: "/task/submit", method: "POST" })
      .reply(200, { ok: true, task_id: "task-1" });
    pool
      .intercept({ path: "/task/result/task-1", method: "GET" })
      .reply(() => {
        polls += 1;
        return { statusCode: 200, data: { status: "QUEUED" } };
      })
      .persist();
    const controller = new AbortController();
    const solved = solver.solve(target, proxy, controller.signal).catch((error: unknown) => error);
    await settle();
    controller.abort(new RiskBypassError("private-password"));
    const result = await solved;
    expect(result).toBeInstanceOf(RiskBypassError);
    expect(String(result)).not.toContain("private-password");
    await vi.advanceTimersByTimeAsync(300000);
    expect(polls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not submit when already aborted", async () => {
    const { pool, solver } = fixture();
    const submit = vi.fn(() => ({ statusCode: 200, data: { ok: true, task_id: "task-1" } }));
    pool.intercept({ path: "/task/submit", method: "POST" }).reply(submit);
    await expect(solver.solve(target, proxy, AbortSignal.abort())).rejects.toBeInstanceOf(
      RiskBypassError,
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("times out a stalled submission after sixty seconds without retrying", async () => {
    const { pool, solver } = fixture();
    let submissions = 0;
    pool
      .intercept({ path: "/task/submit", method: "POST" })
      .reply(() => {
        submissions += 1;
        return { statusCode: 200, data: { ok: true, task_id: "task-1" } };
      })
      .delay(65000)
      .persist();
    const solved = solver
      .solve(target, proxy, new AbortController().signal)
      .catch((error: unknown) => error);
    await settle();
    await vi.advanceTimersByTimeAsync(60000);
    expect(await solved).toBeInstanceOf(RiskBypassError);
    expect(submissions).toBe(1);
  });

  it("includes submission time in the five-minute total deadline", async () => {
    const { pool, solver } = fixture();
    pool
      .intercept({ path: "/task/submit", method: "POST" })
      .reply(200, { ok: true, task_id: "task-1" })
      .delay(59000);
    pool
      .intercept({ path: "/task/result/task-1", method: "GET" })
      .reply(200, { status: "RUNNING" })
      .persist();
    let finished = false;
    const solved = solver
      .solve(target, proxy, new AbortController().signal)
      .catch((error: unknown) => error)
      .finally(() => {
        finished = true;
      });
    await settle();
    await vi.advanceTimersByTimeAsync(299999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await solved).toBeInstanceOf(RiskBypassError);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("RiskBypass result validation", () => {
  it.each([
    null,
    { cookies: { other: "token" }, user_agent: session.user_agent },
    { cookies: [{ name: "cf_clearance", value: "token" }], user_agent: session.user_agent },
    { cookies: { cf_clearance: "token\r\nInjected: true" }, user_agent: session.user_agent },
    { cookies: { cf_clearance: "token", "bad;name": "value" }, user_agent: session.user_agent },
    { cookies: { cf_clearance: "a".repeat(4096) }, user_agent: session.user_agent },
    {
      cookies: {
        cf_clearance: "token",
        ...Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`c${i}`, "v"])),
      },
      user_agent: session.user_agent,
    },
    {
      cookies: {
        cf_clearance: "token",
        ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`c${i}`, "v".repeat(4000)])),
      },
      user_agent: session.user_agent,
    },
    { cookies: session.cookies },
    { cookies: session.cookies, user_agent: "bad\r\nInjected: true" },
    { cookies: session.cookies, user_agent: "", ua: session.user_agent },
  ])("rejects an unusable success payload %#", async (result) => {
    const { pool, solver } = fixture();
    pool
      .intercept({ path: "/task/submit", method: "POST" })
      .reply(200, { ok: true, task_id: "task-1" });
    pool
      .intercept({ path: "/task/result/task-1", method: "GET" })
      .reply(200, { status: "SUCCESS", result });
    await expect(solver.solve(target, proxy, new AbortController().signal)).rejects.toBeInstanceOf(
      RiskBypassError,
    );
  });

  it("accepts the provider's ua field when user_agent is absent", async () => {
    const { pool, solver } = fixture();
    pool
      .intercept({ path: "/task/submit", method: "POST" })
      .reply(200, { ok: true, task_id: "task-1" });
    pool.intercept({ path: "/task/result/task-1", method: "GET" }).reply(200, {
      status: "SUCCESS",
      result: { cookies: session.cookies, ua: session.user_agent },
    });
    expect((await solver.solve(target, proxy, new AbortController().signal)).userAgent).toBe(
      session.user_agent,
    );
  });

  it.each([
    "not-json private-api-key",
    JSON.stringify({ ok: false, task_id: "task-1" }),
    JSON.stringify({ ok: true }),
    JSON.stringify({ ok: true, task_id: "../submit" }),
    JSON.stringify({ ok: true, task_id: "task-1", extra: "x".repeat(1024 * 1024) }),
  ])("rejects malformed or oversized submission responses %#", async (body) => {
    const { pool, solver } = fixture();
    pool.intercept({ path: "/task/submit", method: "POST" }).reply(200, body);
    const result = await solver
      .solve(target, proxy, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(RiskBypassError);
    expect(String(result)).not.toContain("private-api-key");
  });
});
