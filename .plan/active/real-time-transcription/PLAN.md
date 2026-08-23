# Proportional Real-Time Transcription

## 0. Plan Metadata

- **Status:** Approved — 2026-08-06 `aristotle-plan-review`
- **Plan format version:** 1
- **Generated:** 2026-08-04
- **Latest re-review:** 2026-08-06
- **Plan host:** `sesori-ai/sesori_auth_server`
- **Selected implementation base:** `master`
- **Active plan slug:** `real-time-transcription`
- **Legacy context:** This canonical plan supersedes the oversized legacy definition in `.plans/real-time-transcription/`. The legacy files remain historical evidence, not execution authority.
- **Invocation context:** Planning is being performed from local worktree branch `real-time-transcription-pr2a-shutdown-foundation` at `020afc0c456bdbf4edd13bbea56b2e95410bec29` (open PR #55). That branch is evidence only. Every auth implementation wave starts from the selected remote `master` branch after its own drift assessment; it must not inherit the invocation branch.

| Repository | Role | Implementation base | Initial audited tip | Initial tip date | Latest audited tip | Latest tip date | Review date |
|---|---|---|---|---|---|---|---|
| `sesori-ai/sesori_auth_server` | Plan host; async and realtime proxy | `master` | `9cc495397158722e4bf9c7ee2ed10f4b17b59e26` | 2026-08-04 15:07:23 +0300 | `9cc495397158722e4bf9c7ee2ed10f4b17b59e26` | 2026-08-04 15:07:23 +0300 | 2026-08-04 |
| `sesori-ai/sesori_apps_monorepo` | Mobile capture and Sesori protocol client | `main` | `5f98b3207c40d264b48c4265216fb32a18546846` | 2026-08-04 16:51:43 +0300 | `5f98b3207c40d264b48c4265216fb32a18546846` | 2026-08-04 16:51:43 +0300 | 2026-08-04 |
| `sesori-ai/sesori_relay_server` | Audited trust-boundary reference; no implementation PR | `master` | `b2064789202e635506601ccd88fee111bf5f6254` | 2026-07-27 17:52:35 +0300 | `b2064789202e635506601ccd88fee111bf5f6254` | 2026-07-27 17:52:35 +0300 | 2026-08-04 |

## 1. Goal

Deliver low-latency voice transcription in the Sesori mobile composer while keeping every application-facing contract independent of Soniox. Mobile audio streams over a Sesori-owned WebSocket to the auth server; the auth server authenticates, applies project glossary context and bounded best-effort quota policy, proxies through a provider adapter, and returns provider-neutral transcript updates.

The same provider boundary also permits the existing file-upload endpoint to select OpenAI or Soniox at deployment time. The implementation must be materially smaller than the superseded 13-slice design and must not introduce receipts, recovery schedulers, distributed leases, automatic provider failover, or server-wide handler tracking without observed evidence.

## 2. Success Criteria

1. New mobile clients can use protocol version 1 without containing a Soniox URL, key, SDK type, model name, error name, or provider-specific message.
2. A normal iOS and Android hold-to-talk session displays confirmed and provisional text before release; a staging screen recording shows the first non-empty update within two seconds in at least 9 of 10 short dictation trials per platform.
3. Successful release appends one final voice-origin span to the existing draft. Drag cancellation appends nothing. A mid-session failure appends only already-confirmed text and presents a retryable error.
4. Older apps continue using `POST /voice/transcribe`. New apps choose realtime or async before capture from a Sesori capability response and fall back to async when an older server lacks that response.
5. `POST /voice/transcribe` can use either configured async provider. Realtime initially has a Soniox adapter but no provider detail escapes its server-side interface.
6. Audio, transcripts, provisional text, glossary words, JWTs, provider keys, raw project IDs, and raw user IDs are absent from persistence and logs. Soniox content uses the approved US project and endpoints.
7. Daily quota behavior remains explicitly best effort: precheck before provider work, bounded realtime duration, one post-use atomic increment, and measured/logged persistence failure. No receipt or reconciliation collection is added.
8. The auth and apps verification suites, Docker build/smoke checks, protocol compatibility tests, and real-device manual checks pass.

## 3. Scope

### In Scope

- Opaque project-scoped glossary storage and bounded context selection.
- Deployment-selected async transcription providers (`openai` or `soniox`).
- Official `@soniox/node` SDK isolated behind Sesori client interfaces and Zod adapters.
- A Sesori-owned authenticated realtime WebSocket proxy and provider-neutral protocol.
- PCM16 streaming from the existing Flutter `record` dependency on iOS and Android.
- Interaction-local live transcript preview and final/confirmed-partial draft commit.
- Staged server capability selection with the current async path retained.
- Minimal feature-owned cancellation and shutdown behavior, including release of the two existing long-poll waiter stores before Fastify close.
- US Soniox configuration, legal disclosure, ordinary cleanup, an operator purge command, safe logs, and rollout gates.

### Non-Goals

- Direct app-to-Soniox streaming or temporary provider credentials in any app.
- Relay transport changes; readable transcription audio must not enter the encrypted relay.
- Automatic provider failover, per-request provider choice, or a lowest-common-denominator provider feature framework.
- Exact quota reservation, receipts, recovery jobs, or billing-grade accounting.
- Exact glossary caps under concurrent mutation, mutation queues, or MongoDB leases.
- Horizontal scaling. Auth remains single-instance; no Redis or distributed session ownership is introduced.
- Continuous provider cleanup reconciliation or a new job framework.
- Simultaneously retaining an entire realtime recording for seamless mid-session file-upload fallback.
- Diarization, translation, language labels, semantic endpoint detection, or server-side audio resampling.
- A generic admitted-request tracker, a second process signal handler, or exhaustive terminal-state precedence machinery.
- Desktop voice UI changes.

## 4. Audited Baseline

### Auth server

- `src/routes/voice.ts` buffers one authenticated multipart file up to 25 MiB, rate-limits transcription to 10 requests/minute per authorization header, and exposes user-wide glossary CRUD.
- `src/services/voice-service.ts` prechecks daily usage, transcribes through `OpenAIClient`, atomically increments usage afterward, and deliberately soft-fails the increment if transcription already succeeded. That shipped behavior is the evidence for bounded best-effort accounting.
- `src/repositories/daily-usage-repo.ts` owns the existing atomic daily increment; no reservation or receipt schema exists.
- `src/repositories/glossary-entry-repo.ts`, `src/models/documents.ts`, and `src/db/mongo-db-accessor.ts` currently use `{userId, word}`. The merged PR #53 migration helper recognizes the target `{userId, projectKey, word}` index, while the last production dry-run reported zero glossary documents.
- `src/models/voice.ts` already validates opaque `prj_v1_` keys. Runtime routes and repositories do not yet use them.
- `src/clients/openai-client.ts` combines transcription and metadata chat calls. The transcription method has a 60-second SDK timeout and local duration fallback.
- The selected remote `master` tip above has no `src/shutdown.ts` or `tests/index-shutdown.test.ts`; `src/index.ts` owns inline signal handlers, waits for `app.close()` before MongoDB close, and does not release parked OAuth or app-presence long polls first. Those files visible in this planning worktree belong only to unmerged PR #55.
- PR #52 ([plan definition](https://github.com/sesori-ai/sesori_auth_server/pull/52)) merged to `master` as `8fc4fcf470c786b5bbb1b3efb5bc3120cb870028`; it shipped planning artifacts, not the realtime runtime.
- PR #53 ([glossary migration tooling](https://github.com/sesori-ai/sesori_auth_server/pull/53)) merged to `master` as `bc7df1d87de8992c1498849d9133337446e675a3`; it shipped the migration helper and tests only.
- PR #55 ([shutdown foundation](https://github.com/sesori-ai/sesori_auth_server/pull/55)) remains open, mergeable, and changes-requested at `020afc0c456bdbf4edd13bbea56b2e95410bec29`. Review reproduced a roughly 22-second shutdown wait while an OAuth long poll was parked ([review evidence](https://github.com/sesori-ai/sesori_auth_server/pull/55#discussion_r3703493160)); that observed release-before-close requirement is retained. PR #55's broader admitted-handler tracking and coordinator implementation are unshipped and rejected as an implementation source.

### Apps monorepo

- `client/app/lib/capabilities/voice/voice_transcription_service.dart` records a complete platform-specific file, then uploads it after release. It already owns permission, wake lock, amplitude, cancellation, stale-result suppression, and a 15-minute limit.
- `client/module_core/lib/src/capabilities/voice/voice_api.dart` calls only `POST /voice/transcribe` with a 30-second request timeout.
- `record` 7.1.1 supports PCM16 streams on iOS, Android, web, Windows, macOS, and Linux; the mobile app already depends on it. `web_socket_channel` is also already present.
- `PromptInput` displays a waveform while recording and inserts one transcript only after the file request succeeds. Existing `ComposerDraftCalculator.appendVoiceTranscript` is the correct final commit seam.
- No feature-flag framework exists. A server-owned capability response is therefore simpler than inventing client global flag infrastructure.
- No repository-visible glossary caller exists. Both `PromptInput` call sites already possess a project ID, but the UI does not expose a bridge ID.

### Relay and external provider

- Relay remains an encrypted forwarding boundary and must not receive readable voice data.
- Soniox documents `stt-async-v5`, `stt-rt-v5`, final tokens sent once, replaceable non-final tokens, audio progress fields, a 10-session default realtime project cap, and a 300-minute provider session cap.
- The current official Node SDK supports typed async and realtime APIs, abort signals, explicit regional endpoints, stable error classes, and normal lifecycle methods. Its realtime `sendAudio` method has no per-frame acknowledgement.
- Soniox states realtime content is not retained, while the async API stores uploaded files/transcriptions until deletion. The US regional project keeps content processing and storage in the US.

## 5. Architecture and Data Flow

### Boundaries and dependency direction

- Routes own Fastify/WebSocket framing, request validation, authentication handoff, and public responses.
- `VoiceService` owns async transcription orchestration and best-effort quota behavior.
- `GlossaryService` owns project-scoped glossary CRUD, cap checks, and deterministic context selection.
- `RealtimeTranscriptionService` owns one public session lifecycle, provider-neutral updates, session duration, usage finalization, and its active-session set.
- Provider clients own external SDK calls only. Soniox SDK values/errors pass through Zod-backed adapters before services consume them.
- Repositories own MongoDB documents and `ObjectId`; services use strings and domain DTOs.
- `src/index.ts` remains the production composition root; `src/server.ts` remains Fastify and route registration.
- In the app, `module_core` owns the auth-server HTTP/WebSocket protocol client; the Flutter app owns microphone capture and UI integration. Neither layer contains provider knowledge.

### Opaque project key

The mobile client derives:

```text
projectKey = "prj_v1_" + base64url(sha256(utf8("sesori-project-glossary-v1\0" + projectId)))
```

Auth receives only the opaque key. It is not an authorization credential; the authenticated user remains the outer partition. The deliberately accepted simplification is that equal project IDs on two bridges share a glossary for that user because the current composer flow does not carry bridge identity.

The canonical cross-repository vector is project ID `project-123`, digest input bytes for `sesori-project-glossary-v1\0project-123`, and output `prj_v1_xgjNDm_yyduAKisFHr498ZgcjIU1FACdyEj68wSmbhc`. `README.md` and the apps unit test use this exact vector. The previous README formula included `bridgeId`, but it had no shipped producer and the production migration dry-run found zero rows; S01 replaces that obsolete documentation rather than preserving an unusable input.

### Async flow

1. The app records a file and sends it with an optional `projectKey`; old clients omit the field.
2. The route validates multipart metadata and normalizes omission to `null`.
3. `VoiceService` prechecks daily usage and asks `GlossaryService` for the deterministic context subset for the exact key, or no terms for `null`.
4. The deployment-selected `AsyncTranscriptionClient` transcribes through OpenAI or Soniox.
5. The Soniox adapter uses explicit US REST configuration, validates the result, and attempts immediate transcription/file deletion with a separate bounded cleanup signal.
6. `VoiceService` performs one atomic usage increment. Increment failure is logged safely and does not discard a completed transcript.
7. The existing response shape returns text and remaining daily seconds.

### Realtime flow

1. The app fetches and caches `GET /voice/capabilities`. Missing/failed capability discovery selects async; realtime is selected only when protocol version 1 is advertised as enabled.
2. The app opens `wss://<auth-host>/voice/realtime` with the normal `Authorization: Bearer <access-token>` handshake header. Tokens never appear in URLs, frames, or logs.
3. The existing auth middleware validates the stateless access JWT (RS256, issuer, audience, expiry, and access-token Zod shape; no refresh-token `tokenVersion` check). The route then validates the first provider-neutral `start` frame, and the service checks quota, loads exact-project terms, and creates a provider-neutral session.
4. The server replies `ready`; the app starts `record.startStream` and sends naturally paced PCM16 binary frames.
5. The Soniox adapter emits validated results. The service converts final tokens to an append-only `confirmedDelta` and each result's non-final tokens to one replacement `provisional` string.
6. The app displays confirmed plus provisional text in interaction-local recording UI. The editable draft remains unchanged.
7. `finish` gracefully finishes the provider and commits the final transcript. `cancel` discards the interaction. Unexpected failure retains only confirmed text already delivered to the app.
8. Realtime usage is the ceiling of accepted PCM duration, reconciled upward by validated provider progress when larger, and is incremented once on terminal cleanup. Failure of that write remains best effort.

### Public protocol version 1

- Client control: strict `start`, `finish`, and `cancel` JSON frames; authentication is the HTTP upgrade header, not a protocol field.
- Client audio: binary PCM16 frames only after `ready`.
- Server events: `ready`, `transcript`, `complete`, `error`.
- `transcript` contains only `confirmedDelta` and replaceable `provisional`.
- `complete` contains a provider-neutral reason (`finished`, `session_limit`, or `quota_limit`) and remaining daily seconds.
- `error` contains a bounded Sesori error code and `retryable`; raw provider messages are never returned.
- Straight-line state machine: `awaiting_start -> streaming -> finishing -> closed`, with S02's synchronous first-terminal-claim gate defining material races. Invalid frames close the one session; no combinatorial precedence subsystem is introduced.

### Lifecycle and shutdown

- First `start` frame and first audio each have one short timeout. Normal audio arrival is naturally paced by the recorder.
- Public frames are bounded and compression is disabled. Provider concurrency and rate limits remain the coarse capacity boundary; no duplicate server admission registry is added.
- A slow app client is closed if its outbound WebSocket buffer crosses one configured threshold. No transcript coalescing scheduler is added.
- `RealtimeTranscriptionService` keeps only the active sessions it owns so it can cancel them on app close/shutdown.
- One memoized shutdown path releases existing pending-auth and app-presence long polls, stops realtime sessions, disposes existing producers, closes Fastify to quiesce handler admission, drains every tracked app-presence repository read, then closes MongoDB. A 22-second deadline exits nonzero without closing MongoDB beneath known unfinished work. It does not track unrelated HTTP handlers.

## 6. Locked Decisions

1. Realtime audio absolutely must proxy through Sesori infrastructure; apps must not become tied to Soniox.
2. Provider independence means Sesori-owned public contracts and injected server adapters, with deploy-time selection where multiple implementations exist; it does not mean automatic runtime failover or a speculative one-value selector.
3. Use the official Soniox Node SDK behind a validating adapter rather than handwritten provider transport.
4. Include both auth and apps repositories in this plan; relay has no implementation change.
5. Quota accounting is bounded best effort, not a strict entitlement boundary.
6. Glossary limits are proportional safety bounds, not exact concurrent entitlements.
7. The app chooses realtime or async before capture. There is no mid-session file fallback.
8. Live text is preview-only until commit; confirmed partial text survives a failed session, while provisional text does not.
9. Async provider cleanup is immediate on ordinary paths plus operator/startup-window purge, with hard-crash residue accepted rather than persisted reconciliation.
10. Preserve the 15-minute product session cap, English as a non-strict hint, explicit hold-to-talk finish, and no initial diarization/translation/endpoint detection.

## 7. Backward Compatibility and Migration

- Existing apps continue to use `POST /voice/transcribe`; that route remains a supported staged mode, not a temporary alias.
- The multipart `projectKey` is optional at the transport boundary for old apps. Omission honestly normalizes to `null`, and modern internal methods receive an explicit nullable project context. No global glossary fallback is invented.
- `GET /voice/capabilities` is additive. The app's old-server 404/unavailable fallback to async is compatibility-only and must carry the required `COMPATIBILITY` source comment using the implementation date and then-current app version.
- The optional async `projectKey` normalization is compatibility-only and must carry the required marker in the auth route/model seam using auth version `0.1.0` unless `package.json` changes before implementation.
- Project-scoped glossary CRUD intentionally requires a project key. Repository history found no caller, and the production dry-run found zero rows; any nonzero rerun stops rollout rather than guessing ownership.
- Use the merged `migrate-project-glossary-index` command. Production apply occurs with the single auth instance stopped, followed by verify before starting the scoped runtime. Once a scoped row exists, rollback to the old index is forbidden.
- Async provider remains `openai` by default until the new app timeout and rollout checks are complete. Switching to Soniox is configuration, not an automatic fallback.
- Realtime defaults from Soniox key presence: omitted configuration enables it when `SONIOX_API_KEY` exists and disables it otherwise. Explicit `false` is available as a rollout hold for credentialed environments. Older apps ignore the additive endpoint; app adoption remains a separate stage.
- Exact cleanup of compatibility branches is authorized only after the minimum supported app always sends project context and all supported auth deployments expose capability protocol 1. Relevant PR files name the mechanical cleanup.
- Compatibility and migration scaffolding is retained deliberately, not indefinitely. S05 owns its removal so the debt is scheduled rather than orphaned; every marker added by this plan names its trigger, and S05-W01-P01 deletes exactly those whose triggers have fired. Nothing is removed while its rollback path is still the documented recovery route.

## 8. Rollout and Verification

### Merge order

1. Project-scoped glossary runtime.
2. Provider-neutral async Soniox support, still defaulting to OpenAI.
3. Realtime auth proxy, key-aware by default with an explicit opt-out for environments that need to hold endpoint registration.
4. Mobile realtime adoption with async fallback.

### Production order

1. Complete Soniox DPA/subprocessor approval, provision a dedicated US project/key, and publish updated legal disclosure.
2. Deploy the additive realtime endpoint; current and older apps ignore it and remain on async transcription until S03 adoption. Set `REALTIME_TRANSCRIPTION_ENABLED=false` only where operations need to hold endpoint registration despite a configured Soniox key.
3. Stop the single auth instance, rerun glossary dry-run, apply/verify the target index only if the collection remains valid, and deploy the new auth binary with async OpenAI. Verify capability discovery matches the resolved key-aware configuration.
4. Run the safe Soniox residual audit/purge command before sending production audio.
5. Select Soniox async, verify ordinary deletion/latency/error logs, then begin approved protocol 1 client traffic.
6. Observe safe outcome counts, provider cost/concurrency, process memory, and cleanup residual counts. Do not log content or identifiers.

### Rollback

- Disable realtime in auth; new apps select async on their next capability read.
- The deployment operator owns configuration-first binary rollback. While the region-aware binary is still running, set `ASYNC_TRANSCRIPTION_PROVIDER=openai` and `SONIOX_REGION=eu`, restart, then verify `/health` and one authenticated OpenAI transcription. A binary predating US-region support rejects `SONIOX_REGION=us`, so it must never start with the US configuration still present.
- After Soniox traffic is drained, run the residual audit against `SONIOX_REGION=us` with the region-aware binary and clear any residue under the normal purge rules. Only then may an older binary replace it.
- Roll forward for any code defect after scoped glossary rows exist. Database rollback is allowed only under the existing empty-collection migration rule.
- A provider outage returns bounded retryable errors; it does not route audio through relay or directly from the app to the provider.

### Automated verification

- Auth: each PR names every focused native Node test file it adds or changes. Full verification uses Node 22 and MongoDB 7 with `npm ci`, `npm run format:check`, `npm run lint`, `npx tsc --noEmit`, `npm run build`, `MONGODB_URI_TEST=mongodb://localhost:27017/auth-backend-test npm test`, and `npm run circular-dependencies`. S02 additionally runs `docker build -t auth-backend:ci .` and the exact `bash scripts/ci-auth-container-smoke.sh` workflow for startup, `/health`, public disabled capability, unauthenticated WebSocket rejection, a parked OAuth long poll, SIGTERM, exit code, and log ordering.
- Apps: S03 names every focused Dart/Flutter test file, runs the exact `mobile-ci.yml` package analyzer/test commands, regenerates DI/localization from sources, and runs `flutter build apk --debug` from `client/app` as the mobile build check.
- Contract fixtures cover protocol version 1 in both repositories without sharing provider models.

### Manual verification

- Real Soniox US async and realtime smoke tests with safe logs inspected.
- iOS and Android PCM stream, provisional replacement, final commit, cancel, network loss, backgrounding, quota/session limit, and async fallback.
- Old app/new server and new app/old server compatibility.
- Ingress holds a session until the 15-minute application cap without an earlier infrastructure timeout.
- SIGTERM with an active realtime session and each existing long poll exits within the deployment grace period.

## 9. Risks and Deferrals

| Risk | Accepted boundary | Revisit signal |
|---|---|---|
| Crash or MongoDB write failure undercounts usage; concurrent work can overshoot quota | Precheck, 15-minute cap, provider limits, one atomic increment, safe warning | Cost/usage divergence or abuse is observed |
| Concurrent glossary requests can narrowly exceed a cap | Per-request limits, deterministic trimming, unique index | Real contention or storage growth is observed |
| SDK `sendAudio` exposes no acknowledgement and may buffer during provider/network stalls | Recorder-paced audio, provider disconnect behavior, 15-minute cap, memory observation | Reproduced RSS growth or OOM |
| Hard crash can leave Soniox async artifacts | Dedicated US project, immediate ordinary cleanup, residual audit/operator purge | Residuals recur or approach provider limits |
| Equal project IDs on two bridges share glossary scope | User partition plus opaque project digest; no bridge-ID plumbing | Demonstrated cross-bridge glossary conflict |
| Process restart loses realtime sessions and feature-owned in-memory state | Single-instance deployment and client retry/confirmed partial behavior | Horizontal scaling or restart-loss product harm |
| No automatic provider failover | Explicit deploy-time rollback | Availability objective requires multi-provider continuity |
| Slow clients can lose undelivered provisional text | Confirmed deltas prioritized; close on bounded outbound buffer | Ordinary clients hit the threshold |
| PR #55's broad shutdown machinery is abandoned | Retain only reproduced long-poll release and feature-owned realtime shutdown | A concrete uncovered shutdown failure is reproduced |

Deferred systems are not placeholders: receipts, reconcilers, leases, exact cap serialization, global request tracking, and direct-provider clients are excluded until a new evidence-backed plan authorizes them.

## 10. Stage Map

| Stage | Goal | PRs | Manual checkpoints |
|---|---|---:|---:|
| S01 | Project scope and provider-neutral async Soniox | 2 | 0 |
| S02 | Provider-neutral realtime auth proxy | 1 | 0 |
| S03 | Mobile realtime adoption | 1 | 0 |
| S04 | Cross-repository verification and production enablement | 0 | 2 |
| S05 | Compatibility and migration scaffolding removal | 1 | 0 |

## 11. Evidence-Based Safeguard Disposition

| Superseded safeguard | Evidence classification | Revised disposition |
|---|---|---|
| Usage reservations, receipts, replay, blocked-user states | Theoretical relative to shipped soft-fail policy | Remove; precheck plus one post-use increment |
| Per-user mutation queues and MongoDB leases | No callers, zero production rows, no contention | Remove; ordinary checks plus unique index |
| Continuous provider cleanup reconciler | Crash residue is possible, but no incident exists | Normal cleanup plus residual audit/operator purge |
| Two-global/one-user async buffer gate | No observed memory failure | Retain 25 MiB and request rate limits; measure |
| Custom Soniox REST/WebSocket transport | Superseded by current maintained SDK | Use official SDK behind Zod adapter |
| Pending/active session capacity registries | Provider already enforces 10 concurrent and 100/minute | Rely on provider and route rate limits |
| Per-frame provider acknowledgement queue | SDK has no acknowledgement; no observed buffering failure | Send naturally paced audio and observe memory |
| Transcript coalescing scheduler and 1,000,000-character buffers | No ordinary dictation reaches those bounds | Confirmed delta plus one provisional replacement; bounded frames |
| Exhaustive terminal precedence table | Theoretical interleavings | Four-state session and one local terminal gate |
| Server-wide admitted-handler tracker and pervasive fences | No reproduced handler/DB race | `app.close()` waits handlers; release known long polls; own realtime sessions |
| Relay carriage or direct Soniox credentials | Violates established trust/product boundary | Explicitly prohibited |
