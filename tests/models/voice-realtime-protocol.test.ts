import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  REALTIME_PROTOCOL_ERROR_RETRYABLE,
  realtimeClientMessageSchema,
  realtimeProtocolFixtureSchema,
  realtimeServerEventSchema,
  realtimeStartMessageSchema,
  realtimeTranscriptEventSchema,
} from "../../src/models/voice.js";
import {
  RealtimeClientMessageType,
  RealtimeProtocolErrorCode,
  RealtimeProtocolVersion,
  RealtimeProviderEventType,
  RealtimeServerEventType,
} from "../../src/types/transcription.js";

const fixturePath = new URL("../fixtures/voice-realtime-protocol-v1.json", import.meta.url);
const fixtureSource = readFileSync(fixturePath, "utf8");
const fixtureResult = realtimeProtocolFixtureSchema.safeParse(JSON.parse(fixtureSource));
assert.equal(fixtureResult.success, true);
const fixture = fixtureResult.data;

describe("realtime protocol v1 schemas", () => {
  it("keeps the canonical fixture free of provider/token-like generated content", () => {
    assert.equal(fixtureSource.includes("accessToken"), false);
    assert.equal(fixtureSource.includes("soniox"), false);
    assert.equal(fixtureSource.includes("user_"), false);
    assert.equal(fixtureSource.includes("sk-"), false);
    assert.equal(fixtureSource.includes("project-123"), false);
    assert.equal(/\bproject-[A-Za-z0-9_-]+\b/.test(fixtureSource), false);
  });

  it("accepts every valid canonical protocol case", () => {
    for (const [name, value] of Object.entries(fixture.valid)) {
      const schema =
        name.startsWith("start") || name === "finish" || name === "cancel"
          ? realtimeClientMessageSchema
          : realtimeServerEventSchema;
      assert.equal(schema.safeParse(value).success, true, name);
    }
  });

  it("rejects every invalid canonical protocol case", () => {
    for (const [name, value] of Object.entries(fixture.invalid)) {
      const schema = isClientInvalidCase(name) ? realtimeClientMessageSchema : realtimeServerEventSchema;
      assert.equal(schema.safeParse(expandFixtureSentinels(value)).success, false, name);
    }
  });

  it("enforces exact start bounds and enum values", () => {
    assert.equal(
      realtimeStartMessageSchema.safeParse({
        type: "start",
        protocolVersion: RealtimeProtocolVersion.V1,
        projectKey: null,
        audio: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
      }).success,
      true,
    );

    assert.equal(
      realtimeStartMessageSchema.safeParse({
        type: "start",
        protocolVersion: RealtimeProtocolVersion.V1,
        projectKey: undefined,
        audio: { encoding: "pcm_s16le", sampleRate: 48000, channels: 1 },
      }).success,
      false,
    );
  });

  it("locks realtime message type enum values to the protocol wire strings", () => {
    assert.deepEqual(RealtimeClientMessageType, {
      Start: "start",
      Finish: "finish",
      Cancel: "cancel",
    });
    assert.deepEqual(RealtimeServerEventType, {
      Ready: "ready",
      Transcript: "transcript",
      Complete: "complete",
      Error: "error",
    });
    assert.deepEqual(RealtimeProviderEventType, {
      Transcript: "transcript",
      Finished: "finished",
    });
  });

  it("requires transcript content and applies the 32768-character public bounds", () => {
    assert.equal(
      realtimeTranscriptEventSchema.safeParse({
        type: "transcript",
        confirmedDelta: "x".repeat(32768),
        provisional: "",
      }).success,
      true,
    );

    assert.equal(
      realtimeTranscriptEventSchema.safeParse({
        type: "transcript",
        confirmedDelta: "x".repeat(32769),
        provisional: "",
      }).success,
      false,
    );
  });

  it("keeps fixed retryability for every closed error code", () => {
    for (const [code, retryable] of Object.entries(REALTIME_PROTOCOL_ERROR_RETRYABLE)) {
      const parsed = realtimeServerEventSchema.safeParse({ type: "error", code, retryable });
      assert.equal(parsed.success, true, code);
      assert.equal(
        realtimeServerEventSchema.safeParse({ type: "error", code, retryable: !retryable }).success,
        false,
        code,
      );
    }

    assert.equal(Object.keys(REALTIME_PROTOCOL_ERROR_RETRYABLE).length, Object.keys(RealtimeProtocolErrorCode).length);
  });
});

function isClientInvalidCase(name: string): boolean {
  return (
    name.includes("Start") ||
    name.includes("Protocol") ||
    name.includes("Sample") ||
    name.includes("Encoding") ||
    name.includes("Channels") ||
    name.includes("Project") ||
    name.includes("Control") ||
    name.includes("finish") ||
    name.includes("cancel")
  );
}

function expandFixtureSentinels(value: unknown): unknown {
  if (value === "__TEXT_32769__") {
    return "x".repeat(32769);
  }

  if (Array.isArray(value)) {
    return value.map((item) => expandFixtureSentinels(item));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandFixtureSentinels(item)]));
  }

  return value;
}
