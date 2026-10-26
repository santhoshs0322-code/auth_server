# Monster Merge Google Play module

The existing shared auth server is retained. Only its Monster Merge payment import switches from PayU to this module. CandyCraze, Balloon Pop and Classic Puzzle code and credentials are unchanged.

- `utils/google-play.js`: shared Publisher API verification and consumption. A factory gives each game a separate package, account namespace, credentials and access-token cache.
- `games/monstermerge/config.js`: Monster Merge package ID, coin products and dedicated environment settings.
- `games/monstermerge/play-api.js`: binds that game configuration to the shared utility.
- `games/monstermerge/play-billing.js`: authenticated routes, MongoDB receipts and atomic coin credits.

For another game, add its own `games/<game>/` module and configuration. Do not reuse Monster Merge routes, player identity namespace or receipt collection blindly. Existing games have not been migrated to this new utility.

## Render configuration

Set these only on the auth-server Render service:

```
MONSTER_PLAY_ENABLED=true
MONSTER_PLAY_SERVICE_ACCOUNT_EMAIL=<service-account-email>
MONSTER_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY=<server-only-private-key>
```

The dedicated flag defaults to disabled. Existing PayU `PAYMENTS_ENABLED` and other games' credentials do not enable this module. Keep existing Google login, MongoDB, JWT and other-game settings unchanged. Secret values are not included in this repository.

Confirm the package ID `com.yourstudio.monstermerge` matches Monster Merge in Play Console. Create consumable products `starter` (500 coins), `adventurer` (1500), `champion` (4000), `legend` (10000). Configure their prices, service-account access and license testers in Play Console.

Deploy this auth repo with the updated Dockerfile. Check `/payments/health` reports `google-play`. Monster Merge's existing client URL and `/api/billing/*` routes stay compatible. This change does not deploy or push automatically.

Reconcile outstanding PayU payments before production cutover; old checkout routes are retired. Existing live profile/account balances and historical PayU files/collections are retained. Old PayU endpoint tests are historical and do not describe the new active router. Use `npm run test:monster-play`, `npm run check` for this integration. Tests require local MongoDB (`MONGOD_BINARY` can override its path).


## Separate Monster Merge test service

For the existing `https://candycraze.onrender.com` test service, deploy this repository's `dev` branch using the root Dockerfile. The CandyCraze player-service image does not implement `/auth/monster/start`. Keep the CandyCraze production server at `http://13.206.105.80` unchanged.

Set `PUBLIC_URL=https://candycraze.onrender.com` and `MONSTER_MONGODB_DATABASE=monstermerge` on the test service, plus the required `MONGODB_URI`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `JWT_SECRET` (at least 32 characters). Register `https://candycraze.onrender.com/auth/google/callback` on the Google OAuth web client. Configure the `MONSTER_PLAY_*` settings above separately for billing.

After deploying, `/health` should identify the central auth service's apps and `/payments/health` should identify Google Play billing. The Unity project already points to this test host. Pushing this branch alone does not change which repository the Render service deploys.
