import { DailyUsageRepository } from "../repositories/daily-usage-repo.js";
import { OpenAIClient } from "../clients/openai-client.js";
import { QuotaExceededError } from "../lib/errors.js";
import { loadConfig } from "../config.js";
import { GlossaryService } from "./glossary-service.js";
import type { ProjectKey } from "../models/voice.js";

export class VoiceService {
  readonly #openai: OpenAIClient;
  readonly #glossaryService: GlossaryService;
  readonly #dailyUsageRepo: DailyUsageRepository;

  constructor(deps: { openai: OpenAIClient; glossaryService: GlossaryService; dailyUsageRepo: DailyUsageRepository }) {
    this.#openai = deps.openai;
    this.#glossaryService = deps.glossaryService;
    this.#dailyUsageRepo = deps.dailyUsageRepo;
  }

  async transcribe(args: {
    userId: string;
    projectKey: ProjectKey | null;
    fileBuffer: Buffer;
    filename: string;
    mimetype: string;
  }): Promise<{ text: string; dailySecondsRemaining: number }> {
    const usedSeconds = await this.#dailyUsageRepo.getDailyTranscriptionSeconds(args.userId);

    if (usedSeconds >= loadConfig().DAILY_TRANSCRIPTION_LIMIT_SECONDS) {
      throw new QuotaExceededError({
        service: "transcription",
        debugMessage: `Daily transcription limit reached: ${usedSeconds}/${loadConfig().DAILY_TRANSCRIPTION_LIMIT_SECONDS}s`,
      });
    }

    const glossaryWords = await this.#glossaryService.getContextWords({
      userId: args.userId,
      projectKey: args.projectKey,
    });
    const prompt = this.#buildTranscriptionPrompt(glossaryWords);
    const { text, durationSeconds } = await this.#openai.transcribe({
      fileBuffer: args.fileBuffer,
      filename: args.filename,
      mimetype: args.mimetype,
      prompt: prompt ?? undefined,
    });

    let dailySecondsRemaining: number;
    try {
      const { previousTotal, newTotal } = await this.#dailyUsageRepo.incrementTranscriptionSeconds(
        args.userId,
        durationSeconds,
      );

      if (previousTotal >= loadConfig().DAILY_TRANSCRIPTION_LIMIT_SECONDS) {
        console.warn("[VoiceService] Concurrent quota race detected");
        dailySecondsRemaining = 0;
      } else {
        dailySecondsRemaining = Math.max(0, loadConfig().DAILY_TRANSCRIPTION_LIMIT_SECONDS - newTotal);
      }
    } catch (error) {
      console.error("[VoiceService] Failed to record transcription usage", error);
      dailySecondsRemaining = Math.max(
        0,
        loadConfig().DAILY_TRANSCRIPTION_LIMIT_SECONDS - usedSeconds - durationSeconds,
      );
    }

    return { text, dailySecondsRemaining };
  }

  #buildTranscriptionPrompt(glossaryWords: string[]): string | null {
    if (glossaryWords.length === 0) {
      return null;
    }

    return `The following terms may appear in the audio: ${glossaryWords.join(", ")}.`;
  }
}
