# Sesori Auth Server

Node.js/TypeScript authentication service. Social login (GitHub, Google) via OAuth2 PKCE, RS256 JWT issuance, token refresh/revocation. Relay verifies tokens using the public key endpoint.

## STRUCTURE

```
.plans/
└── activation-reminders/ # Resumable multi-PR plan + design considerations for the activation funnel
src/
├── types/             # Enums + shared types (mongo.ts, oauth.ts)
├── clients/
│   ├── auth/          # OAuth provider abstraction
│   │   ├── oauth-client.ts   # Abstract base — template method: exchangeCode → resolveIdentity
│   │   ├── github-client.ts  # GithubClient extends OAuthClient
│   │   └── google-client.ts  # GoogleClient extends OAuthClient (JWKS verification)
│   └── openai-client.ts      # OpenAI transcription client
├── api/               # Typed adapters translating external SDK values/errors into local models
├── db/
│   ├── mongo-db-connector.ts  # MongoDbConnector — connection lifecycle, health check
│   └── mongo-db-accessor.ts   # MongoDbAccessor — generic DB access + config-driven ensureIndexes
├── lib/               # Utilities (state-store.ts — LRU singleton, errors.ts — ApiError hierarchy)
├── middleware/         # createAuthMiddleware factory → requireAuth preHandler hook
├── models/            # Zod schemas — api.ts, bridge.ts (shared bridge enums/schemas), documents.ts, jwt.ts
├── repositories/      # Data access — user-repo.ts, oauth-account-repo.ts, bridge-repo.ts, activation-state-repo.ts, …
├── routes/
│   └── auth/          # OAuth + pending-confirmation flow
│       ├── github.ts             # GET /auth/github, POST /auth/github/init, POST/GET callbacks
│       ├── google.ts             # mirror of github.ts for Google
│       ├── init.ts               # Shared helpers: parseSessionTokenHeader, createPendingOAuthInit, …
│       ├── provider-callback.ts  # GET interstitial + POST confirm/deny (HTML responses)
│       └── session-status.ts     # GET /auth/session/status long-poll
├── services/          # Business logic - auth, activation, reminders, tokens, voice, etc.
│   └── pending-auth-store.ts     # In-memory LRU of pending OAuth sessions (anti-phishing flow)
├── config.ts          # Zod-validated env config
├── index.ts           # Composition root (wires all dependencies)
└── server.ts          # Fastify app factory (buildApp receives typed AppServices)
```

## WHERE TO LOOK

| Task                       | Location                                                                                                                                | Notes                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Add OAuth provider         | `src/clients/auth/` + `src/routes/auth/`                                                                                                | Extend OAuthClient, implement exchangeCode + resolveIdentity, add route plugin in server.ts |
| OAuth pending/confirm flow | `src/routes/auth/init.ts` + `provider-callback.ts` + `session-status.ts`                                                                | Anti-phishing interstitial; pending state in `src/services/pending-auth-store.ts`           |
| Modify JWT claims          | `src/models/jwt.ts` + `src/services/token-service.ts`                                                                                   | Zod schema defines payload shape                                                            |
| Add API endpoint           | `src/routes/`                                                                                                                           | Register as Fastify plugin in `server.ts`, add to AppServices if deps needed                |
| Change DB schema           | `src/models/documents.ts` + `src/repositories/`                                                                                         | Zod document schemas, raw MongoDB driver                                                    |
| Add DB collection          | `src/types/mongo.ts` + `src/db/mongo-db-accessor.ts`                                                                                    | Add to AuthDbCollection enum + DATABASE_CONFIG                                              |
| Auth middleware            | `src/middleware/auth.ts`                                                                                                                | `createAuthMiddleware(tokenService)` factory                                                |
| Manage bridges             | `src/routes/bridges.ts` + `src/services/bridge-service.ts` + `src/repositories/bridge-repo.ts` + `src/services/bridge-state-tracker.ts` | Per-bridge registry behind `/auth/me bridges[]`; see BRIDGE SUBSYSTEM below                 |
| Product analytics preference/export/deletion | `src/types/product-analytics.ts`, `src/models/{documents,api,product-analytics-export}.ts`, `src/clients/bigquery-product-analytics-*.ts`, `src/api/product-analytics-*.ts`, `src/repositories/{user-repo,product-analytics-*}.ts`, `src/services/product-analytics-*.ts`, `src/routes/product-analytics.ts`, `src/scripts/{backfill-product-analytics-preference,export-product-analytics,suppress-product-analytics-export}.ts` | Required revisioned preference, isolated auth-private export, and separately permissioned privacy-target handoff; see README rollout and IAM boundaries |
| Activation reminders       | `.plans/activation-reminders/` + `src/services/activation-reminder-service.ts` + `src/repositories/activation-state-repo.ts`            | Read `PLAN.md` and `CONSIDERATIONS.md` before continuing the staged implementation          |
| Per-device settings        | `src/routes/settings/settings.ts` + `src/services/settings-service.ts` + `src/repositories/settings-configuration-repo.ts` + `src/models/settings.ts` | Settings keyed by `{userId, deviceId}`; toggle registry + server-resolved defaults live in `models/settings.ts` |
| Push notification filtering | `src/models/notification.ts` + `src/services/notification-service.ts` | `NotificationCategory` is the wire contract; `NOTIFICATION_CATEGORY_SETTING_KEYS` maps each category to the toggle that silences it |
| Wire dependencies          | `src/index.ts`                                                                                                                          | Composition root — all instantiation happens here                                           |

## CONVENTIONS

- **DI**: Constructor injection for stateful classes. Composition root in `index.ts`.
- **Validation**: All request/response types defined with Zod — safeParse, no .parse()
- **No ODM**: Raw MongoDB driver. Collections via `MongoDbAccessor.getCollection()`
- **Error handling**: Fastify error handler, ApiError hierarchy in `src/lib/errors.ts`
- **ESM**: `"type": "module"` in package.json
- **Config**: All env vars validated by Zod schema at startup (`src/config.ts`)
- **Secrets**: SOPS + age encryption for env files (`env/app/*.env`). NEVER commit plaintext `.env` or `*.pem`
- **Types**: Shared types in `src/types/`. DB-specific config types stay in `src/db/`.
- **Enums**: Use string-valued enums for domain discriminators that are compared or switched on. Do not scatter raw string literals through string-literal unions.
- **Control flow**: Always use braces for `if`, loops, and other control-flow bodies. Separate adjacent guard blocks with a blank line.

## SCALING CONSTRAINTS

- **Pending OAuth sessions are in-process only.** `PendingAuthStore` is an in-memory LRU with a 5-minute TTL. The store is NOT shared between instances. Horizontal scaling of this service requires either sticky sessions (`X-Sesori-Session-Token` → consistent instance) OR migrating the store to Redis. Until then: **single-instance deploys only**.
- Tunable via `PENDING_AUTH_MAX_SESSIONS` (default 10k entries ≈ 10 MB) and `PENDING_AUTH_POLL_TIMEOUT_MS` (default 30s long-poll cap).
- **App-client presence waiters are in-process only.** `AppClientPresenceService` wakes long polls on the instance that commits a device-token registration. Keep auth single-instance until app-presence signaling is distributed.
- **Bridge notification debounce is in-process only.** `BridgeStateTracker` keeps per-(userId, bridgeId) debounce timers and last-notified state in a process-local Map: pending notifications are lost on restart, the map is unbounded for the process lifetime (acceptable under the 50-bridges-per-user registration cap), and multiple instances would double-notify. Same single-instance constraint as above.
- **Activation reminder polling is in-process only.** `ActivationReminderService` has a process-local interval and single-flight guard. Multiple enabled instances can send the same reminder before either writes its MongoDB marker. Keep `ACTIVATION_REMINDERS_ENABLED=false` on all but one instance unless a distributed lease or claim is added.

## ACTIVATION REMINDERS

The activation-reminder feature is intentionally split into independently deployable PRs. `.plans/activation-reminders/PLAN.md` is the authoritative implementation checkpoint and `.plans/activation-reminders/CONSIDERATIONS.md` records the product and architecture decisions. Verify live GitHub state before starting the next slice; do not infer merge status from the static plan alone.

`activationStates` stores one document per user. Milestones are real event timestamps, reminder baselines are campaign scheduling timestamps that may diverge during backfill, and sent markers independently suppress each reminder. Do not conflate these categories. `ActivationService` records milestones from device-token registration, bridge registration, and accepted metadata requests; these secondary writes are failure-isolated from the existing endpoint response. Logout/revoke does not erase lifetime activation history.

`ActivationReminderService` is disabled by default. Its delivery order is due query, immediate eligibility recheck, FCM send, then conditional sent-marker write. Genuine zero-device results are marked complete; FCM-unavailable, thrown sends, and zero-success results with retryable token failures remain eligible. Disposal stops queued candidates and waits up to 15 seconds for the current candidate through its marker write before MongoDB closes; a late FCM result cannot start stale-token cleanup or a marker after that timeout. Later backfill behavior must follow the staged acceptance criteria in the plan.

## BRIDGE SUBSYSTEM

Desktop bridge instances register via `POST /auth/bridges` (idempotent: clients resend their `bridgeId`; an owned non-revoked id updates in place, anything else mints a new `br_` id). `GET /auth/me` returns `bridges[]` (id, name, platform, addedAt, lastSeenAt — no live status; clients get live connectivity from the relay). The relay reports per-bridge connect/disconnect to `POST /internal/bridge-status`, which requires `bridgeId`; missing or malformed IDs get a 400. Unknown/revoked bridgeIds get a 404, which the relay turns into a WS close 4006 so the bridge re-registers. Bridges authenticate to the relay with the **user access token** — there is no bridge-scoped token. Bridge-scoped JWTs were prototyped and dropped (`8b600dd`): they added a second credential lifecycle (24h TTL, no re-issue path) and a synchronous relay→auth call per connect without buying real revocation, since the bridge host holds the user refresh token regardless. Re-evaluate only if bridge auth must outlive user sessions.

Push notifications debounce through `BridgeStateTracker` (120s), keyed per bridge by `(userId, bridgeId)`.

## NOTIFICATION CATEGORY FILTERING

Every push producer funnels through `NotificationService.sendToUser`, so that is the only place category filtering belongs — adding a second filter at a route or producer would double-apply it. `NotificationCategory` values are the wire contract shared with the client's own enum; changing a value breaks the bridge and the apps. `NOTIFICATION_CATEGORY_SETTING_KEYS` is typed `Record<NotificationCategory, NotificationSettingKey>` so a new category cannot compile until it is mapped to a toggle.

`deviceTokens.deviceId` is the join key to `settingsConfiguration`. It is optional while clients roll it out: a token without one **fails open** and keeps delivering, because it cannot be matched to a stored preference and silently muting it would be worse than an unwanted notification. Do not invert that default until clients reliably send `deviceId`. A token that changes owner has its `deviceId` cleared so it is never filtered against the previous account's settings.

`register-token` predates this feature and every shipped client already calls it with only `{ token, platform }`, so requiring `deviceId` outright would 400 every existing install and remove it from push entirely — a registration failure is not a degraded filter, it is no notifications at all. `AUTH_REQUIRE_DEVICE_ID_IN_TOKEN_REGISTRATION` gates that cutover: ship with it unset, ship the client that sends `deviceId`, then flip it once the install base has rolled over. Same shape as the retired `AUTH_REQUIRE_BRIDGE_ID_IN_STATUS` gate; delete it the same way once every client sends the field.

Filtering applies to activation reminders too — they send `system_update`, so a user who disables that toggle stops receiving them. When every device opts out, `sendToUser` returns `devicesNotified: 0` without calling FCM, and `ActivationReminderService` treats that as a genuine zero-device result and marks the reminder complete rather than retrying forever.

## ANTI-PATTERNS

- **No Mongoose / ODM** — raw MongoDB driver only
- **No `as any`** — TypeScript strict mode, `@typescript-eslint/no-explicit-any: warn`
- **No unvalidated input** — every request body/param goes through Zod
- **No plaintext secrets** — `env/app/prod.env` is the SOPS-encrypted production environment. Use `npm run env:edit` to modify it and `npm run start:prod` only when production-backed local execution is explicitly intended.
- **No ObjectId in services/routes** — string IDs above repository layer, repos convert at boundary
- **Never amend commits** — always create new follow-up commits. Amending erases audit trail and makes PR reviews impossible. Force-push is only acceptable for fixing sensitive data leaks.

## PASSWORD ACCOUNTS

Password login (`/auth/email`) is live but there is **no registration endpoint**. Accounts must be seeded out-of-band (e.g. admin CLI, ops tool, direct DB insert). The expected flow:

1. Create a `User` document (generates `userId`)
2. Create a `PasswordAccount` document with the same `userId`, hashed password (Argon2id), and email

See `src/repositories/password-account-repo.ts` for the schema. Do not enable the route in production until a seeding path is documented or a registration flow is implemented.

## TESTING

- **Framework**: Node.js native test runner (`node:test`), NOT Jest/Vitest
- **Assertions**: `node:assert/strict`
- **Concurrency**: Sequential (`--test-concurrency=1`)
- **Setup**: `tests/helpers/setup.ts` → `createTestApp()` returns app + cleanup + user factories
- **Database**: Test MongoDB on `localhost:27017`, DB dropped per suite via cleanup

## COMMANDS

```bash
npm install                    # Install deps
npm run start:prod             # Start locally with SOPS-decrypted production env
npm run dev                    # Start with file watching
npm test                       # Run tests (needs MongoDB)
npm run build                  # TypeScript compile to dist/
npm run lint                   # ESLint
npm run format:check           # Prettier check
npm run circular-dependencies  # Check for circular imports (madge)
npm run env:init               # First-time SOPS/age setup
npm run env:edit               # Edit encrypted production env in $EDITOR
npm run env:update-keys        # Re-encrypt after adding team member
```
