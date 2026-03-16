import { ObjectId } from "mongodb";
import { GlossaryEntryRepository } from "../repositories/glossary-entry-repo.js";
import { TranscriptionUsageRepository } from "../repositories/transcription-usage-repo.js";
import { OpenAIClient } from "../clients/openai-client.js";
import { QuotaExceededError } from "../lib/errors.js";

const MAX_GLOSSARY_SIZE = 500;
const DAILY_TRANSCRIPTION_LIMIT_SECONDS = 3600;

export class VoiceService {
  private constructor() {}

  static async transcribe(args: {
    userId: ObjectId;
    fileBuffer: Buffer;
    filename: string;
    mimetype: string;
  }): Promise<{ text: string; dailySecondsRemaining: number }> {
    const usedSeconds = await TranscriptionUsageRepository.getDailyUsedSeconds(args.userId);

    if (usedSeconds >= DAILY_TRANSCRIPTION_LIMIT_SECONDS) {
      throw new QuotaExceededError({
        debugMessage: `Daily transcription limit reached: ${usedSeconds}/${DAILY_TRANSCRIPTION_LIMIT_SECONDS}s`,
      });
    }

    const glossaryWords = await VoiceService.getGlossaryWords(args.userId);
    const prompt = VoiceService.buildTranscriptionPrompt(glossaryWords);

    const { text, durationSeconds } = await OpenAIClient.transcribe({
      fileBuffer: args.fileBuffer,
      filename: args.filename,
      mimetype: args.mimetype,
      prompt: prompt ?? undefined,
    });

    const newTotal = await TranscriptionUsageRepository.incrementDailyUsage(args.userId, durationSeconds);
    const remaining = Math.max(0, DAILY_TRANSCRIPTION_LIMIT_SECONDS - newTotal);

    return { text, dailySecondsRemaining: remaining };
  }

  static async getGlossaryWords(userId: ObjectId): Promise<string[]> {
    const entries = await GlossaryEntryRepository.findByUserId(userId);
    return entries.map((e) => e.word);
  }

  static async addGlossaryWords(args: { userId: ObjectId; words: string[] }): Promise<string[]> {
    const currentEntries = await GlossaryEntryRepository.findByUserId(args.userId);
    const remaining = MAX_GLOSSARY_SIZE - currentEntries.length;

    if (remaining <= 0) {
      return [];
    }

    const existingWords = new Set(currentEntries.map((e) => e.word));
    const newWords = args.words.filter((w) => !existingWords.has(w));
    const wordsToAdd = newWords.slice(0, remaining);
    return GlossaryEntryRepository.insertMany({ userId: args.userId, words: wordsToAdd });
  }

  static async removeGlossaryWords(args: { userId: ObjectId; words: string[] }): Promise<number> {
    return GlossaryEntryRepository.deleteMany({ userId: args.userId, words: args.words });
  }

  private static buildTranscriptionPrompt(glossaryWords: string[]): string | null {
    if (glossaryWords.length === 0) return null;
    return `The following terms may appear in the audio: ${glossaryWords.join(", ")}.`;
  }
}
