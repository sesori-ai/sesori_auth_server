# Installation Script Cache Endpoints

## TL;DR

> **Summary**: Add two public plain-text endpoints, `/install.sh` and `/install.ps1`, backed by a new in-memory `InstallScriptService` that resolves the latest published `bridge-v*` GitHub release from `sesori-ai/sesori_apps_monorepo`, fetches the tagged script contents once, and rechecks release freshness every 5 minutes.
> **Deliverables**:
>
> - Public `GET /install.sh` and `GET /install.ps1` endpoints
> - In-memory atomic cache for both scripts keyed by one selected release tag
> - GitHub release discovery + contents fetch logic using unauthenticated REST calls
> - Automated tests for cache hit, refresh, failure, and plain-text response behavior
>   **Effort**: Medium
>   **Parallel**: YES - 2 waves
>   **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6

## Context

### Original Request

Add paths that return the contents of `install.sh` and `install.ps1` directly from memory, sourcing them from the latest published GitHub release tagged `bridge-v*` in `sesori-ai/sesori_apps_monorepo`, with a 5-minute in-memory cache and refresh/recheck logic. Do not redirect and do not read from `main`.

### Interview Summary

- Endpoints must be exactly `/install.sh` and `/install.ps1`.
- Source repo is public; do not add GitHub authentication support.
- Release selection must use published `bridge-v*` releases only; exclude drafts and prereleases.
- Cache TTL is fixed at 5 minutes.
- If the release tag changes after a recheck, fetch new scripts and serve the new cached content.
- If the release tag does not change, keep serving the existing cached content and wait another 5 minutes before the next recheck.
- Test strategy is tests-after using the repo’s existing Node test runner and Fastify injection patterns.

### Metis Review (gaps addressed)

- Locked “latest” to the matching release with the greatest valid `published_at` timestamp; do not trust API order.
- Chose an atomic cache entry containing both scripts and the selected release tag so `.sh` and `.ps1` never diverge.
- Chose single-flight refresh deduplication so only one GitHub refresh runs per process when TTL expires.
- Chose warm-cache stale-on-error behavior: if refresh fails after a successful prior cache fill, serve the stale cached scripts and schedule the next recheck for 5 minutes later.
- Chose cold-cache fail-closed behavior: if no cache exists and GitHub lookup or content fetch fails, return `502 bad_gateway`.
- Chose no fallback to older releases when the latest matching release is missing either script; treat that as upstream failure.

## Work Objectives

### Core Objective

Serve stable installer scripts directly from this auth server without redirects by caching tagged GitHub release contents in memory and refreshing only on a 5-minute cadence.

### Deliverables

- New `InstallScriptService` in `src/services/install-script-service.ts`
- New route plugin in `src/routes/install.ts`
- DI wiring updates in `src/server.ts`, `src/index.ts`, and `tests/helpers/setup.ts`
- Automated tests in `tests/install/`

### Definition of Done (verifiable conditions with commands)

- `npm test` passes with new install-script route/service coverage.
- `npm run build` passes.
- `npm run lint` passes.
- `npm run format:check` passes.
- Automated tests prove:
  - `/install.sh` and `/install.ps1` return `200` + `text/plain` without auth
  - GitHub release lookup ignores non-`bridge-v*`, draft, and prerelease releases
  - cache hits within 5 minutes do not trigger extra upstream requests
  - TTL expiry rechecks releases, refreshes on new tag, and preserves stale cache on warm-cache upstream failures
  - no request path ever fetches scripts from `main`

### Must Have

- Public unauthenticated endpoints exactly at `/install.sh` and `/install.ps1`
- GitHub release discovery via REST releases API for `sesori-ai/sesori_apps_monorepo`
- Contents fetches pinned to the selected tag via `ref={tag}`
- One atomic cache entry holding `{ tag, installSh, installPs1, expiresAt }`
- Single-flight refresh promise shared across concurrent requests
- `text/plain` success responses
- `502 bad_gateway` on cold-cache upstream failure or missing tagged script content

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)

- No redirects
- No `main`/default-branch fallback
- No disk, Redis, or database persistence
- No GitHub auth/token config
- No release-assets path unless the requirement changes later
- No per-endpoint independent caches that can drift across tags
- No background timer loop; refresh only on request after TTL expiry

## Verification Strategy

> ZERO HUMAN INTERVENTION - all verification is agent-executed.

- Test decision: tests-after + Node native test runner (`node --import tsx --test --test-concurrency=1 'tests/**/*.test.ts'`)
- QA policy: Every task includes executable unit/integration scenarios using `node:test`, `mock.method(...)`, and `app.inject(...)`
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy

### Parallel Execution Waves

> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: service contract + cache behavior + upstream retrieval rules
Wave 2: route exposure + DI wiring + regression coverage

### Dependency Matrix (full, all tasks)

- Task 1 blocks Tasks 2, 4, 5, 6
- Task 2 blocks Tasks 4, 5, 6
- Task 3 blocks Tasks 4, 5, 6
- Task 4 blocks Tasks 5 and 6
- Task 5 blocks Task 6 by enabling full-app integration wiring
- Task 6 depends on Tasks 1-5

### Agent Dispatch Summary (wave → task count → categories)

- Wave 1 → 3 tasks → unspecified-low
- Wave 2 → 3 tasks → quick + unspecified-low

## TODOs

> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Create `InstallScriptService` contract and release-selection rules

  **What to do**: Add `src/services/install-script-service.ts` with a service class that owns all feature constants: repo owner `sesori-ai`, repo name `sesori_apps_monorepo`, script paths `install.sh` and `install.ps1`, and cache TTL `5 * 60 * 1000`. Inside the service, add private helpers to parse GitHub release payloads, keep only releases where `tag_name.startsWith("bridge-v")`, `draft === false`, `prerelease === false`, and `published_at` is a valid date, then deterministically select the newest match by greatest `published_at` timestamp with descending `tag_name` as the tie-breaker. Add `tests/install/install-script-service.test.ts` coverage for filtering, deterministic sorting, and the no-match path that throws `BadGatewayError`.
  **Must NOT do**: Do not add env/config entries in `src/config.ts`. Do not use `/releases/latest`. Do not consider prereleases, draft releases, release assets, or `main` branch fallbacks.

  **Recommended Agent Profile**:
  - Category: `unspecified-low` - Reason: new service logic with concrete rules but limited blast radius.
  - Skills: `[]` - No specialized skill is needed; repo-local service/test patterns are sufficient.
  - Omitted: [`/playwright`] - No browser surface exists for this API-only work.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [2, 3, 4, 5, 6] | Blocked By: []

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/lib/state-store.ts:4-11` - Follow the repo’s existing TTL cache primitive style (`LRUCache` with constant TTL values).
  - Pattern: `src/clients/auth/github-client.ts:15-29` - Follow native `fetch(...)` + validation/error handling style for GitHub HTTP work.
  - Pattern: `src/clients/auth/github-client.ts:40-59` - Throw `BadGatewayError` when upstream responses are invalid or non-OK.
  - Pattern: `src/lib/errors.ts:47-50` - Reuse `BadGatewayError` for release lookup failures and missing matching releases.
  - Pattern: `src/config.ts:3-43` - Existing env schema is explicit; this feature should stay out of config unless requirements change.
  - Test: `tests/voice/transcribe.test.ts:45-47` - Use `mock.restoreAll()` in `afterEach` when stubbing globals.
  - Test: `tests/voice/transcribe.test.ts:121-149` - Use `mock.method(...)` style stubs for external calls.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `node --import tsx --test --test-concurrency=1 tests/install/install-script-service.test.ts` passes with cases proving published-only `bridge-v*` filtering, `published_at` ordering, deterministic tie-breaking, and `BadGatewayError` when no eligible release exists.
  - [ ] The service file contains hardcoded constants for repo owner/name, script paths, and the 5-minute TTL; `src/config.ts` remains unchanged.

  **QA Scenarios** (MANDATORY - task incomplete without these):

  ```
  Scenario: Release filtering picks the newest published bridge release
    Tool: Bash
    Steps: Run `node --import tsx --test --test-concurrency=1 tests/install/install-script-service.test.ts`
    Expected: Tests covering mixed draft/prerelease/non-bridge releases pass; selected tag is the eligible release with the greatest `published_at`.
    Evidence: .sisyphus/evidence/task-1-release-selection.txt

  Scenario: No eligible release returns upstream failure
    Tool: Bash
    Steps: Run the same test file with the no-match case included.
    Expected: The no-match case asserts a thrown `BadGatewayError` and the command exits 0 because the expected failure is handled by the test.
    Evidence: .sisyphus/evidence/task-1-no-match.txt
  ```

  **Commit**: NO | Message: `feat(install): add release selection service` | Files: [`src/services/install-script-service.ts`, `tests/install/install-script-service.test.ts`]

- [x] 2. Implement atomic cache state, expiry handling, and single-flight refresh orchestration

  **What to do**: Extend `InstallScriptService` to store exactly one cache entry containing `{ tag, installSh, installPs1, expiresAt }` plus a single `refreshPromise`. Add a public method pair such as `getInstallSh()` / `getInstallPs1()` that both funnel through one shared refresh path. Use lazy refresh only: if `Date.now() < expiresAt`, return cached bodies immediately; if TTL expired, let the first request create `refreshPromise` and await it while all concurrent requests await the same promise. Distinguish cold-cache and warm-cache failure behavior: cold-cache failures throw `BadGatewayError`; warm-cache failures keep the previous cached entry intact, push `expiresAt` forward by 5 minutes, and return stale content.
  **Must NOT do**: Do not create per-endpoint caches. Do not start background timers or cron-like refresh loops. Do not clear a good cache entry when a warm refresh fails.

  **Recommended Agent Profile**:
  - Category: `unspecified-low` - Reason: stateful logic with concurrency semantics and explicit failure policy.
  - Skills: `[]` - No specialized skill is needed; this is contained TypeScript/service work.
  - Omitted: [`/playwright`] - Browser automation is irrelevant.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [4, 5, 6] | Blocked By: [1]

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/lib/state-store.ts:7-31` - Keep cache ownership inside a small class with private state.
  - Pattern: `src/services/bridge-state-tracker.ts:13-21` - Follow private-field constructor/state style.
  - Pattern: `src/services/bridge-state-tracker.ts:23-60` - Follow the repo’s guarded state-transition style to avoid duplicate work during concurrent events.
  - Pattern: `src/lib/errors.ts:34-50` - Use `InternalServerError` only for impossible internal state problems; use `BadGatewayError` for upstream failures.
  - Test: `tests/voice/transcribe.test.ts:1-2` - Use Node native test imports and strict assertions.
  - Test: `tests/voice/transcribe.test.ts:45-47` - Restore mocks after each scenario.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `node --import tsx --test --test-concurrency=1 tests/install/install-script-service.test.ts` passes with cases proving cache hits avoid refresh, concurrent expired-cache requests share one refresh, cold-cache failures throw `BadGatewayError`, and warm-cache failures return stale content while extending the next recheck deadline.
  - [ ] Service state stores one release tag and both script bodies together; no per-script TTL fields or refresh paths exist.

  **QA Scenarios** (MANDATORY - task incomplete without these):

  ```
  Scenario: Concurrent requests share one refresh after TTL expiry
    Tool: Bash
    Steps: Run `node --import tsx --test --test-concurrency=1 tests/install/install-script-service.test.ts`
    Expected: A concurrency-focused test asserts exactly one mocked releases fetch and exactly one pair of content fetches while multiple service calls await the same refresh.
    Evidence: .sisyphus/evidence/task-2-singleflight.txt

  Scenario: Warm-cache refresh failure serves stale content
    Tool: Bash
    Steps: Run the same service test file with the warm-cache failure case included.
    Expected: The test proves the returned script body matches the previously cached version and that the refresh failure does not clear the cache.
    Evidence: .sisyphus/evidence/task-2-stale-on-error.txt
  ```

  **Commit**: NO | Message: `feat(install): add single-flight cache behavior` | Files: [`src/services/install-script-service.ts`, `tests/install/install-script-service.test.ts`]

- [x] 3. Implement GitHub release pagination and contents-at-tag retrieval

  **What to do**: Finish `InstallScriptService` with sequential unauthenticated GitHub REST calls. For release discovery, fetch `https://api.github.com/repos/sesori-ai/sesori_apps_monorepo/releases?per_page=100&page={n}` until there is no next page, aggregate all releases, and select the newest eligible `bridge-v*` release by the rules from Task 1. For script bodies, fetch `https://api.github.com/repos/sesori-ai/sesori_apps_monorepo/contents/install.sh?ref={tag}` and `https://api.github.com/repos/sesori-ai/sesori_apps_monorepo/contents/install.ps1?ref={tag}` using `Accept: application/vnd.github.raw+json`, then cache both bodies atomically. On TTL expiry, recheck releases first; if the selected tag is unchanged, skip body refetches and only extend `expiresAt`; if the selected tag changed, refetch both bodies before replacing the cache. Add service tests covering pagination, same-tag optimization, changed-tag atomic replacement, missing script failure, and explicit assertions that all script fetches use `ref={tag}` and never `main`.
  **Must NOT do**: Do not use `download_url`, tarballs, zipballs, or release assets. Do not fetch script bodies when the rechecked tag is unchanged. Do not fall back to older matching releases when the selected latest release is incomplete.

  **Recommended Agent Profile**:
  - Category: `unspecified-low` - Reason: external-API integration logic with multiple edge cases but still isolated to one service/test file.
  - Skills: `[]` - No additional skill is required.
  - Omitted: [`/playwright`] - No browser verification is needed.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [4, 5, 6] | Blocked By: [1, 2]

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/clients/auth/github-client.ts:41-47` - Check `response.ok` and convert upstream failures into `BadGatewayError`.
  - Pattern: `src/clients/auth/github-client.ts:49-58` - Validate upstream payload shape before using it.
  - Pattern: `src/lib/errors.ts:47-50` - Use `BadGatewayError` for missing script or invalid release/content responses.
  - External: `https://docs.github.com/en/rest/releases/releases?apiVersion=2026-03-10` - Releases API; do not use `/releases/latest` for prefix matching.
  - External: `https://docs.github.com/en/rest/repos/contents?apiVersion=2026-03-10` - Contents API with `ref={tag}` and raw media type.
  - Test: `tests/voice/transcribe.test.ts:121-149` - Use method stubs to capture outbound call arguments and assert exact upstream URLs.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `node --import tsx --test --test-concurrency=1 tests/install/install-script-service.test.ts` passes with cases proving multi-page release traversal, unchanged-tag no-refetch behavior, changed-tag atomic refresh of both scripts, missing-file `BadGatewayError`, and exact URL assertions containing `ref=bridge-v...`.
  - [ ] No implementation string or tested outbound URL includes `/main`, `download_url`, `/tarball/`, `/zipball/`, or `/releases/latest`.

  **QA Scenarios** (MANDATORY - task incomplete without these):

  ```
  Scenario: TTL expiry with unchanged tag skips body refetch
    Tool: Bash
    Steps: Run `node --import tsx --test --test-concurrency=1 tests/install/install-script-service.test.ts`
    Expected: The unchanged-tag case asserts a releases recheck occurs, but no new `contents/install.sh` or `contents/install.ps1` fetches happen.
    Evidence: .sisyphus/evidence/task-3-same-tag.txt

  Scenario: Latest release missing one script fails closed
    Tool: Bash
    Steps: Run the same service test file with the incomplete-release case included.
    Expected: The test asserts a `BadGatewayError` on cold cache and confirms there is no fallback to an older release.
    Evidence: .sisyphus/evidence/task-3-missing-script.txt
  ```

  **Commit**: NO | Message: `feat(install): fetch installer scripts from release tags` | Files: [`src/services/install-script-service.ts`, `tests/install/install-script-service.test.ts`]

- [x] 4. Wire `InstallScriptService` through app boot and test harness

  **What to do**: Add `installScriptService` to `AppServices` in `src/server.ts`, instantiate it once in `src/index.ts`, and pass it into `buildApp(...)`. Mirror the same wiring in `tests/helpers/setup.ts` by extending `TestAppOverrides` with `installScriptService?: InstallScriptService`, defaulting to a real service instance when no override is provided, and ensuring cleanup still closes the app cleanly with no extra disposal requirements. Add `tests/install/wiring.test.ts` coverage so `createTestApp()` boots successfully with a supplied service stub and with the default real service instance.
  **Must NOT do**: Do not instantiate the service inside the route plugin. Do not add singleton imports directly into routes. Do not change unrelated service construction order or DB setup.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: constrained DI and test-harness plumbing across a few files.
  - Skills: `[]` - Existing composition-root patterns are enough.
  - Omitted: [`/playwright`] - Wiring change only; no browser work.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [5, 6] | Blocked By: [1, 2, 3]

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/server.ts:26-38` - Extend `AppServices` with the new injected service.
  - Pattern: `src/server.ts:40-109` - Register route plugins by passing explicit dependencies from `buildApp(...)`.
  - Pattern: `src/index.ts:23-109` - Instantiate services in the composition root and pass them into `buildApp(...)`.
  - Pattern: `tests/helpers/setup.ts:51-57` - Extend override types here.
  - Pattern: `tests/helpers/setup.ts:61-139` - Mirror production DI wiring when constructing the test app.
  - Pattern: `tests/helpers/setup.ts:218-225` - Keep cleanup behavior centralized in the test harness.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `node --import tsx --test --test-concurrency=1 tests/install/wiring.test.ts` passes with boot-focused tests proving `createTestApp({ installScriptService: stub })` starts successfully and the default real service instance also boots.
  - [ ] `npm run build` passes after adding the new service to `AppServices`, `buildApp(...)`, `src/index.ts`, and `tests/helpers/setup.ts`.

  **QA Scenarios** (MANDATORY - task incomplete without these):

  ```
  Scenario: Test harness boots with injected install script service stub
    Tool: Bash
    Steps: Run `node --import tsx --test --test-concurrency=1 tests/install/wiring.test.ts`
    Expected: A boot-focused test passes using `createTestApp({ installScriptService: stub })` and the process exits 0.
    Evidence: .sisyphus/evidence/task-4-test-harness.txt

  Scenario: Type-safe DI wiring compiles cleanly
    Tool: Bash
    Steps: Run `npm run build`
    Expected: TypeScript compilation succeeds with no missing `installScriptService` property errors.
    Evidence: .sisyphus/evidence/task-4-build.txt
  ```

  **Commit**: NO | Message: `refactor(install): wire install script service into app` | Files: [`src/server.ts`, `src/index.ts`, `tests/helpers/setup.ts`, `tests/install/wiring.test.ts`]

- [x] 5. Add public install routes with plain-text responses

  **What to do**: Create `src/routes/install.ts` exporting `installRoutes: FastifyPluginAsync<InstallRouteOptions>`. Register `GET /install.sh` and `GET /install.ps1` as public routes with no auth pre-handler. Each handler should call the injected service method, then respond with `reply.type("text/plain").send(scriptBody)`. Do not add request schemas because these are fixed-path GET routes with no input. Add `tests/install/routes.test.ts` happy-path coverage that verifies both endpoints return `200`, `content-type` includes `text/plain`, bodies match the stubbed service output exactly, and no `Authorization` header is required.
  **Must NOT do**: Do not place these routes under `/auth`. Do not return JSON wrappers. Do not swallow `BadGatewayError`; let the global error handler preserve the repo’s existing JSON error response contract on failures.

  **Recommended Agent Profile**:
  - Category: `unspecified-low` - Reason: new route plugin plus route-level integration tests.
  - Skills: `[]` - No specialized skill is required.
  - Omitted: [`/playwright`] - API responses are covered by `app.inject(...)`.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [6] | Blocked By: [1, 2, 3, 4]

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/routes/token.ts:12-18` - Follow the standard typed route-options export pattern.
  - Pattern: `src/routes/token.ts:49-52` - Use `reply.type("text/plain").send(...)` exactly like the existing public-key route.
  - Pattern: `src/server.ts:76-107` - Register the new route plugin alongside existing public/private route plugins.
  - Pattern: `tests/auth/token.test.ts:16-29` - Mirror the exact content-type assertion style for plain-text routes.
  - Pattern: `tests/helpers/setup.ts:126-139` - Route tests should use the real `buildApp(...)` path through the shared harness.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `node --import tsx --test --test-concurrency=1 tests/install/routes.test.ts` passes with happy-path tests for `/install.sh` and `/install.ps1`, including `200`, exact payload assertions, and `text/plain` content-type checks.
  - [ ] Route handlers are public and have no `preHandler: requireAuth` usage.

  **QA Scenarios** (MANDATORY - task incomplete without these):

  ```
  Scenario: `/install.sh` returns plain text without auth
    Tool: Bash
    Steps: Run `node --import tsx --test --test-concurrency=1 tests/install/routes.test.ts`
    Expected: A route test sends `GET /install.sh` without auth headers and asserts `200`, `text/plain`, and exact body equality.
    Evidence: .sisyphus/evidence/task-5-install-sh.txt

  Scenario: `/install.ps1` returns plain text without auth
    Tool: Bash
    Steps: Run the same route test file.
    Expected: A route test sends `GET /install.ps1` without auth headers and asserts `200`, `text/plain`, and exact body equality.
    Evidence: .sisyphus/evidence/task-5-install-ps1.txt
  ```

  **Commit**: NO | Message: `feat(install): expose cached install endpoints` | Files: [`src/routes/install.ts`, `src/server.ts`, `tests/install/routes.test.ts`]

- [x] 6. Add end-to-end regression coverage for refresh, stale-cache, and no-main guarantees

  **What to do**: Finish `tests/install/routes.test.ts` and `tests/install/install-script-service.test.ts` with regression scenarios that prove the full feature behavior. Cover: ignoring newer non-`bridge-v*` releases, ignoring draft/prerelease releases, serving cached content without extra fetches inside TTL, performing exactly one releases recheck on TTL expiry, refreshing both endpoint bodies together when the selected tag changes, preserving stale content on warm-cache refresh failure, returning `502` JSON on cold-cache failure, and asserting captured upstream URLs never request `main`. Ensure at least one route-level regression exercises both `/install.sh` and `/install.ps1` after a tag change so mixed-release responses are impossible.
  **Must NOT do**: Do not rely on manual curl-only verification. Do not leave refresh behavior untested. Do not allow one endpoint to update independently of the other in tests or implementation.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: focused regression test expansion once implementation is in place.
  - Skills: `[]` - Existing Node test patterns are sufficient.
  - Omitted: [`/playwright`] - API-only verification should stay in `node:test`.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [] | Blocked By: [1, 2, 3, 4, 5]

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `tests/auth/token.test.ts:16-29` - Keep plain-text assertions direct and explicit.
  - Pattern: `tests/helpers/setup.ts:61-139` - Use the shared app factory for full-route tests.
  - Pattern: `tests/voice/transcribe.test.ts:121-149` - Capture and assert mocked outbound-call arguments.
  - Pattern: `src/lib/errors.ts:47-50` - Cold-cache upstream failure should surface as `bad_gateway` / 502.
  - Pattern: `src/server.ts:57-67` - Error responses remain JSON through the global error handler even for text routes.
  - Pattern: `src/routes/token.ts:49-52` - Success remains plain text while errors stay under global JSON handling.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `node --import tsx --test --test-concurrency=1 tests/install/install-script-service.test.ts` passes with regression cases for stale-on-error, no-main URL assertions, and atomic tag refresh.
  - [ ] `node --import tsx --test --test-concurrency=1 tests/install/routes.test.ts` passes with route-level regression coverage proving both endpoints move together to the new tag and cold-cache failures return `{ error: "bad_gateway" }` with status `502`.
  - [ ] `npm test && npm run lint && npm run format:check && npm run build` all pass.

  **QA Scenarios** (MANDATORY - task incomplete without these):

  ```
  Scenario: New tag refresh updates both endpoints atomically
    Tool: Bash
    Steps: Run `node --import tsx --test --test-concurrency=1 tests/install/routes.test.ts`
    Expected: A regression test primes the cache with one tag, advances/fakes TTL expiry, refreshes to a newer tag, then asserts `/install.sh` and `/install.ps1` both serve the new-tag bodies in the same test flow.
    Evidence: .sisyphus/evidence/task-6-atomic-refresh.txt

  Scenario: Cold-cache upstream failure returns 502 JSON and never falls back to main
    Tool: Bash
    Steps: Run `node --import tsx --test --test-concurrency=1 tests/install/install-script-service.test.ts && node --import tsx --test --test-concurrency=1 tests/install/routes.test.ts`
    Expected: Service tests assert all captured URLs are tag-pinned and contain no `/main`; route tests assert the cold-cache failure response is status `502` with body `{ error: "bad_gateway" }`.
    Evidence: .sisyphus/evidence/task-6-failures.txt
  ```

  **Commit**: YES | Message: `feat(install): cache release installer scripts` | Files: [`src/services/install-script-service.ts`, `src/routes/install.ts`, `src/server.ts`, `src/index.ts`, `tests/helpers/setup.ts`, `tests/install/install-script-service.test.ts`, `tests/install/routes.test.ts`]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.

- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

  **Executable Verification Scenarios**:

  ```
  Scenario: F1 Plan Compliance Audit
    Tool: task
    Steps: Run `task(subagent_type="oracle", load_skills=[], run_in_background=false, prompt="Audit the completed implementation against .sisyphus/plans/installation-script-cache.md. Verify every Must Have/Must NOT Have item, the 5-minute cache behavior, published-only bridge-v selection, single-flight refresh, stale-on-error policy, and the exact route paths /install.sh and /install.ps1. Return APPROVE or REJECT with cited file paths.")`
    Expected: Oracle returns APPROVE or a precise REJECT list with file-backed findings.
    Evidence: .sisyphus/evidence/f1-plan-compliance.txt

  Scenario: F2 Code Quality Review
    Tool: task
    Steps: Run `task(category="unspecified-high", load_skills=[], run_in_background=false, prompt="Review the completed install-script caching changes for code quality, maintainability, TypeScript correctness, and test quality. Focus on src/services/install-script-service.ts, src/routes/install.ts, wiring files, and tests/install/*. Return APPROVE or REJECT with actionable findings and cited files.")`
    Expected: Reviewer returns APPROVE or a concrete REJECT report covering implementation and tests.
    Evidence: .sisyphus/evidence/f2-code-quality.txt

  Scenario: F3 Real Manual QA
    Tool: task
    Steps: Run `task(category="unspecified-high", load_skills=[], run_in_background=false, prompt="Execute hands-on QA for the completed install-script endpoints. Run the relevant automated commands from the plan, then verify /install.sh and /install.ps1 behavior through the test harness or local app execution, including happy path, TTL refresh, same-tag reuse, new-tag refresh, warm-cache stale-on-error, and cold-cache 502 behavior. Return APPROVE or REJECT with evidence.")`
    Expected: Reviewer confirms the feature behaves correctly end-to-end or returns a REJECT report with failing scenario names.
    Evidence: .sisyphus/evidence/f3-manual-qa.txt

  Scenario: F4 Scope Fidelity Check
    Tool: task
    Steps: Run `task(category="deep", load_skills=[], run_in_background=false, prompt="Check that the completed work stayed within scope for .sisyphus/plans/installation-script-cache.md. Confirm there is no redirect behavior, no main-branch fallback, no GitHub auth/config addition, no disk/Redis persistence, no release-assets support, and no per-endpoint split cache. Return APPROVE or REJECT with cited files.")`
    Expected: Reviewer returns APPROVE only if the implementation matches scope exactly; otherwise REJECT with file-backed scope drift findings.
    Evidence: .sisyphus/evidence/f4-scope-fidelity.txt
  ```

## Commit Strategy

- Create one feature commit after implementation and tests are green.
- Recommended message: `feat(install): cache release installer scripts`
- Do not commit secrets, generated evidence, or encrypted-env changes unrelated to this feature.

## Success Criteria

- The service always serves script bodies from the latest published `bridge-v*` release that successfully passed a release recheck.
- Repeated requests inside the TTL reuse memory only.
- TTL expiry causes exactly one release recheck across concurrent requests.
- A new release updates both endpoint bodies together.
- Warm-cache refresh failures do not break existing installs.
- Cold-cache upstream failures surface clearly as `502 bad_gateway`.
