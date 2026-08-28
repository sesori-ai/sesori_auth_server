# S03-W01-P01: Stream Mobile Voice Through Sesori

## Metadata

- **ID:** S03-W01-P01
- **Repository:** `sesori-ai/sesori_apps_monorepo`
- **Worktree:** worker-created `sesori_apps_monorepo/.worktrees/real-time-transcription-s03-w01-p01`
- **Base branch:** `main`
- **Required rebase tip:** exact merged apps voice-retry Step 4 SHA (pending); the prior audited base is superseded
- **Branch:** `plan/real-time-transcription/s03-w01-p01-stream-mobile-voice`

## Goal and Cohesion

Adopt Sesori realtime voice protocol version 1 in the existing mobile interaction while preserving async compatibility. This is one user-visible cohesive PR because transport, capture, preview, commit, cancellation, and tests must agree for any part to be useful.

## Dependencies

- S02-W01-P01 merged.
- Voice-retry client Steps 3–4 merged, establishing shared platform/session/repository/service/Cubit ownership and async retained-file Retry.
- PR #918 rebased onto the exact voice-retry Step 4 merge SHA with every overlapping voice/DI/composer/test/doc seam reconciled.
- Auth staging can advertise enabled/disabled protocol 1.

## Scope

- Derive the opaque project key from the existing project ID without exposing the raw ID to auth.
- Extend `VoiceApi` with capability discovery and optional async `projectKey`; increase the async request budget from 30 seconds to exactly 120 seconds for Soniox rollout.
- Add a provider-neutral realtime voice WebSocket client in `module_core`, using `AuthTokenProvider` and `web_socket_channel`.
- Extend the module_core voice repository/service-session/Cubit flow to choose mode before capture, stream PCM16, expose live preview, finalize/cancel, and map errors.
- Render Cubit-owned confirmed/provisional preview in `PromptInput` and commit through `ComposerDraftCalculator` only at terminal outcome.
- Preserve async file capture and retained-file Retry for old/disabled servers and pre-audio fallback.

## Non-Goals

- Soniox names, URLs, models, credentials, SDKs, or errors in app code.
- Direct provider streaming or relay carriage.
- Recording file and stream simultaneously.
- Automatic retry/reconnect or full-recording Retry after realtime audio has begun.
- Dual file/stream capture or hidden post-audio async upload.
- Live mutation of the editable draft.
- Desktop voice integration or a general client feature-flag framework.

## Audited Current Code and Assumptions

- The original PR #918 implementation was built around an app-layer singleton; that baseline is superseded by the voice-retry plan's platform capability, HTTP repository, lazy service with per-composer state session, and `VoiceInputCubit` ownership.
- The rebase must use the then-merged module_core `VoiceApi`/`VoiceRepository` and async timeout rather than restoring PR #918's older API shape.
- `AuthTokenProvider` exposes a fresh access token without importing concrete auth types into app code.
- `PromptInput` owns recording/transcribing UI and already guards stale/cancelled interactions with a monotonic ID.
- `record` 7.1.1 supports PCM16 streaming across target mobile platforms and reports configuration adjustment through its API.

## Touched Modules and Files

The list below records PR #918's existing overlap surface. During the required rebase, recalculate exact paths from the merged voice-retry architecture; do not restore a removed app-layer singleton or bypass its repository/service/Cubit flow solely to preserve these historical paths.

- `client/module_core/lib/src/capabilities/voice/voice_api.dart`
- `client/module_core/lib/src/capabilities/voice/voice_capabilities.dart` (new)
- `client/module_core/lib/src/capabilities/voice/realtime_voice_protocol.dart` (new)
- `client/module_core/lib/src/capabilities/voice/realtime_voice_api.dart` (new)
- `client/module_core/lib/src/capabilities/voice/realtime_websocket_connector.dart` (new abstract platform interface)
- `client/module_core/lib/src/capabilities/voice/project_glossary_key.dart` (new pure helper)
- `client/module_core/lib/src/di/injection.dart`; regenerate `client/module_core/lib/src/di/injection.config.dart`, never hand-edit it
- `client/module_core/lib/sesori_dart_core.dart`
- `client/app/lib/capabilities/voice/voice_transcription_service.dart`
- `client/app/lib/capabilities/voice/audio_format_config.dart`
- `client/app/lib/capabilities/voice/io_realtime_websocket_connector.dart` (new mobile `web_socket_channel/io.dart` adapter)
- `client/app/lib/core/di/injection.dart`; regenerate `client/app/lib/core/di/injection.config.dart`, never hand-edit it
- `client/app/lib/features/session_detail/widgets/prompt_input.dart`
- `client/app/lib/features/new_session/new_session_screen.dart` and `client/app/lib/features/session_detail/widgets/session_detail_loaded_view.dart` (the two `PromptInput` project-context call sites)
- `client/app/lib/l10n/app_en.arb`; regenerate `app_localizations.dart` and `app_localizations_en.dart` through `flutter gen-l10n`
- `client/module_core/test/capabilities/voice/project_glossary_key_test.dart` (new)
- `client/module_core/test/capabilities/voice/realtime_voice_api_test.dart` (new)
- `client/module_core/test/fixtures/voice_realtime_protocol_v1.json` (new canonical apps fixture matching auth semantics)
- `client/app/test/capabilities/voice/voice_api_test.dart`
- `client/app/test/capabilities/voice/audio_format_config_test.dart`
- `client/app/test/capabilities/voice/io_realtime_websocket_connector_test.dart` (new)
- `client/app/test/capabilities/voice/voice_transcription_service_test.dart`
- `client/app/test/features/session_detail/widgets/prompt_input_voice_preview_test.dart` (new)

## Collaborator Contracts

- `VoiceCapabilities` parses only the auth-owned enabled flag and supported protocol versions. `VoiceApi` owns HTTP capability discovery and async multipart requests.
- `module_core` defines `RealtimeWebSocketConnector` as a pure-Dart platform interface and constructor-injects it into `RealtimeVoiceApi`; core tests supply a fake. The app's `IoRealtimeWebSocketConnector` wraps `IOWebSocketChannel.connect` and sends the fresh access token only as the `Authorization: Bearer` upgrade header on supported iOS/Android. App DI registers this platform adapter before core initialization. `RealtimeVoiceApi` owns token acquisition, strict start/control frames, binary sends, protocol parsing, and socket close, and exposes sealed provider-neutral interaction events.
- `VoiceApi`/`RealtimeVoiceApi` remain Layer 1; the voice repository maps transport outcomes; the lazy `VoiceTranscriptionService` owns mode selection and orchestration parameterized by its per-composer state session; `VoiceInputCubit` owns that session and renderable interaction state.
- `PromptInput` owns only gesture/presentation/controller concerns and the existing `ComposerDraftCalculator.appendVoiceTranscript` effect. Its owner supplies the raw local project ID; only the project-key helper hashes it, and only the resulting opaque key reaches auth APIs.

## Data Flow and Ownership

1. The voice Cubit/service flow receives the project ID; a pure helper derives `prj_v1_ + base64url(SHA-256(versioned project ID))`. Its canonical test vector is `project-123` -> `prj_v1_xgjNDm_yyduAKisFHr498ZgcjIU1FACdyEj68wSmbhc`.
2. Prewarm/capability discovery selects async unless enabled protocol 1 is confirmed.
3. Realtime setup registers `AudioRecorder.setOnConfigChanged`, calls `startStream` with PCM16/mono/16 kHz, immediately pauses the native recorder, and discards any pre-pause chunks. Because the config-change callback is delivered during platform start, the resolved `startStream` future establishes the final effective `RecordConfig`; validate its PCM16 encoding, mono channel count, and sample rate against `16000|24000|44100|48000`.
4. Only after that validation does setup get a fresh Sesori token, open auth WSS with the bearer upgrade header, and send `start.audio` from the effective config. It waits for `ready`, then switches the existing stream subscription from discard to direct socket forwarding and resumes the recorder. No pre-ready audio is queued or retained.
5. Any later config-change callback that differs from the announced format terminates setup/session before sending another audio frame; the app never lies about stream format and never resamples.
6. `transcript` events update an immutable interaction preview: append `confirmedDelta`, replace `provisional`.
7. `complete` returns the confirmed text to `PromptInput`, which appends one voice-origin span. A failure returns confirmed text plus a typed error; UI commits confirmed text, drops provisional, and shows the localized error.
8. Async mode preserves the voice-retry retained-artifact lifecycle and response path, now including project context.

## Error, Cancellation, Concurrency, and Lifecycle

- A missing/404/failed capability request selects async. A realtime connect/start failure before `ready` cancels the paused/discarding stream and may start the async file path while the hold remains active.
- Unsupported/adjusted effective format cancels the paused stream and selects async before WSS/audio. Release or drag-cancel during paused setup cancels recorder/config callback/setup and commits nothing rather than starting fallback after the gesture ended.
- HTTP 401 during upgrade is surfaced as the existing authentication failure rather than retrying async. HTTP 404/429 or a transport failure before `ready` may select async; a malformed protocol event or unsupported advertised version is a typed contract failure and does not silently downgrade.
- Once streaming begins, network/provider/server failure closes the stream, stops recording, returns confirmed partial text if present, and never uploads retained audio.
- Drag cancellation stops recorder, sends/cancels the session, drops preview, and commits nothing.
- Release stops the recorder, waits for stream closure, sends `finish`, and applies a bounded finish deadline.
- App background/disposal cancels the active interaction and releases recorder, config-change callback, channel, subscriptions, wake lock, and timers. Realtime duration/minimum-hold timers begin only when `ready` is accepted and the recorder resumes.
- Existing interaction generation prevents stale events from a prior session mutating a newer draft.
- One voice interaction remains active per composer-owned Cubit/service session; no new global queue or retry manager.

## Backward Compatibility

- Treat missing/unsupported `GET /voice/capabilities` as async. Place the required `COMPATIBILITY` comment directly above the 404/unsupported-response fallback branch in `client/module_core/lib/src/capabilities/voice/voice_api.dart`, using implementation date and then-current `client/app/pubspec.yaml` version (currently 1.6.1).
- Affected pairs: app with auth before protocol 1; app with protocol-1 auth while realtime is disabled.
- Send async `projectKey` only after capability protocol 1 has been observed. When capability discovery falls back for an old server, preserve the exact legacy multipart request and omit the new field.
- Cleanup: after every supported auth server exposes capability protocol 1, remove only the missing-endpoint compatibility fallback/marker; keep async mode because it remains a product rollout mode.

## Audio and UI Behavior

- Stream PCM signed 16-bit little-endian, mono, using the validated effective recorder sample rate announced before `ready`. Do not resample or send a frame after a later format adjustment.
- Preserve amplitude monitoring, haptics, drag-to-cancel, wake lock, minimum recording duration, and 15-minute limit.
- Preview may replace the current waveform center or use the existing recording chrome, but it must not reparent the gesture owner or mutate the editable text controller.
- Confirmed text is visually stable; provisional text is visibly secondary and replacement-only.
- On success, preserve existing voice-first/text-first focus behavior and analytics event.

## Automated Tests

- Project-key deterministic vector and raw-project-ID non-transmission.
- Capability enabled, disabled, malformed, 404, timeout, and compatibility fallback.
- Realtime protocol parsing, token acquisition, ready/update/complete/error, binary send, and close.
- Parse the matching protocol-v1 fixture with strict unknown/omitted-field rejection, all sample rates/bounds/error codes, fixed retryability/close mapping, and no access token in any JSON fixture.
- Pre-audio realtime failure selects async and keeps its retained-file Retry behavior; post-audio failure never invokes async upload or exposes the async Retry control.
- Confirmed append, provisional replacement, finish commit, confirmed-partial failure commit, cancel discard, and empty transcript.
- Stale session events cannot modify a later draft.
- Recorder start-paused ordering, callback-before-start-frame effective format, pre-ready discard/no queue, supported adjustment, unsupported/late adjustment termination, callback cleanup, amplitude, wake lock, max duration, background/disposal, and all existing async cases.
- Widget tests for preview without draft mutation and one terminal draft append.

## Manual Verification

- Voice-first and text-first composer modes on physical iOS and Android.
- Very short hold, normal hold, 15-minute cap, drag cancel, network loss, background/resume, quota exhaustion, and provider capacity error.
- Confirm no local recording file remains after realtime and no transcript/audio appears in logs or crash reports.

## Regression Guide and Commands

```bash
cd client
dart pub get
(cd module_core && dart run build_runner build --delete-conflicting-outputs)
(cd app && dart run build_runner build --delete-conflicting-outputs && flutter gen-l10n)
(cd module_core && dart test test/capabilities/voice/project_glossary_key_test.dart test/capabilities/voice/realtime_voice_api_test.dart)
(cd app && flutter test test/capabilities/voice/voice_api_test.dart test/capabilities/voice/audio_format_config_test.dart test/capabilities/voice/io_realtime_websocket_connector_test.dart test/capabilities/voice/voice_transcription_service_test.dart test/features/session_detail/widgets/prompt_input_voice_preview_test.dart)
(cd app && dart analyze --fatal-infos)
(cd module_core && dart analyze --fatal-infos)
(cd module_auth && dart analyze --fatal-infos)
(cd module_prego && dart analyze --fatal-infos)
(cd module_core && dart test)
(cd module_auth && dart test)
(cd module_prego && flutter test)
(cd app && flutter test)
(cd ../shared/no_slop_linter && dart pub get && dart test)
(cd app && flutter build apk --debug)
```

## Risks

- Device audio configuration can differ from the requested sample rate; the start-paused sequence obtains and validates the effective config before protocol start, and physical-device tests verify callback ordering and no pre-ready audio.
- Capability can become stale after prewarm; pre-audio setup failure safely selects async.
- Confirmed partial text may be incomplete; UI explicitly signals the failure instead of pretending full success.

## Acceptance Criteria

- No provider-specific value exists in app contracts or source.
- Realtime preview appears before release and draft remains unchanged until terminal commit.
- Old/disabled server behavior uses async; midstream failure does not create hidden upload fallback.
- Existing voice UI/lifecycle tests remain green.

## Definition of Done

- Generated files are produced only through build runner/localization tooling.
- `module_core`, app analyzer/tests, and mobile CI/build pass.
- Physical-device evidence is attached or recorded in S04 without content/secrets.
