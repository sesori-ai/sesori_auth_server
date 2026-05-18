# Sesori Auth Server

Node.js/TypeScript authentication service. Social login (GitHub, Google) via OAuth2 PKCE, RS256 JWT issuance, token refresh/revocation. Relay verifies tokens using the public key endpoint.

## STRUCTURE

```
src/
├── types/             # Enums + shared types (mongo.ts, oauth.ts)
├── clients/
│   ├── auth/          # OAuth provider abstraction
│   │   ├── oauth-client.ts   # Abstract base — template method: exchangeCode → resolveIdentity
│   │   ├── github-client.ts  # GithubClient extends OAuthClient
│   │   └── google-client.ts  # GoogleClient extends OAuthClient (JWKS verification)
│   └── openai-client.ts      # OpenAI transcription client
├── db/
│   ├── mongo-db-connector.ts  # MongoDbConnector — connection lifecycle, health check
│   └── mongo-db-accessor.ts   # MongoDbAccessor — generic DB access + config-driven ensureIndexes
├── lib/               # Utilities (state-store.ts — LRU singleton, errors.ts — ApiError hierarchy)
├── middleware/         # createAuthMiddleware factory → requireAuth preHandler hook
├── models/            # Zod schemas — documents.ts (User, OAuthAccount), jwt.ts (payload + constants), api.ts
├── repositories/      # Data access — user-repo.ts, oauth-account-repo.ts, glossary-entry-repo.ts
├── routes/
│   └── auth/          # OAuth + pending-confirmation flow
│       ├── github.ts             # GET /auth/github, POST /auth/github/init, POST/GET callbacks
│       ├── google.ts             # mirror of github.ts for Google
│       ├── init.ts               # Shared helpers: parseSessionTokenHeader, createPendingOAuthInit, …
│       ├── provider-callback.ts  # GET interstitial + POST confirm/deny (HTML responses)
│       └── session-status.ts     # GET /auth/session/status long-poll
├── services/          # Business logic — auth-service.ts, token-service.ts, voice-service.ts
│   └── pending-auth-store.ts     # In-memory LRU of pending OAuth sessions (anti-phishing flow)
├── config.ts          # Zod-validated env config
├── index.ts           # Composition root (wires all dependencies)
└── server.ts          # Fastify app factory (buildApp receives typed AppServices)
```

## WHERE TO LOOK

| Task                       | Location                                                                 | Notes                                                                                       |
| -------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Add OAuth provider         | `src/clients/auth/` + `src/routes/auth/`                                 | Extend OAuthClient, implement exchangeCode + resolveIdentity, add route plugin in server.ts |
| OAuth pending/confirm flow | `src/routes/auth/init.ts` + `provider-callback.ts` + `session-status.ts` | Anti-phishing interstitial; pending state in `src/services/pending-auth-store.ts`           |
| Modify JWT claims          | `src/models/jwt.ts` + `src/services/token-service.ts`                    | Zod schema defines payload shape                                                            |
| Add API endpoint           | `src/routes/`                                                            | Register as Fastify plugin in `server.ts`, add to AppServices if deps needed                |
| Change DB schema           | `src/models/documents.ts` + `src/repositories/`                          | Zod document schemas, raw MongoDB driver                                                    |
| Add DB collection          | `src/types/mongo.ts` + `src/db/mongo-db-accessor.ts`                     | Add to AuthDbCollection enum + DATABASE_CONFIG                                              |
| Auth middleware            | `src/middleware/auth.ts`                                                 | `createAuthMiddleware(tokenService)` factory                                                |
| Wire dependencies          | `src/index.ts`                                                           | Composition root — all instantiation happens here                                           |

## CONVENTIONS

- **DI**: Constructor injection for stateful classes. Composition root in `index.ts`.
- **Validation**: All request/response types defined with Zod — safeParse, no .parse()
- **No ODM**: Raw MongoDB driver. Collections via `MongoDbAccessor.getCollection()`
- **Error handling**: Fastify error handler, ApiError hierarchy in `src/lib/errors.ts`
- **ESM**: `"type": "module"` in package.json
- **Config**: All env vars validated by Zod schema at startup (`src/config.ts`)
- **Secrets**: SOPS + age encryption for env files (`env/app/*.env`). NEVER commit plaintext `.env` or `*.pem`
- **Types**: Shared types in `src/types/`. DB-specific config types stay in `src/db/`.

## SCALING CONSTRAINTS

- **Pending OAuth sessions are in-process only.** `PendingAuthStore` is an in-memory LRU with a 5-minute TTL. The store is NOT shared between instances. Horizontal scaling of this service requires either sticky sessions (`X-Sesori-Session-Token` → consistent instance) OR migrating the store to Redis. Until then: **single-instance deploys only**.
- Tunable via `PENDING_AUTH_MAX_SESSIONS` (default 10k entries ≈ 10 MB) and `PENDING_AUTH_POLL_TIMEOUT_MS` (default 30s long-poll cap).

## ANTI-PATTERNS

- **No Mongoose / ODM** — raw MongoDB driver only
- **No `as any`** — TypeScript strict mode, `@typescript-eslint/no-explicit-any: warn`
- **No unvalidated input** — every request body/param goes through Zod
- **No plaintext secrets** — use `npm run env:edit` to modify encrypted env, `npm run start:local` to run with SOPS
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
npm run start:local            # Start with SOPS-decrypted local env
npm run dev                    # Start with file watching
npm test                       # Run tests (needs MongoDB)
npm run build                  # TypeScript compile to dist/
npm run lint                   # ESLint
npm run format:check           # Prettier check
npm run circular-dependencies  # Check for circular imports (madge)
npm run env:init               # First-time SOPS/age setup
npm run env:edit               # Edit encrypted env in $EDITOR
npm run env:update-keys        # Re-encrypt after adding team member
```
