# Real-Time And Soniox Transcription

## Purpose

Add a provider-agnostic real-time transcription WebSocket backed initially by
Soniox `stt-rt-v5`, and let the existing async `POST /voice/transcribe`
endpoint select OpenAI or Soniox `stt-async-v5` through server configuration.

The server must preserve partial work when it ends a real-time stream, enforce
the user's daily transcription budget, keep provider details out of public
contracts, and scope glossary terms to an opaque user/project identity.

This file is the authoritative implementation plan. Read it together with
`.plans/real-time-transcription/CONSIDERATIONS.md` before implementing a slice.

## Current State

- Plan host: `sesori_auth_server`.
- Planning branch: `real-time-transcription-plan`.
- Implementation PR base branch: `master`.
- Reviewed auth-server remote-tracking baseline: `origin/master` at
  `7334a564ccaf9aa0fb53094eb70ea18875b36a52` from 2026-08-02. Before this plan
  PR, the planning branch was fast-forwarded from its original
  `18155f2853f6928fecf3c28eab1a61de176ee484` branch point to that reviewed
  baseline.
- Before implementing each PR, fetch `origin`, verify the PR branch is based on
  the then-current `origin/master`, and re-audit any changed paths in that PR's
  file map. The recorded SHA is evidence for this plan, not permission to base a
  later PR on a stale commit.
- Client reference baseline:
  `f6ec9e9dc66782197a46261de3bcc002e261a5bd` from 2026-08-02.
- Relay reference baseline:
  `b2064789202e635506601ccd88fee111bf5f6254` from 2026-07-27.
- Implementation status: PR2a active.
- Last updated: 2026-08-03.

The baseline refresh from `18155f2` to `7334a56` changed only `AGENTS.md`,
`src/lib/request-close-signal.ts`, app-client presence implementation/tests, and
the app-client route. The request-close helper change added documentation without
runtime behavior, and the only `AGENTS.md` change reordered existing scaling
bullets. No transcription/glossary/config/composition behavior changed, so the
file maps and timeout design remain valid. Each implementation slice still starts
from its then-current `origin/master`, not merely this recorded planning baseline.

The current async flow is:

1. The authenticated client uploads one AAC/WAV file to
   `POST /voice/transcribe`.
2. `VoiceService` checks the daily usage document and loads the user's global
   glossary.
3. `OpenAIClient` transcribes with the configured OpenAI model and an English
   language setting.
4. `VoiceService` records audio duration and returns
   `{ text, dailySecondsRemaining }`.

The current mobile app records files at these settings:

- Android: AAC-LC, mono, 16,000 Hz.
- iOS and native non-Android: AAC-LC, mono, 44,100 Hz.
- Web: WAV, mono, 44,100 Hz.

The installed `record` 7.1.1 stream API can emit PCM16 on each target. Its iOS
stream implementation converts from the hardware input format, and its web
implementation reports adjusted capture settings.

### Client Compatibility Evidence

The following history checks were run against the client reference repository
at `f6ec9e9dc66782197a46261de3bcc002e261a5bd` on 2026-08-02:

```bash
git grep -n '/voice/glossary' f6ec9e9dc66782197a46261de3bcc002e261a5bd -- client
git log --all --oneline -S'/voice/glossary' -- client mobile
```

Both commands returned no matches. The first command exited 1, as `git grep`
does for no matches. This supports the scoped claim that no glossary caller is
present anywhere in the repository-visible client history; it does not prove
that the public endpoint was never invoked manually. Production data remains
the authoritative migration gate.

The shipped async caller and recorder behavior were checked with:

```bash
git log --all --follow --format='%H %cI %s' -- \
  client/module_core/lib/src/capabilities/voice/voice_api.dart
git diff 0b4e6787c4b3388c25a3b2c1cd0374fd7044ca23 \
  f6ec9e9dc66782197a46261de3bcc002e261a5bd -- \
  mobile/module_core/lib/src/capabilities/voice/voice_api.dart \
  client/module_core/lib/src/capabilities/voice/voice_api.dart
git log --all --follow --format='%H %cI %s' -- \
  client/app/lib/capabilities/voice/audio_format_config.dart
git diff 0b4e6787c4b3388c25a3b2c1cd0374fd7044ca23 \
  f6ec9e9dc66782197a46261de3bcc002e261a5bd -- \
  mobile/app/lib/capabilities/voice/audio_format_config.dart \
  client/app/lib/capabilities/voice/audio_format_config.dart
```

`voice_api.dart` first appears at repository-visible commit `0b4e6787` on
2026-06-11, changed only by the 100%-similar workspace rename `f52be45c`, and at
the reference SHA still calls only `POST /voice/transcribe` with a 30-second
timeout. `audio_format_config.dart` has the same 16,000 Hz Android and 44,100 Hz
other-platform rates at `0b4e6787`; `3f9a2980` on 2026-08-01 made mono and
128-kbps settings explicit without changing those rates. These facts require the
documented downstream increase from 30 to at least 140 seconds before Soniox
async is enabled and justify accepting both current effective rates in the
future stream contract.

## Scope

This plan changes only the auth server.

In scope:

- Keep `POST /voice/transcribe` alive with its existing response contract.
- Add a startup-validated async provider selector with values `openai` and
  `soniox`; default to `openai`.
- Add Soniox async v5 support with prompt resource cleanup.
- Add a provider-agnostic real-time WebSocket proxy backed by Soniox
  `stt-rt-v5`.
- Add project-scoped glossaries keyed by an opaque project key.
- Share admission and daily usage policy across async and real-time modes.
- Update the hosted Privacy Policy before production Soniox processing.
- Add an operational cleanup reconciler for orphaned Soniox async resources.
- Document deployment and scaling constraints.

Out of scope:

- Flutter implementation, UI copy, mobile feature-flag implementation, or
  recorder changes.
- Relay or bridge changes. Provider-readable audio must not enter the E2E relay.
- Direct client-to-Soniox credentials.
- Automatic provider fallback.
- Automatic real-time reconnect, audio replay, or cross-session deduplication.
- Translation, speaker diarization, language labels, or token metadata in the
  public API.
- Persisting audio or transcript content in Sesori storage.
- Changing the existing daily limit or async endpoint's successful response.

## Agreed Product Decisions

- Live audio terminates at the auth server and is proxied to the provider.
- Both public transcription APIs remain provider-agnostic.
- The existing async route and new real-time route remain available together.
- PR13 deploys the real-time route behind
  `REALTIME_TRANSCRIPTION_ENABLED=false`; operations enable it only after the
  trusted-ingress, Soniox, privacy, and capacity gates pass. Disabled means the
  WebSocket route is not registered and returns the normal HTTP 404.
- The async provider is selected globally at process startup; a failed request
  is not retried with the other provider.
- Soniox processing uses the EU regional project and EU REST/WebSocket domains.
- Soniox receives an English language hint without strict restriction, so
  multilingual speech remains possible.
- Soniox semantic endpoint detection is disabled. The client `finish` command
  is the normal authoritative finalization signal.
- Existing glossary terms apply to both Soniox modes when an exact project
  glossary exists.
- Missing `projectKey` or no matching glossary is a valid no-context request.
- Real-time audio is mono signed 16-bit little-endian PCM at exactly 16,000,
  44,100, or 48,000 Hz.
- A real-time session can send at most 15 minutes of audio.
- An independent wall-clock deadline starts when the first bounded `start` frame
  arrives and expires after at most 900 seconds, so tiny frames cannot hold a
  provider/socket indefinitely.
- There is no quota grace. A session is limited to the lesser of 15 minutes and
  the user's remaining daily budget.
- Reaching the session or quota cap gracefully finalizes all attempted-upstream audio and
  returns the transcript; it does not discard the session.
- A user already at or above quota is rejected before a provider connection is
  opened.
- One transcription may be active per user across async and real-time modes.
- The server allows at most 10 active real-time sessions globally.
- The ten-session cap includes admitted pre-`ready` provider handshakes, so slow
  upstream connects cannot bypass capacity.
- A ready stream with no audio for 10 seconds is cancelled upstream and
  completed locally as `audio_timeout` with empty text and zero usage; Soniox
  `finish()` is never called for an empty stream because it rejects that case.
- Real-time starts are limited to 10 per minute per authenticated user.
- Real-time usage is written once at session end, before the terminal event.
- Audio already sent upstream counts on cancel, disconnect, or provider failure.
- A PCM byte becomes locally billable when the outbound `ws.send()` accepts it
  without a synchronous throw. A later callback error/timeout remains billable
  because the provider may have received a prefix; queued bytes never handed to
  `ws.send()` are not billable.
- If the final usage write fails, the server keeps an in-memory pending debit,
  retries the same server-generated operation ID, and rejects further
  transcription for that user until it persists. The MongoDB daily aggregate
  retains every committed operation ID/amount receipt for that UTC day and
  atomically appends the receipt with the increment, so an arbitrarily delayed
  duplicate cannot charge again after newer operations complete.
- Each user may commit at most 10,000 positive transcription debit receipts per
  UTC day. Receipt capacity is checked with durable quota before provider work;
  reaching it has the same HTTP/WS outcome as daily seconds exhaustion. Zero-
  audio sessions append no receipt.
- A hard process crash can still lose up to one complete 15-minute usage debit.
  This is the accepted residual risk of end-only accounting.
- Each socket retains at most 128 KiB/32 frames of client audio including its
  single in-flight provider write; backpressure overflow ends the session and
  charges only bytes already attempted upstream.
- Client-bound transcript sends are also serialized: one callback in flight,
  256 KiB maximum `bufferedAmount`, five-second callback timeout, append-only
  coalescing of unsent final deltas, and replacement of unsent provisional text.
  A slow client is treated as a transport disconnect rather than retaining an
  unbounded event queue.
- Confirmed partial text is returned in a provider-neutral terminal error when
  an active upstream session fails.
- Explicit cancellation returns an acknowledgement only after usage handling;
  it returns no transcript.
- The WebSocket application protocol starts at version 1.

## Public Contract

### Opaque Project Key

The auth server accepts an opaque `projectKey`; it never accepts or persists a
raw bridge project ID or filesystem path for glossary ownership.

The downstream client contract is:

```text
digestInput = "sesori-project-glossary-v1\0" + bridgeId + "\0" + projectId
projectKey = "prj_v1_" + base64url(sha256(utf8(digestInput)))
```

The resulting key is validated as `prj_v1_` followed by the 43-character
base64url SHA-256 digest. The server cannot prove that a caller derived the key
correctly, but authentication confines every key to that user.

Including `bridgeId` prevents collisions between bridge-scoped project IDs.
Using the bridge's stable `Project.id`, rather than its current path, preserves
the key when a project directory moves.

### Async Transcription

`POST /voice/transcribe` remains authenticated multipart form data.

- Required file part: `audio`.
- Optional text field: `projectKey`.
- The route parses parts in any order, allows one file and at most one project
  key, and retains the existing 25 MiB and MIME restrictions.
- Multipart receive is capped at 45,000 ms from route-handler entry. The entire
  handler is capped at 130,000 ms to cover, in order: up to 45 seconds receiving
  the body, 60 seconds provider upload/create/poll/result work, two ordered
  five-second cleanup calls, the PR6 worst-case 10-second MongoDB usage
  write, and five seconds response/dispatch margin.
- The 130-second response-budget timer calls `unref()`, aborts every cancellable
  stage, and prevents a new stage from starting after expiry. Multipart expiry
  returns local HTTP 408; provider/overall expiry returns bounded HTTP 504.
  Cleanup still uses its request-independent controller, but that controller is
  combined with the response-budget and server-disposal signals.
- An omitted key skips the glossary database query entirely.
- A valid key with no entries sends no glossary context.
- A malformed provided key is a 400; it is not treated as missing.
- A user with active/pending work, or a new user when the 1,000-state usage map
  is full, receives typed HTTP 503 with `Retry-After: 1` before provider work. A
  blocked debit or malformed durable usage receives a content-redacted HTTP 500
  accounting error without `Retry-After`. Existing quota exhaustion remains 429.
- The untrusted multipart filename is ignored and never leaves the route/logs.
  The route derives a fixed ASCII provider filename solely from validated MIME:
  `sesori-voice.mp3`, `.m4a`, `.wav`, `.webm`, `.ogg`, or `.flac`; all are under
  32 bytes and match `^sesori-voice\.(mp3|m4a|wav|webm|ogg|flac)$`.
- Success remains exactly:

```json
{
  "text": "transcribed text",
  "dailySecondsRemaining": 3542.5
}
```

The response contains no provider or model field.

The downstream caller must use an end-to-end HTTP timeout of at least 140,000 ms
before Soniox async is enabled. That exceeds the enforced 130-second server
budget by 10 seconds for authentication, TLS/request setup, and final response
transit. A timeout merely above the 60-second provider wait is insufficient.

### Glossary CRUD

Glossary management remains under `/voice/glossary`, but all operations require
an opaque project key:

- `GET /voice/glossary?projectKey=...`
- `POST /voice/glossary` with `{ "projectKey": "...", "words": [...] }`
- `DELETE /voice/glossary` with `{ "projectKey": "...", "words": [...] }`

An exact project with no entries returns `{ "words": [] }`. Limits are 500
terms per project and 5,000 total terms per user. The existing per-word length,
per-request count, duplicate, and authentication rules remain.

### Real-Time Route

Endpoint: `GET /voice/transcribe/realtime` with a WebSocket upgrade.

The endpoint exists only when `REALTIME_TRANSCRIPTION_ENABLED=true`. Before the
upgrade, the route applies these exact process-local controls:

- The typed route registration sets `config: { rateLimit: false }`, disabling
  the existing global `@fastify/rate-limit` hook for this route only. Therefore
  its 100/minute counter and loopback allowlist cannot preempt or bypass realtime
  controls; all ordinary HTTP routes retain existing global limiting.
- Fastify uses `trustProxy: false` when `AUTH_TRUSTED_PROXY_CIDRS` is empty and
  the exact configured CIDR array otherwise. It never uses `trustProxy: true` or
  trusts forwarding headers from any other peer.
- `RealtimeConnectionGate` enforces a fixed-window 12 upgrades/minute per
  derived `request.ip`, with no loopback allowlist. The 13th and later requests
  in that same window receive HTTP 429 without moving the expiry.
- The gate retains at most 4,096 live peer windows. It lazily removes every
  expired window before a full-map decision; if the map remains full, an unseen
  peer receives HTTP 503 with `Retry-After: 1` and is not inserted. Existing
  peers continue to be evaluated in their retained windows, and no live key is
  evicted to admit attacker-controlled IP churn.
- At most 32 upgraded sockets may await authentication. The 33rd receives HTTP
  503 with `Retry-After: 1`. A pending slot transfers directly to authenticated
  admission or is released exactly once on every failure/close/timeout path.
- During shutdown, new upgrades receive HTTP 503 with `Retry-After: 1`.

After the route-level global-limiter opt-out, pre-upgrade order is feature/stop
check, gate-owned peer window/full-map check, then pending-slot acquisition; the
first failing control owns the HTTP response.

`@fastify/websocket` is registered before every route with `maxPayload: 32768`,
`perMessageDeflate: false`, `allowSynchronousEvents: false`, `maxFragments: 16`,
and `maxBufferedChunks: 64`. The payload cap applies to the complete reassembled
message. Oversize input closes 1009 and invalid UTF-8 closes 1007 at the
transport layer; locked `ws@8.21.1` closes its 17th-fragment and
65th-buffered-chunk guards with 1008. Those parser-owned cases receive no JSON
terminal promise.
The lockfile pins `@fastify/websocket@11.3.0`, direct `ws@8.21.1`, and
`@types/ws@8.18.1`. The selected types omit both parser-limit options and the
runtime ESM `Receiver` export. `src/types/ws.d.ts` uses a compile-checked ambient
module merge: extend exported `ServerOptions` with the two optional numbers;
declare exported `ReceiverOptions` with `allowSynchronousEvents`, `binaryType`,
`extensions`, `isServer`, `maxBufferedChunks`, `maxFragments`, `maxPayload`, and
`skipUTF8Validation`; and declare exported `Receiver extends Writable` with its
optional-options constructor. The inherited typed `write`/error-event surface is
enough for the controlled harness. Production options and tests use named ESM
imports directly, with no cast, `any`, suppression, or private subpath import.

```ts
import type { Writable } from "node:stream";

declare module "ws" {
  interface ServerOptions {
    maxFragments?: number;
    maxBufferedChunks?: number;
  }

  interface ReceiverOptions {
    allowSynchronousEvents?: boolean;
    binaryType?: "nodebuffer" | "arraybuffer" | "fragments" | "blob";
    extensions?: Record<string, object>;
    isServer?: boolean;
    maxBufferedChunks?: number;
    maxFragments?: number;
    maxPayload?: number;
    skipUTF8Validation?: boolean;
  }

  class Receiver extends Writable {
    constructor(options?: ReceiverOptions);
  }
}
```

`@fastify/websocket` wraps the older namespace-form server options in `Omit`, so
the ambient top-level merge does not satisfy its excess-property check. PR13
therefore adds this exact local structural type and passes a `satisfies`-checked
variable to `app.register`; the intersection is assignable to the plugin's base
options and preserves both parser fields without a cast:

```ts
import type websocket from "@fastify/websocket";

type WsParserLimits = {
  maxFragments?: number;
  maxBufferedChunks?: number;
};

export type BoundedWebsocketPluginOptions = Omit<websocket.WebsocketPluginOptions, "options"> & {
  options: NonNullable<websocket.WebsocketPluginOptions["options"]> & WsParserLimits;
};
```

The repository's main `tsconfig.json` includes only `src/**/*`, and `tsx` test
execution transpiles without type-checking. PR9 therefore adds
`tsconfig.contract-tests.json` extending the main NodeNext config with
`rootDir: "."`, `noEmit: true`, declaration/maps/source maps disabled, and
`skipLibCheck: false`. Its explicit includes are `src/types/ws.d.ts`, optional
later `src/types/websocket-options.ts`, `tests/lib/ws-parser-limits.test.ts`, and
optional later `tests/types/ws-contract.test.ts`. The npm script
`typecheck:contracts` runs `tsc --project tsconfig.contract-tests.json`; PR9 adds
it to CI, and PR13's later files are picked up by the same config. Both focused
commands and common verification run this script, so neither `tsx` nor the
source-only `npx tsc --noEmit` is treated as type-contract evidence.

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "declaration": false,
    "declarationMap": false,
    "noEmit": true,
    "rootDir": ".",
    "skipLibCheck": false,
    "sourceMap": false
  },
  "include": [
    "src/types/ws.d.ts",
    "src/types/websocket-options.ts",
    "tests/lib/ws-parser-limits.test.ts",
    "tests/types/ws-contract.test.ts"
  ],
  "exclude": ["node_modules", "dist"]
}
```

The access token is not placed in the URL. The first client text frame must
arrive within five seconds, be no more than 4,096 UTF-8 bytes, and be a strict
`start` message. `accessToken` must be ASCII and no more than 2,048 bytes:

```json
{
  "type": "start",
  "protocolVersion": 1,
  "accessToken": "<Sesori access token>",
  "audio": {
    "encoding": "pcm_s16le",
    "sampleRate": 44100,
    "channels": 1
  },
  "projectKey": "prj_v1_<digest>"
}
```

`projectKey` is optional. The model, provider, region, language behavior, and
provider feature flags are server-owned and cannot be selected by the client.

After authentication, admission, quota lookup, optional glossary lookup, and
upstream connection, the server sends `ready` only after the outbound WebSocket
is open and its configuration `ws.send()` callback succeeds. This proves local
transport usability, not provider application acceptance because Soniox has no
separate pre-audio acknowledgement:

```json
{
  "type": "ready",
  "protocolVersion": 1,
  "maxAudioDurationMs": 420000,
  "dailySecondsRemaining": 420
}
```

The client must wait for `ready` before sending binary audio. Binary frames:

- contain raw interleaved PCM bytes with no file/container header;
- must be non-empty and have even byte length;
- have a 32 KiB maximum;
- should normally represent 60-120 ms of audio;
- must match the declared sample rate and mono channel count.

Each connection has a FIFO bounded to 128 KiB and 32 binary frames, including
the one provider write in flight. The route pauses client reads at 96 KiB and
resumes at or below 32 KiB. The provider adapter allows exactly one outbound
audio `ws.send()` callback in flight with a five-second timeout. A frame that
would exceed either queue bound triggers `audio_backpressure_overflow`; queued
but unsent bytes are discarded and uncharged.

Server-to-client sends also allow one callback in flight. While it is pending,
confirmed deltas are coalesced and only the newest provisional string is kept.
Confirmed plus provisional state is bounded to 1,000,000 characters each; the
socket is terminated as a lost transport if `bufferedAmount` exceeds 256 KiB or
a send callback takes five seconds. The service then cancels upstream and
accounts attempted audio without trying another terminal event.

After `ready`, the only valid client text controls are:

```json
{ "type": "finish" }
```

and:

```json
{ "type": "cancel" }
```

The server emits a provider-neutral transcript update:

```json
{
  "type": "transcript",
  "finalTextDelta": "confirmed text emitted once",
  "provisionalText": "replace the prior provisional value",
  "finalAudioMs": 1820,
  "totalAudioMs": 2110
}
```

Final deltas are append-only. Each provisional value replaces the prior
provisional value. No Soniox tokens, confidence values, control tokens, speaker
labels, or language labels cross the public boundary.

Normal or policy-driven completion sends exactly one terminal event before a
normal close:

```json
{
  "type": "finished",
  "reason": "quota_exhausted",
  "text": "the complete finalized transcript accepted before cutoff",
  "audioDurationMs": 420000,
  "dailySecondsRemaining": 0
}
```

`reason` is required and is one of:

- `client_finished`
- `quota_exhausted`
- `session_limit_reached`
- `audio_timeout`

If quota and the 15-minute cap are reached together, `quota_exhausted` wins so
the client can show the actionable budget state.

Explicit cancellation sends no text:

```json
{
  "type": "cancelled",
  "audioDurationMs": 3150,
  "dailySecondsRemaining": 3596.85
}
```

Errors are a discriminated union so start failures cannot accidentally claim an
active-session transcript. Examples:

```json
{
  "type": "error",
  "stage": "start",
  "code": "quota_exhausted",
  "retryable": false
}
```

```json
{
  "type": "error",
  "stage": "active",
  "code": "provider_unavailable",
  "retryable": true,
  "partialText": "confirmed text only",
  "audioDurationMs": 8420,
  "dailySecondsRemaining": 3511.58
}
```

### Exhaustive Terminal Semantics

Every writable upgraded socket gets at most one terminal JSON event followed by
the listed close code. `partialText` always means confirmed text only; provisional
text is discarded. Start errors never contain transcript or duration fields.

Pre-upgrade and parser-owned transport outcomes have no JSON event:

| Trigger                                        | HTTP/transport outcome                               |
| ---------------------------------------------- | ---------------------------------------------------- |
| Feature disabled                               | Normal HTTP 404 because the route is not registered. |
| Upgrade rate exceeded                          | HTTP 429 from `RealtimeConnectionGate`.              |
| Peer-window map full for unseen peer           | HTTP 503 with `Retry-After: 1`.                      |
| Pending-auth capacity full or shutdown started | HTTP 503 with `Retry-After: 1`.                      |
| Reassembled message over 32 KiB                | WebSocket close 1009.                                |
| Seventeenth fragment in one message            | WebSocket close 1008 with no JSON event.             |
| Sixty-fifth parser-buffered chunk              | WebSocket close 1008 with no JSON event.             |
| Invalid UTF-8 text                             | WebSocket close 1007.                                |

Transport/parser failure has precedence over application terminal selection.
Before `ready`, the close handler aborts start/provider work and records no
usage; after `ready`, it discards queued unattempted bytes, cancels provider,
persists attempted bytes, and releases pending/user/global/socket ownership
exactly once. No JSON event is promised because the parser owns the close.

Start-stage outcomes:

| Trigger                                                                                                                                                                         | `code`                      | `retryable` | Close | Provider/usage behavior                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ----------- | ----- | ------------------------------------------------------------------------------------------ |
| No first frame in five seconds                                                                                                                                                  | `start_timeout`             | `true`      | 1008  | No provider and no usage.                                                                  |
| Binary first frame, second frame while start is processing, malformed JSON, unknown field/type, text over 4,096 bytes, JWT over 2,048 bytes/non-ASCII, or malformed project key | `invalid_message`           | `false`     | 1008  | No audio or usage; abort start work and terminate any provider connect that already began. |
| Protocol version is not 1                                                                                                                                                       | `unsupported_protocol`      | `false`     | 1008  | No provider and no usage.                                                                  |
| Encoding, channels, or sample rate is unsupported                                                                                                                               | `unsupported_audio`         | `false`     | 1008  | No provider and no usage.                                                                  |
| Access token is absent, invalid, wrong type/audience/issuer/algorithm, or expired                                                                                               | `unauthenticated`           | `true`      | 1008  | No provider and no usage; client may refresh before retrying.                              |
| Authenticated user exceeds 10 starts/minute                                                                                                                                     | `rate_limited`              | `true`      | 1013  | No provider and no usage.                                                                  |
| Captured-day quota is exhausted                                                                                                                                                 | `quota_exhausted`           | `false`     | 1008  | No provider and no usage.                                                                  |
| User already has active work                                                                                                                                                    | `transcription_in_progress` | `true`      | 1013  | No provider and no usage.                                                                  |
| User has an unresolved final debit                                                                                                                                              | `usage_pending`             | `true`      | 1013  | No provider; retry service retains the debit.                                              |
| User has an operator-blocked debit or malformed durable usage                                                                                                                   | `usage_recording_failed`    | `false`     | 1011  | No provider; operator repair is required.                                                  |
| Ten real-time sessions are active                                                                                                                                               | `capacity_exceeded`         | `true`      | 1013  | No provider and no usage.                                                                  |
| Usage-state/start-window capacity, retryable/ambiguous MongoDB quota read, or glossary lookup fails                                                                             | `service_unavailable`       | `true`      | 1013  | No provider and no usage.                                                                  |
| Absolute wall-clock deadline expires before `ready`                                                                                                                             | `service_unavailable`       | `true`      | 1013  | Abort start work, terminate provider connect, and record no usage.                         |
| Provider handshake/open/configuration fails before `ready`                                                                                                                      | `provider_unavailable`      | `true`      | 1013  | Provider is terminated; no audio usage.                                                    |
| Shutdown begins after upgrade but before `ready`                                                                                                                                | `service_restarting`        | `true`      | 1012  | Provider is cancelled/terminated; no audio usage.                                          |

Active-stage error outcomes:

| Trigger                                                                                                         | `code`                        | `retryable` | Close | Text and usage behavior                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid control, binary order/alignment, empty frame, or post-terminal input                                    | `invalid_message`             | `false`     | 1008  | Cancel provider, persist attempted bytes, return confirmed `partialText`.                                                                 |
| Queue exceeds 128 KiB or 32 frames                                                                              | `audio_backpressure_overflow` | `false`     | 1008  | Discard unattempted queue, cancel provider, persist attempted bytes, return confirmed `partialText`.                                      |
| Synchronous provider/session failure, send callback error/timeout, upstream close/error, or final-drain timeout | `provider_unavailable`        | `true`      | 1011  | Persist attempted bytes; the one non-throwing in-flight send counts; return confirmed `partialText`.                                      |
| Final Mongo command has an ambiguous/unavailable outcome after the bounded immediate attempt                    | `usage_recording_pending`     | `true`      | 1013  | Retain/retry the same operation in memory. Return confirmed `partialText` (empty after explicit cancel) and conservative remaining quota. |
| Final Mongo command has an operator-blocked/receipt-capacity outcome                                            | `usage_recording_failed`      | `false`     | 1011  | Retain but do not retry the exact blocked debit; return confirmed `partialText` and safe internal failure only.                           |
| Server shutdown interrupts a ready session                                                                      | `service_restarting`          | `true`      | 1012  | Stop input, drain confirmed output within the shutdown budget, persist attempted bytes, and return confirmed `partialText`.               |

A debit collision is internal recovery, not a public terminal code: it is an
atomic no-op followed by fresh-operation re-keying under the same correlation.
If re-keying does not resolve within immediate terminal handling, the state and
public outcome become ordinary `usage_recording_pending`.

Normal terminal outcomes:

| Trigger                                                                                           | Event       | Reason                  | Close           | Provider/usage behavior                                                                              |
| ------------------------------------------------------------------------------------------------- | ----------- | ----------------------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| Client `finish` after audio                                                                       | `finished`  | `client_finished`       | 1000            | Finish/drain provider, persist attempted bytes, return complete confirmed text.                      |
| Client `finish` before audio                                                                      | `finished`  | `client_finished`       | 1000            | Cancel/close provider without `finish()`, record no debit, return empty text and unchanged quota.    |
| Quota boundary reached                                                                            | `finished`  | `quota_exhausted`       | 1000            | Slice crossing frame, finish/drain, persist attempted bytes, return complete confirmed text.         |
| Configured wall-clock deadline or non-quota attempted-sample cap reached                          | `finished`  | `session_limit_reached` | 1000            | Stop/slice input, finish/drain after audio, persist attempted bytes, return complete confirmed text. |
| Ten-second idle after at least one attempted audio frame                                          | `finished`  | `audio_timeout`         | 1000            | Finish/drain provider, persist attempted bytes, return complete confirmed text.                      |
| Ten-second idle with zero attempted audio                                                         | `finished`  | `audio_timeout`         | 1000            | Cancel/close provider without `finish()`, record no debit, return empty text and unchanged quota.    |
| Explicit `cancel`                                                                                 | `cancelled` | n/a                     | 1000            | Cancel provider, discard transcript, persist attempted bytes, then acknowledge.                      |
| Client transport disappears, exceeds 256-KiB outbound buffer, or misses five-second send callback | No event    | n/a                     | Transport-owned | Cancel provider and persist attempted bytes; no text can be returned.                                |

After a persisted debit, `dailySecondsRemaining` is calculated from the exact
returned aggregate. While a debit is pending/ambiguous it is conservatively
`max(0, remainingAtAdmission - attemptedAudioSeconds)`. Usage handling happens
before an application terminal event. If the socket disappears first, the same
accounting and retry rules run without attempting a terminal write.

When failures overlap, terminal precedence is: lost client transport (no event),
`usage_recording_failed`, `usage_recording_pending`, `service_restarting`, active
provider/input/overflow error, then normal completion. Within normal completion,
quota beats the simultaneous session cap, a reached cap beats a later queued
client `finish`, and explicit `cancel` wins only if processed before a cap. This
ordering is implemented once in the real-time service, not independently in
socket callbacks.

The error code enum is exactly the values named in these tables. It never
includes provider names, raw SDK messages, audio, glossary terms, access tokens,
user IDs, or project keys. Standard WebSocket close codes remain transport
signals; application meaning comes from the terminal JSON event when one can be
delivered.

## Target Data Model

`glossaryEntries` remains one document per term:

```text
_id: ObjectId
userId: ObjectId
projectKey: string
word: string
createdAt: Date
```

Target unique index:

```text
{ userId: 1, projectKey: 1, word: 1 } unique
```

The old `{ userId: 1, word: 1 }` unique index must be dropped only after the
replacement is confirmed. Repository history found no client caller, so no
legacy assignment/backfill is planned, but production data rather than history
decides whether that strategy is safe.

### Executable Glossary Index Migration

PR1 adds `src/db/glossary-index-migration.ts` as the DB-only implementation and
`src/scripts/migrate-project-glossary-index.ts` as its operator CLI. The package
command is `npm run migrate-project-glossary-index`; it requires only
`MONGODB_URI`, defaults to a read-only dry-run, and supports exactly `--apply`,
`--verify`, or `--rollback` as mutually exclusive modes.

Every mode reports the document count, missing/invalid `projectKey` count,
duplicate-key findings, and exact old/target index state without logging words,
user IDs, or project keys. Operations identify indexes by ordered key spec and
options, not by an assumed generated name.

The migration validates every consumed MongoDB result before use: strict Zod
schemas cover the collection metadata, each list-indexes record, and the bounded
duplicate-count aggregation result; all counters must be nonnegative safe
integers. Unknown/malformed persistence metadata is a closed redacted failure.
The collection must be absent or be a normal collection with no default
collation or an explicit `{ locale: "simple" }` default; dry-run/apply fail before mutation when a non-simple
default collation could be inherited by a newly created index. Same-spec sparse,
partial, collated, hidden, non-unique, or otherwise semantically mismatched old/
target indexes also fail closed.

- Dry-run succeeds only when applying is safe: the collection is empty, or all
  rows already contain a valid `projectKey` and have no duplicate target key. It
  fails on any unscoped/invalid row. The expected first production result is
  zero documents.
- `--apply` repeats the audit, creates the unique
  `{ userId: 1, projectKey: 1, word: 1 }` index, reloads index metadata and
  confirms its exact key order/options and collection collation, repeats the
  complete document/duplicate/index audit, then drops the old index and repeats
  that complete audit again before reporting the final target-only state. It
  never mutates documents or invents a project key.
- `--verify` is read-only and succeeds only when all rows are scoped, the exact
  target unique index exists, and the old index is absent.
- `--rollback` is intentionally narrower: it refuses unless the collection is
  empty, creates and verifies the old unique index first, then drops the target
  index and repeats the complete audit before reporting the old-only state. Once
  any project-scoped term exists, rollback is forbidden and recovery must roll
  forward.
- `--apply` and `--rollback` are idempotent. An interruption after creating the
  replacement but before dropping the old index leaves both indexes and can be
  resumed safely.

Mutating modes are supported only while all auth glossary writers are stopped
and no other migration or manual index DDL runs, from the initial audit through
command exit and capture of its report. Under that maintained exclusion, the
final complete audit is the success boundary; the tool makes no claim against
DDL or writes performed after it exits. Mutation failures return one of these
closed recovery outcomes:

| Observed state after failure/re-audit                                                                            | Outcome           | Required action                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| Valid data/simple collation and only absent/exact old/target indexes, including exact-both interruption; rollback additionally requires zero documents | `safe_to_rerun`   | Keep auth stopped and rerun the same mode; missing required indexes may be recreated.                                 |
| Requested final state passes the complete audit despite a same-mode `IndexNotFound`/create race                  | `completed`       | Treat as success only while the maintenance/DDL exclusion remains held through command exit.                          |
| Any invalid/unscoped/nonempty-for-rollback data, duplicate target key, non-simple collation, or mismatched index | `repair_required` | Keep auth stopped; do not rerun blindly or start either binary. Design and review a separate data/index repair first. |
| Fresh audit itself cannot complete, so current state is unknown                                                  | `repair_required` | Keep auth stopped and restore database observability; inspect with a reviewed read-only audit before further DDL.     |

Tests deterministically inject a legacy row and conflicting index operation
between verification and each drop. Post-drop invalid data/mismatched DDL must
return `repair_required`; separate valid missing-index fixtures return
`safe_to_rerun` and prove an ordinary rerun converges.

`DATABASE_CONFIG` changes to the target index. `MongoDbAccessor.ensureIndexes()`
may create a missing target index but must never drop the old glossary index;
after ensuring indexes it calls the shared assertion and refuses application
startup while the old index remains or the exact target is absent. Destructive
index ownership stays in the explicit operator command.

Production sequence for this single-instance service:

1. Build the PR2 artifact, but pause auto-deploy and keep the old instance
   serving while running the read-only preview:

   ```bash
   sops exec-env env/app/prod.env \
     'npm run migrate-project-glossary-index'
   ```

2. Require a zero-document report. If any row exists, stop this rollout and
   design a product-approved assignment/deletion migration; do not apply PR2.
3. Stop the old auth instance or otherwise enter a maintenance window that
   prevents glossary writes. Do not run old and new binaries concurrently, and
   allow exactly one migration command with no manual glossary index DDL.
4. From the reviewed PR2 artifact, apply and verify with the PR1 command:

   ```bash
   sops exec-env env/app/prod.env \
     'npm run migrate-project-glossary-index -- --apply'
   sops exec-env env/app/prod.env \
     'npm run migrate-project-glossary-index -- --verify'
   ```

5. Start only the PR2 binary, require successful startup and `/health`, then
   exercise keyed glossary CRUD and an unkeyed async transcription smoke test.

There is deliberately no mixed-version window. An old binary omits
`projectKey` on writes and reads every term for the user, so it is semantically
unsafe after project-scoped data exists even though MongoDB could accept some
of its writes. On `safe_to_rerun`, keep auth stopped and rerun the same command.
On `repair_required`, keep both binaries stopped and obtain a separately reviewed
data/index repair; this migration never deletes or assigns terms. After a
successful apply, if PR2 fails before any scoped term is written, keep it stopped,
run `--rollback`, verify, and only then restore the old binary. If any scoped term
was written, do not run `--rollback` or an old binary; repair or redeploy PR2
forward.

`dailyUsage` remains the durable quota source. Repository methods accept a
captured strict `YYYY-MM-DD` UTC date key so a request crossing midnight reads
and writes the same daily document. Add one optional bounded field:

```text
transcriptionDebitReceipts: array (optional, maximum 10,000)
  - operationId: UUID string (unique within the array)
  - seconds: positive finite number
```

Runtime validation rejects duplicate operation IDs as malformed persistence.
Existing documents require no backfill and the existing unique
`{ userId: 1, date: 1 }` index does not change. Metadata increments preserve the
receipt array. An absent array means zero receipts. Do not add a TTL to
`dailyUsage`; activation reconciliation uses its historical metadata rows, and
receipts must remain durable so a delayed command can never become eligible
again. Ten thousand worst-case UUID/number receipts must encode below 4 MiB in a
MongoDB BSON-size test, leaving substantial headroom below the 16-MiB document
limit for existing fields. The receipt is account-linked usage metadata retained
with the existing daily document: random operation UUID and exact billed seconds
only, with no per-operation timestamp, provider, project, audio, or transcript.

PR5 introduces this field and PR6 introduces `TranscriptionUsageService` before
Soniox can be selected. Its pre-buffer usage lease captures one UUID operation
ID, one content-free `tdc_` + 22-character base64url correlation ID, and one UTC
date; PR11 reuses that ownership for real-time work. Finalization calls one
repository operation with the same ID/date/exact seconds.

`DailyUsageRepository.readTranscriptionUsage(userId, date)` reads the complete
bounded daily document inside the repository, calls `dailyUsageSchema.safeParse`,
and validates every receipt, array size, and operation-ID uniqueness before it
returns only `{ transcriptionSeconds, receiptCount }`. No receipt leaves the
repository. A missing document returns both values as zero; any malformed
receipt anywhere in the array fails closed before provider work. A count of
10,000 is daily quota exhaustion.

For a positive final debit, the repository issues exactly this logical
`findOneAndUpdate` command using typed driver values rather than raw JSON:

```text
filter = {
  userId: ObjectId(userId),
  date,
  transcriptionDebitReceipts: {
    $not: { $elemMatch: { operationId } }
  },
  $expr: {
    $lt: [
      { $size: { $ifNull: ["$transcriptionDebitReceipts", []] } },
      10000
    ]
  }
}

update = {
  $inc: { transcriptionSeconds: seconds },
  $push: { transcriptionDebitReceipts: { operationId, seconds } },
  $set: { updatedAt: now },
  $setOnInsert: {
    _id: new ObjectId(),
    userId: ObjectId(userId),
    date,
    createdAt: now
  }
}

options = {
  upsert: true,
  returnDocument: "after",
  writeConcern: { w: "majority" },
  timeoutMS: min(2000, remainingCallerCutoffMs),
  comment: "sesori-transcription-debit-v2"
}
```

`transcriptionSeconds` appears only in `$inc`; the insert starts at `seconds`
without a conflicting `$setOnInsert`. The receipt path appears only in `$push`.
The caller does not dispatch when its cutoff has no time left. Automatic driver
retryable-write replay is safe because the same filter/update remain
receipt-idempotent. Outcomes are:

- a non-null, fully validated updated/upserted document returns `committed` with
  the exact resulting total;
- a null result or MongoDB duplicate-key response performs one complete bounded
  document read and full schema/integrity validation; same ID/seconds returns
  `committed`, same ID/different seconds returns `collision`, and no ID at a full
  count returns `receipt_capacity`;
- only code 11000 whose `keyPattern` and `keyValue` exactly identify the existing
  `(userId, date)` unique index is the expected metadata-upsert race; an
  unexpected duplicate key is `operator_blocked_not_applied`;
- if that full read finds no matching ID below capacity, the repository reruns
  the same conditional command once, only while the caller cutoff remains, and
  never recurses: it tracks whether either invocation had unknown dispatch
  status. After the rerun, two exact expected 11000 results plus a valid full read
  with no matching ID below capacity return
  `operator_blocked_not_applied`/`metadata_race_unresolved`; any null/unknown
  invocation followed by that same terminal read returns
  `operator_blocked_unknown`/`metadata_race_commit_unknown`; it never retries a
  raw `$inc`;
- local command validation or malformed persistence found before invocation and
  MongoDB server codes 2 (`BadValue`), 13 (`Unauthorized`), 14 (`TypeMismatch`),
  121 (`DocumentValidationFailure`), 10334 (`BSONObjectTooLarge`), or unexpected
  11000 duplicate key are `operator_blocked_not_applied`, but only when no
  write-concern/unknown-commit/retryable-write label makes commit status unknown;
- `MongoServerSelectionError`, `MongoNotConnectedError` before command selection,
  or an error carrying MongoDB's `NoWritesPerformed` label is
  `retryable_not_applied`;
- network/socket/driver timeout or cancellation after invocation,
  `MongoWriteConcernError`, any `RetryableWriteError`/unknown-commit label, and
  unknown transport/server outcomes are `ambiguous`; a malformed returned
  document or malformed resolution read after invocation is
  `operator_blocked_unknown` because the command may have applied.

The repository adapter uses exact MongoDB 7 exported error classes, numeric
codes, that exact deterministic-not-applied code allowlist, `errorLabels`,
`keyPattern`, and `keyValue`; it never string-matches error messages or assumes
an unknown `MongoServerError` did not apply. Each safe outcome includes only a
closed reason enum and commit status, never a driver error or command/document
content. Unit adapter fixtures and MongoDB 7 failpoint integration tests pin
every class above, including timeout during the one metadata-race rerun.
Classification precedence is: validate local input; resolve the exact expected
11000 race by full read; honor `NoWritesPerformed`; classify transport,
write-concern, retryable-write, timeout, and cancellation uncertainty; then use
the deterministic code allowlist; everything else is ambiguous.

Concurrent same-operation commands serialize at the one daily document: the
first append wins and every later copy fails the absence predicate. Because that
receipt is never overwritten by newer operation IDs, even an original command
that completes after a retry, lease release, and later transcription remains a
no-op. Metadata updates never alter receipts. `receipt_capacity` is rejected at
admission as daily quota exhaustion; seeing it during finalization is an
invariant/scaling violation. It retains a user-blocking `blocked` state without
automatic retries and emits one content-redacted operator error.

The one-user usage lease from PR6 onward prevents a newer operation for that user
while the current debit is resolving. A retry with the same payload either
applies once or observes the durable matching receipt. All retries/in-flight
callbacks carry the lease generation and are fenced before release.
Post-dispatch failures remain `ambiguous` until a matching durable receipt is
observed or their PR6 inline window ends. Generation fencing controls callbacks;
durable receipts, not process state, provide database-command idempotency.

`retryable_not_applied` retries the same ID within the inline window and then
uses ordinary pending backoff. `operator_blocked_not_applied` and
`operator_blocked_unknown` are never automatically retried: before provider work
either fails closed immediately; after validated provider work either retains
the exact process-local debit in a blocked user state, returns the defined
internal accounting failure, appears in shutdown diagnostics, and requires
operators to repair persistence/permissions and restart the same version. That
restart can lose this in-memory debit, within the explicitly accepted
hard-process-loss window; the plan distinguishes known-no-write from unknown
commit state in diagnostics.

The usage lease also keeps a sticky private `commitMayHaveOccurred` bit. Any
`ambiguous` result sets it; later known-not-applied retries cannot clear it. If a
later terminal repository outcome is operator-blocked/not-applied or receipt
capacity while that bit is set, the service retains/reports the blocked debit as
unknown commit status. Only a durable matching receipt proves committed and
permits release.

A `collision` never increments or creates an unrecoverable failed state: retain
the same correlation/date/seconds, generate a fresh UUID, and re-run the
conditional operation. After three immediate re-key attempts, PR6/PR11 transition
to ordinary non-evicting `pending` backoff with a fresh UUID per collision. Safe
structured logs contain only correlation ID, attempt count, and outcome, never
user ID/date/audio/transcript. Atomic no-op-on-collision plus fresh-ID apply is
the executable repair; a committed result releases the state, and an
ambiguous result follows the same pending semantics.

Durable receipts provide idempotency across all later operations and process
callbacks for a committed command. A hard process exit can still lose an
uncommitted full debit because the audio/amount exists only in memory, as already
accepted; a committed ambiguous write remains charged once in MongoDB. Rollback
needs no data migration because old binaries ignore the optional receipt array
and read the aggregate, but never run old and new binaries concurrently or start
a raw writer before the stopped-auth database drain passes.

No audio, transcript, provider token, provider job ID, or project path is added
to MongoDB.

### Legacy Writer Drain And Receipt Erasure

Stopping the old Node.js process does not by itself prove that MongoDB has no
already-dispatched legacy raw `$inc`. PR5 therefore adds a separately
permissioned maintenance boundary and CLI,
`npm run maintain-transcription-usage:drain:prod`, before PR6 changes the
live writer. `src/config.ts` owns a dedicated `maintenanceConfigSchema` and
`loadMaintenanceConfig()` that validates `MONGODB_MAINTENANCE_URI` plus
`TRANSCRIPTION_MAINTENANCE_MODE=drain|erase`; the CLI must use that loader and
reject a mode/argument mismatch. Normal `loadConfig()` neither requires nor
returns either maintenance value.

Maintenance secrets use two independently permissioned MongoDB identities and
two tracked SOPS+age files covered by `.sops.yaml`'s existing `env/app/*.env`
creation rule:

- `env/app/transcription-drain.env` contains only
  `TRANSCRIPTION_MAINTENANCE_MODE=drain` and the drain identity's encrypted
  `MONGODB_MAINTENANCE_URI`. Its custom MongoDB role has cluster actions
  `inprog`/`killop` and no auth-database read/write/delete privilege.
- `env/app/transcription-erasure.env` contains only
  `TRANSCRIPTION_MAINTENANCE_MODE=erase` and the separate erasure identity's
  encrypted URI. Its role has `inprog`/`killop` plus only `find`/`remove` on the
  auth `dailyUsage` collection; it has no insert/update or other collection
  privilege.

Database administrators provision those two users/roles out of band and place
only their URIs into the corresponding encrypted files with
`npm run env:edit:transcription-drain` and
`npm run env:edit:transcription-erasure`. Plaintext URI/password values never
enter git, shell arguments, docs, logs, or `env/app/prod.env`.

`package.json` owns the only production invocations:

```text
start:prod = sops exec-env env/app/prod.env \
  'env -u MONGODB_MAINTENANCE_URI -u TRANSCRIPTION_MAINTENANCE_MODE tsx src/index.ts'

maintain-transcription-usage:drain:prod = \
  sops exec-env env/app/transcription-drain.env \
  'env -u MONGODB_URI tsx src/scripts/maintain-transcription-usage.ts \
    --drain-writes --auth-stopped'

maintain-transcription-usage:erase:prod = \
  sops exec-env env/app/transcription-erasure.env \
  'env -u MONGODB_URI tsx src/scripts/maintain-transcription-usage.ts \
    --erase-user-stdin --auth-stopped'
```

The `env -u` guards prevent accidental inherited runtime/maintenance credential
mixing in either direction. `start:prod` loads only `prod.env`, which must not
contain either maintenance key; maintenance commands load exactly one dedicated
file and never load `prod.env`. `env:update-keys` already covers both because it
iterates `env/app/*.env`.

The command requires an explicit `--auth-stopped` assertion and a maintenance
window in which every auth process is removed from ingress, gracefully stopped,
confirmed absent, and its MongoClient sockets are closed. Through a small raw
MongoDB maintenance repository it then:

1. Runs `$currentOp` with the privileged credential and identifies only
   `findAndModify`/update commands for the auth `dailyUsage` collection whose
   update has `$inc.transcriptionSeconds`; this covers the legacy raw writer and
   receipt writer without selecting metadata-only increments.
2. Calls `killOp` for every match without logging operation documents, user IDs,
   filters, or values. Unknown command shapes touching `transcriptionSeconds`
   fail the command closed for manual investigation rather than being ignored.
3. Repeats scan/kill until five consecutive 500-ms scans contain no matching
   operation. The quiet interval exceeds the v2 command's two-second `timeoutMS`;
   pre-v2 commands have no trusted timeout and therefore must be killed and
   observed absent.
4. Returns a content-free count/outcome report. Any missing privilege, failed
   kill, reappearing operation, scan timeout, or non-absent auth process blocks
   cutover; PR6 cannot start or accept transcription.

PR6's first deployment must execute this gate after stopping the legacy binary
and before starting the receipt-backed binary. This is the executable fence for
an arbitrarily delayed legacy command; ordinary no-mixed-version replacement
alone is insufficient.

Receipts follow the existing `dailyUsage` operational/account-data retention and
have no new fixed automatic expiry in this implementation. The repository has no
authoritative account-closure date or retention job, so this plan does not make
an unenforceable maximum-retention promise. Before PR6 collection, legal/product
must approve privacy wording that accurately states the purpose/retention
criteria and verified erasure process. Because deleting a receipt while an old
command can still execute would make that command eligible again, operators run
exactly `npm run maintain-transcription-usage:erase:prod` under the global
stopped-auth drain above. That script loads only
`env/app/transcription-erasure.env`, verifies erase mode, and reads one ObjectId
from stdin so personal data does not appear in a process list or command history.
After the five-scan zero-operation proof, it deletes all `dailyUsage` documents
for the validated user ID, verifies zero remain, and requires auth to stay
stopped until verification completes. Continued use after restart can create new
daily usage; no pre-erasure command can recreate it because every producer/socket
is absent and every dispatched transcription write was killed and observed
absent.

PR5's dedicated `MongoMemoryServer` harness pins MongoDB 7.0.24 and starts it with
`--setParameter enableTestCommands=1`. It blocks a legacy raw `findAndModify` and
a receipt-backed command with failpoints, runs the maintenance drain, and proves
neither can increment after two newer receipt operations. It also races receipt
finalization with `--erase-user-stdin` and proves the document cannot reappear
after verified deletion. Tests create both MongoDB roles and prove drain cannot
read/delete `dailyUsage`, erasure cannot insert/update or access another
collection, and swapped SOPS modes fail before connection. They also cover
unknown command shapes, failed `killOp`, quiet-window reset, no-content logging,
and refusal without `--auth-stopped`. Production use remains a manual, audited
privacy/rollout operation; no app route receives maintenance privilege.

### Repository Runtime Validation

MongoDB collection generics are compile-time only. Repositories treat every
document and write/update result as untrusted and call `safeParse` before reading
fields; malformed persistence throws a content-redacted `InternalServerError`.

- `GlossaryEntryRepository` validates every found `GlossaryEntry`, validates
  non-negative safe-integer count/write-result fields, and returns only local
  values such as sorted `string[]`, inserted words, or deleted count. A service
  never receives a Mongo document or `ObjectId`.
- `DailyUsageRepository` validates every complete found/pre-update `DailyUsage`
  document, every receipt, operation-ID uniqueness, the 10,000 bound, numeric
  totals, and acknowledged update outcomes. It returns only provider-neutral
  numbers and the closed `committed`/`collision`/`receipt_capacity`/
  `retryable_not_applied`/`ambiguous`/`operator_blocked_not_applied`/
  `operator_blocked_unknown` DTO; no receipt array, document, driver error, or
  ObjectId crosses into a service.
- Repositories perform all string-to-`ObjectId` conversion and validate IDs/date
  keys before a query. Logs include only safe error type/context, never malformed
  document contents.

Repository tests seed malformed documents through the raw test collection and
verify fail-closed errors, DTO-only outputs, write-result checks, and no content
logging. Receipt tests include a malformed nonmatching receipt, duplicate IDs,
invalid UUIDs, non-positive/non-finite seconds, and arrays above 10,000 so a
partial matching projection cannot accidentally satisfy this boundary.

All voice repository, provider, config, and protocol Zod failures pass through
one bounded diagnostic helper before logging. It emits at most eight entries
containing only Zod `code` and a path made from compile-time allowlisted schema
field names/numeric indices; every other string segment becomes `<field>`. It
never returns issue messages, input/received values, unknown-key arrays, raw
issues, or a `ZodError`. Callers never attach the raw failure/provider payload to
`ApiError.nestedError`, so the existing global error logger cannot leak it.

`ApiError` gains an optional typed positive-safe-integer `retryAfterSeconds`.
`ServiceUnavailableError` fixes it to `1`; the global Fastify error handler sets
exactly `Retry-After: <seconds>` before its existing JSON body. The handler does
not accept arbitrary response-header maps or infer headers from messages. Every
planned overload/shutdown HTTP 503 uses this class; ordinary 4xx/5xx errors do
not acquire the header.

## Internal Architecture

### Local Provider Boundaries

Add local transcription enums and provider interfaces under
`src/types/transcription.ts`, with public Zod protocol/input schemas under
`src/models/voice.ts`. Services depend on these local interfaces, never on
Soniox SDK types.

- `OpenAIClient` implements the async transcription interface while retaining
  chat completion responsibilities used by session metadata. Its transcription
  response crosses `src/api/openai.ts`, never directly into the service.
- `SonioxAsyncClient` adapts `@soniox/node` job/resource concerns;
  `SonioxRealtimeClient` uses the locked direct `ws` transport for send
  callbacks. Both translate through shared raw response/event/error validators
  in `src/api/soniox.ts` and expose only local values.
- The composition root selects one async implementation from
  `ASYNC_TRANSCRIPTION_PROVIDER` and injects it into `VoiceService`.
- The real-time service receives the local real-time interface. No public
  contract assumes Soniox.
- Neither mode automatically falls back to another provider.

Both async adapters `safeParse` every consumed external value into the same
bounded local result: transcript text must be non-empty after trimming and at
most 1,000,000 characters; duration must be finite, positive, and no more than
86,400 seconds. OpenAI duration is locally derived but still validated before it
enters the provider-neutral result. Empty, malformed, oversized, or out-of-range
values map to a local invalid-provider-result error; raw provider values and
messages never reach logs or HTTP responses.

Soniox configuration for both modes:

- EU region.
- Explicit v5 model from validated configuration.
- `language_hints: ["en"]`.
- `language_hints_strict: false`.
- No language identification, diarization, or translation.
- Project glossary mapped to `context.terms` when non-empty.
- Deterministic alphabetic glossary prefix bounded to a conservative 8,000
  characters; log only included/omitted counts.
- Random `client_reference_id` with a fixed Sesori prefix and no user/project
  data.

Real-time additionally uses raw PCM configuration and disables endpoint
detection.

### Async Pre-Buffer Admission

`AsyncTranscriptionGate` is composed from PR3 onward and is acquired after JWT
authentication but before calling `request.parts()`, reading a file stream, or
allocating its Buffer. It grants at most one permit/user and two permits
process-wide. Every permit reserves the full 25 MiB upload allowance and is held
until provider/accounting work releases the request Buffer; two permits bound
raw file Buffers to 50 MiB and approximately 100 MiB when allowing one
provider-side copy per request.

The gate never queues upload requests. A same-user second request or third
global request receives HTTP 503 `service_unavailable` with `Retry-After: 1`
before body retention. Each permit owns a lifecycle abort signal. Request close
or shutdown aborts cancellable body/provider work, but the permit releases only
in terminal `finally` after any required cleanup/accounting no longer retains the
Buffer; all malformed/timeout/error/success paths release exactly once. During
shutdown the gate stops acquisition and aborts body reads immediately. This gate
is process-local and joins the existing single-instance constraint.

### Async Service Flow

1. Start the 130-second response budget at route-handler entry, authenticate,
   apply the existing request rate limit, acquire the pre-buffer permit, then
   (from PR6 onward) ask `TranscriptionUsageService` to acquire/pre-check an
   opaque lease before any multipart read. If usage admission fails, release the
   body permit; only the usage service can see the captured date/operation/
   correlation.
2. Parse one audio file and optional `projectKey` within the 45-second multipart
   receive budget while holding the permit.
3. Reject at quota from the usage service's admission result; do not perform a
   second caller-owned usage read/date calculation.
4. Skip glossary lookup when the key is absent; otherwise load only the exact
   `(userId, projectKey)` terms and bound provider context.
5. Invoke only the configured async provider with the request-close abort
   signal.
6. For Soniox, upload, create, wait up to 60 seconds, fetch text/duration, and
   immediately delete the file and transcription in cleanup.
7. Pass successful duration and the opaque lease to
   `TranscriptionUsageService.finalize()`; the service supplies its private date
   and operation ID to the idempotent repository update.
8. On committed usage (new append or matching durable receipt), return the
   unchanged response with exact remaining quota and release. PR6 follows its
   bounded inline matrix for collision/ambiguity: unresolved ambiguity or
   collision re-keying transitions the lease to pending, returns the same success schema with
   conservative `max(0, remainingAtAdmission - durationSeconds)`, and blocks
   follow-up transcription while retrying.

OpenAI retains its existing 60-second timeout, MIME handling, local duration
fallback, and response behavior. Provider errors are translated to local HTTP
errors without leaking provider bodies.

### Async Deadline And Debit Matrix (PR6 Onward)

PR6 must be accounting-safe before Soniox is selectable; together PR5/PR6
introduce the bounded durable daily receipt array, repository operation,
active/pending/blocked usage map, and background retry scheduler. Absolute latest
stage cutoffs from route-handler entry are: body T+45, validated provider result
T+105, ordered cleanup T+115, usage handling T+125, and response T+130 seconds.
A validated transcript reserves/proceeds to its usage window even when cleanup
fails; no optional stage can consume that window.

| Event at async boundary                                                 | Cleanup                                                                                                                         | Debit behavior                                                                             | HTTP/permit behavior                                                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Malformed/oversized body or body timeout before provider                | None beyond any owned upload that somehow exists                                                                                | No debit.                                                                                  | 4xx/408; release body permit exactly once.                                                                                           |
| Provider fails/times out/aborts without a validated transcript+duration | Run the resource-state matrix within its independent calls/deadline.                                                            | No debit.                                                                                  | Translated provider error/504 if writable; release after cleanup.                                                                    |
| Client disconnects before validated provider result                     | Abort provider through request/permit signal; still perform required owned-resource cleanup.                                    | No debit.                                                                                  | No response; release after cleanup.                                                                                                  |
| Client disconnects after validated provider result                      | Continue request-independent cleanup and usage.                                                                                 | Dispatch the captured idempotent debit.                                                    | No response; release only after usage handling/cutoff.                                                                               |
| Immediate cleanup fails or times out after validated result             | Leave resource for reconciler and continue at the fixed usage cutoff.                                                           | Dispatch debit; cleanup failure never suppresses accounting.                               | Preserve success/error selected by usage outcome if writable.                                                                        |
| Usage returns `committed`                                               | Already complete.                                                                                                               | Matching receipt proves exactly one debit; use exact returned total.                       | Return unchanged success JSON if before T+130; release.                                                                              |
| Usage returns `collision`                                               | Usage service keeps correlation/date/seconds, generates a fresh UUID, and retries up to three times within T+125.               | Every collision is an atomic no-op; first committed replacement debits once.               | Success after recovery; after three immediate collisions transition to pending re-key backoff and user blocking.                     |
| Usage command is ambiguous                                              | Retry the same operation within the reserved T+125 window; durable receipt resolves committed replies without double increment. | If still ambiguous at T+125, retain the exact operation in the non-evicting pending map.   | Return success with conservative remaining quota if writable, otherwise 504/no response; release body permit but retain usage state. |
| Usage returns `retryable_not_applied`                                   | Retry the same ID within T+125; transition to ordinary pending backoff at cutoff.                                               | Definitively not charged by that attempt.                                                  | Same conservative success/504 behavior as ambiguity; release body permit but retain usage state.                                     |
| Usage returns either operator-blocked outcome                           | Do not retry; retain exact lease/amount and emit one safe operator error with known/unknown commit status.                      | Known-not-applied or unknown exactly as returned; never claim success.                     | 500/no response if writable; release body permit but keep the user blocked until repair/restart.                                     |
| Finalization unexpectedly returns `receipt_capacity`                    | Do not issue another ID or unsafe increment; retain the exact lease and alert.                                                  | Known not applied; valid single-instance admission should make this unreachable.           | 500/no response if writable; release body permit but keep the user blocked for operator repair.                                      |
| Scheduler stall/shutdown reaches T+125 before any usage dispatch        | Store the known duration on the active lease and transition it to pending; do not start an unowned late write.                  | The owned retry scheduler dispatches after the inline window if the process remains alive. | 504 if writable, otherwise no response; release body permit but retain usage state.                                                  |
| Response delivery fails/expires after committed usage                   | Cleanup/accounting stay complete.                                                                                               | Debit remains exactly once.                                                                | No retry/no second response; release.                                                                                                |

All PR6 retry callbacks carry the usage-lease generation. Body permit release
waits until no Buffer is retained, but unresolved accounting remains in the
bounded usage map and blocks the user before any later body buffering. PR11
reuses the same receipt/pending scheduler for real-time rather than changing
persistence semantics. A hard process loss remains the explicit end-only
residual risk.

### Shared Admission And Usage

A small `TranscriptionUsageService` owns the process-local state needed by both
modes:

- one `Map<userId, UsageState>` containing active, pending-debit, or
  operator-blocked states, capped at 1,000 users;
- one active lease per user, with a UUID operation ID, generation, captured UTC
  date, pre-checked remaining seconds, and durable receipt count below 10,000;
- reservation of the map slot before provider work, so a later failed debit can
  never require unbounded state;
- final receipt-backed idempotent usage persistence before successful lease
  release;
- one global retry scheduler, never one timer per user, with operation-ID-stable
  jittered delays of 1, 2, 4, 8, 16, then at most 30 seconds, at most 50 due
  entries selected per pass, and at most 10 MongoDB operations concurrently;
- two-second per-attempt MongoDB timeout and indefinite retention/retry of
  pending entries during process life, but no retries for operator-blocked
  entries;
- rejection of new work for a pending user with typed service-capacity behavior,
  rejection of an operator-blocked user with the internal accounting failure,
  and service-capacity rejection for a new user when all 1,000 slots are
  occupied;
- no TTL or eviction for pending/blocked debits; committed and zero-audio states
  are removed only after their timer/in-flight generation is fenced;
- graceful disposal that stops admission/scheduling and uses at most five
  seconds for one final pass over the 50 oldest pending entries with the same
  concurrency/operation limits.

`acquire(userId, mode)` returns a branded opaque lease token plus only the
pre-checked remaining seconds; seconds exhaustion or 10,000 receipts returns the
same daily-quota outcome. `finalize(lease, seconds, cutoff)` and
`abandon(lease)` are the only caller operations. The token does not expose date,
operation UUID, correlation ID, generation, retry count, or mutable state;
`VoiceService`, the WebSocket route, and `RealtimeTranscriptionService` neither
generate nor store those values. Every retry/re-key callback resolves its token
back through the service-owned map and generation fence.

An admission integrity failure maps to the internal accounting failure before
body/audio retention or provider work and releases the newly reserved map slot.
A blocked post-provider debit keeps its slot and exact amount until process exit;
shutdown reports pending and blocked counts separately and never represents a
blocked state as drained.

The sole retry scheduler timer is rescheduled to the earliest due entry and
calls `unref()`. The service must not contain Fastify or provider SDK concerns.
Collision re-keying uses the same scheduler/pending bound and never creates a
separate unrecoverable state.

This state is process-local by explicit decision. It is correct for the current
single-instance deployment, but multiple auth instances could admit one
transcription each for the same user. Add this to `AGENTS.md` beside the existing
single-instance constraints.

### Process-Local Ownership And Bounds

Every new process-local resource has one owner and an explicit full-state rule:

| Owner                          | State                                  | Bound/removal                                                                                                    | Full-state behavior                                                                                              |
| ------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `AsyncTranscriptionGate`       | Buffered async request permits         | One/user and two globally; each reserves 25 MiB through provider/accounting                                      | Reject before multipart read with HTTP 503 and `Retry-After: 1`; never queue.                                    |
| `GlossaryService`              | Per-user glossary mutation queues      | Four retained mutations/user and 256 globally, including executing work; remove empty user queues                | Reject before retaining request data with HTTP 503 and `Retry-After: 1`.                                         |
| `RealtimeConnectionGate`       | Per-peer upgrade windows               | 4,096 fixed one-minute entries; lazy expiry/full prune; no live eviction                                         | Return rate/capacity outcome; route maps to HTTP 429 or typed 503/`Retry-After: 1`.                              |
| `RealtimeConnectionGate`       | Pending unauthenticated leases/counter | 32 sockets; release/transfer exactly once                                                                        | Return capacity outcome; route maps it to typed HTTP 503/`Retry-After: 1`.                                       |
| `RealtimeTranscriptionService` | Authenticated start-window map         | 10,000 users; each holds at most 10 timestamps; lazily remove timestamps older than 60 seconds and empty entries | After a full-map prune, reject a previously unseen user with `service_unavailable`. No rate-window timer exists. |
| `RealtimeTranscriptionService` | Active session map/global count        | Exactly 10 sessions; remove through one idempotent terminal owner                                                | Reject with `capacity_exceeded`.                                                                                 |
| `TranscriptionUsageService`    | Active/pending user states             | 1,000 users; no pending eviction during process life                                                             | Reject with typed HTTP 503/`Retry-After: 1` or WS `service_unavailable`; hard-restart loss remains explicit.     |
| Per-connection route session   | Pending audio FIFO                     | 128 KiB and 32 frames including one in flight                                                                    | Emit `audio_backpressure_overflow`, discard unsent audio, and close 1008.                                        |
| Per-connection route session   | Client-bound send/coalescing state     | One send, 256-KiB socket buffer, five-second callback, 1,000,000 confirmed plus 1,000,000 provisional characters | Treat as transport loss; cancel provider and account without another event.                                      |
| `SonioxCleanupService`         | Sweep interval/current sweep           | One interval and one in-flight sweep                                                                             | Skip overlapping ticks; disposal stops new pages/deletes.                                                        |

First-frame, idle, absolute-session, provider handshake/send/drain, retry, and
cleanup timers all call `unref()` and are cancelled by their owner. The single
hard shutdown deadline remains referenced deliberately so the process cannot
hang past its termination budget.

`GlossaryService` alone owns glossary cap checks, repository calls, and mutation
admission; `VoiceService` requests exact-project words but owns no glossary
queue. Mutation admission counts the executing operation in both limits. A
request-close signal removes a not-yet-started mutation and releases both slots;
an already-dispatched MongoDB operation is allowed to settle but cannot write a
reply, and releases in `finally`. Shutdown rejects new mutations, cancels all
queued/not-started work, and waits at most five seconds for executing operations
before the existing MongoDB close sequence. No queued request data is evicted to
make room for newer work.

### Real-Time Service Flow

The WebSocket route owns protocol validation and serialization. A dedicated
real-time transcription service owns admission, provider lifecycle, byte
accounting, timers, transcript accumulation, and terminal outcome selection.

1. Register bounded WebSocket support before all routes; acquire the 32-slot
   pending lease in a pre-upgrade hook and synchronously attach socket handlers
   before asynchronous work.
2. Require and byte-bound `start` within five seconds. Keep the synchronous
   listener active in `starting`; any additional text/binary frame atomically
   selects `invalid_message`, aborts start work, and prevents `ready` even when
   frames arrive back-to-back.
   Every awaited start step rechecks the state/generation before the next DB or
   provider side effect; a provider connect already in flight is terminated.
   Start the absolute wall-clock session timer at receipt of this first frame,
   before authentication/provider awaits.
3. Verify the Sesori access token with `TokenService`, then `safeParse` its
   unknown result with the existing `accessTokenPayloadSchema`; never log the
   frame or token.
4. Apply the 10/minute per-user start limit, then acquire the one-user lease and
   global 10-session slot while atomically transferring/releasing the pending
   authentication lease. Every schema-valid authenticated start consumes the
   user-rate slot even when a later quota/capacity/provider check rejects it.
5. Read usage. Reject at/above quota without opening Soniox.
6. Set
   `maxSamples = floor(min(configuredMaxSessionSeconds, dailySecondsRemaining) * sampleRate)`
   and reject as quota-exhausted if it is zero. Attempted duration is always
   derived from whole PCM16 samples, never a wall clock.
7. Load exact project terms only when `projectKey` is present.
8. Open the outbound `ws` provider connection, send configuration, and send
   `ready` only after the configuration write callback succeeds.
9. Enqueue inbound binary frames under the 128-KiB/32-frame bounds, pause/resume
   at the documented watermarks, and reject binary-before-ready, empty,
   odd-length, oversized, overflow, or post-terminal frames.
10. Forward exactly one provider write at a time. Slice the frame first when it
    crosses the remaining sample budget. A synchronous `ws.send()` throw leaves
    those bytes uncharged; any non-throwing call moves the whole slice to
    attempted/billable duration before awaiting its callback.
11. Reset the 10-second idle timer on each non-throwing provider audio send, not
    merely on client enqueue.
12. Normalize provider results into final deltas and replaceable provisional
    text while retaining complete confirmed text server-side.
13. On client finish or a policy cutoff after audio, stop accepting audio, drain
    the local queue only up to the selected cutoff, gracefully
    finish Soniox, drain final results, and select the terminal reason.
    The wall-clock timer is independent of sample accounting: if it fires first,
    use `session_limit_reached`; if a sample cap fires first, use the terminal
    table's quota/session precedence. Before `ready`, an otherwise-impossible
    wall deadline maps to start `service_unavailable`.
14. On zero-audio idle, cancel/close Soniox without calling its unsupported
    empty-stream `finish()`, then return local `audio_timeout` with empty text.
15. On explicit cancel or socket loss, stop Soniox without returning transcript
    text, but still persist exact attempted-upstream duration.
16. On provider failure, do not reconnect. Persist attempted duration and return
    confirmed partial text when the client socket remains available.
17. Persist usage before `finished`, `cancelled`, or active `error` is sent;
    unresolved ambiguous/retryable-not-applied outcomes retain the same
    idempotent operation and use `usage_recording_pending`, while either
    operator-blocked outcome or impossible final receipt capacity uses
    `usage_recording_failed` and retains a non-retrying blocked state.
18. Release pending/user/global/queue ownership exactly once across every
    close/error/shutdown race, after fencing retries and provider callbacks.

The direct outbound `ws` adapter uses `handshakeTimeout: 10000`,
`maxPayload: 262144`, `perMessageDeflate: false`, `followRedirects: false`, a
five-second send-callback timeout, and a five-second graceful finish/close
timeout followed by `terminate()`. Soniox progress fields never redefine local
attempted-byte accounting. If final drain cannot complete, return only
already-confirmed text in `provider_unavailable`.

### Soniox Async Cleanup Reconciler

Do not use SDK `cleanup`, `destroy`, `delete_all`, or `destroy_all`; their order,
error suppression, or provider-wide scope does not meet this policy. Each
request creates one upload used by exactly one transcription. Immediate cleanup
runs before the HTTP handler settles, but a cleanup failure never replaces a
successful transcript or masks the original translated transcription error;
the reconciler is the privacy retry path.

Immediate outcome matrix:

| Last known state                                                                | Required cleanup                                                                                            | Request outcome                                                                        |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Upload never returned an ID                                                     | None.                                                                                                       | Return the translated upload error.                                                    |
| Upload succeeded; transcription creation definitely failed before a job existed | Delete the owned file; owned-ID 404 is success.                                                             | Return the original translated create error even if file deletion fails.               |
| Create result is ambiguous after dispatch                                       | Do not delete the file because an undiscovered job may reference it.                                        | Return the translated create/timeout error; reconciler locates prefixed resources.     |
| Known job is `queued`/`processing` when request aborts or times out             | Delete neither job nor file.                                                                                | Return/abort with the original outcome; reconciler waits for terminal state.           |
| Known job is `completed`/`error`                                                | Delete transcription first. After success/owned-ID 404, delete its exclusive file; owned-ID 404 is success. | Preserve successful transcript or original provider error; log cleanup outcome safely. |
| Transcription delete returns 409/currently active                               | Stop and do not delete the file.                                                                            | Preserve original outcome; later sweep retries.                                        |
| Transcription delete has another failure                                        | Stop and do not delete the file.                                                                            | Preserve original outcome; later sweep retries.                                        |
| Transcription delete succeeds but file delete fails                             | Leave the orphan for the sweep.                                                                             | Preserve original outcome.                                                             |

An owned-ID 404 is idempotent success only for an ID returned by the request or
selected from a prefix-filtered dedicated-project listing; a raw 404 does not
establish ownership.

Every cleanup REST page/delete call has its own five-second deadline. The client
must use the cancellable collection APIs (`stt.list(options, signal)`,
`files.list({ ..., signal })`, `stt.delete(id, signal)`, and
`files.delete(id, signal)`), never instance `destroy()`/uncancellable helpers.
For each individual call create a fresh
`AbortSignal.any([lifecycleSignal, AbortSignal.timeout(5000)])`; do not reuse one
timeout across pagination. Immediate cleanup owns a lifecycle controller
independent of the request-close signal, so an already-aborted upload request
cannot skip or instantly abort its cleanup. The controller is combined with the
130-second response-budget and server-disposal signals, either of which still
aborts cleanup.

A timed-out/aborted delete is ambiguous and follows the same safe rule as any
other deletion failure: preserve the original request result, do not advance to
file deletion after an unresolved transcription delete, and leave reconciliation
to a later idempotent pass. A timed-out list aborts the whole sweep before any
deletion. The generation is checked after every await so a late callback cannot
start a next page/delete or change current single-flight state.

Add a single-flight in-process safety sweep for process crashes and interrupted
cleanup:

- Use a dedicated Soniox EU project.
- Operate only on resources whose random `client_reference_id` has the Sesori
  voice prefix.
- Sweep at startup and approximately every 15 minutes.
- Fully materialize all cursor pages within the following bounds for both
  transcriptions and files before deleting anything; a list failure aborts that
  sweep with no partial-snapshot deletion.
- Request at most 1,000 resources/page and allow at most 10 pages and 10,000
  resources independently for transcriptions and files. Validate each non-null
  cursor as a non-empty string of at most 2,048 characters and each resource ID
  as a non-empty string of at most 256 characters. Track seen cursors and
  resource IDs; a
  repeated cursor/ID, oversized page, 11th page, or 10,001st resource aborts the
  whole sweep before deletion.
- For completed/error transcriptions older than one hour, delete the
  transcription first. Treat an owned 404 as success, a raced 409/active state
  as skip, and any other failure as skip-without-file-delete.
- Leave queued/processing jobs alone; a later sweep removes them after they
  become terminal. Treat an unknown future status conservatively as active.
- After transcription deletion passes, delete a prefixed file older than one
  hour only when the fully materialized bounded snapshot contains no remaining
  transcription reference. A concurrent race is harmless and is retried next
  sweep.
- Paginate; never call provider-wide `delete_all`/`destroy_all`.
- Log only resource IDs, ages, statuses, counts, and safe error classes.
- The 15-minute interval calls `unref()`. Disposal stops scheduling and page
  fetch/delete initiation, aborts the current call's lifecycle controller, waits
  at most five seconds for it to settle, and fences late callbacks from starting
  another provider call.
- Start the reconciler whenever a Soniox key is configured, even when async has
  switched back to OpenAI, until prefixed leftovers are verified absent.

### Ordered Shutdown Budget

PR2 introduces `src/shutdown.ts` and an entrypoint-guarded `main()` in
`src/index.ts`; every later lifecycle slice extends that same coordinator rather
than installing another signal handler. One coordinator closure owns
`shutdownPromise`: the first SIGINT/SIGTERM starts it and all later signals return
the same promise, so disposal, DB close, and exit selection run exactly once.
Importing `index.ts` in tests never starts the server or registers process
listeners. A referenced 22-second hard-deadline timer guarantees completion below
Docker's 25-second stop allowance. PR2 tests the production composition order;
PR3, PR6, PR8, and PR13 extend those tests in the same PR that adds a lifecycle
participant.

1. At T+0, synchronously call `beginShutdown()` on every producer:
   `AsyncTranscriptionGate`, `RealtimeConnectionGate`,
   `RealtimeTranscriptionService`, and `GlossaryService`. This rejects new body
   permits, upgrades, starts, and mutations before any asynchronous close work.
   Stop the independent cleanup scheduler and dispose `BridgeStateTracker`.
   Do not stop `TranscriptionUsageService` or its retry scheduler yet: already
   admitted async/realtime generations must still finalize through it.
2. Also at T+0, after those synchronous producer gates are closed, call
   `app.close()` so Fastify stops accepting HTTP/upgrades. Concurrently start:
   `AsyncTranscriptionGate.drain()` capped at six seconds (its T+0 signal aborts
   body/provider work while permits remain held through cleanup/accounting),
   `RealtimeConnectionGate.dispose()` capped at five seconds (abort pending
   leases, await route release, then fence),
   `RealtimeTranscriptionService.dispose()` capped at seven seconds (pre-ready
   cancellation; active drain, debit, `service_restarting`, close),
   `GlossaryService.dispose()` capped at five seconds,
   `SonioxCleanupService.dispose()` capped at five seconds, and the existing
   `ActivationReminderService.dispose()` capped at its current 15 seconds.
   When realtime is enabled, the custom `@fastify/websocket` `preClose` hook
   reuses the same idempotent connection-gate/realtime-service disposal promises;
   it does not execute the plugin default client-close loop.
3. Cap `app.close()` and that concurrent producer group at T+15. Each shorter component timeout
   advances its own generation fence; at T+15 fence every remaining producer,
   terminate provider/client sockets, discard only unattempted queue data, and
   call `app.closeAllConnections()`. A fenced producer cannot acquire/finalize a
   usage lease or start cleanup. A usage-service operation already dispatched
   before the fence may settle idempotently under usage-service ownership, but a
   provider callback cannot dispatch accounting after the fence.
   The custom WebSocket `preClose` waits for service-driven closes through those
   bounded promises, then terminates only residual clients after the force fence
   waits at most one additional second for their close events, and invokes
   `websocketServer.close` once with a one-second callback cap. Generation and
   completion guards ignore any later close callback. Its typed error handler
   logs only a safe error type and terminates the socket; it never logs the
   Error/message/request.
4. Only after every async/realtime producer reports settled or force-fenced,
   call `TranscriptionUsageService.beginShutdown()` and then, from T+15 through
   T+20, `dispose()` for its bounded final retry pass. Pending entries not
   resolved by the deadline are counted/logged without user IDs and then lost
   with the documented hard-crash residual risk; no raw `$inc` is retried.
5. Give `dbConnector.close()` the remaining two seconds. Exit 0 when all steps
   settle by T+22. If the hard deadline fires, fence callbacks, make one final
   `app.closeAllConnections()` call, and exit 1 rather than hanging.

Deterministic shutdown tests cover no-work, active async, pending first-frame,
pre-ready provider connect, active/paused/overflowing real-time queues,
provider-drain timeout, cleanup mid-page/delete, activation disposal, pending
debits, duplicate signals, late callbacks, and the 22-second hard deadline. The
Docker smoke covers the normal SIGTERM/exit-0 path. A direct `app.close()` in a
test is also safe: custom pre-close idempotently begins the same realtime drains
instead of waiting on a coordinator that was never invoked.

## Configuration Target

| Variable                                         | Default        | Purpose                                                                                                   |
| ------------------------------------------------ | -------------- | --------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                       | `production`   | Closed `development`/`test`/`production` enum used to forbid provider URL overrides in production.        |
| `ASYNC_TRANSCRIPTION_PROVIDER`                   | `openai`       | Closed enum selecting the existing async route's provider.                                                |
| `SONIOX_API_KEY`                                 | conditional    | Required when async selects Soniox, realtime is enabled, or cleanup must drain existing Soniox resources. |
| `SONIOX_REGION`                                  | `eu`           | Closed literal `eu`; production always uses EU endpoints.                                                 |
| `SONIOX_BASE_DOMAIN`                             | forbidden      | SDK-owned environment override; startup rejects its presence in every environment.                        |
| `SONIOX_API_BASE_URL`                            | absent         | Non-production-only REST override for deterministic tests/Docker stub; production rejects it.             |
| `SONIOX_WS_URL`                                  | absent         | Non-production-only WebSocket override for deterministic tests/Docker stub; production rejects it.        |
| `SONIOX_ASYNC_MODEL`                             | `stt-async-v5` | Exact literal server-owned async model.                                                                   |
| `SONIOX_REALTIME_MODEL`                          | `stt-rt-v5`    | Exact literal server-owned real-time model.                                                               |
| `SONIOX_ASYNC_TIMEOUT_MS`                        | `60000`        | Integer 1,000-60,000 ms upload/job/poll timeout for the synchronous async route.                          |
| `REALTIME_TRANSCRIPTION_ENABLED`                 | `false`        | Fail-closed route registration gate until ingress/legal/provider checks pass.                             |
| `REALTIME_TRANSCRIPTION_MAX_SESSION_SECONDS`     | `900`          | Integer 1-900 used for both wall-clock deadline and attempted-upstream audio cap.                         |
| `REALTIME_TRANSCRIPTION_MAX_CONCURRENT_SESSIONS` | `10`           | Integer 1-10 local cap aligned with the initial Soniox project quota.                                     |
| `AUTH_TRUSTED_PROXY_CIDRS`                       | empty          | Comma-separated exact CIDRs allowed to supply forwarding headers; empty config means `trustProxy: false`. |

Keep the five-second start timeout, 10-second audio idle timeout, 32 KiB frame
limit, 12 upgrades/minute/peer, 4,096 peer windows, 10 starts/minute/user,
one-user/two-global async upload permits,
four-user/256-global glossary mutations, 45-second async multipart receive
timeout, 130-second async response budget, five-second cleanup-call timeout,
cleanup interval, and cleanup stale age as named code constants unless
production evidence requires runtime tuning.

All new variables are Zod-validated at startup, including CIDR syntax and
conditional key/override rules. Validation also inspects and rejects any defined
`SONIOX_BASE_DOMAIN` before an SDK client is constructed; non-production tests
use only the validated `SONIOX_API_BASE_URL`. `SonioxAsyncClient` always passes
the resolved local REST URL explicitly as the SDK `base_url`: exactly
`https://api.eu.soniox.com` outside a validated non-production override. It also
passes `region: "eu"` and the key explicitly, so no SDK-owned endpoint environment
fallback selects the REST destination. Add the Soniox key only through the
existing SOPS workflow; never create a plaintext environment file.

Realtime construction is one optional dependency bundle, never several optional
services. `src/routes/voice-realtime.ts` exports exact
`VoiceRealtimeRouteOptions` containing `TokenService`,
`RealtimeConnectionGate`, and `RealtimeTranscriptionService`; `AppServices` has
one optional `realtime` property of that type. When
`REALTIME_TRANSCRIPTION_ENABLED=false`, validation requires an empty trusted
proxy list and absent WebSocket override, `index.ts` constructs no Soniox
realtime client/gate/service/bundle, `server.ts` registers neither
`@fastify/websocket` nor the route, and shutdown has no realtime participant.
Async Soniox and cleanup may still use a configured key independently. When the
flag is true, validation requires the key, `index.ts` constructs the entire
bundle or fails startup, `server.ts` configures exact trusted proxy handling and
registers the plugin then route, and shutdown receives that same bundle. Tests
spy on constructors/registration/disposal to prove both graphs; no non-null
assertions or optional individual dependencies are permitted.

## Security, Privacy, And Logging

- The long-lived Soniox key exists only in server configuration and is never
  returned to a client.
- Access tokens are accepted only in the initial TLS-protected frame and are
  never included in errors or logs.
- Every client text frame and provider event is validated with strict local Zod
  schemas before business logic consumes it; failures log only the bounded
  allowlisted path/code projection and never raw issues, messages, keys, or
  submitted values.
- Binary frame size, alignment, order, sample rate, channel count, session time,
  user rate, user concurrency, and global concurrency are bounded.
- Raw project IDs and paths never reach the auth server. Opaque project keys are
  not sent to Soniox or written to diagnostics.
- Multipart filenames are untrusted, ignored, and never forwarded/logged;
  providers receive only the fixed validated-MIME filename.
- Audio, transcript text, and provisional text are never logged or persisted by
  Sesori. Glossary terms remain intentionally persisted in the user/project-
  scoped `glossaryEntries` collection and are never logged.
- Provider errors are translated. Safe logs may retain Soniox request IDs and
  stable error types for support, but not raw messages when they could include
  submitted values.
- Real-time Soniox content is transient. Async content is stored only for job
  processing and is deleted immediately plus reconciled after crashes.
- Update `assets/legal/privacy.md` before production traffic:
  - add Soniox Inc. as an EU-region voice-transcription subprocessor;
  - retain OpenAI because async selection and metadata processing remain;
  - explain transient real-time processing and short-lived async job storage;
  - retain the no-training commitment and immediate post-processing deletion
    statement;
  - note that Soniox system/usage metadata may be processed outside the content
    region.
- Soniox DPA acceptance, EU regional-project access, and the matching regional
  key are production gates.

## Delivery Plan

Each implementation PR updates this plan's status, completed checkboxes,
verification results, and next-slice checkpoint, and updates
`CONSIDERATIONS.md` if implementation evidence changes a recorded tradeoff.
These two plan files are therefore part of every PR even when they are not
repeated in the file maps below.

### PR Size And Checkpoint Discipline

Target at most 1,500 changed authored lines per implementation PR, including
source, tests, scripts, and ordinary documentation. Measure additions plus
deletions against that PR's merge base with `git diff --numstat`; report
generated `package-lock.json` and SOPS ciphertext churn separately rather than
hiding them in the authored count. This plan-only documentation work is the
persistent implementation context, not an implementation slice.

Tests for behavior introduced by a PR ship in that PR and are never deferred
only to meet the line target. Before coding each slice, record its forecast in
this section. Before opening it, record actual authored/generated totals,
verification commands/results, reviewed `origin/master` SHA, and the exact next
slice. If a slice is forecast or measured above 1,500 authored changed lines,
split it at the fallback boundary listed below before review. An exception is
allowed only when a smaller merge would leave production unsafe; document the
reason and reviewer approval here rather than silently exceeding the target.

All slices are sequential and independently deployable from the then-current
`master`; do not stack hidden dependencies across unmerged PRs.

| PR   | Scope                                                         | Expected production behavior after merge                                                                        | Fallback split boundary if over target                                  |
| ---- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| PR1  | Glossary migration audit/tooling and opaque-key primitives    | No runtime/API change; operators must not run `--apply` yet.                                                    | Separate CLI wiring/docs from migration library/tests.                  |
| PR2a | Shared shutdown, error, and validation foundation              | No glossary/API change; shutdown becomes bounded, idempotent, and import-safe.                                  | Keep lifecycle corrections together; defer no tests.                    |
| PR2b | Atomic project-scoped glossary cutover                         | Existing clients omit the key and transcribe with no glossary.                                                  | Separate repository/service from route only if deploy safety permits.   |
| PR3  | Async pre-buffer admission, deadlines, and fixed filenames    | OpenAI behavior remains; buffering and timeout/error handling become bounded.                                   | Separate timeout errors/watchdogs from async gate/route integration.    |
| PR4  | Provider-neutral validated OpenAI transcription boundary      | Existing OpenAI provider and public response remain unchanged.                                                  | Separate API validation/client adaptation from DI conversion.           |
| PR5  | Idempotent daily-debit persistence and maintenance primitives | Optional bounded receipts/repository/maintenance CLI exist; live route still uses its previous accounting path. | Land maintenance CLI/failpoint harness first, then receipt repository.  |
| PR6  | Bounded usage service and async accounting integration        | Async uses one-user admission and idempotent pending recovery; provider remains OpenAI.                         | Separate service/retry engine from route/VoiceService integration.      |
| PR7  | Uncomposed Soniox async adapter and immediate cleanup         | No selectable provider change; adapter is reachable only from focused tests.                                    | Separate provider API validation from client lifecycle/cleanup.         |
| PR8  | Soniox reconciler, configuration, legal update, and selection | Async remains OpenAI by default; Soniox can be selected only after timeout/legal/provider gates.                | Separate reconciler from final selector/composition/legal wiring.       |
| PR9  | Realtime protocol, parser, and admission foundation           | No realtime public route is registered.                                                                         | Separate protocol/parser dependency work from connection-gate work.     |
| PR10 | Uncomposed Soniox realtime transport adapter                  | No realtime public route is registered; adapter is focused-test only.                                           | Separate handshake/event normalization from bounded send lifecycle.     |
| PR11 | Realtime transcription lifecycle and shared usage integration | No realtime public route is registered; complete service is exercised behind local interfaces.                  | Separate admission/timers from transcript/terminal/accounting behavior. |
| PR12 | Realtime socket-session collaborator and backpressure         | No route plugin exists and production behavior remains unchanged.                                               | Separate client-send coalescing from inbound FIFO/session behavior.     |
| PR13 | Typed route, conditional composition, pre-close, CI, rollout  | Realtime route is registered only when default-false flag is enabled; async and realtime coexist.               | Move more non-plugin tests into PR12; keep route/registration atomic.   |

Checkpoint ledger (update the active row before coding and again before opening
each PR; `actual` includes authored additions plus deletions):

| Slice | Status  | Reviewed base SHA | Forecast authored lines | Actual authored/generated lines | Verification | Next slice |
| ----- | ------- | ----------------- | ----------------------- | ------------------------------- | ------------ | ---------- |
| PR1   | Merged  | `8fc4fcf`         | 1,480                   | 1,402 / 0                       | MongoDB 7 focused/full; production dry-run zero; deployed | PR2a       |
| PR2a  | Active  | `fa831d1`         | 1,450                   | 2,149 / 0                       | Focused 62/62; MongoDB 7 memory full 557 pass/1 skip; static/build passed; Docker CI pending | PR2b       |
| PR2b  | Pending | -                 | TBD before coding       | -                               | -            | PR3        |
| PR3   | Pending | -                 | TBD before coding       | -                               | -            | PR4        |
| PR4   | Pending | -                 | TBD before coding       | -                               | -            | PR5        |
| PR5   | Pending | -                 | TBD before coding       | -                               | -            | PR6        |
| PR6   | Pending | -                 | TBD before coding       | -                               | -            | PR7        |
| PR7   | Pending | -                 | TBD before coding       | -                               | -            | PR8        |
| PR8   | Pending | -                 | TBD before coding       | -                               | -            | PR9        |
| PR9   | Pending | -                 | TBD before coding       | -                               | -            | PR10       |
| PR10  | Pending | -                 | TBD before coding       | -                               | -            | PR11       |
| PR11  | Pending | -                 | TBD before coding       | -                               | -            | PR12       |
| PR12  | Pending | -                 | TBD before coding       | -                               | -            | PR13       |
| PR13  | Pending | -                 | TBD before coding       | -                               | -            | Complete   |

Foundation slices may add only exact local contracts/components assigned to a
named later slice in this plan. They remain unreachable from production
composition, add no dormant public configuration, and are deleted/replanned if
the consuming checkpoint invalidates them; this is staged reviewability, not a
generalized future-provider abstraction.

### PR1 - Glossary Migration Tooling And Opaque-Key Primitives

File map:

- `src/models/voice.ts` (new): define and export the strict reusable
  `projectKey` schema without changing a live request contract.
- `src/models/documents.ts`: add exported strict legacy and project-scoped
  glossary migration document schemas while leaving the live
  `glossaryEntrySchema`/`GlossaryEntry` contract unchanged until PR2.
- `src/config.ts`: add a narrow `MONGODB_URI`-only migration config loader using
  `safeParse`; normal web config remains unchanged and no other app secret is
  required by the CLI.
- `src/db/glossary-index-migration.ts` (new): own old/target index specs,
  binary/simple collection-collation invariant, strict collection/index/
  aggregation metadata validation, old/target document-shape audit, exact
  verification, apply ordering, rollback ordering, and redacted reports; it is
  not called by application startup.
- `src/scripts/migrate-project-glossary-index.ts` (new): expose dry-run,
  `--apply`, `--verify`, and `--rollback` modes using only `MONGODB_URI` and
  always close MongoDB.
- `package.json`: add `migrate-project-glossary-index`; no new dependency.
- `README.md`: document the derivation contract and complete dry-run/apply/
  verify/interruption/rollback/`repair_required` runbook, prominently stating
  that production `--apply` waits for the PR2 maintenance-window cutover and
  auth stays stopped for every non-rerunnable partial state.
- `tests/models/voice.test.ts` (new): cover exact opaque-key length/alphabet and
  malformed variants plus strict legacy/target migration document shapes.
- `tests/config.test.ts` (new): cover isolated valid/missing/malformed migration
  URI configuration without loading normal web configuration.
- `tests/scripts/project-glossary-index-migration.test.ts` (new): cover dry-run,
  apply, verify, interruption/idempotency, unsafe legacy/target rows, exact index
  mismatch, non-simple collection collation, malformed MongoDB metadata/counts,
  redacted output, post-drop race detection, concurrent/conflicting DDL outcomes,
  and empty-only rollback against MongoDB 7.

Acceptance criteria:

- [x] Add the strict opaque `projectKey` schema and document the v1 client
      derivation formula without importing client code.
- [x] Make migration dry-run the default; require explicit, mutually exclusive
      flags for mutation and fail closed on malformed data/indexes.
- [x] Validate complete persisted document and every consumed collection/index/
      aggregation result through strict Zod `safeParse`, including nonnegative
      safe-integer counts; require absent or binary/simple collection collation
      before any index mutation.
- [x] Prove apply creates/verifies the target unique index before dropping the
      legacy index, rollback does the inverse only while data is empty, and every
      mode is resumable and content-redacted.
- [x] Require the mutating-mode maintenance boundary to exclude glossary writers
      and concurrent migration/index DDL; run the complete data, duplicate,
      collation, and index audit after every destructive drop and never report
      success when an intervening write or conflicting DDL invalidates it.
- [x] Return `safe_to_rerun` only for valid absent/exact-index interruption states
      and `repair_required` for post-drop invalid data, mismatched DDL, or unknown
      state; keep auth stopped and require separate review for every repair.
- [x] Run the production dry-run and record its counts, but do not run production
      `--apply` until the PR2 binary/artifact and maintenance window are ready.
- [x] Record the actual authored/generated line count and the reviewed
      `origin/master` SHA in this plan before opening the PR.

Focused verification:

```bash
MONGODB_URI_TEST=mongodb://localhost:27017/auth-backend-test \
  node --import tsx --test --test-concurrency=1 \
  tests/config.test.ts \
  tests/models/voice.test.ts \
  tests/scripts/project-glossary-index-migration.test.ts
```

PR1 non-goals:

- No application index wiring or production migration apply.
- No glossary API/repository behavior change.
- No transcription behavior change.

### PR2a - Shared Shutdown, Error, And Validation Foundation

PR2's fallback separates the over-budget shutdown/glossary cutover; glossary and transcription behavior remain unchanged.

File map:

- Error/server/voice paths add typed retry-1 handling and retain eight bounded, allowlisted Zod path/code issues.
- Bridge/activation services synchronously stop/abort/fence, expose drains, and redact touched failure logs.
- `src/shutdown.ts` and `src/index.ts` implement the Ordered Shutdown Budget
  foundation: memoized deadlines, waiter/read drainage, idle reaping, bounded startup cleanup, and MongoDB-last close.
- Tests, helpers, CI, README, and AGENTS cover lifecycle order, health, SIGTERM, 25-second stop, and exit zero.

Acceptance criteria:

- [x] Diagnostics retain eight bounded path/code issues; typed 503 errors alone emit `Retry-After: 1`.
- [x] Bridge/activation aborts prevent post-fence stages and expose safe drains/logs.
- [x] Parked long polls release before Fastify close; detached repository reads drain before MongoDB closes.
- [x] Only fulfilled drains close MongoDB; T+15 may recover timeouts; rejection/stall exits 1 at T+22 with MongoDB open.
- [x] Startup signals retain absolute deadlines; imports are inert; checkpoint
      interruption closes DB-last, but failed/stalled cleanup leaves DB open.
- [ ] Docker serves `/health`, handles SIGTERM, and exits zero within 25 seconds.

Focused verification:

```bash
node --import tsx --test --test-concurrency=1 \
  tests/lib/errors.test.ts \
  tests/lib/validation-diagnostics.test.ts \
  tests/index-shutdown.test.ts \
  tests/notifications/bridge-state-tracker.test.ts \
  tests/services/activation-reminder-service.test.ts \
  tests/voice/glossary.test.ts
```

### PR2b - Project-Scoped Glossary Cutover

File map:

- `src/models/voice.ts`: add strict glossary request/query schemas using the PR1
  `projectKey` schema.
- `src/models/api.ts`: add `projectKey` to the glossary body types while keeping
  existing reply shapes unchanged.
- `src/models/documents.ts`: make `projectKey` required on `GlossaryEntry`.
- `src/repositories/glossary-entry-repo.ts`: replace user-global operations with
  exact `(userId, projectKey)` reads/deletes/inserts; add separate project and
  user counts for the two storage caps; `safeParse` documents/count/write
  results, keep `ObjectId` conversion here, and return word/count DTO values
  rather than `GlossaryEntry`/`ObjectId` above the repository.
- `src/services/glossary-service.ts` (new): exclusively own project-scoped CRUD,
  project/user cap checks, exact-project word loading, repository calls, and
  per-user mutation queues; retain at most four mutations/user and 256 globally
  including executing work, reject before copying/retaining excess input with
  HTTP 503 plus `Retry-After: 1`, remove empty queues, and expose bounded
  stop/drain/fence lifecycle methods without Fastify concerns.
- `src/services/voice-service.ts`: remove direct glossary repository/CRUD/queue
  ownership; request bounded exact-project words from `GlossaryService` when
  async transcription supplies a key, skip the call when omitted, and otherwise
  retain only transcription orchestration. Replace current user-ID/raw-error
  quota logs with bounded outcome and `safeErrorType` fields.
- `src/routes/voice.ts`: validate the GET query, POST/DELETE bodies, and
  order-independent optional multipart `projectKey`; reject duplicate fields,
  duplicate files, malformed fields, and unknown extra parts; bound multipart
  fields to one 50-byte value in addition to the existing file limit, and pass
  request-close signals to glossary lifecycle methods.
- `src/db/mongo-db-accessor.ts`: configure the target unique index and invoke
  the PR1 shared post-ensure assertion without dropping an index at startup.
- `src/server.ts`: add `GlossaryService` to `AppServices`/voice-route wiring;
  when handling `ApiError`, set
  `Retry-After` from the typed field before sending the existing JSON error and
  never infer headers from free-form messages.
- `src/shutdown.ts` and `src/index.ts`: extend the PR2a coordinator and
  composition with `GlossaryService` T+0 stop, bounded drain, and force fence.
- `README.md`: update glossary API examples and mark the PR1 migration runbook
  ready for the exact maintenance-window apply/cutover sequence.
- `AGENTS.md`: record that glossary cap serialization is process-local and
  relies on the existing single-instance deployment constraint; record that
  every new composed lifecycle owner extends the one guarded shutdown
  coordinator and its production-order tests.
- `tests/helpers/setup.ts`: compose/expose/dispose `GlossaryService`.
- `tests/db/mongo-db-accessor.test.ts`: cover exact target matching and startup
  rejection while the legacy glossary index remains.
- `tests/repositories/glossary-entry-repo.test.ts` (new): cover exact scoped
  queries/writes/counts, DTO-only outputs, ObjectId conversion, malformed stored
  documents, malformed/unacknowledged write results, and redacted failures.
- `tests/voice/glossary.test.ts`: cover required scope, isolation, malformed
  input, duplicates, per-project/user caps, queue saturation/release,
  disconnect, shutdown, and unchanged reply shapes.
- `tests/services/glossary-service.test.ts` (new): cover four/user and 256-global
  glossary mutation saturation, FIFO serialization, rejection before input
  retention, queued disconnect removal, executing completion, slot release, and
  bounded shutdown.
- `tests/index-shutdown.test.ts`: extend PR2a production-order cases with active
  glossary drain/force-fence behavior.
- `tests/voice/transcribe.test.ts`: cover multipart order/duplicates, omitted
  key query skipping, exact scope/no-match, malformed fields, disconnect during
  glossary work, and otherwise unchanged async behavior.

The Yaak workspace currently has no voice request, so PR2 does not modify it.
If that changes before implementation, update the newly discovered request in
the same PR rather than adding a duplicate fixture.

Acceptance criteria:

- [ ] Add required `projectKey` to glossary documents and repository methods.
- [ ] Create the unique `{ userId, projectKey, word }` index, confirm exact key
      order and uniqueness, then remove `{ userId, word }` only in `--apply`.
- [ ] Run the production dry-run and require zero documents before rollout;
      stop and design an explicit data migration if that assertion is false.
- [ ] Require project key on glossary CRUD and enforce 500/project plus
      5,000/user limits under concurrent requests on the current single
      instance without retaining idle per-user queues; test four/user and 256
      global slots, rejection-before-retention, release, disconnect cancellation,
      and shutdown behavior.
- [ ] Make `GlossaryService` the sole owner of glossary CRUD, cap checks,
      repository calls, queues, and lifecycle; keep those concerns out of
      `VoiceService`.
- [ ] Accept optional `projectKey` as an order-independent multipart field on
      async transcription.
- [ ] Skip the glossary query entirely when no key is supplied.
- [ ] Return no-context behavior for a valid key with no matching entries.
- [ ] Keep OpenAI async request/response, authentication, quota, MIME, and file
      limits otherwise unchanged.
- [ ] Add repository, index, route, multipart ordering/duplication, exact-scope,
      missing-key, no-match, malformed-key, and limit tests.
- [ ] `safeParse` every glossary repository document/result and expose no Mongo
      document or `ObjectId` above the repository.
- [ ] Propagate typed `retryAfterSeconds` through `ApiError` and the global error
      handler; prove this PR's mutation overload sends `Retry-After: 1` and make
      the common class mandatory for later overload slices.
- [ ] Reduce all logged voice Zod failures to the bounded path/code-only helper;
      never attach a raw `ZodError` or submitted value to an `ApiError`.
- [ ] Extend the single PR2a shutdown coordinator with glossary stop, drain, and
      force-fence behavior before MongoDB close.
- [ ] Run the exact focused command below against MongoDB 7, then the common
      full verification sequence.

Focused verification:

```bash
MONGODB_URI_TEST=mongodb://localhost:27017/auth-backend-test \
  node --import tsx --test --test-concurrency=1 \
  tests/db/mongo-db-accessor.test.ts \
  tests/repositories/glossary-entry-repo.test.ts \
  tests/services/glossary-service.test.ts \
  tests/index-shutdown.test.ts \
  tests/voice/glossary.test.ts \
  tests/voice/transcribe.test.ts
```

PR2 non-goals:

- No Soniox dependency or configuration.
- No real-time route.
- No client implementation.

### PR3 - Async Admission, Deadlines, And Safe Transport Errors

File map:

- `src/models/voice.ts`: add the exhaustive validated-MIME-to-fixed-provider
  filename mapping.
- `src/services/async-transcription-gate.ts` (new): own one upload permit/user,
  two process-wide 25-MiB reservations, per-permit abort/generation state,
  synchronous `beginShutdown()`, bounded drain/force-fence, and exactly-once
  release without retaining rejected bodies.
- `src/routes/voice.ts`: acquire the async permit after authentication and before
  `request.parts()`, Buffer allocation, or usage/provider work; enforce the
  45-second multipart and 130-second response watchdogs, strict multipart
  cardinality, fixed MIME-derived provider filename, combined request/permit
  abort propagation, no stage starts after expiry, and terminal `finally`
  release only after no work retains the Buffer. Translate multipart/parser
  failures to fixed local codes without attaching raw errors, field values,
  MIME strings, or filenames to `ApiError`.
- `src/lib/errors.ts`: add bounded local 408 multipart-timeout and 504
  provider/overall-timeout errors; reuse the typed 503/`Retry-After: 1` path for
  gate saturation and shutdown.
- `src/server.ts`: add `AsyncTranscriptionGate` to `AppServices` and voice-route
  wiring without moving multipart logic into the composition layer.
- `src/shutdown.ts` and `src/index.ts`: extend the PR2 coordinator/dependencies
  with `AsyncTranscriptionGate`; synchronously call `beginShutdown()` before
  `app.close()`, then drain/force-fence active permits before MongoDB closes.
- `AGENTS.md`: record the process-local one-user/two-global gate and its
  single-instance requirement.
- `tests/helpers/setup.ts`: compose/expose/dispose the gate for route tests.
- `tests/services/async-transcription-gate.test.ts` (new): cover one/user, two
  global reservations, rejection before retention, every release/abort path,
  duplicate release, T+0 stop, bounded drain, and late-generation fencing.
- `tests/index-shutdown.test.ts`: extend PR2 production-composition cases with
  async-gate-before-Fastify order, duplicate-signal reuse, six-second drain/fence,
  late provider callbacks, and MongoDB-last behavior.
- `tests/voice/transcribe.test.ts`: cover multipart ordering/duplicates,
  same-user/global concurrent uploads, oversized/slow/disconnected bodies,
  exact 45,000/130,000-ms boundaries, malicious filenames mapping to fixed
  names, no raw filename/Zod value logging, permit release, and unchanged JSON.

Acceptance criteria:

- [ ] Acquire one/user and two-global 25-MiB permits before multipart buffering;
      never queue and return typed HTTP 503/`Retry-After: 1` on saturation.
- [ ] Hold each permit through provider/cleanup/accounting so retained raw and
      provider-copy memory remains within the documented bound.
- [ ] Enforce the complete 45/130-second budgets, 408/504 classification, abort
      propagation, and no-new-stage-after-expiry rule without changing success.
- [ ] Ignore client filenames and pass/log only the fixed name derived from
      validated MIME.
- [ ] Stop gate admission synchronously before Fastify close and prove all
      success/error/disconnect/shutdown paths release or fence exactly once.
- [ ] Run focused and common verification, then record line totals/base SHA.

Focused verification:

```bash
MONGODB_URI_TEST=mongodb://localhost:27017/auth-backend-test \
  node --import tsx --test --test-concurrency=1 \
  tests/services/async-transcription-gate.test.ts \
  tests/index-shutdown.test.ts \
  tests/voice/transcribe.test.ts
```

PR3 non-goals:

- No provider abstraction or Soniox dependency.
- No accounting persistence change.
- No real-time route.

### PR4 - Provider-Neutral Validated OpenAI Boundary

File map:

- `src/types/transcription.ts` (new): define provider-neutral async input/result/
  error types and the async provider interface consumed by `VoiceService`; no
  selector enum is added until there are two composed implementations.
- `src/api/openai.ts` (new): `safeParse` bounded OpenAI transcription text and
  locally derived duration into the provider-neutral result and classify invalid
  values without logging them.
- `src/clients/openai-client.ts`: implement the local async interface, accept an
  abort signal, replace raw metadata/provider error logging with bounded safe
  types, and leave metadata chat-completion behavior intact.
- `src/services/voice-service.ts`: depend only on the local async provider and
  `GlossaryService`, pass bounded terms/abort signals, and retain current quota
  persistence and public response behavior without provider-specific branches.
- `src/index.ts`: inject the existing OpenAI client through the local async
  interface while preserving its separate metadata-chat use.
- `tests/helpers/setup.ts`: accept an async-provider test double rather than
  prototype-mocking OpenAI.
- `tests/api/openai.test.ts` (new): cover valid, empty, malformed, oversized-text,
  non-finite, non-positive, and oversized-duration results.
- `tests/clients/openai-client.test.ts` (new): cover local result shape,
  validation/error mapping, abort propagation, and unchanged metadata behavior.
- `tests/services/voice-service.test.ts` (new): cover exact bounded glossary
  context, abort propagation, validated result use, translated invalid output,
  and no provider/model leakage or fallback.
- `tests/voice/transcribe.test.ts`: preserve route and response behavior through
  an injected local provider and prove raw provider/Zod values never reach logs.

Acceptance criteria:

- [ ] Define the local async provider contract with no SDK types above the
      client boundary; add the real-time contract only in PR9 when consumed.
- [ ] Make `OpenAIClient` satisfy the async contract without changing metadata
      chat completion behavior.
- [ ] `safeParse` OpenAI text/duration into the bounded local result and map
      empty, malformed, oversized, or out-of-range values without leaking them.
- [ ] Keep `VoiceService` limited to transcription orchestration; it owns no
      glossary queue, persistence document, provider SDK type, or retry state.
- [ ] Preserve OpenAI selection, request/response shape, timeout behavior,
      metadata behavior, and all existing tests.
- [ ] Log only bounded path/code diagnostics for invalid OpenAI output and never
      attach the raw `ZodError`/payload to an `ApiError`.
- [ ] Run focused/common verification and record line totals/base SHA.

Focused verification:

```bash
MONGODB_URI_TEST=mongodb://localhost:27017/auth-backend-test \
  node --import tsx --test --test-concurrency=1 \
  tests/api/openai.test.ts \
  tests/clients/openai-client.test.ts \
  tests/services/voice-service.test.ts \
  tests/voice/transcribe.test.ts
```

### PR5 - Idempotent Daily-Debit Persistence And Maintenance Primitives

File map:

- `src/types/transcription.ts`: add closed `committed`/`collision`/
  `receipt_capacity`/`retryable_not_applied`/`ambiguous`/
  `operator_blocked_not_applied`/`operator_blocked_unknown` debit outcomes,
  commit-status/reason enums, and repository-neutral command/result values.
- `src/models/documents.ts`: add the optional bounded
  `transcriptionDebitReceipts` array to `DailyUsage`; existing rows require no
  backfill.
- `src/repositories/daily-usage-repo.ts`: add captured-date reads and the single
  exact majority-write conditional `findOneAndUpdate`, complete bounded-document
  validation, the one deadline-bounded metadata-race rerun, MongoDB 7 error
  classification, preserved metadata methods/receipts, and DTO-only returns.
- `src/repositories/transcription-usage-maintenance-repo.ts` (new): isolate
  privileged `$currentOp`/`killOp`, exact transcription-write recognition,
  quiet-window proof, and verified user-usage deletion from app repositories.
- `src/config.ts`: add `maintenanceConfigSchema` and
  `loadMaintenanceConfig(env)` for the maintenance URI and exact drain/erase
  mode; normal `loadConfig()` neither requires nor exposes either value.
- `src/scripts/maintain-transcription-usage.ts` and `package.json`: add the
  stopped-auth CLI, exact SOPS-backed production drain/erase scripts, exact
  environment scrubbing on those scripts and `start:prod`, and separate SOPS
  edit scripts; no app composition imports the CLI and no user ID uses argv.
- `.sops.yaml`, `env/app/transcription-drain.env`, and
  `env/app/transcription-erasure.env`: retain/describe the `env/app/*.env`
  encryption rule and add only operator-provisioned encrypted mode/URI values
  for the two independently permissioned MongoDB identities; never add either
  key to `env/app/prod.env`.
- `README.md`: document DBA role provisioning, SOPS edit/update-key ownership,
  exact production drain/erasure invocations, stdin erasure input, audit output,
  and the requirement that auth stays stopped throughout.
- `AGENTS.md`: record that the two maintenance SOPS files/roles are mode-bound,
  never loaded by app startup, and usable only through the stopped-auth scripts.
- `tests/repositories/daily-usage-repo.test.ts`: cover existing receipt-less
  rows, explicit dates, every closed outcome/error class, full-array malformed
  persistence, first upsert/operator paths, expected/unexpected duplicate keys,
  committed-but-reply-lost and delayed-original ordering, deadline-bounded
  metadata races and both terminal second-no-match commit statuses, majority/
  timeout/comment options, BSON size, and safe logs.
- `tests/scripts/transcription-usage-maintenance.test.ts` (new): use a dedicated
  MongoDB 7 test-command/failpoint harness for delayed legacy/new writes, exact
  current-op selection, kill/quiet verification, erasure races, privilege/
  assertion failures, mode mismatch, a drain role unable to read/delete, an
  erasure role limited to `dailyUsage` find/remove, unknown command shapes, and
  no content logging.
- `tests/config.test.ts`: prove missing/malformed maintenance URI/mode fails
  through `loadMaintenanceConfig`, valid mode-bound input remains CLI-only, and
  normal web config neither requires nor returns maintenance values.
- `tests/install/wiring.test.ts`: inspect package scripts/encrypted-env key names
  to prove `start:prod` loads only `prod.env` and unsets both maintenance values,
  each maintenance mode loads only its matching SOPS file and unsets runtime
  `MONGODB_URI`, `prod.env` has no maintenance key, and each dedicated file has
  only its mode plus SOPS-encrypted maintenance URI.

Acceptance criteria:

- [ ] Store each positive operation ID/seconds receipt atomically with the
      increment, preserve every receipt through metadata writes, and enforce the
      10,000-receipt schema/repository/admission bound.
- [ ] Validate the complete bounded receipt array before admission and conflict
      resolution; malformed nonmatching entries and duplicate IDs fail closed.
- [ ] Make same-ID/same-seconds return committed, same-ID/different-seconds
      collision, full-without-match receipt capacity, and post-dispatch
      uncertainty ambiguous; never retry raw `$inc`.
- [ ] Implement the exact non-conflicting filter/update/options and exhaustive
      MongoDB 7 known/unknown commit taxonomy with a single cutoff-bounded
      metadata-race rerun.
- [ ] Prove an original command completing after its retry, lease release, and a
      newer operation cannot increment again, and prove worst-case receipts stay
      below 4 MiB BSON.
- [ ] Ship the privileged stopped-auth drain/erasure CLI and failpoint tests; do
      not grant maintenance privileges to the runtime app.
- [ ] Keep maintenance env validation in `src/config.ts`: malformed/missing CLI
      config or mode mismatch fails safely while normal web config neither
      requires nor exposes maintenance values.
- [ ] Provision distinct drain/erasure MongoDB roles and tracked SOPS files;
      prove exact mode privilege, encrypted key sets, `start:prod` scrubbing, and
      no normal-runtime or cross-mode credential delivery.
- [ ] Keep all `ObjectId` and Mongo result details below the repository boundary.
- [ ] Merge with no live route caller and no production behavior change.
- [ ] Run the repository suite against MongoDB 7 plus common verification and
      record line totals/base SHA.

Focused verification:

```bash
MONGODB_URI_TEST=mongodb://localhost:27017/auth-backend-test \
  node --import tsx --test --test-concurrency=1 \
  tests/config.test.ts \
  tests/install/wiring.test.ts \
  tests/repositories/daily-usage-repo.test.ts \
  tests/scripts/transcription-usage-maintenance.test.ts
```

### PR6 - Bounded Usage Service And Async Integration

File map:

- `src/services/transcription-usage-service.ts` (new): exclusively own the
  capped 1,000-user active/pending/blocked map, UTC date, operation UUID,
  content-free correlation ID, generation, full-integrity durable pre-check,
  finalization, collision re-keying, exhaustive outcome behavior, bounded retry
  scheduler, user blocking, and five-second disposal.
  Expose only opaque lease tokens with remaining seconds plus
  `acquire`/`finalize`/`abandon`; callers cannot read or mutate accounting IDs,
  dates, correlations, generations, or retry state.
- `src/services/voice-service.ts`: accept an opaque usage lease, use only its
  public remaining-seconds value, and invoke usage-service finalization/abandon
  APIs; own no accounting metadata, retry, collision, pending, or blocked state.
- `src/routes/voice.ts`: after auth acquire the PR3 async gate first, then acquire
  the usage lease/pre-check before reading multipart; release the gate if usage
  admission fails, pass the opaque lease to `VoiceService`, call usage
  `abandon()` for pre-service failures, and preserve the documented response
  deadline/debit matrix. Route code never inspects accounting identity/state.
- `src/server.ts`, `src/shutdown.ts`, and `src/index.ts`: compose/wire usage and
  extend the one PR2 coordinator; stop the async producer gate before
  `app.close()`, let/fence all gate-owned producers, and only then stop/dispose
  usage before MongoDB closes. No new process signal handler is added.
- `assets/legal/privacy.md`: disclose durable account-linked per-transcription
  operation/duration usage metadata, accurate purpose-based retention without an
  unenforceable fixed maximum, and verified stopped-auth erasure before the live
  route starts writing receipts; obtain existing legal/product approval.
- `AGENTS.md`: add active/pending/blocked usage-map single-instance,
  restart-loss, and stopped-auth maintenance-drain constraints.
- `tests/helpers/setup.ts`: compose/expose/dispose usage after async producers.
- `tests/services/transcription-usage-service.test.ts` (new): cover opaque lease
  admission, daily-seconds and 10,000-receipt exhaustion, 1,000 states, exact
  internal correlation/date/operation ownership, every debit/commit-status
  outcome, immediate and pending collision re-key, retryable-not-applied versus
  ambiguous scheduling, sticky commit-uncertainty across later known-no-write
  outcomes, non-retrying blocked states, retry concurrency, generation fencing,
  `unref`, hard-restart residual, and disposal diagnostics.
- `tests/services/voice-service.test.ts`: cover every async deadline/debit matrix
  row while proving no operation/date/correlation is generated outside usage.
- `tests/voice/transcribe.test.ts`: cover admission before buffering, pending/full
  503 with `Retry-After: 1`, disconnect after validated result, conservative
  response, and unchanged success JSON.
- `tests/index-shutdown.test.ts`: extend the PR3 cases to prove gate stop precedes
  Fastify close, producer drain/fence precedes usage disposal, duplicate signals
  still share one promise, and no late producer can dispatch accounting after
  disposal begins.

Acceptance criteria:

- [ ] Reserve usage state before body read/provider spend and reject pending or
      full users through the typed overload path; map daily-seconds or receipt
      exhaustion to the existing 429 quota response.
- [ ] Make `TranscriptionUsageService` the sole owner of all accounting identity,
      retry, collision, generation, pending, and blocked state.
- [ ] Implement every async deadline/debit matrix row with opaque leases and no
      raw `$inc` retry.
- [ ] Retain unresolved debits without eviction, retry only collision/
      retryable/ambiguous states through one bounded unref'd scheduler, retain
      deterministic/unknown blocked states without retry, and fence callbacks.
- [ ] Before the first PR6 process starts, stop/confirm absence of every old auth
      process and pass PR5's privileged legacy-write drain; fail the rollout on
      any residual/unknown operation or missing permission.
- [ ] Prove producer-first shutdown ordering and the explicit hard-crash loss.
- [ ] Run focused/common verification and record line totals/base SHA.

Focused verification:

```bash
MONGODB_URI_TEST=mongodb://localhost:27017/auth-backend-test \
  node --import tsx --test --test-concurrency=1 \
  tests/repositories/daily-usage-repo.test.ts \
  tests/services/transcription-usage-service.test.ts \
  tests/services/voice-service.test.ts \
  tests/index-shutdown.test.ts \
  tests/voice/transcribe.test.ts
```

### PR7 - Uncomposed Soniox Async Adapter

File map:

- `src/api/soniox.ts` (new): validate every consumed async SDK response/status,
  pagination shape, result, and provider error into bounded local values.
- `src/clients/soniox-async-client.ts` (new): own EU async upload/create/poll/
  result/list/delete calls, 60-second provider deadline, fixed filename/context,
  request abort, and the exact fresh-five-second immediate-cleanup matrix; expose
  only local interfaces and do not compose it into the app. Accept the resolved
  local REST URL and pass it explicitly to the SDK as `base_url` alongside the
  explicit EU region/key; never let SDK environment lookup choose the endpoint.
- `package.json` and `package-lock.json`: add locked `@soniox/node` without
  bypassing `.npmrc` safeguards; report generated lockfile churn separately.
- `tests/api/soniox.test.ts` (new): cover every raw async value/status/error and
  path/code-only diagnostics.
- `tests/clients/soniox-async-client.test.ts` (new): use a fake SDK for success,
  invalid result, timeout/abort, every cleanup state, never-settling deletion,
  ambiguous creation/delete timeout, request-independent cleanup, fixed filename,
  bounded terms, EU/model settings, explicit production/test `base_url`, hostile
  `SONIOX_BASE_DOMAIN` non-influence at this boundary, and safe logs.

Acceptance criteria:

- [ ] Implement `stt-async-v5` behind the PR4 local interface with no SDK type
      above the client/API boundary and no application composition.
- [ ] Apply non-strict English hints, bounded exact-project terms, random
      content-free references, and fixed MIME-derived filenames.
- [ ] Implement transcription-before-exclusive-file deletion, owned 404 success,
      active/ambiguous preservation, fresh cleanup signals, and late fencing.
- [ ] Prove no raw provider response/error, filename, content, user ID, or project
      key reaches logs.
- [ ] Run focused/common verification and record authored/generated totals.

Focused verification:

```bash
node --import tsx --test --test-concurrency=1 \
  tests/api/soniox.test.ts \
  tests/clients/soniox-async-client.test.ts
```

### PR8 - Soniox Reconciler, Selection, And Rollout Gates

File map:

- `src/services/soniox-cleanup-service.ts` (new): own startup/15-minute
  single-flight bounded reconciliation, fresh per-call timeout/lifecycle signals,
  prefix/status/reference safety, one interval, and five-second disposal.
- `src/types/transcription.ts`: add the string-valued OpenAI/Soniox selector enum
  now that both implementations are composed.
- `src/config.ts`: validate provider enum/default, EU-only region, exact async
  model/timeout, conditional key, `NODE_ENV`, production-forbidden REST stub, and
  globally forbidden SDK-owned `SONIOX_BASE_DOMAIN`; resolve the exact EU/test
  REST URL passed to the client.
- `src/shutdown.ts` and `src/index.ts`: construct OpenAI separately for metadata,
  select exactly one async provider, start cleanup after listen whenever a Soniox
  key exists, and extend the one PR2 coordinator with reconciler stop/disposal
  while preserving producer-before-usage order and one signal promise.
- `src/lib/errors.ts`: add only bounded provider unavailable/invalid-result
  translations not already introduced by PR3.
- `assets/legal/privacy.md`: disclose Soniox, EU content/system-metadata split,
  short-lived async storage, no training, deletion, and date.
- `README.md`: document selector, cleanup, no fallback, 140-second downstream,
  DPA/EU/dedicated-project gates, and provider rollback.
- `AGENTS.md`: record cleanup scheduler/dedicated-project constraints.
- `tests/config.test.ts` (new): cover defaults, key condition, EU/model/timeout
  bounds, production endpoint-override rejection, `SONIOX_BASE_DOMAIN`
  rejection in every environment, exact resolved EU/test REST URL, and
  secret-canary failures producing only bounded path/code diagnostics.
- `tests/services/soniox-cleanup-service.test.ts` (new): cover full bounded
  pagination-before-mutation, ordering, statuses, 404/409/errors, repeated IDs/
  cursors, oversized pages, list/delete timeouts, races, single flight, `unref`,
  disposal, and late fencing.
- `tests/index-shutdown.test.ts`: extend production-composition ordering with
  cleanup stop at T+0, five-second disposal/fence, duplicate signals, no late
  provider call, and unchanged producer/usage/DB order.
- `tests/helpers/setup.ts`, `tests/services/voice-service.test.ts`, and
  `tests/voice/transcribe.test.ts`: compose both provider doubles, verify exact
  selection/no fallback, ordered worst-case budget, and unchanged success JSON.
- `.github/workflows/ci.yml`: run a no-egress local Soniox REST stub, wait for it,
  assert both startup list calls, and prohibit live endpoint resolution.
- `env/app/prod.env` (operator-owned, SOPS-encrypted): add the EU key only via
  `npm run env:edit` after legal/provider gates; never expose plaintext.

Acceptance criteria:

- [ ] Keep OpenAI as default and make Soniox selectable only by validated startup
      configuration, never per request and never as fallback.
- [ ] Reconcile only stale prefixed owned resources within all pagination/cursor/
      ID bounds and exact deletion ordering.
- [ ] Give every list/delete a fresh five-second timeout combined with cleanup
      lifecycle, and prevent any late continuation from starting work.
- [ ] Update privacy before production selection and enforce all rollout gates.
- [ ] Prove Docker CI reaches only its local stub and normal successful requests
      leave no provider resources.
- [ ] Run focused/common/Docker verification and record line totals/base SHA.

Focused verification:

```bash
MONGODB_URI_TEST=mongodb://localhost:27017/auth-backend-test \
  node --import tsx --test --test-concurrency=1 \
  tests/config.test.ts \
  tests/services/soniox-cleanup-service.test.ts \
  tests/index-shutdown.test.ts \
  tests/services/voice-service.test.ts \
  tests/voice/transcribe.test.ts
```

PR8 rollout checkpoint:

- [ ] Replace PR7 rather than overlap it: remove the old single instance from
      ingress, stop new body permits, allow the bounded shutdown to complete,
      confirm process exit, then start one PR8 instance with async still OpenAI.
      Before PR8 accepts work, startup failure may restore PR7;
      afterward, require zero active/pending/blocked usage states before any
      rollback.
- [ ] Provision a dedicated Soniox EU project and verify the API key against
      `api.eu.soniox.com`.
- [ ] Accept/review the applicable Soniox DPA and subprocessor materials.
- [ ] Add the key through SOPS before selecting Soniox.
- [ ] Keep `ASYNC_TRANSCRIPTION_PROVIDER=openai` until the downstream client has
      raised its repository-evidenced 30-second end-to-end timeout to at least
      140 seconds and tested a response at the 130-second server boundary.
- [ ] Verify normal requests leave no file or transcription in the Soniox
      project after cleanup.

### PR9 - Realtime Protocol, Parser, And Admission Foundation

File map:

- `src/types/transcription.ts`: add string-valued protocol outcome/error enums
  and the provider-neutral real-time session/client interface.
- `src/models/voice.ts`: add strict protocol-v1 client/server Zod schemas,
  audio enums/rates, 4,096-byte text/2,048-byte JWT bounds, exhaustive error and
  terminal enums, and discriminated event schemas.
- `src/types/ws.d.ts` (new): merge the locked `ws@8.21.1` ESM declaration
  selected by exact `@types/ws@8.18.1`: add
  `maxFragments`/`maxBufferedChunks` to `ServerOptions`; add exported
  `ReceiverOptions` with all eight runtime constructor fields (using
  `Record<string, object>` for extensions and the closed binary-type enum); and
  add exported `Receiver extends node:stream.Writable` with its constructor.
  Named imports compile with no casts, `any`, suppression, or private subpaths.
- `src/services/realtime-connection-gate.ts` (new): own the 32 pending-auth
  leases and their abort controllers, a bounded 4,096-entry fixed one-minute
  peer-window map, 12-upgrade decisions, lazy expiry/full prune, stopping flag,
  transfer/release invariants, and local outcomes without importing Fastify.
  `beginShutdown()` aborts every pending lease; idempotent `dispose()` waits at
  most five seconds for release before generation-fencing the remainder. A known peer continues through
  its existing window; an unseen peer at full capacity returns a closed local
  `peer_capacity` outcome and is not inserted. PR13 maps capacity/stopping
  outcomes to typed 503/`Retry-After: 1`; no window is evicted to admit it.
- `package.json` and `package-lock.json`: pin compatible direct `ws@8.21.1`
  runtime and exact `@types/ws@8.18.1` development dependencies; add
  `typecheck:contracts` as `tsc --project tsconfig.contract-tests.json`; report
  generated lockfile churn separately from authored lines.
- `tsconfig.contract-tests.json` (new): add the exact strict NodeNext/no-emit
  project shown above, with `rootDir` covering source declarations and test
  fixtures and `skipLibCheck: false`; this is separate because the production
  config intentionally excludes `tests/`.
- `.github/workflows/ci.yml`: run `npm run typecheck:contracts` from PR9 onward in
  addition to the source build/typecheck and native tests.
- `tests/lib/ws-parser-limits.test.ts` (new): instantiate the locked `ws`
  `Receiver` with the augmented options and feed controlled encoded chunks to
  deterministically assert 16/17-fragment and 64/65-buffered-chunk limits and
  no-JSON close/status 1008 independent of TCP chunking. Narrow callback errors
  structurally, locate only the `status-code` symbol description through
  `Object.getOwnPropertySymbols`, and assert code/status without a cast.
- `tests/models/voice.test.ts`: extend PR1 coverage with strict protocol schemas,
  enums, frame/rate limits, and discriminated terminal/error shapes.
- `tests/services/realtime-connection-gate.test.ts` (new): cover slots 1-32,
  33rd rejection, 12th/13th known-peer outcomes, 4,096/4,097 unique peers,
  fixed-window reset, lazy prune, spoof-independent string input, unseen-peer
  fail-closed behavior, stopping abort of all pending leases, transfer/release
  exactly once, five-second force fence, duplicate disposal, and late release.

Acceptance criteria:

- [ ] Add direct locked `ws@8.21.1` and exact `@types/ws@8.18.1` dependencies
      through npm and commit/report the generated lockfile change.
- [ ] Make `RealtimeConnectionGate` own both 32 pending slots and the bounded
      4,096-peer/12-per-minute fixed-window map; unseen peers fail closed when
      full through a local outcome, and no attacker-controlled key can make the
      map unbounded.
- [ ] Use the controlled `Receiver` harness to prove 16/17 fragment and 64/65
      buffered-chunk boundaries return parser status 1008 independent of TCP
      chunking; defer route/raw-socket integration to PR13.
- [ ] Prove named ESM `Receiver`, its inherited `Writable.write`/error surface,
      and augmented server options compile under the repository's NodeNext
      TypeScript settings without casts, `any`, suppressions, or private imports.
- [ ] Run the dedicated strict contract-test TypeScript project locally and in
      CI; do not treat `tsx` execution or source-only `tsc` as type evidence.
- [ ] Add strict protocol-v1 client/server message schemas and bounded enums.
- [ ] Merge parser/protocol/admission primitives with no registered public route
      and no production behavior change.
- [ ] Run focused/common verification and record authored/generated totals.

Focused verification:

```bash
npm run typecheck:contracts
MONGODB_URI_TEST=mongodb://localhost:27017/auth-backend-test \
  node --import tsx --test --test-concurrency=1 \
  tests/models/voice.test.ts \
  tests/lib/ws-parser-limits.test.ts \
  tests/services/realtime-connection-gate.test.ts
```

### PR10 - Uncomposed Soniox Realtime Transport Adapter

File map:

- `src/api/soniox.ts`: add strict real-time provider event/control/error
  validation, transcript bounds, and local classifications with path/code-only
  diagnostics.
- `src/clients/soniox-realtime-client.ts` (new): use the direct locked `ws`
  dependency rather than SDK `sendAudio()`; own EU handshake/configuration,
  PCM/context settings, endpoint-detection disablement, exactly one outbound
  write callback, five-second send timeout, finish/cancel/terminate, and local
  provider-event normalization. It remains uncomposed.
- `tests/api/soniox.test.ts`: cover raw real-time events, controls, errors,
  unknown future payloads, transcript bounds, and secret-canary log redaction.
- `tests/clients/soniox-realtime-client.test.ts` (new): cover EU/model/config,
  configuration callback before ready, one write in flight, synchronous throw,
  callback error/timeout, normalized output, finish/cancel/terminate, zero-audio
  avoidance, abort, and late-callback fencing.

Acceptance criteria:

- [ ] Keep every Soniox type/event below the API/client boundary and expose only
      the PR9 provider-neutral interface.
- [ ] Configure `stt-rt-v5`, PCM16 mono/rate, non-strict English hint, bounded
      terms, and disabled endpoint detection exclusively server-side.
- [ ] Treat non-throwing `ws.send()` acceptance as the local attempted-byte
      boundary; callback failure/timeout remains conservatively attempted.
- [ ] Merge with no public route/composition and no production behavior change.
- [ ] Run focused/common verification and record line totals/base SHA.

Focused verification:

```bash
node --import tsx --test --test-concurrency=1 \
  tests/api/soniox.test.ts \
  tests/clients/soniox-realtime-client.test.ts
```

### PR11 - Realtime Lifecycle And Shared Usage Integration

File map:

- `src/services/transcription-usage-service.ts`: add mode-neutral realtime lease
  acquisition/finalization while preserving PR6's opaque token, one capped map,
  internal operation/date/correlation ownership, scheduler, and disposal.
- `src/services/realtime-transcription-service.ts` (new): own the bounded
  10,000-user start-window map, ten admitted provider sessions including
  pre-ready connects, provider/session lifecycle, attempted bytes, idle/wall/
  sample/quota timers and precedence, glossary loading, transcript accumulation,
  exhaustive terminal selection, opaque usage calls, and exactly-once release.
- `src/repositories/daily-usage-repo.ts`: no semantic change; reuse the PR5
  idempotent captured-date operation through usage service only.
- `tests/services/transcription-usage-service.test.ts`: add async/realtime
  overlap, mode-neutral opaque leases, quota cutoffs, and realtime finalization
  while retaining all PR6 ownership/retry regressions.
- `tests/services/realtime-transcription-service.test.ts` (new): use fake clocks/
  provider sessions for start-window capacity/expiry, session admission,
  attempted-byte slicing, wall/sample/quota precedence, tiny-frame wall deadline,
  idle/zero-audio behavior, transcript evolution, every terminal-table row,
  usage pending/collision/operator-blocked outcomes, `usage_recording_failed`,
  and close/error/cancel/shutdown races.
- `tests/voice/transcribe.test.ts`: prove a service-held realtime lease rejects an
  async request before body buffering and releases both admissions correctly.

Acceptance criteria:

- [ ] Enforce 10 starts/minute/user, one active transcription across modes, ten
      realtime sessions including handshakes, and all documented timer/cap rules.
- [ ] Forward only aligned bytes within the remaining budget and account exact
      locally attempted bytes on every terminal path.
- [ ] Use only opaque PR6 usage leases; no realtime caller owns operation ID,
      date, correlation, retry, collision, blocked, or generation state.
- [ ] Normalize confirmed/provisional evolution and select every provider-neutral
      terminal outcome without a Fastify or client-socket dependency.
- [ ] Merge with no registered public route and no production behavior change.
- [ ] Run focused/common verification and record line totals/base SHA.

Focused verification:

```bash
MONGODB_URI_TEST=mongodb://localhost:27017/auth-backend-test \
  node --import tsx --test --test-concurrency=1 \
  tests/repositories/daily-usage-repo.test.ts \
  tests/services/transcription-usage-service.test.ts \
  tests/services/realtime-transcription-service.test.ts \
  tests/voice/transcribe.test.ts
```

### PR12 - Realtime Socket-Session Collaborator And Backpressure

File map:

- `src/routes/voice-realtime-session.ts` (new, not a Fastify plugin): implement
  the exact per-upgraded-socket collaborator consumed by PR13. Its typed
  constructor receives a narrow `RealtimeClientSocket` interface structurally
  satisfied by `ws.WebSocket`, the already-acquired pending lease,
  `TokenService`, and `RealtimeTranscriptionService`; it imports no Fastify type
  and owns immediate listeners, strict first-frame/auth, the always-live
  `starting` listener, 128-KiB/32-frame inbound FIFO, 96/32-KiB pause/resume, one
  client send, 256-KiB `bufferedAmount`, five-second send timeout,
  final/provisional coalescing, terminal serialization, close/terminate fallback,
  and one `closed` promise. Pending-lease abort and service terminal callbacks
  drive graceful shutdown; all terminal/release paths are idempotent.
- `tests/routes/voice-realtime-session.test.ts` (new): use a strict typed fake
  `WebSocket` boundary and fake token/realtime services to cover five-second
  first frame, 4,096/4,097 text, 2,048/2,049 ASCII JWT, strict order/auth,
  pipelined start+frame before delayed ready, all rates, FIFO watermarks/exact
  overflow, slow-client coalescing/buffer/timeout, every application terminal,
  pending/active shutdown callbacks, listener removal, and exact release. Logs
  use secret canaries and must remain content-free.

Acceptance criteria:

- [ ] Add no Fastify route plugin, registration, configuration, or production
      composition in PR12; the exact collaborator remains reachable only through
      focused tests until PR13 creates and registers the typed route.
- [ ] Attach all socket listeners synchronously before any awaited auth/start
      work and preserve invalid pipelined-frame detection.
- [ ] Enforce all first-frame, FIFO, client-send, terminal, and exactly-once
      cleanup rules with no raw values in diagnostics.
- [ ] Make pending/service shutdown signals drive socket closure; never add an
      independent process-level socket registry or timer.
- [ ] Run focused/common verification and record line totals/base SHA.

Focused verification:

```bash
MONGODB_URI_TEST=mongodb://localhost:27017/auth-backend-test \
  node --import tsx --test --test-concurrency=1 \
  tests/services/realtime-transcription-service.test.ts \
  tests/routes/voice-realtime-session.test.ts
```

### PR13 - Typed Route, Conditional Composition, Pre-Close, CI, And Rollout

File map:

- `src/config.ts`: add exact trusted-proxy CIDRs, default-false realtime enable
  flag, conditional Soniox-key rule, exact model/session/concurrency bounds, and
  non-production-only WebSocket endpoint override; failures use only bounded
  path/code diagnostics. Disabled config requires empty trusted CIDRs and no WS
  override; enabled config requires the Soniox key.
- `src/routes/voice-realtime.ts` (new): define `VoiceRealtimeRouteOptions` with
  exactly `TokenService`, `RealtimeConnectionGate`, and
  `RealtimeTranscriptionService`; register the GET WebSocket route; derive only
  Fastify `request.ip`; perform feature/stop, peer-rate/map, and pending-lease
  pre-upgrade checks only when typed `request.ws` is true (ordinary GET remains
  404 without a lease); set typed `config: { rateLimit: false }` so the gate alone
  owns upgrade rate limiting; map local outcomes to 429 or typed 503; transfer
  the typed lease synchronously into the PR12 session collaborator; and release
  it through route error/response hooks if upgrade/transfer does not complete.
- `src/types/fastify.d.ts`: add the typed nullable pending realtime lease on
  `FastifyRequest`; route registration decorates it before use and no unbounded
  WeakMap/request registry is introduced.
- `src/types/websocket-options.ts` (new): define the exact
  `BoundedWebsocketPluginOptions` intersection shown above so the two runtime
  parser fields pass `@fastify/websocket`'s namespace-form `Omit` type without
  casts, `any`, module-private imports, or suppression.
- `package.json` and `package-lock.json`: pin
  `@fastify/websocket@11.3.0`; report generated lockfile churn separately.
- `src/server.ts`: change `AppServices` to carry one optional `realtime` bundle
  of `VoiceRealtimeRouteOptions`; reject config/bundle mismatch. With no bundle,
  keep `trustProxy: false` and register neither WebSocket plugin nor route. With
  the bundle, configure exact CIDRs and register the plugin before all routes
  with exact parser options plus the custom handlers below, then register the
  typed route. Ordinary HTTP auth/route behavior remains unchanged.
- `src/server.ts` custom WebSocket `errorHandler`: log only fixed phase plus
  `safeErrorType`, never the Error/message/request/token; release and clear any
  untransferred typed pending lease, then terminate the socket. After transfer,
  the synchronously attached PR12 close listener owns idempotent cleanup.
- `src/server.ts` custom async WebSocket `preClose`: idempotently stop the
  connection gate and realtime service, reuse/await their bounded disposal
  promises, and do not run the plugin's default client-close loop. Service and
  pending-lease signals close sockets gracefully first; only after those
  promises settle or force-fence does the hook terminate residual clients, await
  their closes for at most one second, and invoke `websocketServer.close` exactly
  once with a one-second callback cap/fence. A direct `app.close()` invokes the
  same path safely; all hook timers are unref'd.
- `src/shutdown.ts` and `src/index.ts`: if and only if the flag is enabled,
  construct the Soniox realtime client, connection gate, service, and one route/
  shutdown bundle; otherwise construct none. Extend the PR2 coordinator with
  that optional bundle and the full producer-first 15+5+2-second sequence; retain
  its entrypoint guard, one `shutdownPromise`, and referenced 22-second deadline.
- `src/lib/errors.ts`: reuse typed 503/`Retry-After: 1` for pending/peer/usage
  capacity; WebSocket application failures remain closed protocol outcomes.
- `README.md`: document protocol v1, default-off/ingress/legal/capacity gates,
  single-instance constraints, replacement/rollback, and operational probes.
- `assets/legal/privacy.md`: add accurate transient realtime-processing wording
  before that mode can be enabled, retaining the PR8 async disclosure.
- `AGENTS.md`: record peer-map, pending/start/session/usage bounds, end-only crash
  loss, and producer-first shutdown constraints.
- `tests/helpers/setup.ts`: compose fake realtime providers/services and dispose
  every permit, timer, retry, socket, and provider session in owner order; expose
  constructor/registration spies proving the disabled graph constructs none.
- `tests/helpers/raw-websocket-client.ts` (new): perform bounded local `node:net`
  upgrades and masked raw frames only for invalid UTF-8/transport cases a
  standards-compliant client cannot construct.
- `tests/types/ws-contract.test.ts` (new): with no casts or suppressions, use
  `satisfies BoundedWebsocketPluginOptions` for all plugin/parser options, pass
  that variable to a typed Fastify `register` call, import/construct named ESM
  `Receiver`, and exercise its inherited typed write/error surface;
  `npm run typecheck:contracts` is the acceptance assertion.
- `tests/config.test.ts`: add default-off, conditional-key, enabled, exact-CIDR,
  model, 1/900-second and 1/10-session bounds, production override rejection,
  disabled-CIDR/WS-override rejection, and secret-canary diagnostic cases.
- `tests/index-shutdown.test.ts`: verify T+0 async/connection/realtime/glossary
  producer stop before `app.close`; concurrent producer drains; force fences;
  usage disposal only after every producer settled/fenced; cleanup/reminder
  bounds; duplicate signals still returning the PR2 promise; custom pre-close;
  close-all; DB order; exit status; hard deadline; and no accounting dispatch
  after usage disposal starts.
- `tests/voice/realtime-transcribe.test.ts` (new): use real `buildApp` to cover
  disabled 404/no constructors/no plugin, config-bundle mismatch, enabled typed
  route, first-frame/auth/order, 32/33 pending, 12/13 peer upgrades,
  4,096/4,097 peer-map behavior, trusted/spoofed forwarding, upgrade after the
  global HTTP counter is exhausted (test-trust loopback as proxy and use one
  fixed non-loopback derived IP for HTTP and upgrade), loopback receiving no
  realtime allowlist,
  32,768/32,769 payload, 16/17 fragments, every application terminal/close,
  exact `Retry-After: 1` on upgrade 503s, redacted plugin error handling, and
  pending-lease release before/after transfer plus pre-close ordering. Use direct
  `ws` `fin: false` for fragmentation and the raw helper only for invalid UTF-8;
  retain the PR9 controlled Receiver test for deterministic 64/65 parser
  buffering.
- `.github/workflows/ci.yml`: retain the PR8 no-egress stub, enable realtime for
  the Docker probe, and retain MongoDB 7, sequential tests, image, health, and
  SIGTERM checks.

Acceptance criteria:

- [ ] Ship realtime default-disabled and register WebSocket support before every
      route only with a complete typed optional bundle; disabled startup creates
      no realtime client/gate/service/plugin/route and requires no Soniox key.
- [ ] Define/register `VoiceRealtimeRouteOptions` in the same PR as the route;
      carry only typed dependencies and never leave a route plugin unregistered.
- [ ] Disable global `@fastify/rate-limit` only on the realtime route with typed
      route config; prove exhausted global/loopback behavior cannot preempt or
      bypass `RealtimeConnectionGate` while ordinary HTTP limiting is unchanged.
- [ ] Replace the plugin defaults with the exact safe error and graceful
      pre-close behavior; prove active/pending sockets are not closed before
      service accounting/drain and residual termination happens only after fence.
- [ ] Synchronously stop `AsyncTranscriptionGate`, `RealtimeConnectionGate`,
      `RealtimeTranscriptionService`, and `GlossaryService` before `app.close()`.
- [ ] Keep `TranscriptionUsageService` fully available to admitted producers;
      stop/dispose it only after all async/realtime producers settle or their
      generations are force-fenced, then close MongoDB last.
- [ ] Implement and prove the exact 15+5+2-second sequence and 22-second hard
      deadline, including duplicate signals and late callbacks.
- [ ] Extend PR9's strict contract typecheck/CI path with the Fastify structural
      options and typed `app.register` fixture; no `tsx`-only claim is accepted.
- [ ] Deploy only by the documented single-instance replacement and keep the
      route disabled until ingress, privacy, Soniox, and capacity gates pass.
- [ ] Run focused/common/Docker/WebSocket/shutdown verification and record line
      totals/base SHA.

Focused verification:

```bash
npm run typecheck:contracts
MONGODB_URI_TEST=mongodb://localhost:27017/auth-backend-test \
  node --import tsx --test --test-concurrency=1 \
  tests/config.test.ts \
  tests/types/ws-contract.test.ts \
  tests/lib/ws-parser-limits.test.ts \
  tests/services/transcription-usage-service.test.ts \
  tests/services/realtime-connection-gate.test.ts \
  tests/services/realtime-transcription-service.test.ts \
  tests/routes/voice-realtime-session.test.ts \
  tests/index-shutdown.test.ts \
  tests/voice/transcribe.test.ts \
  tests/voice/realtime-transcribe.test.ts
```

## Common Automated Verification

Run every integration suite sequentially against MongoDB 7. Do not rely on the
`mongodb-memory-server` fallback for PR acceptance. From the repository root:

```bash
docker run --detach --rm --name sesori-auth-test-mongo \
  --publish 27017:27017 mongo:7
until docker exec sesori-auth-test-mongo mongosh --quiet \
  --eval 'quit(db.runCommand({ ping: 1 }).ok ? 0 : 1)'; do sleep 1; done

npm ci
# Run the PR-specific focused command from its section first.
npm run format:check
npm run lint
npx tsc --noEmit
# PR9 onward: type-check fixtures excluded by the production tsconfig.
npm run typecheck:contracts
npm run build
MONGODB_URI_TEST=mongodb://localhost:27017/auth-backend-test npm test
npm run circular-dependencies
git diff --check origin/master
base="$(git merge-base HEAD origin/master)"
git diff --shortstat "$base"...HEAD -- . \
  ':(exclude)package-lock.json' ':(exclude)env/app/*.env'
git diff --shortstat "$base"...HEAD -- package-lock.json env/app

docker stop sesori-auth-test-mongo
```

`package.json` already fixes `npm test` to `--test-concurrency=1`; every focused
command spells out the same setting. If a command fails, retain its exact output
in the PR and do not mark the slice complete. Stop/remove the named test MongoDB
container manually if an earlier failure exits before the final command.
PR1-PR8 omit the not-yet-created `typecheck:contracts` line; PR9 adds it and CI
must retain it for every later slice.
Add authored insertions plus deletions from the first shortstat and record that
total in the checkpoint ledger; report the second generated/ciphertext shortstat
separately.

## Docker Composition Smoke

The existing CI Docker job is the canonical image/startup check and must remain
green. PR8 adds the local Soniox stub and PR13 enables the local real-time route.
Run the following equivalent Linux/macOS shell smoke after PR8 and PR13; after
PR13 also run the WebSocket probe shown below. The internal Docker network has no
external egress, and validated test-only URL overrides point the startup cleanup
sweep at the stub. This verifies the production image build, Mongo/index
startup, real SDK HTTP composition without live Soniox traffic, `/health`, and
SIGTERM shutdown. Timer/retry behavior remains in fake-clock focused tests.

```bash
smoke_dir="$(mktemp -d)"
cleanup_smoke() {
  docker rm -f sesori-auth-smoke sesori-auth-smoke-mongo \
    sesori-auth-smoke-soniox >/dev/null 2>&1 || true
  docker network rm sesori-auth-smoke-net >/dev/null 2>&1 || true
  rm -rf "$smoke_dir"
}
trap cleanup_smoke EXIT

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out "$smoke_dir/private.pem" 2>/dev/null
openssl rsa -in "$smoke_dir/private.pem" -pubout \
  -out "$smoke_dir/public.pem" 2>/dev/null
JWT_PRIVATE_KEY="$(awk 'NR>1{printf "\\n"}{printf "%s",$0}' "$smoke_dir/private.pem")"
JWT_PUBLIC_KEY="$(awk 'NR>1{printf "\\n"}{printf "%s",$0}' "$smoke_dir/public.pem")"
PRODUCT_ANALYTICS_PSEUDONYMIZATION_KEY="$(openssl rand -base64 32 | tr -d '\n')"
FCM_SA_JSON="$(node -e '
const fs = require("node:fs");
const serviceAccount = {
  type: "service_account",
  project_id: "ci",
  private_key_id: "ci",
  private_key: fs.readFileSync(process.argv[1], "utf8"),
  client_email: "ci@ci.iam.gserviceaccount.com",
  client_id: "1",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/ci",
  universe_domain: "googleapis.com"
};
process.stdout.write(Buffer.from(JSON.stringify(serviceAccount)).toString("base64"));
' "$smoke_dir/private.pem")"

docker build --tag auth-backend:transcription-smoke .
docker network create --internal sesori-auth-smoke-net
docker run --detach --name sesori-auth-smoke-mongo \
  --network sesori-auth-smoke-net mongo:7
until docker exec sesori-auth-smoke-mongo mongosh --quiet \
  --eval 'quit(db.runCommand({ ping: 1 }).ok ? 0 : 1)'; do sleep 1; done

docker run --detach --name sesori-auth-smoke-soniox \
  --network sesori-auth-smoke-net --publish 3002:8080 \
  node:22.22.1-slim node -e '
const http = require("node:http");
let calls = 0;
http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/calls") {
    response.end(JSON.stringify({ calls }));
    return;
  }
  calls += 1;
  if (request.method === "GET" && request.url.startsWith("/v1/transcriptions")) {
    response.end(JSON.stringify({ transcriptions: [], next_page_cursor: null }));
    return;
  }
  if (request.method === "GET" && request.url.startsWith("/v1/files")) {
    response.end(JSON.stringify({ files: [], next_page_cursor: null }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not_found" }));
}).listen(8080, "0.0.0.0");
'

stub_ready=""
for attempt in $(seq 1 30); do
  if stub_ready="$(curl --silent --fail http://localhost:3002/calls)"; then
    break
  fi
  sleep 1
done
node -e 'const body=JSON.parse(process.argv[1]); if (body.calls !== 0) process.exit(1)' \
  "$stub_ready"

docker run --detach --name sesori-auth-smoke \
  --network sesori-auth-smoke-net --publish 3001:3001 \
  -e MONGODB_URI=mongodb://sesori-auth-smoke-mongo:27017/auth-smoke \
  -e "JWT_PRIVATE_KEY=$JWT_PRIVATE_KEY" \
  -e "JWT_PUBLIC_KEY=$JWT_PUBLIC_KEY" \
  -e GITHUB_CLIENT_ID=ci-test \
  -e GITHUB_CLIENT_SECRET=ci-test \
  -e GOOGLE_CLIENT_ID=ci-test \
  -e GOOGLE_CLIENT_SECRET=ci-test \
  -e ALLOWED_REDIRECT_URIS=http://localhost:3000/callback \
  -e RELAY_URL=ws://localhost:8080 \
  -e "PRODUCT_ANALYTICS_PSEUDONYMIZATION_KEY=$PRODUCT_ANALYTICS_PSEUDONYMIZATION_KEY" \
  -e OPENAI_API_KEY=ci-test \
  -e NODE_ENV=test \
  -e ASYNC_TRANSCRIPTION_PROVIDER=openai \
  -e SONIOX_API_KEY=ci-test \
  -e SONIOX_REGION=eu \
  -e SONIOX_API_BASE_URL=http://sesori-auth-smoke-soniox:8080 \
  -e SONIOX_WS_URL=ws://sesori-auth-smoke-soniox:8080/realtime \
  -e REALTIME_TRANSCRIPTION_ENABLED=true \
  -e "FCM_SA_JSON=$FCM_SA_JSON" \
  -e APPLE_CLIENT_ID=ci-test \
  -e APPLE_IOS_CLIENT_ID=ci-test \
  -e APPLE_TEAM_ID=ci-test \
  -e APPLE_KEY_ID=ci-test \
  -e APPLE_PRIVATE_KEY=ci-test \
  auth-backend:transcription-smoke

response=""
for attempt in $(seq 1 30); do
  response="$(curl --silent --fail http://localhost:3001/health)" && break
  sleep 1
done
node -e 'const body=JSON.parse(process.argv[1]); if (body.status !== "ok") process.exit(1)' "$response"

stub_response=""
for attempt in $(seq 1 30); do
  stub_response="$(curl --silent --fail http://localhost:3002/calls)"
  node -e 'const body=JSON.parse(process.argv[1]); process.exit(body.calls >= 2 ? 0 : 1)' \
    "$stub_response" && break
  sleep 1
done
node -e 'const body=JSON.parse(process.argv[1]); if (body.calls < 2) process.exit(1)' \
  "$stub_response"

docker stop --time 25 sesori-auth-smoke
test "$(docker inspect --format '{{.State.ExitCode}}' sesori-auth-smoke)" = "0"
```

PR13 WebSocket registration probe, run after the health assertion and before
`docker stop` in the preceding block:

```bash
node --input-type=module -e '
const socket = new WebSocket("ws://localhost:3001/voice/transcribe/realtime");
const message = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("WebSocket probe timed out")), 10000);
  socket.addEventListener("open", () => socket.send("{}"));
  socket.addEventListener("error", () => reject(new Error("WebSocket upgrade failed")));
  socket.addEventListener("message", (event) => {
    clearTimeout(timer);
    resolve(JSON.parse(String(event.data)));
  });
});
if (message.type !== "error" || message.stage !== "start") {
  throw new Error(`Unexpected WebSocket response: ${JSON.stringify(message)}`);
}
socket.close();
if (socket.readyState !== WebSocket.CLOSED) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket close timed out")), 5000);
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
'
```

### PR6 First Receipt-Writer Deployment

PR6 is the one cutover where process absence alone is insufficient because every
earlier binary can have an already-dispatched raw transcription `$inc`:

1. Build/review the PR6 image but do not start it. Confirm the PR5 maintenance
   CLI and its dedicated MongoDB 7 failpoint suite passed.
2. Enter a full auth maintenance window, remove every old auth process from
   ingress, stop it gracefully, close its MongoClient, and confirm the process/
   container is absent. Force-stop only after the normal deadline and continue
   to the database drain either way.
3. Confirm the tracked `env/app/transcription-drain.env` was edited only through
   `npm run env:edit:transcription-drain`, contains the independently permissioned
   drain identity, and `env/app/prod.env` has no maintenance key. Run exactly
   `npm run maintain-transcription-usage:drain:prod`. Require successful kills,
   five quiet scans, no unknown transcription command, and a content-free
   zero-active report. Missing/wrong-mode privilege or any residual operation
   aborts deployment.
4. Start exactly one PR6 process only after that report, require startup/health,
   run one OpenAI async smoke, and restore ingress. The normal runtime credential
   never receives current-op/kill-op privilege.
5. If PR6 fails before accepting transcription, stop it and restore the prior
   binary. Once PR6 accepts work, roll back only after its shutdown report shows
   zero active, pending, and blocked usage states; otherwise repair/roll forward.

This cutover plus the stopped-auth verified-erasure mode is the only supported
way to remove receipts. It is tested with a delayed legacy command crossing
newer receipt writes rather than assuming process shutdown cancels server work.

### PR13 Replacement Deployment

PR6 and later binaries own process-local usage recovery, and PR13 extends the
PR2 coordinator with the optional realtime/pre-close participants. PR13 must
therefore replace rather than overlap the old process even while realtime is
disabled:

1. Build/review the PR13 image with `REALTIME_TRANSCRIPTION_ENABLED=false` and
   pause automatic rollout.
2. Enter an auth maintenance window: remove the single old instance from ingress
   and stop new HTTP work before sending SIGTERM.
3. Let the old binary execute its bounded producer-first shutdown and require it
   to exit. If it remains beyond its declared deadline, force-stop it and confirm
   the instance/process is absent; do not start PR13 while any old binary can
   still receive or complete work.
4. Start exactly one PR13 instance, require index/startup success and `/health`,
   verify the realtime route is 404, then run one existing unkeyed OpenAI async
   smoke before restoring ingress.
5. If PR13 fails before listening or accepting any transcription, stop it and
   restart the old instance. Once PR13 accepts transcription work, never restart
   an old binary until PR13 is removed from ingress, fully stopped, and its final
   shutdown report records zero active, zero pending, and zero blocked usage
   states.

The optional bounded daily receipt array needs no document backfill. PR6's
privileged command drain, and later process-exit plus zero-state checks, are the
executable enforcement of the no-legacy/no-mixed-binary invariants.

## Deployment And Manual Gates

The repository does not reveal the production ingress timeout. Before PR13 is
enabled for client traffic:

1. Complete PR2's no-mixed-version glossary migration and post-deploy
   `--verify`; never let a normal web startup own the destructive index step.
2. Before PR6 accepts transcription, approve and publish its privacy disclosure
   for durable random operation IDs, per-transcription billed seconds, accurate
   purpose-based retention criteria without a false fixed maximum, and verified
   erasure.
3. Before the first PR6 process starts, complete the exact stopped-auth
   SOPS-backed `maintain-transcription-usage:drain:prod` procedure above with the
   drain-only identity; retain its content-free audit outcome.
4. Run the common automated suite and the exact Docker composition smoke for
   the candidate image. For PR13, run the WebSocket registration probe too.
5. Keep async on OpenAI until the downstream timeout is at least 140 seconds,
   its boundary test receives a server response at the 130-second budget, and
   the PR8 legal/EU/cleanup gates pass.
6. Deploy PR13 with `REALTIME_TRANSCRIPTION_ENABLED=false`; verify the route is
   absent, production rejects `SONIOX_API_BASE_URL`/`SONIOX_WS_URL`, every
   environment rejects `SONIOX_BASE_DOMAIN`, and startup resolves the production
   async REST endpoint to exactly `https://api.eu.soniox.com`.
7. Identify every platform/proxy hop in front of `api.sesori.com`. If proxied,
   record exact source CIDRs in `AUTH_TRUSTED_PROXY_CIDRS`; if direct, retain an
   empty list/`trustProxy: false`. Never use all-proxy or ambiguous hop-count
   trust.
8. In staging, prove WebSocket upgrade support, derived client IP behavior,
   spoofed forwarding-header rejection, the 12/minute peer limit, and 32-socket
   pending-auth cap from the actual ingress path.
9. Configure and demonstrate at least a 20-minute connection/request timeout.
10. Set `REALTIME_TRANSCRIPTION_ENABLED=true` in staging only after steps 7-9,
    then repeat `/health`, invalid-start WebSocket, and SIGTERM checks.
11. Confirm production remains single-instance while the documented in-memory
    auth-server constraints exist.
12. Confirm the Soniox project has at least 10 concurrent real-time sessions and
    100 new real-time requests/minute in EU.
13. Run a staging stream longer than the ingress's former/default timeout and
    verify a terminal event arrives.
14. Stream PCM fixtures at 16,000, 44,100, and 48,000 Hz and compare text against
    Soniox async and the current OpenAI async path.
15. Exercise quota cutoff and 15-minute cutoff with accelerated test settings,
    verifying the final transcript is preserved and the reason is visible.
16. Confirm cancellation/disconnect remove the upstream session and charge only
    attempted-upstream duration.
17. Confirm provider dashboards contain only random Sesori references and no
    user/project identifiers.

## Downstream Client Handoff

Client implementation is a separate plan/change. Its contract obligations are:

- Derive `projectKey` from `bridgeId` and stable `Project.id` with the specified
  v1 formula; never send a raw path to auth.
- Include it in async multipart requests and real-time `start` when project
  context exists.
- Keep a mobile feature flag that selects async upload or real-time streaming,
  independent of provider choice.
- Raise the async client's complete multipart HTTP timeout from 30 seconds to at
  least 140 seconds and test the enforced 130-second server boundary before
  enabling Soniox async; do not derive it from the 60-second provider wait alone.
- Use PCM16 mono and report the recorder's effective 16,000, 44,100, or 48,000
  Hz rate, including platform adjustment callbacks.
- Wait for `ready`, apply final deltas, replace provisional text, and use terminal
  full text as authority.
- Surface at least quota exhaustion and session-limit cutoffs to the user.
- Wait for `cancelled` before starting another voice interaction.
- Preserve provider agnosticism: no Soniox package, model name, event type, or
  error string in client domain/UI contracts.

The client follow-up must review the then-current monorepo tip rather than
implementing against the reference SHA recorded above.

## Rollback

- Mobile can switch its feature flag back to async without removing the
  real-time endpoint.
- Operations can set `ASYNC_TRANSCRIPTION_PROVIDER=openai` and restart; there is
  no per-request provider state or automatic fallback to unwind.
- Keep the Soniox cleanup reconciler running until all prefixed async resources
  are gone, even after switching async back to OpenAI.
- Before rolling PR13 back, set realtime disabled, stop new async/realtime
  admissions, drain active work, and require the shutdown report to show zero
  active, pending, and blocked usage states. Then stop/confirm absence of the
  candidate and pass `npm run maintain-transcription-usage:drain:prod` with the
  drain-only SOPS identity before an older raw-writer binary starts. Optional
  daily receipt fields and completed aggregate values are old-reader compatible,
  but an already-dispatched v2 command still cannot overlap an old writer. If
  pending/blocked states remain, keep the same version, repair MongoDB and
  restart/roll forward; an old binary cannot safely own them.
- For the PR2 glossary cutover, stop the candidate instance and run the
  migration command introduced in PR1,
  `npm run migrate-project-glossary-index -- --rollback`, only if the collection
  is still empty; verify the old-only state before starting an old binary. The
  command refuses after any scoped term exists. At that point only a forward
  repair is allowed because an old binary would read across project scopes.
- A server rollback before real-time support leaves the existing async endpoint
  available. New clients must treat WebSocket upgrade failure as feature
  unavailability and use their rollout flag/fallback policy.

## Definition Of Done

- After all fail-closed rollout gates are satisfied and realtime is deliberately
  enabled, both endpoints are live and provider-agnostic.
- Async defaults to OpenAI and can be deliberately switched to Soniox v5 with
  no response-contract change or hidden fallback.
- Real-time uses Soniox v5 through the auth proxy and returns confirmed partial
  work for all graceful cutoffs and active failures.
- Quota-exhausted starts spend no provider resources; active streams stop at the
  exact attempted-upstream PCM budget and identify the cutoff reason.
- Project glossary lookup never receives a raw path and never falls back across
  missing project scope.
- Normal Soniox async requests leave no stored provider resources, and the
  reconciler handles crash leftovers.
- No audio, transcript, access token, raw project identity, or provider secret
  appears in Sesori persistence or logs. Project-scoped glossary terms remain in
  `glossaryEntries` by design and never appear in logs.
- Privacy disclosure, EU regional setup, capacity, ingress lifetime, tests,
  build, lint, formatting, circular dependency check, and manual smoke checks
  are complete.
- Durable debit receipts have approved retention/erasure wording, the runtime
  app has no maintenance privilege, and delayed-write cutover/erasure tests plus
  content-free maintenance audit outcomes are complete.
