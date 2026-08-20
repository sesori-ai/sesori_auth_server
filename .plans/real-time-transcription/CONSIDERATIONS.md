# Real-Time And Soniox Transcription - Considerations

## Existing Boundaries

- Implementation PRs target auth-server `master`; this plan was reviewed against
  `origin/master` at `7334a564ccaf9aa0fb53094eb70ea18875b36a52`.
  Before this plan PR, the planning branch was fast-forwarded from `18155f2` to
  that reviewed baseline. The intervening commit changed app-client presence
  files and comments/reordering in two referenced files but no transcription
  behavior. Each implementation PR must refresh the remote base and re-audit
  changed mapped files before coding.
- `src/routes/voice.ts` owns the authenticated multipart async endpoint and
  glossary routes.
- `src/services/voice-service.ts` owns async quota checks, glossary loading, and
  post-provider usage recording.
- `src/clients/openai-client.ts` combines transcription with chat completion
  used by session metadata. Replacing that whole client based on the
  transcription setting would break metadata generation.
- `dailyUsage` has a unique `(userId, UTC date)` document and stores fractional
  transcription seconds.
- The auth server has no WebSocket dependency today.
- The relay is intentionally unable to read E2E application payloads. Routing
  readable voice audio through it would violate its trust boundary.
- The current mobile recorder writes a complete file and uploads only after
  release. Real-time capture is a later client concern.

The target deliberately splits implementation into 13 sequential,
independently deployable PRs with a 1,500-authored-changed-line soft cap. Source,
tests, scripts, and ordinary docs count; generated lockfile/SOPS churn is
reported separately. Every PR includes its tests and updates the authoritative
plan checkpoint/base SHA/actual line count. If a forecast exceeds the cap, the
declared fallback boundary is applied before coding unless a smaller merge would
be operationally unsafe and that exception receives explicit review.

## Repository Evidence And Limits

The client observations are based on history, not recollection. At client
baseline `f6ec9e9dc66782197a46261de3bcc002e261a5bd`, both:

```bash
git grep -n '/voice/glossary' f6ec9e9dc66782197a46261de3bcc002e261a5bd -- client
git log --all --oneline -S'/voice/glossary' -- client mobile
```

returned no matches. The repository-visible `voice_api.dart` history starts at
`0b4e6787` on 2026-06-11, has only the 100%-similar path rename `f52be45c`, and
still contains only `POST /voice/transcribe` with a 30-second timeout at the
reference SHA. This is sufficient to avoid invented client compatibility code,
but not sufficient to infer an empty production collection: manual or unknown
callers remain possible, so the production migration command must report zero
documents before the no-backfill rollout proceeds.

The recorder history was checked with `git log --follow` and a diff from
`0b4e6787` to the client baseline. Android remained mono 16,000 Hz and other
platforms remained mono 44,100 Hz; `3f9a2980` only made mono/bit-rate settings
explicit. The stream API research additionally supports effective 48,000 Hz
hardware capture. These are reference facts for a later client implementation,
not an auth-server test substitute.

## Why Proxy Through Auth

Soniox supports direct untrusted-client use with temporary API keys, but that
topology was rejected for this feature.

The auth proxy:

- retains the currently disclosed Sesori-server voice processing path;
- keeps the provider credential out of applications;
- centralizes project glossary lookup and provider configuration;
- can stop a stream at the user's exact local quota;
- can normalize provider-specific token and error behavior;
- permits future provider changes without changing the application protocol.

The costs are an extra network hop, auth-server bandwidth, long-lived sockets,
and explicit backpressure/shutdown work. Those costs are bounded by 10 global
sessions, 15 minutes per session, and a 128-KiB/32-frame FIFO per connection.

## Why The Relay Is Not Involved

The relay forwards encrypted phone/bridge traffic and must not decrypt or
inspect payloads. Transcription is a hosted feature in which Sesori and its
subprocessor intentionally receive readable audio. Adding this traffic to relay
would mix trust postures, consume bridge-routing capacity, and add no useful
authorization or quota capability.

## Provider-Agnostic Contracts

Provider isolation applies in both directions:

- Clients send Sesori audio/control concepts, not Soniox configuration.
- Clients receive finalized text deltas, a replaceable provisional string,
  terminal text/reasons, and bounded errors, not provider tokens.
- Services consume local provider interfaces.
- The Soniox adapters translate SDK/REST/WebSocket events, control tokens,
  request IDs, and errors at the boundary.
- OpenAI transcription text and locally derived duration cross the same kind of
  `safeParse` boundary; neither provider receives a trust exemption.
- Provider/model selection is startup configuration and operational logging,
  never client-visible response data.

This is a current requirement, not a speculative abstraction: async already has
two implementations and the user expects either mode to change providers over
time.

The local async result bounds non-empty text to 1,000,000 characters and finite
positive duration to 86,400 seconds. These are defensive provider-output bounds,
not product promises. Invalid/oversized provider values map to local errors and
are never logged.

Zod's issue message, received value, unknown-key list, and raw issue object can
contain submitted/provider data. Voice boundaries therefore log only a shared,
eight-entry maximum projection of issue code plus allowlisted/static path
segments and numeric indices; unexpected string segments become `<field>`. Raw
`ZodError` values are never attached to the global `ApiError` logger.

Overload responses need a real transport contract, not prose in a route. A typed
positive `retryAfterSeconds` field on `ApiError` is the sole source for the
global handler's `Retry-After` header; the bounded service-unavailable error fixes
it to one second. This avoids arbitrary header injection while guaranteeing all
planned overload 503 responses carry the advertised header.

The Soniox Node SDK's realtime `sendAudio()` returns `void` and exposes no
drain/send acknowledgement. The real-time adapter therefore uses a direct,
declared `ws` dependency. The SDK remains appropriate for async REST work; the
public and service contracts remain independent of either library.

## Audio Contract

Raw PCM16 was selected over container audio because it has no stream header,
decoder rollover, or fragment-boundary ambiguity. It also provides exact local
duration from bytes attempted upstream:

```text
durationSeconds = attemptedBytes / (sampleRate * channels * 2)
```

Mono 16,000 Hz alone is not safe as a public requirement. The existing iOS file
path uses 44,100 Hz because forcing a lower recorder setting previously produced
silent recordings. The current `record_ios` stream path can convert hardware
input with `AVAudioConverter`, but accepting 44,100 and 48,000 Hz avoids making
successful server use depend on that conversion. Web capture can also report an
adjusted hardware/audio-context rate.

The server does not resample. The client must declare the effective stream rate
and may use only 16,000, 44,100, or 48,000 Hz.

Small frames preserve latency and bound memory. A 32 KiB maximum still permits
roughly 341 ms at 48 kHz while normal clients should send 60-120 ms.

Promise-chaining message handlers alone would retain an unbounded number of
Buffers. The route instead pauses reads at 96 KiB, resumes at 32 KiB, and ends a
session before exceeding 128 KiB or 32 frames including one in flight. Only one
provider send callback may be outstanding. Queued data is not usage: the exact
local debit boundary is a non-throwing outbound `ws.send()`. Callback
error/timeout remains conservatively billable because a prefix may have reached
the provider; synchronous throw is not billable. This callback confirms local
socket writing, not Soniox receipt or processing. Soniox processing-progress
fields do not alter the local count, and provider billing may differ from the
Sesori PCM entitlement.

Backpressure also applies toward the app. Only one client send callback is in
flight; unsent final deltas coalesce and provisional text is replacement-only.
At 256 KiB `bufferedAmount` or a five-second callback timeout, the socket is
treated as gone, upstream is cancelled, and usage is handled without retaining
more events or promising a terminal message. Confirmed/provisional buffers are
independently capped at 1,000,000 characters.

Async uploads need admission before buffering, not after. The authenticated
route therefore reserves one 25-MiB slot/user and only two globally before
iterating multipart data, and holds it through provider/accounting. This bounds
raw Buffers to 50 MiB and approximately 100 MiB with one provider copy/request.
The gate rejects rather than queues; disconnect/shutdown abort work but release
waits until cleanup/accounting no longer retains the Buffer.

## Project Identity And Glossary Privacy

The bridge/client `Project.id` is often an original absolute worktree path. It
is stable inside a bridge catalog but is neither safe to persist in auth nor
globally unique across a user's bridges.

The versioned client-side digest solves both problems:

- auth never sees a raw path;
- `bridgeId` provides a bridge namespace and random salt;
- stable `Project.id` survives a directory move;
- the version prefix permits a future derivation change without ambiguous
  dual interpretation.

The digest is not an authorization credential. The authenticated user remains
the outer MongoDB partition. A caller can choose arbitrary valid keys but can
only read/write that same user's entries, which is why per-project and per-user
storage caps are both necessary.

Missing project context intentionally means no glossary. There is no global
fallback. Git history contains no old glossary caller, so no speculative
assignment rule is justified. The operator audit is authoritative: any legacy
row blocks the empty-data migration and requires a separately reviewed data
decision rather than guessing which project owns it.

The target does not expand `VoiceService` into a second domain service.
`GlossaryService` alone owns glossary CRUD, repository calls, project/user cap
checks, bounded per-user mutation queues, and their shutdown lifecycle.
`VoiceService` only requests bounded exact-project terms for transcription. This
keeps MongoDB and queue ownership out of transcription orchestration and gives
each process-local resource one disposal owner.

Soniox limits total structured context to about 10,000 characters/8,000 tokens,
while Sesori permits 500 terms of up to 200 characters. Sending every possible
entry can fail an otherwise valid transcription. The server therefore uses an
alphabetically deterministic subset within an 8,000-character budget and logs
counts only.

MongoDB TypeScript generics do not validate persisted data. Glossary and daily
usage repositories therefore `safeParse` every consumed document/update result,
fail closed without logging malformed contents, and return word/count/number/
outcome DTOs only. Services never receive a Mongo document or `ObjectId`.
Glossary words are intentionally persisted under the authenticated user's opaque
project scope; the privacy rule is that they are never logged, not that they are
absent from Sesori persistence. Audio and transcript content remain unpersisted.

## Language And Feature Settings

The existing OpenAI path explicitly requests English. Soniox will instead use
an English hint without strict restriction, as agreed, so English remains
favored while multilingual or code-switched speech can be recognized.

Language identification is not enabled because language labels are not part of
the product contract. Diarization is not enabled because the current use is a
single phone microphone dictating one prompt. Translation is not enabled.

Semantic endpointing is disabled for the initial quality comparison. It can
irreversibly finalize phrase boundaries and slightly reduce recognition
accuracy. The hold-to-talk release maps naturally to an explicit complete-stream
finish. Soniox may still naturally finalize tokens during a stream; those tokens
are safe to emit as final deltas.

## Quota And Admission Semantics

The real-time server checks durable daily usage before connecting to Soniox.

- At or above quota: reject immediately.
- Under quota: attempted-upstream duration is
  `min(15 minutes, remaining daily seconds)`.
- No grace is added.
- A frame crossing the cap is sliced at an aligned PCM sample boundary.
- The provider is gracefully finished and its final tokens are drained.
- The terminal event identifies whether quota or the session cap stopped it.

The configured session cap is an integer from 1 through the product maximum of
900 seconds and applies twice: as a whole-sample attempted-audio budget and as
an independent wall-clock deadline starting when the first bounded `start`
frame arrives. Tiny frames can reset the 10-second idle timer but cannot extend
that wall deadline. An active wall/sample cap uses `session_limit_reached`; quota
wins when simultaneous. The 1-10 concurrency cap and 1,000-60,000 ms async
timeout are likewise startup-validated with the stated product maxima.

One active transcription per user across both modes prevents two requests on
the current single instance from spending the same pre-checked remainder. The
10-session global cap mirrors Soniox's default real-time concurrency.

Explicit cancellation and transport loss still consume exact attempted-upstream
duration. Otherwise repeated disconnects would bypass the daily entitlement and
provider-cost control.

### End-Only Accounting Tradeoff

The user selected one usage write at session end rather than periodic
checkpoints. This keeps MongoDB off the live audio path, but it has an explicit
failure window:

- a hard process crash can lose the complete session debit, up to 15 minutes;
- normal disconnect/cancel/provider failures still execute final accounting;
- a failed MongoDB write retains a process-local pending debit, blocks new work
  for that user, and retries the same operation ID with backoff;
- a process crash while that retry is pending also loses the debit.

A raw `$inc` retry is unsafe because a majority-committed command can lose its
reply and finish after newer work. The daily aggregate therefore retains every
committed server-generated operation ID and exact seconds for that UTC day in a
bounded receipt array. One conditional majority `findOneAndUpdate` both
increments usage and appends the receipt. A matching retry is a no-op; a
same-ID/different-amount result is a collision and also makes no change. Because
newer receipts never overwrite older ones, even an arbitrarily delayed original
command remains ineligible after its lease is released and newer operations
complete. Generation fencing separately prevents stale process callbacks from
mutating released state.

The receipt array is bounded at 10,000 positive debits per user/UTC day and is
part of daily quota admission before provider work. Reaching that bound has the
same public outcome as exhausting daily seconds. Zero-audio sessions add no
receipt. A worst-case BSON test holds 10,000 UUID/number receipts below 4 MiB,
leaving headroom under MongoDB's 16-MiB document limit. Existing rows need no
backfill, an absent array means zero receipts, and old code ignores and preserves
the optional field. These receipts are durable account-linked usage metadata:
only a random UUID and exact billed seconds are added under the existing
user/date envelope, with no timestamp, provider, project, audio, or transcript.
They follow existing `dailyUsage` operational/account-data retention and verified
erasure. Because this repository has no authoritative account-closure date or
retention job, the plan deliberately makes no fixed maximum promise. Privacy
wording must state enforceable purpose-based criteria, and legal/product review
must approve it before PR6 starts collecting receipts.

Correctness takes precedence over optimizing a bounded integrity read. Admission
and conflict resolution load and `safeParse` the complete daily document inside
`DailyUsageRepository`, including every receipt, uniqueness, and the array cap;
only total/count/outcome DTOs leave the repository. A projection of only the
matching receipt would fail to detect malformed nonmatching entries and is
therefore deliberately rejected.

The exact update gives `$inc`, `$push`, `$set`, and `$setOnInsert` disjoint paths;
`transcriptionSeconds` is not also initialized by `$setOnInsert`. It uses majority
write concern, a two-second-or-caller-cutoff timeout, and a safe command comment.
Only the existing `(userId,date)` code-11000 key is a metadata-upsert race, and
it gets at most one cutoff-bounded rerun after full-document validation. Driver
errors are classified by MongoDB 7 types/codes/labels, never message text:
known-not-dispatched transient selection failures retry, transport/write-concern
uncertainty remains ambiguous, allowlisted deterministic server rejection is
operator-blocked/not-applied, and malformed post-command results are
operator-blocked/unknown. The latter two do not enter an infinite scheduler
loop; they retain a blocked debit and require same-version operator repair/
restart, with restart loss honestly included in the hard-process residual risk.

Collision is repaired automatically inside `TranscriptionUsageService`: keep a
random content-free correlation ID plus the captured date/amount, generate a
fresh operation UUID, and retry the atomic no-op/commit path. PR6 does this inline
within its reserved usage window and transitions unresolved re-keying to normal
pending backoff; PR11 reuses the same mechanism. Collision itself never creates
a blocked state; deterministic persistence corruption/rejection can, and is
reported explicitly.

The PR6 usage service reserves one of 1,000 active/pending/blocked slots before
async body buffering/provider work; PR11 reuses it for realtime. Pending and
blocked states are never evicted during process life. One unref'd scheduler
retries only pending states at bounded concurrency with a 30-second maximum
delay; when full, new users fail before provider spend. Restart still loses
unresolved in-memory state, exactly matching the accepted residual risk rather
than claiming durable reservations.

The first receipt writer also has a legacy boundary that process-local fencing
cannot solve. PR5 ships a separately permissioned stopped-auth maintenance CLI
that finds/kills every current MongoDB transcription increment and requires five
quiet scans. PR6 cannot start until every legacy process/socket is absent and
that database drain passes. The same global drain precedes verified receipt
erasure and user-linked `dailyUsage` deletion, so a late command cannot recreate
the document or become eligible after its receipt disappears. The runtime app
never receives current-op/kill-op privilege. `src/config.ts` owns a dedicated
mode-bound maintenance schema/loader; normal web config neither requires nor
exposes maintenance values. Drain and erasure use separate MongoDB users and
tracked SOPS files under `env/app/`: drain has only `inprog`/`killop`, while
erasure adds only `dailyUsage` find/remove. Exact `sops exec-env` package scripts
load one file, reject a swapped mode, and `env -u` runtime/maintenance variables
in the opposite process. `start:prod` loads only `prod.env`, unsets maintenance
variables, and that file must contain neither key. Dedicated MongoDB 7 failpoint/
role tests exercise delayed writes, privilege separation, and erasure races.

The auth server has no public account-deletion endpoint or closure-date source,
so this plan does not pretend erasure or fixed post-closure expiry is an app
request. Verified receipt erasure is an audited operator procedure; the CLI reads
the target ObjectId from stdin, never argv/logs, and auth remains globally
stopped through drain, deletion, and zero-document verification.

Do not claim stronger crash accounting in implementation or documentation. A
future distributed/multi-instance deployment should replace this mechanism with
durable reservations or periodic atomic consumption before removing the
single-instance constraint.

The usage date is captured at admission and reused for the increment so a
session crossing UTC midnight does not check one day and charge another.
Callers receive only an opaque lease plus remaining seconds and can call
`finalize` or `abandon`; operation ID, date, correlation, generation, collision,
and retry state never leave the usage service. `VoiceService` and realtime code
therefore cannot accidentally create competing accounting identities.

## Transcript Evolution

Soniox non-final tokens replace the current provisional window. Final tokens
are immutable and emitted once within an uninterrupted provider request.

The server therefore owns two buffers:

- append-only confirmed text;
- current replaceable provisional text.

Each public update carries only the new confirmed delta and current provisional
value. The terminal success carries complete confirmed text, which is the
authoritative recovery value if an earlier update was missed.

On upstream failure, only confirmed text is safe to salvage. Provisional text is
discarded because the failed provider cannot finalize it. There is no upstream
resume token or cross-session token identity, so automatic reconnect/replay was
rejected.

## Graceful Cutoffs And Shutdown

Quota, 15-minute, and post-audio 10-second idle cutoffs stop accepting new binary
frames, finish the provider, drain results, write usage, send one terminal
event, and then close. They must not terminate the socket first. A zero-audio
idle or immediate client finish cancels/closes upstream and completes locally;
Soniox rejects `finish()` with "No audio received," so empty-stream behavior
must not depend on it.

Client cancellation is different: stop provider processing, discard transcript
output, persist attempted-upstream duration, acknowledge cancellation, and
close.

An unexpected client disconnect has no channel on which to return text, but it
still stops provider work and persists attempted-upstream duration.

Server shutdown uses the plan's executable 22-second budget. At T+0 it
synchronously closes async, WebSocket, realtime, and glossary producer gates
before `app.close()`, while deliberately leaving usage finalization/retries
available to already admitted generations. It drains those producers through
T+15 and force-fences any remainder; only then does it stop/dispose usage through
T+20 and close MongoDB through T+22. Pre-ready sockets receive
`service_restarting` and active sockets receive the active form with confirmed
text when writable. After a producer fence, its late provider callback cannot
start accounting; a usage operation already dispatched before the fence may
settle idempotently under usage-service ownership but may not write twice, emit,
schedule producer work, or release state twice.

This is not deferred to the realtime rollout. PR2 introduces the one
entrypoint-guarded, import-safe shutdown coordinator and memoized signal promise;
PR3, PR6, PR8, and PR13 extend its concrete participant list and production-order
tests. A slice that adds a composed state owner also adds its T+0 stop,
drain/fence, duplicate-signal, late-callback, and MongoDB-order tests in that
slice.

`@fastify/websocket`'s default pre-close loop would close clients before the
realtime service drains/accounting completes, so it is forbidden. The custom
async hook idempotently starts/reuses pending-gate and realtime-service disposal,
waits for their graceful socket closures or force fences, then terminates only
residual clients, gives close events one second, and closes the WebSocket server
once under a one-second callback cap/fence. Direct `app.close()` uses the same
path. The plugin error handler records only a safe error type and terminates; it
first releases any still-untransferred typed pending lease and never logs the raw
Error, message, request, token, or frame. A transferred session's synchronous
close listener remains the sole cleanup owner.

## Async Soniox Storage And Cleanup

Soniox's real-time API is transient. Its async API necessarily stores an upload
and transcription while the job is processed. Normal code follows an explicit
state matrix rather than blindly deleting on every exit. A known terminal job is
deleted before its exclusive file; owned-ID 404 is idempotent success, 409 means
leave an active job/file, and another transcription-delete failure prevents file
deletion. Ambiguous creation or known queued/processing state leaves both for
the reconciler. Cleanup failure does not replace a successful transcript or the
original translated provider error.

Immediate cleanup alone is insufficient because process termination can happen
between any provider operations. The reconciler is therefore required for both
privacy and Soniox's default file/transcription count limits.

The random `client_reference_id` must not contain the Sesori user ID, project
key, filename/path, or any content-derived value. The untrusted multipart
filename is discarded; validated MIME maps only to fixed ASCII
`sesori-voice.<ext>` names under 32 bytes. Prefix filtering prevents the reconciler from deleting
Console or unrelated resources in the same provider project. A dedicated
Soniox project is still required to tighten operational isolation.

The sweep fully materializes cursor pages before deleting because Soniox does
not promise snapshot-stable cursors during mutation, but materialization is
bounded independently per resource kind to 1,000/page, 10 pages, and 10,000
resources. Cursors are at most 2,048 characters, IDs at most 256, and repeated
cursors/IDs or exceeded bounds abort the sweep before mutation. Queued/processing
and unknown statuses are treated as active. For a stale terminal job, delete the
transcription first, then delete a stale prefixed file only when the bounded
snapshot has no remaining reference. A list failure aborts deletion for that
sweep. Project-wide SDK helpers and SDK cleanup/destroy shortcuts are forbidden.

Every list page and transcription/file delete gets a fresh five-second
`AbortSignal.timeout()` combined with a cleanup-owned lifecycle signal. Immediate
cleanup deliberately does not reuse an already-aborted request signal; shutdown
or the 130-second response watchdog can still abort it. A list timeout aborts
the no-mutation snapshot, a
transcription-delete timeout prevents file deletion, and any cleanup timeout
preserves the original request outcome for a later idempotent sweep. Disposal
aborts the current call and generation checks prevent late callbacks from
starting another call or clearing newer single-flight state.

## Authentication And Protocol Safety

First-frame authentication matches the existing cross-platform relay
convention. It avoids bearer tokens in URLs and does not require WebSocket
clients to support custom upgrade headers.

The tradeoff is that an unauthenticated socket exists briefly. Mitigations are:

- default-disabled route until ingress validation;
- five-second first-frame timeout and 32 pending-auth slots;
- a `RealtimeConnectionGate`-owned fixed-window limit of 12/minute by derived
  peer IP, with no loopback exemption and at most 4,096 live peer entries;
- 32-KiB transport payload, 16-fragment, 64-buffered-chunk, 4,096-byte text, and
  2,048-byte ASCII JWT bounds before JSON/token work;
- disabled WebSocket compression;
- no async/provider work before token validation;
- per-user start limiting after validation.

The locked `ws@8.21.1` parser owns reassembled-payload, 17th-fragment,
65th-buffered-chunk, and invalid-UTF-8 failures. They close
1009/1008/1008/1007 respectively without a JSON promise and take precedence over
application terminal selection. Local declaration merging adds the two runtime
parser-limit options and named ESM `Receiver` export absent from exact
`@types/ws@8.18.1`: `ServerOptions` is extended, while exported
`ReceiverOptions` and `Receiver extends Writable` declare the constructor and
inherited write/error surface. A controlled harness imports it from `ws`, not a
private subpath, and tests the 64/65 chunk boundary without TCP write count,
casts, `any`, or suppressions. The route close owner still aborts pre-ready work
or accounts active attempted bytes and releases all capacity exactly once.

The Fastify plugin types wrap a namespace-form `ServerOptions` in `Omit`, which
does not observe that top-level ambient merge for excess-property checking. A
small exact `BoundedWebsocketPluginOptions` intersection adds only the two
runtime fields; a `satisfies`-checked variable remains assignable to the plugin's
base options and is passed to typed `app.register` without a cast. PR13's type
contract test compiles both paths under NodeNext.

The production `tsconfig.json` excludes tests and `tsx` is transpile-only, so
neither can prove these contracts. PR9 adds a strict, no-emit NodeNext
`tsconfig.contract-tests.json` with `skipLibCheck: false`, explicit ws declaration/
Receiver fixture includes, an npm script, and a required CI step. PR13's Fastify
fixture is added to the same project; both PR9 and PR13 focused commands run it.

The route does not pause reads during asynchronous start processing. Pausing
would hide pipelined pre-ready frames until after the state transition. Instead,
one synchronous listener stays active in `starting`; every additional frame
selects `invalid_message`, aborts generation-checked start work, terminates any
connect already in flight, and prevents `ready`.

To preserve the PR line budget without violating route registration rules, PR12
adds only a non-Fastify per-socket collaborator behind a narrow socket interface;
there is no route plugin in that slice. PR13 adds
`VoiceRealtimeRouteOptions`, the route, request lease decoration, production
registration, optional app bundle, and integration tests together. The route is
therefore never present-but-unregistered, and all pre-upgrade HTTP mapping stays
at the Fastify boundary.

Fastify keeps `trustProxy: false` unless operations configure exact validated
proxy CIDRs. Forwarding headers from any other TCP peer are ignored; `true` and
ambiguous hop counts are forbidden. Until the production ingress and CIDRs are
known, the route stays disabled. In a direct-ingress deployment, the validated
outcome may deliberately remain `trustProxy: false`.

The existing global `@fastify/rate-limit` hook has a 100/minute counter and a
loopback allowlist, so leaving it active would contradict the realtime route's
12/minute/no-allowlist ownership and pre-upgrade precedence. PR13 disables that
plugin on only the realtime route with typed `config: { rateLimit: false }`.
`RealtimeConnectionGate` then owns every upgrade rate decision; ordinary HTTP
routes retain the existing global plugin. Integration tests first exhaust the
global counter and separately use loopback to prove neither global state nor its
allowlist preempts/bypasses the peer gate.

The route passes only Fastify's derived `request.ip` string into
`RealtimeConnectionGate`; the gate has no Fastify dependency. It lazily prunes
expired one-minute windows. At 4,096 live keys, a previously unseen peer fails
closed with a local capacity outcome rather than evicting a live key; the route
maps that outcome to typed HTTP 503/`Retry-After: 1`. Known peers retain their
window and receive HTTP 429 after request 12. This bounds spoofed/direct source
churn even when the trusted ingress legitimately supplies many addresses.

An access token is verified at start. As with the relay, an accepted WebSocket
is not terminated merely because that token later reaches its 15-minute expiry.
The application session itself cannot exceed 15 minutes.

Protocol versioning is in the start/ready messages instead of a provider name
or a new URL. Unsupported versions fail before provider work.

## Scaling Constraints

The auth server is already single-instance because pending OAuth sessions,
app-client presence waiters, bridge notification debounce, and activation
reminder polling use process-local state.

This feature adds process-local:

- at most four glossary mutations/user and 256 globally, including executing
  work, with empty queues removed;
- one 25-MiB async request/user and two globally, held through provider/accounting
  to bound raw/provider-copy memory near 100 MiB;
- at most 4,096 one-minute peer upgrade windows and 32 pending-auth sockets;
- up to 1,000 one-active/pending/blocked transcription states, with no pending or
  blocked eviction;
- up to 10,000 per-user real-time start windows, lazily expired after one minute;
- 10 active real-time sessions;
- one 128-KiB/32-frame FIFO per active real-time session;
- active WebSocket/provider session state;
- one unref'd usage retry scheduler and one unref'd async cleanup interval.

Active socket state is naturally process-bound, but one-user admission and
pending/blocked debit correctness are not shared across instances. Keep auth
single-instance. Before horizontal scaling, use durable/distributed admission
and usage reservation plus a distributed cleanup lease.

## Provider And Application Limits

Soniox's documented default real-time limits on 2026-08-02 are:

- 100 new requests/minute;
- 10 concurrent sessions;
- 300 minutes per provider session.

Sesori deliberately imposes the lower 15-minute application cap. Provider
limits can change, so production configuration and Console values must be
verified before rollout rather than inferred from this document alone.

Soniox async defaults include 1,000 files, 10 GB total file storage, 100 pending
transcriptions, and 2,000 total transcriptions. Prompt cleanup is the normal
control; the reconciler is the crash control.

## Deployment And Compatibility

The old async route remains because released clients use it. Its success
response does not change. Clients that omit `projectKey` continue transcribing,
but intentionally receive no glossary context.

The project-scope index replacement is an offline compatibility boundary, not a
rolling migration. PR1's dry-run command audits document shape and both index
specs; PR2 owns the application cutover. During its single-instance maintenance
window, `--apply` creates and
verifies `{ userId, projectKey, word }` unique before dropping
`{ userId, word }`; app startup verifies the completed state but never performs
the destructive drop. Old and new binaries must not overlap because the old
binary omits project scope and reads all of a user's terms. Rollback creates and
verifies the old index before dropping the new one and is permitted only while
the collection remains empty. An interrupted apply is rerun; once scoped data
exists, recovery is forward-only.

The async provider setting defaults to OpenAI. This provides an explicit
rollback and makes quality testing attributable. Automatic fallback would send
one recording to two subprocessors, can bill twice, and makes observed output
provider ambiguous.

The reference client aborts the complete multipart request after 30 seconds. A
provider-only 60-second number is not the response contract: the server enforces
a 130-second handler budget comprising 45 seconds body receive, 60 seconds
provider work, two ordered five-second cleanup calls, the PR6 worst-case
10-second usage write, and five seconds response margin. Multipart expiry is
408; provider/overall expiry is 504; no new stage starts after the watchdog.
Operations may not switch to Soniox until the downstream complete-request timeout
is at least 140 seconds and a boundary test receives the server's 130-second
outcome. The extra 10 seconds covers authentication, TLS/request setup, and
response transit. A timeout merely above 60 seconds remains incompatible.

PR5 introduces the bounded durable daily receipts and PR6 integrates the usage
service before Soniox is selectable. PR6 reserves fixed stage cutoffs: validated
provider result by T+105, cleanup by T+115, usage by T+125, response by T+130.
Once a transcript/duration is validated, cleanup failure or client disconnect
cannot suppress the reserved usage attempt. A new append or matching receipt
charges once; collision re-keys atomically; ambiguous writes retry inside the
request's usage window. Known-not-applied availability failures use the same
bounded retry path. If unresolved at T+125, PR6 retains the exact debit in its
bounded, user-blocking pending map and reports conservative remaining quota when
writable. Deterministic/unknown operator-blocked outcomes retain a non-retrying
blocked debit and return the explicit internal accounting failure. If scheduler
delay reaches T+125 before dispatch, the owned lease transitions to pending
before body-buffer release; no unowned late write starts. PR11 reuses this
lifecycle for realtime.

The real-time route is additive but fail-closed: PR13 ships
`REALTIME_TRANSCRIPTION_ENABLED=false`, so no route is registered until
operations finish ingress/legal/provider checks. Once enabled, the later mobile
feature flag controls cohort use between async and real-time; it does not select
Soniox versus another provider.

Disabled also means no hidden realtime object graph: config rejects trusted
proxy CIDRs/WS override in that state, `index.ts` constructs no realtime Soniox
client, connection gate, transcription service, or route bundle, `server.ts`
registers no WebSocket plugin/route, and shutdown has no realtime participant.
When enabled, the key is mandatory and one complete optional bundle is built or
startup fails. `AppServices` carries that bundle as one optional typed property,
and the route plugin is created and conditionally registered in the same PR with
options containing exactly token, connection-gate, and realtime-service
dependencies.

PR6 changes live async admission/debit ownership, so PR6 and every later slice
deploy as sequential single-instance replacements, never rolling overlap. For
the first PR6 deployment, remove/stop/confirm absence of every legacy process and
socket, then pass PR5's separately permissioned current-op kill/quiet drain
before PR6 starts; this fences raw increments already dispatched to MongoDB.
Later replacements synchronously stop producer gates, complete bounded shutdown,
confirm process absence, and require zero active/pending/blocked usage states.
Rollback to any old raw writer additionally reruns the database drain after the
new process stops. Optional aggregate receipts are old-reader compatible, but
process-local recovery ownership and late database commands are not safe to
overlap. PR13 only extends the PR2 22-second coordinator with the optional
realtime bundle and WebSocket pre-close participants; it does not create a
second coordinator or relax this rule.

Production ingress behavior is unresolved. The implementation cannot be
considered rollout-ready until the actual platform is shown to pass WebSocket
upgrades and hold a connection for at least 20 minutes. A shorter infrastructure
timeout can bypass graceful application finalization and lose the terminal
event.

Non-production Soniox endpoint overrides exist only to test real SDK
composition. Docker CI sets `NODE_ENV=test`, uses an internal no-egress network,
and points the startup reconciler to a local list stub. Production validation
rejects those overrides and derives REST/WebSocket endpoints from the closed
`SONIOX_REGION` allowlist. The SDK-specific `SONIOX_BASE_DOMAIN` variable is
forbidden and startup-rejected in every environment. The async client always
receives the validated resolved REST URL as explicit SDK `base_url`, exactly
`https://api.soniox.com` for official production, so SDK environment precedence
cannot redirect the key or audio.

## Legal And Data Residency

The chosen Soniox project is US regional and must use both the US project key
and US domains:

- `https://api.soniox.com`
- `wss://stt-rt.soniox.com/transcribe-websocket`

Soniox documents that content remains in the selected region, while account,
billing, usage, security, and other system metadata may be processed elsewhere.
The hosted Privacy Policy must disclose Soniox Inc. and this distinction before
production audio is sent.

OpenAI remains a disclosed subprocessor because the async flag can select it
and `OpenAIClient` still provides metadata chat completion. Soniox's public
no-training and certification statements do not replace contractual review;
the applicable DPA and regional access are deployment prerequisites.

## Observability

V1 uses bounded structured logs rather than adding a metrics subsystem.
Permitted fields include:

- random local/provider request reference;
- mode and configured provider enum;
- lifecycle outcome or terminal reason;
- safe provider error type and request ID;
- duration, latency, frame count, and cleanup counts;
- admission/rate/capacity outcome.

Forbidden fields include audio, transcript/provisional text, glossary words,
access tokens, raw user IDs, raw/opaque project IDs, filenames containing local
paths, raw Zod issues/messages/unknown-key lists/received values, and raw upstream
error text that has not been classified as safe.

## Authoritative External References

- Soniox models: <https://soniox.com/docs/stt/models>
- WebSocket API: <https://soniox.com/docs/api-reference/stt/websocket-api>
- Real-time transcription: <https://soniox.com/docs/stt/rt/real-time-transcription>
- Manual finalization: <https://soniox.com/docs/stt/rt/manual-finalization>
- Real-time limits: <https://soniox.com/docs/stt/rt/limits-and-quotas>
- Async transcription: <https://soniox.com/docs/stt/async/async-transcription>
- Async limits: <https://soniox.com/docs/stt/async/limits-and-quotas>
- Delete transcription: <https://soniox.com/docs/api-reference/stt/transcriptions/delete_transcription>
- Delete file: <https://soniox.com/docs/api-reference/stt/files/delete_file>
- Provider errors: <https://soniox.com/docs/api-reference/errors>
- Context: <https://soniox.com/docs/stt/concepts/context>
- Language hints: <https://soniox.com/docs/stt/concepts/language-hints>
- Node SDK: <https://soniox.com/docs/sdk/node-SDK>
- Node SDK reference: <https://soniox.com/docs/sdk/node-SDK/reference>
- Data residency: <https://soniox.com/docs/data-residency>
- Security and privacy: <https://soniox.com/docs/security-and-privacy>
