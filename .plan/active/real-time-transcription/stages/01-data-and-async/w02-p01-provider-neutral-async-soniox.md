# S01-W02-P01: Add Provider-Neutral Async Soniox

## Metadata

- **ID:** S01-W02-P01
- **Repository:** `sesori-ai/sesori_auth_server`
- **Worktree:** worker-created `sesori_auth_server/.worktrees/real-time-transcription-s01-w02-p01`
- **Base branch:** `master`
- **Initial audited base tip:** `9cc495397158722e4bf9c7ee2ed10f4b17b59e26` (2026-08-04 15:07:23 +0300)
- **Branch:** `plan/real-time-transcription/s01-w02-p01-provider-neutral-async-soniox`

## Goal and Cohesion

Introduce one async transcription client contract and a Soniox implementation while preserving OpenAI as the default. The PR is cohesive because it delivers a complete, disabled-by-default provider option including validation, configuration, legal disclosure, cleanup, and tests.

## Dependencies

- S01-W01-P01 merged.
- S01/W02 auth baseline pinned after drift assessment.

## Scope

- Add an `AsyncTranscriptionClient` interface with provider-neutral input/output/error semantics.
- Adapt the current OpenAI transcription method to the interface without changing metadata chat behavior.
- Add a Soniox async client using the official `@soniox/node` SDK.
- Add Zod adapter schemas for all SDK values consumed by the service.
- Add deploy-time async provider selection, explicit EU endpoints, model/time limits, and conditionally required key configuration.
- Add safe ordinary cleanup and a guarded operator residual audit/purge command.
- Update encrypted production configuration through the existing SOPS workflow and update legal documents for Soniox.
- Keep OpenAI selected by default.

## Non-Goals

- Realtime WebSocket support.
- Automatic provider fallback or per-request provider selection.
- Webhooks, a transcription-job collection, cleanup receipts, or a scheduler.
- Raw HTTP/WebSocket Soniox transport.
- Changing the public async response shape.

## Audited Current Code and Assumptions

- `OpenAIClient` owns transcription and metadata completion; only transcription needs the new interface.
- `VoiceService` directly depends on `OpenAIClient`.
- Current app timeout is 30 seconds; production must not switch providers until the app PR extends that budget.
- Soniox async stores files/transcriptions and has 1,000-file/2,000-transcription default storage caps.
- SDK convenience cleanup suppresses cleanup errors internally, conflicting with repository logging policy. Use SDK primitives (`files.upload`, `stt.create`, `wait`, `getTranscript`, delete methods) so Sesori can log a safe cleanup outcome.

## Touched Modules and Files

- `package.json`, `package-lock.json`
- `src/types/transcription.ts` (new provider-neutral domain types)
- `src/clients/async-transcription-client.ts` (new)
- `src/clients/openai-client.ts`
- `src/clients/soniox-transcription-client.ts` (new)
- `src/api/soniox-transcription-api.ts` (new mandatory Zod translation boundary)
- `src/lib/errors.ts`
- `src/services/voice-service.ts`
- `src/routes/voice.ts`
- `src/server.ts`
- `src/config.ts`
- `src/index.ts`
- `src/scripts/purge-soniox-transcription.ts` (new)
- `package.json` script `purge-soniox-transcription`
- `assets/legal/privacy.md`, `assets/legal/terms.md`
- `env/app/*.env` only through SOPS; no decrypted values
- `tests/config.test.ts`
- `tests/lib/errors.test.ts`
- `tests/helpers/setup.ts`
- `tests/api/soniox-transcription-api.test.ts` (new)
- `tests/clients/async-transcription-clients.test.ts` (new)
- `tests/services/voice-service.test.ts` (new)
- `tests/scripts/purge-soniox-transcription.test.ts` (new)
- `tests/voice/transcribe.test.ts`, `tests/repositories/daily-usage-repo.test.ts`, `tests/legal/routes.test.ts`

## Collaborator Contracts

- `AsyncTranscriptionClient.transcribe` receives `{audio, filename, mimeType, terms, signal}` and returns `{text, durationSeconds}`; it exposes no provider job/file ID or provider error type.
- `OpenAIClient` implements that method while retaining its separate metadata methods. `VoiceService` depends only on `AsyncTranscriptionClient` through constructor injection.
- `SonioxTranscriptionClient` alone calls `@soniox/node` and uses explicit EU endpoints. Its constructor accepts a narrow structural `SonioxAsyncSdk` dependency declared beside the client; `src/index.ts` constructs the official SDK object, while tests inject a fake implementing only upload/create/wait/get-transcript/delete/list methods. The client passes every SDK status, transcript, duration, and error payload to pure `safeParse` helpers in `src/api/soniox-transcription-api.ts` before returning domain values.
- The provider-specific purge script may depend directly on `SonioxTranscriptionClient` residual-list/delete methods; those methods are not exposed through the runtime `AsyncTranscriptionClient` interface.
- `src/config.ts` adds a narrow `loadSonioxPurgeConfig(env)` `safeParse` path for the operator script so it reads only the Soniox key/region/endpoints it needs. The script reports `{mode: "audit"|"apply", outcome: "completed"|"failed", fileCount, transcriptionCount, deletedFileCount, deletedTranscriptionCount}` and exits nonzero on `failed`; no IDs, names, content, or provider messages are printed.

## Production and Test Composition

- `src/index.ts` selects exactly one `AsyncTranscriptionClient`: existing `OpenAIClient` for `openai`, or official Soniox SDK -> `SonioxTranscriptionClient` for `soniox`; it injects the selected interface, `GlossaryService`, `DailyUsageRepository`, and `dailyLimitSeconds` into `VoiceService`. Neither service nor client calls `loadConfig()`.
- `tests/helpers/setup.ts` sets disabled/default Soniox environment values, adds `asyncTranscriptionClient`, `glossaryService`, and `voiceService` overrides, constructs the same default OpenAI graph, and exposes `voiceService`. Fake Soniox SDK objects are unit-test dependencies of `SonioxTranscriptionClient`; they are not process-global mocks.
- Route tests use a `TestAppOverrides.asyncTranscriptionClient` fake. Existing cleanup awaits `app.close()` before dropping the test database; async provider work has no process-owned background task after its bounded call settles.

## Data Flow and Ownership

1. `src/routes/voice.ts` obtains one cancellation signal per multipart request from the existing `createRequestCloseSignal({request, reply})` helper in `src/lib/request-close-signal.ts`, which already returns an immediately aborted signal when the connection is gone on entry and removes its own listeners on the first terminal event. The route passes that signal through `VoiceService` with file bytes, filename, MIME, and project key; no new route-owned listener bookkeeping is added.
2. OpenAI adapter preserves current behavior.
3. `SonioxTranscriptionClient` uploads, creates, polls, and fetches through the SDK; `soniox-transcription-api.ts` validates and normalizes each consumed SDK value and maps stable errors to provider-neutral categories.
4. A separate bounded cleanup signal deletes transcription then file in `finally`; cleanup failure is logged with outcome/type/request reference only and never suppresses a valid transcript.
5. `VoiceService` performs its existing best-effort usage increment and maps provider-neutral failures to existing API errors.

## Error, Cancellation, Concurrency, and Lifecycle

- `SonioxTranscriptionClient` composes the caller signal with `AbortSignal.timeout(SONIOX_ASYNC_TIMEOUT_MS)` for upload, processing, and transcript fetch. Cleanup gets a new independent `AbortSignal.timeout(SONIOX_CLEANUP_TIMEOUT_MS)` in `finally`.
- Request abort propagates route -> service -> provider where the SDK supports `AbortSignal`; the route removes its listener on every outcome. Server shutdown does not maintain a second active-operation registry: Fastify awaits the in-flight handler, and the provider timeout bounds it. No detached retry is scheduled.
- `src/types/transcription.ts` defines the closed internal failure enum `invalid_input|capacity|unavailable|timeout|provider_rejected|malformed_output|cancelled|internal`; provider clients throw one typed failure with that enum and retain the original error only as a local cause.
- `VoiceService` maps `invalid_input` -> existing `BadRequestError` / HTTP 400 / `bad_request` / nonretryable; `capacity|unavailable` -> new `TranscriptionUnavailableError` / HTTP 503 / `transcription_unavailable` / `Retry-After: 1` / retryable; `timeout` -> new `TranscriptionTimeoutError` / HTTP 504 / `transcription_timeout` / `Retry-After: 1` / retryable; `provider_rejected` -> new `TranscriptionConfigurationError` / HTTP 500 / `transcription_configuration_error` / nonretryable; `malformed_output` -> new `TranscriptionProviderError` / HTTP 502 / `transcription_provider_error` / `Retry-After: 1` / retryable; and `internal` -> existing `InternalServerError` / HTTP 500 / `internal_server_error` / nonretryable.
- Each new `ApiError` sets `responseBody = {retryable: <fixed boolean>}`; old clients may ignore that additive field. `cancelled` is consumed only when the route-owned signal fired: if the socket is already closed the route emits no response, and otherwise it maps to nonretryable `BadRequestError`. Daily Sesori quota remains existing HTTP 429 `quota_exceeded` and is never conflated with provider capacity.
- The global handler in `src/server.ts` is the sole `Retry-After` response owner: it reads only the positive safe-integer `ApiError.retryAfterSeconds` constructor metadata, emits the header when present, and omits it otherwise. `app.inject()` route tests assert both paths; provider clients/routes never write this header directly.
- To preserve shipped default-OpenAI behavior, the OpenAI adapter maps every non-caller-cancellation SDK timeout, capacity, malformed-response, and other SDK failure to internal `internal`, retaining HTTP 500 `internal_server_error`; only caller cancellation maps to `cancelled`. Place the required compatibility marker immediately above this mapping in `src/clients/openai-client.ts` using implementation date/auth version `0.1.0`. Affected pair: apps through current `1.6.1` (and any later app still supporting OpenAI rollback) with auth `0.1.0` after this PR while OpenAI remains selectable. Cleanup: when OpenAI async rollback support is explicitly removed or a breaking error-contract rollout is approved, delete the marker/legacy mapping and map OpenAI into the detailed enum with matching route tests.
- Raw provider messages, audio, transcripts, terms, paths, user IDs, and keys are never logged. This includes the existing `VoiceService` quota-race warning, which currently prints the authenticated user ID: rewrite it (and any other touched log line) to a bounded event name plus safe error type only, and add a test asserting the quota-race and increment-failure logs contain no user ID.
- Existing 25 MiB and route rate limits remain. No new async semaphore is added without observed memory pressure.

## Backward Compatibility

- The public async success shape remains compatible; `projectKey` omission retains the S01-W01-P01 normalization behavior. Soniox-only failures introduce bounded provider-neutral error strings and an additive boolean `retryable`; released apps continue to handle them through HTTP status/generic error behavior and may ignore the extra field.
- OpenAI stays selected by default. Soniox cannot affect released clients until operators explicitly change configuration after S03/S04.
- Affected pairs: all released apps with auth containing this PR; behavior remains OpenAI until rollout selection.
- No compatibility-only provider fallback is added. Cleanup is mechanical: once Soniox is the only intentionally supported async provider and rollback support is explicitly retired, remove the OpenAI transcription adapter/config branch while preserving the independent OpenAI metadata client.
- Test both configured providers against the same service contract and verify that switching configuration does not change wire shapes.

## Configuration and Deployment

- Add `ASYNC_TRANSCRIPTION_PROVIDER=openai|soniox` (default `openai`), `SONIOX_API_KEY`, literal `SONIOX_REGION=eu` (default `eu`), `SONIOX_ASYNC_MODEL=stt-async-v5`, `SONIOX_ASYNC_TIMEOUT_MS` (default 100,000; range 1,000..110,000), and `SONIOX_CLEANUP_TIMEOUT_MS` (default 10,000; range 1,000..30,000) under `configSchema`.
- This PR resolves the validated `eu` region to the explicit Soniox EU REST URL and passes it into SDK construction so SDK environment precedence cannot redirect secrets or audio. S02 adds the corresponding realtime URL.
- In this PR, the Soniox key is conditionally required only when async Soniox is selected and exists only in encrypted `env/app/*.env`; S02 extends that condition when it introduces the realtime enable flag.
- The purge command defaults to audit-only and requires explicit `--apply` for destructive deletion. It prints counts/outcomes only.
- Add Soniox Inc. as an EU transcription subprocessor and accurately describe async storage, ordinary deletion, system metadata, no-training statement, and rare operational cleanup residue.

## Automated Tests

- OpenAI remains selected by default and preserves route behavior.
- OpenAI SDK timeout/capacity/malformed/general failures retain the shipped HTTP 500 mapping; caller cancellation emits no disconnected response.
- Soniox config conditional validation and explicit endpoint construction.
- Zod rejection for malformed transcript, duration, status, and error shapes.
- Success, provider error, timeout, cancellation, missing transcript, and cleanup failure.
- Route abort propagation via `createRequestCloseSignal`, including an already-disconnected client on entry receiving an immediately aborted signal; bounded provider timeout remains the shutdown bound.
- Route-level assertions for every closed internal failure: exact HTTP status, error string, retryable field/header presence or absence, daily quota distinction, and no response after a disconnected cancellation.
- Cleanup order and the rule that cleanup failure does not discard a valid transcript.
- Purge audit default, explicit apply guard, and content-free output.
- Legal route snapshots include Soniox without removing OpenAI/Anthropic disclosures.

## Manual Verification

- No real provider call is required in CI.
- With a non-production EU key, transcribe one short fixture, confirm text/duration, then confirm zero residual file/transcription counts.
- Force a cleanup failure in a test environment and inspect safe logs.
- Run `npm run purge-soniox-transcription` to audit and, only against the approved non-production project, `npm run purge-soniox-transcription -- --apply` to verify the explicit destructive guard.

## Regression Guide and Commands

```bash
npm ci
docker rm -f rtt-mongo 2>/dev/null || true
docker run --rm -d --name rtt-mongo -p 27018:27017 mongo:7
MONGODB_URI_TEST=mongodb://localhost:27018/auth-backend-test node --import tsx --test --test-concurrency=1 tests/config.test.ts tests/lib/errors.test.ts tests/api/soniox-transcription-api.test.ts tests/clients/async-transcription-clients.test.ts tests/services/voice-service.test.ts tests/scripts/purge-soniox-transcription.test.ts tests/voice/transcribe.test.ts tests/repositories/daily-usage-repo.test.ts tests/legal/routes.test.ts
MONGODB_URI_TEST=mongodb://localhost:27018/auth-backend-test npm test
npx tsc --noEmit
npm run lint
npm run format:check
npm run build
npm run circular-dependencies
docker build -t auth-backend:ci .
docker rm -f rtt-mongo
```

## Risks

- Hard crashes can leave provider artifacts until an operator purge.
- Soniox processing can exceed old app request deadlines; production selection waits for S03 rollout.
- The provider SDK can change types; Zod translation and a pinned lockfile contain the boundary.

## Acceptance Criteria

- `VoiceService` has no provider-specific dependency or branch.
- OpenAI and Soniox satisfy one interface and tests.
- Soniox is disabled by default, EU-bound, secret-safe, legally disclosed, and ordinarily cleans resources.
- No job, receipt, reconciler, or automatic fallback exists.

## Definition of Done

- Focused/full tests and all static checks pass.
- Docker builds without provider credentials and performs no provider egress.
- The PR records the real-Soniox manual evidence if available, without secrets or content.
