# S01-W01-P01: Project-Scope the Glossary Runtime

## Metadata

- **ID:** S01-W01-P01
- **Repository:** `sesori-ai/sesori_auth_server`
- **Worktree:** worker-created `sesori_auth_server/.worktrees/real-time-transcription-s01-w01-p01`
- **Base branch:** `master`
- **Audited base tip:** `9cc495397158722e4bf9c7ee2ed10f4b17b59e26` (2026-08-04 15:07:23 +0300)
- **Branch:** `plan/real-time-transcription/s01-w01-p01-project-scope-glossary`

## Goal and Cohesion

Complete the runtime half of the already-merged glossary index migration: make one opaque project key the repository, service, route, and transcription-context boundary. This PR is independently cohesive because it changes one persisted domain and leaves the configured transcription provider unchanged.

## Dependencies

- Plan approval and pinned S01/W01 auth baseline.
- PR #53 migration code on `master`.

## Scope

- Require `projectKey` in modern glossary list/add/remove contracts.
- Accept an optional multipart `projectKey` for async transcription and normalize omission to explicit `null`.
- Change persisted glossary documents and `DATABASE_CONFIG` to `{userId, projectKey, word}`.
- Add `GlossaryService` for CRUD, safety caps, and deterministic provider context selection.
- Make `VoiceService` consume glossary terms only for the exact project key.
- Use the existing migration helper and preserve its empty-only rollback rules.

## Non-Goals

- Client glossary UI or app project-key derivation.
- A global glossary fallback for omitted project context.
- Exact cap enforcement under concurrent mutations.
- Mutation queues, locks, leases, transactions, or new migration runners.
- Provider selection or realtime work.

## Audited Current Code and Assumptions

- `src/models/voice.ts` already validates the target opaque key shape.
- `src/models/documents.ts` has migration-only scoped schemas but the live document remains unscoped.
- `src/repositories/glossary-entry-repo.ts` and `src/db/mongo-db-accessor.ts` use `{userId, word}`.
- `src/services/voice-service.ts` owns both CRUD and user-wide prompt construction with a hardcoded 500-term cap.
- `src/routes/voice.ts` has no project input.
- Repository-visible clients do not call glossary CRUD; the last production dry-run found zero documents. A nonzero rollout rerun is a blocker, not permission to infer ownership.

## Touched Modules and Files

- `src/models/voice.ts`
- `src/models/documents.ts`
- `src/models/api.ts`
- `src/db/mongo-db-accessor.ts`
- `src/db/glossary-index-migration.ts` only if runtime cleanup metadata must be synchronized
- `src/repositories/glossary-entry-repo.ts`
- `src/services/glossary-service.ts` (new)
- `src/services/voice-service.ts`
- `src/routes/voice.ts`
- `src/index.ts`, `src/server.ts`
- `README.md` (replace the obsolete bridge-plus-project derivation with the canonical project-only formula/vector)
- `tests/helpers/setup.ts`
- `tests/models/voice.test.ts`
- `tests/scripts/project-glossary-index-migration.test.ts`
- `tests/voice/glossary.test.ts`, `tests/voice/transcribe.test.ts`
- `tests/repositories/glossary-entry-repo.test.ts` (new)
- `tests/services/glossary-service.test.ts` (new)

## Composition and Test Harness

- `src/index.ts` constructs `GlossaryEntryRepository`, then `GlossaryService({glossaryRepo, policy})`, injects it into `VoiceService`, and passes the resulting service through `AppServices` in `src/server.ts`; routes never construct repositories or services.
- The immutable injected policy is `{maxWordsPerRequest: 100, maxWordsPerProject: 500, maxWordsPerUser: 5000, maxWordCharacters: 200, maxContextCharacters: 8000}`. Services do not call `loadConfig()` for glossary policy.
- `tests/helpers/setup.ts` mirrors production composition with the per-test MongoDB accessor, adds optional `glossaryService` and `voiceService` overrides to `TestAppOverrides`, exposes `glossaryService` in `TestContext`, and relies on existing `app.close()` / database cleanup; this service owns no timer or additional cleanup.

## Data Flow and Ownership

1. Route `safeParse`s a `projectKey` and words, then passes strings to `GlossaryService`.
2. `GlossaryService` normalizes/deduplicates words, reads project and user counts, applies safety truncation, and calls the repository.
3. Repository converts `userId` to `ObjectId`, validates every consumed document with the live scoped schema, and returns word/count DTOs.
4. `VoiceService` requests a deterministic alphabetic subset for one project within an 8,000-character context budget. `null` context returns no terms.

### Exact safety policy

1. JSON/multipart schemas accept at most 100 words per mutation and each normalized JavaScript string is at most 200 UTF-16 code units after trimming ECMAScript whitespace; empty-after-trim values are rejected.
2. Normalize only with `trim()`. Preserve case and Unicode spelling; exact post-trim strings are the persisted identity. Deduplicate exact values while preserving first request occurrence.
3. For add, remove already-persisted exact values, read ordinary project and user counts, compute `remaining = max(0, min(500 - projectCount, 5000 - userCount))`, and persist that many remaining candidates in request order. Counts already at or above either cap therefore insert nothing rather than passing a negative slice. Responses contain only normalized values actually inserted. Delete applies the same trim/deduplication and returns the repository count.
4. Project/user count checks are intentionally not transactional. Concurrent requests may narrowly exceed either cap; the compound unique index still prevents exact duplicates.
5. Provider context sorts persisted exact strings by deterministic UTF-16 code-unit order (`a < b`, never locale collation) and takes the longest prefix whose `terms.join(", ")` is at most 8,000 UTF-16 code units. It never slices a term.

## Route Contracts

- Authenticated `GET /voice/glossary?projectKey=<prj_v1_...>` requires exactly one valid query key and preserves `{words}` response shape.
- Authenticated `POST /voice/glossary` and `DELETE /voice/glossary` require strict JSON `{projectKey, words}` bodies and preserve `{added}` / `{removed}` response shapes.
- Authenticated multipart `POST /voice/transcribe` accepts exactly one optional text field named `projectKey` in addition to `audio`; duplicate/unknown fields, malformed values, and oversized text are rejected with the existing bounded 400 envelope.
- Request schemas use `safeParse`; response types remain explicit in `src/models/api.ts`.

## Error, Concurrency, and Lifecycle Behavior

- Invalid project keys and request shapes return the existing bounded 400 response through `ApiError` handling.
- Duplicate inserts remain idempotent through the compound unique index.
- Project and user counts are ordinary prechecks. Concurrent requests may narrowly exceed caps; this is accepted and tested as non-exact behavior rather than hidden behind a queue.
- Malformed persisted documents fail closed without logging document contents.
- The service has no timers, process-local mutation state, or disposal lifecycle.

## Backward Compatibility

- `POST /voice/transcribe` accepts legacy omission of `projectKey`, normalizes it immediately to `null`, and applies no glossary. Place one `COMPATIBILITY` marker immediately above the optional multipart `projectKey` schema member in `src/models/voice.ts` and one immediately above the omission-to-`null` normalization in `src/routes/voice.ts`, using the implementation date and auth version from `package.json` (currently `0.1.0`).
- Affected pair: apps at or before the current 1.6.1 behavior with auth after this PR.
- Test old multipart omission and modern valid/invalid keys.
- Cleanup: after every supported app sends project context, make the field required and remove the marker/omission test.
- Glossary CRUD requiring project context is an approved breaking change backed by no repository caller and zero audited rows. Do not add a fictitious global key.

## Schema, Index, and Rollout Work

- Live `GlossaryEntry` requires `projectKey`.
- Desired unique index becomes `{userId: 1, projectKey: 1, word: 1}`.
- Do not deploy the runtime until S04 runs the existing stopped-instance dry-run/apply/verify sequence.
- Any row, invalid document, duplicate, collation mismatch, or repair-required result pauses rollout for stale-plan re-review.
- Retain existing migration compatibility markers and rollback tooling until the scoped-write rollback window is explicitly closed.

## Automated Tests

- Scoped document parsing and ObjectId isolation.
- Same word in different projects and users.
- Duplicate and normalized word handling.
- Per-request, project, and user safety truncation without claims of exact concurrency.
- Project and user counts already above their caps return no additions and never pass a negative limit to repository code.
- Deterministic 8,000-character context selection.
- Async omission means no glossary; valid project means exact-project terms only.
- Existing migration dry-run/apply/verify/rollback tests remain green.

## Manual Verification

- Inspect route logs from malformed requests and confirm no words/project values appear.
- Run migration modes against disposable data, including a deliberately nonempty legacy collection that must block.

## Regression Guide and Commands

```bash
npm ci
docker rm -f rtt-mongo 2>/dev/null || true
docker run --rm -d --name rtt-mongo -p 27018:27017 mongo:7
MONGODB_URI_TEST=mongodb://localhost:27018/auth-backend-test node --import tsx --test --test-concurrency=1 tests/models/voice.test.ts tests/scripts/project-glossary-index-migration.test.ts tests/repositories/glossary-entry-repo.test.ts tests/services/glossary-service.test.ts tests/voice/glossary.test.ts tests/voice/transcribe.test.ts
MONGODB_URI_TEST=mongodb://localhost:27018/auth-backend-test npm test
npx tsc --noEmit
npm run lint
npm run format:check
npm run build
npm run circular-dependencies
docker rm -f rtt-mongo
```

## Risks

- Same project ID on two bridges shares a project key; accepted until demonstrated harmful.
- Concurrent mutations can exceed a safety cap narrowly.
- Deploying before index migration can leave conflicting indexes; rollout ordering is mandatory.

## Acceptance Criteria

- Every live glossary document and repository query includes project scope.
- No route or service can substitute a global scope for missing context.
- Existing async clients still transcribe without glossary context.
- Migration and compatibility behavior are explicit and tested.

## Definition of Done

- Focused and full verification passes.
- No product code outside the declared domain/composition/test paths changes.
- PR documentation states the accepted cap race and production migration prerequisite.
