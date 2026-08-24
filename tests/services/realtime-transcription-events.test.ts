import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RealtimeErrorEvent } from "../../src/services/realtime-transcription-events.js";
import { isPublicEventValid } from "../../src/services/realtime-transcription-events.js";
import { RealtimeProtocolErrorCode, RealtimeServerEventType } from "../../src/types/transcription.js";

describe("realtime public event validation", () => {
  it("rejects structurally assignable error events with extra fields", () => {
    const event = {
      type: RealtimeServerEventType.Error,
      code: RealtimeProtocolErrorCode.InvalidMessage,
      retryable: false,
      providerText: "must not cross boundary",
    } satisfies RealtimeErrorEvent & { readonly providerText: string };

    assert.equal(isPublicEventValid(event), false);
  });
});
