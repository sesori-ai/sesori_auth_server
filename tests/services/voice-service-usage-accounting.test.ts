import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VoiceService } from "../../src/services/voice-service.js";
import type { AsyncTranscriptionClient } from "../../src/clients/async-transcription-client.js";
import type { GlossaryService } from "../../src/services/glossary-service.js";
import type { DailyUsageRepository } from "../../src/repositories/daily-usage-repo.js";
import { AsyncTranscriptionPublicErrorPolicy } from "../../src/types/transcription.js";

/**
 * The usage-accounting tail of `VoiceService.transcribe` is reached only after a
 * provider already returned a transcript, so the route suite cannot drive its
 * branches: the quota race needs a second writer to land between the precheck
 * and the increment. These construct the service directly.
 *
 * Both branches also carry a logging contract. The warning used to print the
 * authenticated user ID; these tests pin that it no longer can.
 */

const USER_ID = "6a7603577dee429b4d11b17a";
const DAILY_LIMIT_SECONDS = 3600;
const DURATION_SECONDS = 10;

function createService(usage: {
  getDailyTranscriptionSeconds: () => Promise<number>;
  incrementTranscriptionSeconds: () => Promise<{ previousTotal: number; newTotal: number }>;
}): VoiceService {
  const dailyUsageRepo = {
    getDailyTranscriptionSeconds: usage.getDailyTranscriptionSeconds,
    incrementTranscriptionSeconds: usage.incrementTranscriptionSeconds,
  } as unknown as DailyUsageRepository;

  const glossaryService = {
    async getContextWords(): Promise<string[]> {
      return [];
    },
  } as unknown as GlossaryService;

  const transcriptionClient: AsyncTranscriptionClient = {
    async transcribe() {
      return { text: "hello", durationSeconds: DURATION_SECONDS };
    },
  };

  return new VoiceService({
    transcriptionClient,
    glossaryService,
    dailyUsageRepo,
    dailyLimitSeconds: DAILY_LIMIT_SECONDS,
    publicErrorPolicy: AsyncTranscriptionPublicErrorPolicy.DetailedV1,
  });
}

async function transcribe(service: VoiceService) {
  return service.transcribe({
    userId: USER_ID,
    projectKey: null,
    fileBuffer: Buffer.from("audio"),
    filename: "a.m4a",
    mimetype: "audio/m4a",
  });
}

describe("VoiceService usage accounting", () => {
  it("reports remaining seconds from the committed total on the normal path", async () => {
    const service = createService({
      getDailyTranscriptionSeconds: async () => 100,
      incrementTranscriptionSeconds: async () => ({ previousTotal: 100, newTotal: 110 }),
    });

    const result = await transcribe(service);

    assert.equal(result.text, "hello");
    assert.equal(result.dailySecondsRemaining, DAILY_LIMIT_SECONDS - 110);
  });

  it("clamps remaining seconds to zero when a concurrent request won the quota race", async (t) => {
    const warnings: unknown[][] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => {
      warnings.push(args);
    });

    const service = createService({
      // The precheck read happened before the competing request landed.
      getDailyTranscriptionSeconds: async () => DAILY_LIMIT_SECONDS - 5,
      // By increment time the account was already over the limit.
      incrementTranscriptionSeconds: async () => ({
        previousTotal: DAILY_LIMIT_SECONDS + 20,
        newTotal: DAILY_LIMIT_SECONDS + 20 + DURATION_SECONDS,
      }),
    });

    const result = await transcribe(service);

    // The transcript is still returned: the caller already paid for the work.
    assert.equal(result.text, "hello");
    // Never a negative or stale positive allowance once the race is lost.
    assert.equal(result.dailySecondsRemaining, 0);

    const logged = JSON.stringify(warnings);
    assert.ok(logged.includes("transcription_quota_race"), "the race must remain observable");
    assert.ok(!logged.includes(USER_ID), "quota-race log must not carry the authenticated user ID");
  });

  it("keeps the transcript and logs only a bounded error type when the usage write fails", async (t) => {
    const errors: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => {
      errors.push(args);
    });

    const service = createService({
      getDailyTranscriptionSeconds: async () => 100,
      // The message deliberately embeds the user ID: only `error.name` may be logged.
      incrementTranscriptionSeconds: async () => {
        throw new Error(`mongo write failed for user ${USER_ID}`);
      },
    });

    const result = await transcribe(service);

    assert.equal(result.text, "hello");
    assert.equal(result.dailySecondsRemaining, DAILY_LIMIT_SECONDS - 100 - DURATION_SECONDS);

    const logged = JSON.stringify(errors);
    assert.ok(logged.includes("transcription_usage_write_failed"), "the failure must remain observable");
    assert.ok(logged.includes("Error"), "the bounded error type is retained");
    assert.ok(!logged.includes(USER_ID), "usage-write-failure log must not carry the authenticated user ID");
  });
});
