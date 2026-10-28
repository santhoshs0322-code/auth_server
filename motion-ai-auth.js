// MotionMagic's native Google login. No game saves, shared game sessions or AI keys.
const crypto = require("node:crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { OAuth2Client } = require("google-auth-library");

const APP_ID = "motionmagic";
const ISSUER = "motionmagic-ai";
const fail = (status, message) => Object.assign(new Error(message), { status });

function readConfig(env = process.env) {
  if (env.MOTION_AI_AUTH_ENABLED && !["true", "false"].includes(env.MOTION_AI_AUTH_ENABLED))
    throw new Error("MOTION_AI_AUTH_ENABLED must be true or false");
  const config = {
    enabled: env.MOTION_AI_AUTH_ENABLED === "true",
    clientId: (env.MOTION_AI_GOOGLE_CLIENT_ID || "").trim(),
    secret: env.MOTION_AI_JWT_SECRET || "",
    database: env.MOTION_AI_MONGODB_DATABASE || "motionmagic"
  };
  if (!config.enabled) return config;
  if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(config.clientId))
    throw new Error("Configure MOTION_AI_GOOGLE_CLIENT_ID with a Google Web OAuth client ID");
  if (config.secret.trim().length < 32 || config.secret === env.JWT_SECRET)
    throw new Error("MOTION_AI_JWT_SECRET must be a separate random secret of at least 32 characters");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.database) ||
      ["admin", "local", "config", "candycraze", "monstermerge", "game_auth", "balloonpop", "classicpuzzle", env.MONSTER_MONGODB_DATABASE].includes(config.database.toLowerCase()))
    throw new Error("MOTION_AI_MONGODB_DATABASE must name a separate application database");
  return config;
}

function createStore(connection, config) {
  const db = connection.useDb(config.database, { useCache: true });
  const users = db.model("MotionAiUser", new mongoose.Schema({
    googleSub: { type: String, required: true, unique: true },
    email: { type: String, required: true }, name: { type: String, required: true },
    picture: { type: String, default: "" }, lastLoginAt: Date
  }, { timestamps: true, versionKey: false }), "users");
  const revoked = db.model("MotionAiRevokedSession", new mongoose.Schema({
    jti: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, expires: 0 }
  }, { versionKey: false }), "revoked_sessions");
  return {
    initialize: () => Promise.all([users.init(), revoked.init()]),
    async upsert(profile) {
      const query = { googleSub: profile.sub };
      const update = { $set: { email: profile.email, name: profile.name || profile.email,
        picture: profile.picture || "", lastLoginAt: new Date() } };
      try { return await users.findOneAndUpdate(query, update, { upsert: true, new: true, setDefaultsOnInsert: true }); }
      catch (error) {
        if (error.code !== 11000) throw error;
        return users.findOneAndUpdate(query, update, { new: true });
      }
    },
    find: id => users.findById(id).lean(),
    isRevoked: jti => revoked.exists({ jti }),
    revoke: payload => revoked.updateOne({ jti: payload.jti },
      { $setOnInsert: { jti: payload.jti, expiresAt: new Date(payload.exp * 1000) } }, { upsert: true })
  };
}

function createMotionAiAuth({ connection, env = process.env, store, google = new OAuth2Client() } = {}) {
  const config = readConfig(env);
  if (config.enabled && !store) store = createStore(connection, config);
  let ready = false;
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use(express.json({ limit: "16kb", strict: true }));
  router.get("/config", (_req, res) => res.status(config.enabled && ready ? 200 : 503).json({
    ok: config.enabled && ready, appId: APP_ID, enabled: config.enabled && ready,
    ...(config.enabled && ready ? { googleWebClientId: config.clientId } : {})
  }));
  router.use((_req, _res, next) => next(config.enabled && ready ? undefined : fail(503, "MotionMagic login is not enabled yet.")));
  // Bounded per-process limiter. Configure an edge limiter when scaling replicas.
  const attempts = new Map();
  router.use((req, res, next) => {
    const now = Date.now(), limit = req.path === "/google/native" ? 20 : 120;
    for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
    const key = `${req.ip}:${req.path === "/google/native" ? "login" : "session"}`;
    const entry = attempts.get(key) || { count: 0, until: now + 60000 };
    if ((!attempts.has(key) && attempts.size >= 10000) || ++entry.count > limit)
      return res.set("Retry-After", "60").status(429).json({ ok: false, message: "Too many attempts. Retry shortly." });
    attempts.set(key, entry); next();
  });
  const route = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
  const publicUser = user => ({ id: String(user._id || user.id), name: user.name, email: user.email, picture: user.picture || "" });

  router.post("/google/native", route(async (req, res) => {
    const { idToken, app } = req.body || {};
    if (app !== APP_ID || typeof idToken !== "string" || !idToken.trim() || idToken.length > 10000)
      throw fail(400, "A MotionMagic app identity and Google ID token are required.");
    let profile;
    try {
      const ticket = await google.verifyIdToken({ idToken, audience: config.clientId });
      profile = ticket.getPayload();
    } catch (_) { throw fail(401, "Google identity could not be verified. Sign in again."); }
    if (!profile || typeof profile.sub !== "string" || !profile.sub || profile.sub.length > 255 ||
        profile.email_verified !== true || typeof profile.email !== "string" || !profile.email || profile.email.length > 320)
      throw fail(401, "A verified Google account is required.");
    const user = await store.upsert({ sub: profile.sub, email: profile.email,
      name: typeof profile.name === "string" ? profile.name.slice(0, 200) : profile.email,
      picture: typeof profile.picture === "string" && profile.picture.startsWith("https://") ? profile.picture.slice(0, 2048) : "" });
    if (!user) throw fail(503, "Account storage is temporarily unavailable.");
    const token = jwt.sign({ sub: String(user._id || user.id), appId: APP_ID }, config.secret, {
      algorithm: "HS256", issuer: ISSUER, audience: APP_ID, expiresIn: "30d", jwtid: crypto.randomUUID()
    });
    res.json({ ok: true, token, user: publicUser(user) });
  }));

  async function session(req) {
    const header = req.headers.authorization || "";
    if (!/^Bearer [A-Za-z0-9_.-]{20,4096}$/.test(header)) throw fail(401, "Sign in to MotionMagic.");
    let payload;
    try {
      payload = jwt.verify(header.slice(7), config.secret, { algorithms: ["HS256"], issuer: ISSUER, audience: APP_ID });
      if (payload.appId !== APP_ID || typeof payload.sub !== "string" || !/^[a-f0-9]{24}$/.test(payload.sub) ||
          typeof payload.jti !== "string" || !payload.jti || !Number.isSafeInteger(payload.exp)) throw new Error();
    } catch (_) { throw fail(401, "Invalid or expired MotionMagic session."); }
    if (await store.isRevoked(payload.jti)) throw fail(401, "Session signed out. Sign in again.");
    const user = await store.find(payload.sub);
    if (!user) throw fail(401, "Account is no longer available. Sign in again.");
    return { payload, user };
  }
  router.get("/me", route(async (req, res) => {
    const { user } = await session(req);
    res.json({ ok: true, appId: APP_ID, user: publicUser(user) });
  }));
  router.post("/logout", route(async (req, res) => {
    const { payload } = await session(req);
    await store.revoke(payload);
    res.json({ ok: true });
  }));
  router.use((error, _req, res, _next) => {
    const status = [400, 401, 413, 429, 503].includes(error.status) ? error.status : 503;
    // No provider error bodies, identity tokens, account details or secrets in logs/responses.
    const message = status === 503 ? "MotionMagic login is temporarily unavailable." :
      status === 400 ? "Invalid MotionMagic login request." : status === 413 ? "Request is too large." : error.message;
    res.status(status).json({ ok: false, message });
  });
  return { router, async initialize() {
    if (config.enabled) {
      if (connection?.name?.toLowerCase() === config.database.toLowerCase())
        throw new Error("MOTION_AI_MONGODB_DATABASE must differ from the shared auth database");
      await store.initialize(); ready = true;
    }
  } };
}

module.exports = { createMotionAiAuth, readConfig };
