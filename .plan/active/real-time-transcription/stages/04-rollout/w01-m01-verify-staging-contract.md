# S04-W01-M01: Verify Staging Contracts and Devices

## Metadata

- **ID:** S04-W01-M01
- **Why manual:** CI fakes cannot prove US routing, real provider behavior, ingress lifetime, physical recorder output, visual preview latency, or content-free operational logs.
- **Worker executable:** Partially. Worker can run local/Docker/protocol checks. User must provide approved staging/provider access and physical devices.

## Setup

1. Deploy merged auth with `ASYNC_TRANSCRIPTION_PROVIDER=openai` and `REALTIME_TRANSCRIPTION_ENABLED=false`; the explicit flag is required once staging receives a Soniox key.
2. Install the merged app build on one physical supported iOS device and one supported Android device.
3. Confirm legal staging text names Soniox and the approved US data handling.
4. Configure the dedicated US Soniox project through encrypted deployment secrets; never copy values into evidence.
5. Enable Soniox async (`ASYNC_TRANSCRIPTION_PROVIDER=soniox`) in staging only after the residual audit/purge reports a safe empty state; run the async Soniox checklist items in this state.
6. Remove the explicit false override (or set `REALTIME_TRANSCRIPTION_ENABLED=true`) in staging and restart before exercising the realtime checklist items (PCM sessions, latency trials, cancel/failure/cap cases, 15-minute ingress hold, and the realtime SIGTERM check). The disabled-capability checklist item must be evidenced before this step.

## Checklist

- [ ] New app + old auth: missing capability selects async before recording.
- [ ] New app + new auth disabled: capability selects async.
- [ ] Old app + new auth: file transcription still succeeds.
- [ ] Async Soniox: short AAC/WAV fixture succeeds within the new app deadline and leaves zero terminal file/transcription residuals.
- [ ] iOS and Android PCM sessions reach `ready`, stream, replace provisional text, append confirmed text, finish, and commit one draft span.
- [ ] In 10 short trials per platform, at least 9 show non-empty preview within two seconds.
- [ ] Drag cancel commits nothing and releases wake lock/recorder/socket.
- [ ] Network loss and provider 429/503 commit only confirmed partial text and show retryable failure.
- [ ] Quota/session cap returns the correct provider-neutral terminal reason.
- [ ] Background/dispose closes the interaction without stale draft mutation.
- [ ] A synthetic session remains connected until the 15-minute app cap, proving no earlier ingress timeout.
- [ ] SIGTERM with realtime, OAuth long poll, and app-presence long poll exits inside platform grace.
- [ ] Logs/crash reporting contain no prohibited content or identifiers.
- [ ] Relay traffic and repository remain unchanged.

## Expected Evidence

- Auth/apps full SHAs and staging build/deployment identifiers.
- Safe timing table with platform, trial number, and first-update milliseconds only.
- Safe provider residual counts before/after.
- CI/Docker links and shutdown exit code/time.
- User confirmation that visual behavior is acceptable; no screen recording containing dictated content is attached to public artifacts.

## Pass Criteria

- Every compatibility and lifecycle case behaves as specified.
- Latency target passes on both platforms.
- Residual counts return to zero on ordinary paths.
- No content/secret exposure or earlier ingress timeout is found.
- Any failure is resolved by a scoped fix and refreshed plan review when intent/contracts change; do not add unapproved coordination machinery.
