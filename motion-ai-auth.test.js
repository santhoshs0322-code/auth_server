const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { createMotionAiAuth, readConfig } = require("./motion-ai-auth");
const env = { MOTION_AI_AUTH_ENABLED: "true", MOTION_AI_GOOGLE_CLIENT_ID: "test-web.apps.googleusercontent.com",
  MOTION_AI_JWT_SECRET: "motion-ai-tests-only-not-a-production-secret-12345", MOTION_AI_MONGODB_DATABASE: "motionmagic" };
const user = { _id: "012345678901234567890123", name: "Creator", email: "creator@example.test", picture: "" };

async function fixture(t, options = {}) {
  const revoked = new Set();
  const state = { present: true, failing: false, audience: null, writes: 0 };
  const store = {
    async initialize() {},
    async upsert() { if (state.failing) throw new Error("private database information"); state.writes++; return user; },
    async find() { if (state.failing) throw new Error("private database information"); return state.present ? user : null; },
    async isRevoked(id) { if (state.failing) throw new Error("private database information"); return revoked.has(id); },
    async revoke(payload) { revoked.add(payload.jti); }
  };
  const google = { async verifyIdToken({ idToken, audience }) {
    state.audience = audience;
    if (idToken === "bad") throw new Error("private provider information");
    return { getPayload: () => ({ sub: "google-verified-sub", email: user.email,
      email_verified: idToken !== "unverified", name: user.name }) };
  } };
  const module = createMotionAiAuth({ env: options.env || env, store, google });
  if (!options.notReady) await module.initialize();
  const app = express(); app.use("/auth/motion-ai", module.router);
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  async function request(path, body, token) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/auth/motion-ai${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const login = () => request("/google/native", { app: "motionmagic", idToken: "valid" });
  return { request, login, state };
}

test("disabled module requires no credentials; invalid enabled config fails closed", () => {
  assert.equal(readConfig({}).enabled, false);
  for (const bad of [{ MOTION_AI_AUTH_ENABLED: "yes" }, { ...env, MOTION_AI_GOOGLE_CLIENT_ID: "android-id" },
    { ...env, MOTION_AI_JWT_SECRET: "short" }, { ...env, JWT_SECRET: env.MOTION_AI_JWT_SECRET },
    { ...env, MOTION_AI_MONGODB_DATABASE: "candycraze" }]) assert.throws(() => readConfig(bad));
});
test("disabled and uninitialized modules return 503 without advertising a client ID", async t => {
  for (const options of [{ env: {} }, { notReady: true }]) {
    const f = await fixture(t, options);
    assert.equal((await f.request("/config")).body.googleWebClientId, undefined);
    assert.equal((await f.login()).status, 503);
  }
});
test("public configuration exposes only the public OAuth client ID", async t => {
  const f = await fixture(t); const r = await f.request("/config");
  assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(r.body, { ok: true, appId: "motionmagic", enabled: true, googleWebClientId: env.MOTION_AI_GOOGLE_CLIENT_ID });
});
test("verified Google identity produces app-bound session and account response", async t => {
  const f = await fixture(t); const r = await f.login();
  assert.equal(r.status, 200); assert.equal(f.state.audience, env.MOTION_AI_GOOGLE_CLIENT_ID);
  const claims = jwt.verify(r.body.token, env.MOTION_AI_JWT_SECRET, { issuer: "motionmagic-ai", audience: "motionmagic", algorithms: ["HS256"] });
  assert.equal(claims.exp - claims.iat, 30 * 86400); assert.equal(claims.sub, user._id); assert.ok(claims.jti);
  const me = await f.request("/me", undefined, r.body.token);
  assert.equal(me.status, 200); assert.equal(me.body.user.id, user._id); assert.equal(me.body.appId, "motionmagic");
});
test("bad app/token, invalid Google identity and unverified email do not write accounts", async t => {
  const f = await fixture(t);
  for (const [body, status] of [[{}, 400], [null, 400], [[], 400], [{ app: "candycraze", idToken: "valid" }, 400],
    [{ app: "motionmagic", idToken: "x".repeat(10001) }, 400], [{ app: "motionmagic", idToken: {} }, 400],
    [{ app: "motionmagic", idToken: "bad" }, 401], [{ app: "motionmagic", idToken: "unverified" }, 401]]) {
    const r = await f.request("/google/native", body); assert.equal(r.status, status);
    assert.ok(!JSON.stringify(r.body).includes("private provider"));
  }
  assert.equal(f.state.writes, 0);
});
test("missing, wrong-app, wrong-key, expired and malformed sessions are rejected", async t => {
  const f = await fixture(t);
  const token = (changes = {}, secret = env.MOTION_AI_JWT_SECRET) => jwt.sign({ sub: user._id, appId: "motionmagic",
    aud: "motionmagic", iss: "motionmagic-ai", jti: "test", exp: Math.floor(Date.now() / 1000) + 60, ...changes }, secret);
  for (const value of [undefined, "bad", token({ appId: "candycraze" }), token({ aud: "candycraze" }),
    token({ iss: "central-game-auth" }), token({ exp: 1 }), token({ sub: "bad" }), token({}, "different-secret")])
    assert.equal((await f.request("/me", undefined, value)).status, 401);
});
test("logout revokes only that session and deleted accounts lose access", async t => {
  const f = await fixture(t); const first = (await f.login()).body.token; const second = (await f.login()).body.token;
  assert.equal((await f.request("/logout", {}, first)).status, 200);
  assert.equal((await f.request("/me", undefined, first)).status, 401);
  assert.equal((await f.request("/me", undefined, second)).status, 200);
  f.state.present = false; assert.equal((await f.request("/me", undefined, second)).status, 401);
});
test("database failures return 503 without leaking details or treating sessions as invalid", async t => {
  const f = await fixture(t); const token = (await f.login()).body.token; f.state.failing = true;
  for (const r of [await f.login(), await f.request("/me", undefined, token)]) {
    assert.equal(r.status, 503); assert.ok(!JSON.stringify(r.body).includes("private database"));
  }
});
test("repeated login attempts are limited independently of session reads", async t => {
  const f = await fixture(t); const token = (await f.login()).body.token;
  for (let i = 0; i < 19; i++) await f.request("/google/native", {});
  const r = await f.login(); assert.equal(r.status, 429); assert.equal(r.headers.get("retry-after"), "60");
  assert.equal((await f.request("/me", undefined, token)).status, 200);
});
