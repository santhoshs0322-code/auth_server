# Monster Merge PayU on the existing Render auth service

Target: **https://auth-server-2bis.onrender.com**

This service now includes Monster Merge coin-payment endpoints alongside the existing Balloon Pop and Candy Craze Google-auth routes. Google authentication is unchanged. PayU records use separate MongoDB collections, so no Render disk or extra Python service is required.

## Deploy

1. Deploy the updated auth-server repository to the **existing** Render service. Keep its existing Docker runtime, MongoDB URI, Google credentials, JWT secret and PUBLIC_URL. The Dockerfile now copies `payu.js` into the image. Do not create a second Blueprint just to update this service.
2. In Render **Environment**, set the following. Enter the PayU credentials only in Render, not Unity or Git. Rotate the test salt previously shared in chat before entering its replacement.

| Variable | Value |
| --- | --- |
| `PUBLIC_URL` | `https://auth-server-2bis.onrender.com` (existing auth setting) |
| `PAYMENTS_ENABLED` | `true` |
| `PAYMENT_MODE` | `test` |
| `ALLOW_LIVE_PAYMENTS` | `false` |
| `PAYU_KEY` | Your PayU test merchant key |
| `PAYU_SALT` | Your matching rotated test salt |

`PAYU_PUBLIC_URL` is optional and defaults to `PUBLIC_URL`. It must be an HTTPS origin without a path. Leave `MONGODB_URI`, Google OAuth settings and JWT secret intact. The service uses the existing Atlas replica set and MongoDB transactions; standalone MongoDB is not sufficient for payment credits.

3. Save/redeploy. These public GET endpoints should respond:

- `/health`: the existing auth health response and app list.
- `/payments/health`: `ok: true`, `provider: payu`, `testMode: true`, `paymentsEnabled: true`.
- `/api/catalog`: `provider: payu`, `testMode: true`, `enabled: true`, and the four coin packs.

4. Configure a PayU payment webhook to:

```text
https://auth-server-2bis.onrender.com/api/webhooks/payu
```

Use PayU's form-encoded payment response with the reverse hash. Success and failure return URLs are generated automatically as:

```text
https://auth-server-2bis.onrender.com/api/payu/return
```

5. Install the updated Monster Merge APK. Its payment configuration points to this Render origin with `provider: payu`, `mode: test`, and `enabled: true`. The app refuses checkout until the backend returns an enabled PayU test catalog. Enabling the client does not enable real payments.
6. In Shop, choose a coin pack, confirm the amount, enter contact details in the browser and complete a genuine PayU **test** transaction. Return to the game and refresh. Confirm coins arrive exactly once, including after restart and repeated webhook delivery. Test cancelled/failed payments and offline return.

Until server environment variables are configured, the auth service continues running with payment checkout disabled. There is no fake-payment HTTP endpoint. Automated tests do not contact PayU or your hosted database.

## Storage and security

- Test records live in `monster_payu_test_accounts`, `monster_payu_test_orders`, and `monster_payu_test_credits`. Live mode uses separate `monster_payu_live_*` collections.
- The unique credit record, account balance increment and paid-order update commit in one MongoDB transaction. Duplicate callbacks and polling cannot award a pack twice.
- The server checks the PayU response SHA-512 hash, then independently calls `verify_payment`. Only a matching successful, captured transaction can credit coins.
- Prices, amounts and owner metadata come from the server. The client cannot set them.
- Customer contact details are stored per order to keep retries consistent. Restrict Atlas and backup access and set an appropriate retention policy. Do not log request bodies, bearer tokens, salts or checkout URLs.
- Payment accounts are installation-bound guest accounts. They are **not** Google-auth accounts. Cross-device recovery and uninstall restore are not implemented. Offline coin spending remains a local save. Arrange recovery/refund support before live sales.
- Existing paid Razorpay accounts need an explicit migration; do not overwrite old ledgers or clear paid-save data. The Python backend is a separate alternative, not a second service to run against this Mongo ledger.
- This integration targets direct APK distribution. A Play Store release still requires the applicable Google billing/alternative-billing program integration.

## Local verification

Use Node 22 (same as the Dockerfile) and install the existing locked dependencies with `npm ci`. Run `npm run check`.

`npm run test:payments` runs 18 integration tests against an isolated local MongoDB replica set. On this Windows machine the MongoDB binary is `C:/Program Files/MongoDB/Server/8.2/bin/mongod.exe`; elsewhere set `MONGOD_BINARY` to your local binary. Tests create and remove their own temporary database and use invented keys. They do not use the production `MONGODB_URI`.

Validated: hash protocol vectors, amount validation, order idempotency, ownership, escaped checkout, forged callbacks, captured-payment verification, concurrent credits, transaction rollback, duplicate payment IDs, delayed recovery, provider outage, connection restart, test/live isolation, HTTP routes, and existing auth-server startup.

Official references: [PayU Hosted Checkout](https://docs.payu.in/docs/prebuilt-checkout-page-integration), [hashing](https://docs.payu.in/docs/hashing-request-and-response), [verification](https://docs.payu.in/reference/verify_payment_api), [Mongoose transactions](https://mongoosejs.com/docs/transactions.html).
