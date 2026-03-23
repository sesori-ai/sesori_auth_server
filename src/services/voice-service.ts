import { GlossaryEntryRepository } from "../repositories/glossary-entry-repo.js";
import { DailyUsageRepository } from "../repositories/daily-usage-repo.js";
import { OpenAIClient } from "../clients/openai-client.js";
import { QuotaExceededError } from "../lib/errors.js";
import { loadConfig } from "../config.js";

// Hardcoded cap to prevent unbounded DB growth and prompt latency.
const MAX_GLOSSARY_SIZE = 500;

export class VoiceService {
  readonly #openai: OpenAIClient;
  readonly #glossaryRepo: GlossaryEntryRepository;
  readonly #dailyUsageRepo: DailyUsageRepository;

  constructor(deps: {
    openai: OpenAIClient;
    glossaryRepo: GlossaryEntryRepository;
    dailyUsageRepo: DailyUsageRepository;
  }) {
    this.#openai = deps.openai;
    this.#glossaryRepo = deps.glossaryRepo;
    this.#dailyUsageRepo = deps.dailyUsageRepo;
  }

  /**
   * Transcribes audio after checking the user's daily quota.
   *
   * Flow:
   *  1. Pre-check: read current usage; throw QuotaExceededError if already at limit.
   *  2. Transcribe via OpenAI.
   *  3. Atomic increment: detects concurrent quota races via "before" snapshot.
   *     If a race is detected (another request consumed quota between steps 1 and 3),
   *     returns `dailySecondsRemaining: 0` without failing the response.
   *  4. Soft-fail on increment DB error: the transcription already completed, so we
   *     log and return an estimated remaining value rather than penalising the user
   *     for an infrastructure failure. The pre-check in step 1 is the primary quota gate.
   *
   * @throws QuotaExceededError when the daily limit is reached before transcription.
   */
  async transcribe(args: {
    userId: string;
    fileBuffer: Buffer;
    filename: string;
    mimetype: string;
  }): Promise<{ text: string; dailySecondsRemaining: number }> {
    // Step 1 — pre-check (fast rejection before spending OpenAI credits).
    const usedSeconds = await this.#dailyUsageRepo.getDailyTranscriptionSeconds(args.userId);

    if (usedSeconds >= loadConfig().DAILY_TRANSCRIPTION_LIMIT_SECONDS) {
      throw new QuotaExceededError({
        service: "transcription",
        debugMessage: `Daily transcription limit reached: ${usedSeconds}/${loadConfig().DAILY_TRANSCRIPTION_LIMIT_SECONDS}s`,
      });
    }

    // Step 2 — transcribe.
    const glossaryWords = await this.getGlossaryWords(args.userId);
    const prompt = this.#buildTranscriptionPrompt(glossaryWords);

    const { text, durationSeconds } = await this.#openai.transcribe({
      fileBuffer: args.fileBuffer,
      filename: args.filename,
      mimetype: args.mimetype,
      prompt: prompt ?? undefined,
    });

    // Step 3 — atomic increment with race detection.
    // returnDocument "before" exposes the snapshot prior to our increment, letting us
    // detect whether a concurrent request already consumed the quota in the window
    // between our pre-check (step 1) and now.
    let dailySecondsRemaining: number;
    try {
      const { previousTotal, newTotal } = await this.#dailyUsageRepo.incrementTranscriptionSeconds(
        args.userId,
        durationSeconds,
      );

      if (previousTotal >= loadConfig().DAILY_TRANSCRIPTION_LIMIT_SECONDS) {
        // Race condition: a concurrent request exhausted the quota between our pre-check and increment.
        // We do not fail the response — the transcription is already complete.
        console.warn("[VoiceService] Concurrent quota race detected for user", args.userId);
        dailySecondsRemaining = 0;
      } else {
        dailySecondsRemaining = Math.max(0, loadConfig().DAILY_TRANSCRIPTION_LIMIT_SECONDS - newTotal);
      }
    } catch (error) {
      // Soft-fail: if the usage-recording write fails (e.g., transient DB error), we
      // do not fail the response. Failing here would penalise the user for an
      // infrastructure issue after their audio has already been transcribed.
      // The pre-check at step 1 is the primary quota enforcement gate.
      console.error("[VoiceService] Failed to record transcription usage", error);
      dailySecondsRemaining = Math.max(
        0,
        loadConfig().DAILY_TRANSCRIPTION_LIMIT_SECONDS - usedSeconds - durationSeconds,
      );
    }

    return { text, dailySecondsRemaining };
  }

  async getGlossaryWords(userId: string): Promise<string[]> {
    const entries = await this.#glossaryRepo.findByUserId(userId);
    return entries.map((e) => e.word);
  }

  async addGlossaryWords(args: { userId: string; words: string[] }): Promise<string[]> {
    const existing = await this.#glossaryRepo.findByUserId(args.userId);
    const remaining = MAX_GLOSSARY_SIZE - existing.length;

    if (remaining <= 0) {
      return [];
    }

    const existingWords = new Set(existing.map((e) => e.word));
    const newWords = args.words.filter((w) => !existingWords.has(w));
    const wordsToAdd = newWords.slice(0, remaining);

    return this.#glossaryRepo.insertMany({ userId: args.userId, words: wordsToAdd });
  }

  async removeGlossaryWords(args: { userId: string; words: string[] }): Promise<number> {
    return this.#glossaryRepo.deleteMany({ userId: args.userId, words: args.words });
  }

  #buildTranscriptionPrompt(glossaryWords: string[]): string | null {
    if (glossaryWords.length === 0) {
      return null;
    }

    return `The following terms may appear in the audio: ${glossaryWords.join(", ")}.`;
  }
}
