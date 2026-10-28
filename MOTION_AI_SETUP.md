# MotionMagic AI login deployment

The implementation is isolated in `motion-ai-auth.js`. It uses normal Google account sign-in, not Google Play Games. Accounts and revoked sessions live in the separate `motionmagic` MongoDB database. Existing game login and billing routes are unchanged. AI generation, API credentials, subscriptions and credits are not implemented by this module.

## Deploy

Deploy repository `santhoshs0322-code/auth_server`, branch `main`, with the root Dockerfile (Node 22). The supplied URL is `https://candycraze.onrender.com`. On 28 October 2026 it returned a health response identifying `monstermerge`; check that this Render service is connected to this repository and branch. The URL alone does not confirm its configured source repository. Do not deploy the Unity CandyCraze player-service repository for these routes.

Keep existing server environment settings. Add these exact case-sensitive names:

```dotenv
MOTION_AI_AUTH_ENABLED=true
MOTION_AI_GOOGLE_CLIENT_ID=YOUR_WEB_OAUTH_CLIENT_ID.apps.googleusercontent.com
MOTION_AI_JWT_SECRET=YOUR_SEPARATE_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
MOTION_AI_MONGODB_DATABASE=motionmagic
```

Generate a fresh secret locally with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"` and put it directly into Render's environment editor. Never commit the result. Do not reuse the games' `JWT_SECRET`. Rotating this secret signs out all MotionMagic accounts.

The module shares the existing `MONGODB_URI` connection; its database user must have read/write and index permissions for `motionmagic`. No additional Mongo URI, Google client secret, payment key or AI key is required for native login. If disabled (the default), no new credentials are required and MotionMagic routes return 503. Invalid enabled configuration or failed index initialization prevents startup; set all four values before enabling.

In Google Cloud create a Web OAuth client for the server audience and an Android OAuth client for package `com.motionmagic.ai` with the signing certificate SHA-1. Register the debug certificate for testing and the Play App Signing certificate for Play releases. Use the Web client ID in `MOTION_AI_GOOGLE_CLIENT_ID`; do not put an Android client ID there. Configure the consent screen and test users as required by the OAuth project's publishing status. These OAuth clients should belong to the same Google Cloud project.

## API contract

All requests use HTTPS. Responses are JSON and `Cache-Control: no-store`.

* `GET /auth/motion-ai/config`: public `ok`, `enabled`, `appId: "motionmagic"`, `googleWebClientId`. The client ID is public configuration, never a secret. Returns 503 when disabled/not ready.
* `POST /auth/motion-ai/google/native`: JSON `{ "app": "motionmagic", "idToken": "<Google ID token>" }`. Server verifies Google's signature, audience, expiry and verified email, then returns `{ "ok": true, "token": "<session JWT>", "user": { "id", "name", "email", "picture" } }`.
* `GET /auth/motion-ai/me`: `Authorization: Bearer <session JWT>`; validates the account and session, returning `ok`, `appId` and `user`.
* `POST /auth/motion-ai/logout`: same Bearer header; revokes that session across server instances. Other device sessions remain active. Delete the local session even when offline; if the remote request fails, that token remains valid until expiry/revocation.

Session JWTs expire after 30 days, with issuer `motionmagic-ai`, audience/appId `motionmagic`, a unique `jti` and a separate signing key. Game sessions are rejected. Expired/revoked/deleted-account sessions return 401; invalid input 400; rate limits 429 with Retry-After; database/unavailable service 503. Native login permits 20 attempts per IP/minute, session routes 120; add a shared edge limiter when running multiple replicas. Review the server's existing trusted-proxy configuration for your actual hosting topology.

After deployment, check `GET https://candycraze.onrender.com/auth/motion-ai/config` returns 200 and your public Web client ID. An unauthenticated `GET /auth/motion-ai/me` must return 401. Complete real Google sign-in from the configured Android build to verify the OAuth registration and MongoDB permissions end to end. No real Google account or production database was used in the automated tests.

Local media is still device storage; this login does not upload, sync or isolate existing guest projects by account. Signing in does not grant paid entitlements.

## Validation

Use Node 22+, `npm ci`, `npm run check`, `npm run test:motion-ai`, and `npm run test:payments`. MotionMagic tests inject Google identity verification and a storage adapter; they exercise HTTP authorization, logout, wrong-app/expired tokens, failures and disabled configuration without spending API credits or changing production data.
