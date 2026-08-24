# Stage S02: Provider-Neutral Realtime Auth Proxy

## 0. Stage Metadata

- **Stage ID:** S02
- **Repository:** `sesori-ai/sesori_auth_server`
- **Base:** `master`
- **PR count:** 1

## 1. Outcome

The auth server exposes Sesori realtime voice protocol version 1 with an omitted-enable default derived from Soniox key presence, proxies PCM audio through a provider-neutral service to Soniox, emits confirmed/provisional updates, records best-effort usage, and shuts down its own sessions cleanly without adopting PR #55's broad coordination machinery.

## 2. Entry Criteria and Baseline

- S01 is complete.
- S02/W01 pins current auth `master` after drift assessment.
- Soniox async boundary/config/legal work exists, but production provider enablement remains off.

## 3. Invariants and Non-Goals

- No provider name, key, URL, model, error, or SDK shape crosses the Sesori protocol.
- Access tokens appear only in the standard WSS `Authorization: Bearer` upgrade header, never a URL, protocol frame, or log.
- Audio/transcript content is not persisted or logged.
- Omitted realtime enablement follows Soniox key presence; explicit false remains a complete route/object-graph opt-out.
- No direct provider app access, relay change, receipt ledger, global admission registry, provider failover, generic handler tracker, or exhaustive terminal matrix.

## 4. Execution Waves

| Wave | Step | Repository | Base | Parallel safety | Outcome |
|---|---|---|---|---|---|
| W01 | S02-W01-P01 | `sesori-ai/sesori_auth_server` | `master` | Sole step | Complete key-aware realtime server capability |

## 5. Integration and Manual Verification

- Automated tests use fake client and fake Soniox SDK seams; no CI egress.
- Native route tests execute an enabled fake-provider WebSocket lifecycle. Docker smoke executes production composition startup, `/health`, disabled capability/WebSocket behavior, one parked OAuth long poll, and SIGTERM without provider egress.
- Real provider, ingress, and device checks remain in S04.

## 6. Exit Criteria

- Protocol version 1 and capability endpoint are merged and documented.
- Disabled configuration preserves all existing routes and startup.
- Realtime service owns and disposes only its sessions.
- Known parked long polls release before Fastify close; no server-wide request tracker exists.
- Provider and client errors are bounded and content-free.

## 7. Stage-Specific Detail

Open PR #55 remains unmerged and superseded. Although its files are visible in the planning worktree, selected remote `master` has no `src/shutdown.ts` or `tests/index-shutdown.test.ts`. This stage may reproduce the small observed behavior—release known long-poll waiters before close—but must implement it freshly from the pinned `master` baseline rather than merging or cherry-picking PR #55.
