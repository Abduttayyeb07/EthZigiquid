import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

process.env.NODE_ENV = "test";
process.env.WEB_ORIGIN = "http://localhost:3000";
process.env.CONTROL_API_TOKEN = "token-alpha,token-beta";
process.env.STATE_ENCRYPTION_KEY = "a".repeat(64);
process.env.PERSIST_RUNTIME_STATE = "false";
process.env.EXECUTION_MODE = "paper";
process.env.DATABASE_URL = "postgresql://unused:unused@127.0.0.1:5432/unused";
process.env.LOG_LEVEL = "silent";

const { buildApp } = await import("../src/app.js");

let app: FastifyInstance;

async function issueSession(token: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/session",
    headers: { authorization: `Bearer ${token}` },
  });
  return (response.json() as { session: string }).session;
}

function state(token: string, session?: string) {
  return app.inject({
    method: "GET",
    url: "/api/v1/state",
    headers: {
      authorization: `Bearer ${token}`,
      ...(session ? { "x-operator-session": session } : {}),
    },
  });
}

beforeAll(async () => {
  ({ app } = await buildApp());
});

afterAll(async () => {
  await app.close();
});

describe("operator session signing", () => {
  it("rejects a request that carries no session", async () => {
    const response = await state("token-alpha");
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "SESSION_INVALID" });
  });

  it("rejects a session the client invented rather than the server issuing", async () => {
    // The pre-signing attack: any token holder could name any session id and
    // inherit that operator's wallet, automation, and logs.
    const forged = "11111111-2222-3333-4444-555555555555";
    const response = await state("token-alpha", forged);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "SESSION_INVALID" });
  });

  it("rejects a validly-shaped session whose signature was tampered with", async () => {
    const session = await issueSession("token-alpha");
    const [sessionId] = session.split(".");
    const response = await state("token-alpha", `${sessionId}.tampered-signature-value`);
    expect(response.statusCode).toBe(401);
  });

  it("accepts a session this server signed", async () => {
    const session = await issueSession("token-alpha");
    const response = await state("token-alpha", session);
    expect(response.statusCode).toBe(200);
  });

  it("refuses a session issued for a different operator token", async () => {
    const session = await issueSession("token-alpha");
    const response = await state("token-beta", session);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "SESSION_INVALID" });
  });

  it("keeps settings isolated between two sessions on the same token", async () => {
    const first = await issueSession("token-alpha");
    const second = await issueSession("token-alpha");

    const patched = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      headers: { authorization: "Bearer token-alpha", "x-operator-session": first },
      payload: { intervalSeconds: 99 },
    });
    expect(patched.statusCode).toBe(200);

    const untouched = await state("token-alpha", second);
    expect(untouched.json().settings.intervalSeconds).toBe(30);
  });

  it("rejects zero trade amounts before they enter saved config", async () => {
    const session = await issueSession("token-alpha");
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      headers: { authorization: "Bearer token-alpha", "x-operator-session": session },
      payload: { tradeAmountEth: "0" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });
});
