# Separate game profiles

Use the same `MONGODB_URI` on both services. Configure Monster Merge with `MONSTER_MONGODB_DATABASE=monstermerge` and CandyCraze with `MONGODB_DATABASE=candycraze`.

Monster Merge keeps one `players` document per verified Google identity. It contains identity, login/save counts, revisioned progress, dragon ownership and stages, payment account links, and purchase summaries. Test progress is stored separately from live progress. Payment ledger collections remain as transaction audit records.

On first startup, the server copies existing `monstermerge_users` and Monster PayU account/order/credit collections from the original auth database into the separate database. Existing IDs are preserved; source records are retained. A migration marker prevents repeating the import after cutover. Back up the original database before deployment and stop older server instances writing during cutover. The MongoDB user needs access to both databases and transaction support for payments.

`GET/POST /auth/monster/profile` require the existing Google session. Uploads use revision checks and enforce the verified purchased-coin total. Repeated identical uploads are idempotent. The client preserves conflicting local progress in a recovery copy and restores newer cloud progress after sign-in.

Deploy `monster-profile.js` with the updated server, payment module, auth module, and Dockerfile. Check `/auth/monster/profile` without a token returns 401, then test Google sign-in and restore on two devices. The Android build requires this server deployment before cloud sign-in can complete.
