import { FastifyPluginAsync } from "fastify";
import multipart from "@fastify/multipart";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { BadRequestError, InternalServerError, QuotaExceededError } from "../lib/errors.js";
import { requireAuth } from "../middleware/auth.js";
import type {
  TranscribeReply,
  GlossaryListReply,
  GlossaryAddBody,
  GlossaryAddReply,
  GlossaryRemoveBody,
  GlossaryRemoveReply,
} from "../models/api.js";
import { VoiceService } from "../services/voice-service.js";

const AUDIO_MAX_FILE_SIZE = 25 * 1024 * 1024;

const glossaryAddBodySchema = z.object({
  words: z.array(z.string().min(1).max(200)).min(1).max(100),
});

const glossaryRemoveBodySchema = z.object({
  words: z.array(z.string().min(1)).min(1).max(100),
});

export const voiceRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(multipart, {
    limits: { fileSize: AUDIO_MAX_FILE_SIZE, files: 1 },
  });

  fastify.post<{ Reply: TranscribeReply }>("/voice/transcribe", { preHandler: requireAuth }, async (request) => {
    let file;
    try {
      file = await request.file();
    } catch (error) {
      throw new BadRequestError({
        debugMessage: "Request must be multipart/form-data with an audio file",
        nestedError: error,
      });
    }
    if (!file) {
      throw new BadRequestError({ debugMessage: "No audio file provided" });
    }

    const buffer = await file.toBuffer();
    if (buffer.length === 0) {
      throw new BadRequestError({ debugMessage: "Audio file is empty" });
    }

    const userId = new ObjectId(request.user!.userId);

    try {
      const result = await VoiceService.transcribe({
        userId,
        fileBuffer: buffer,
        filename: file.filename,
        mimetype: file.mimetype,
      });

      if (!result.text || result.text.trim().length === 0) {
        throw new InternalServerError({ debugMessage: "Transcription returned empty text" });
      }

      return { text: result.text, dailySecondsRemaining: result.dailySecondsRemaining };
    } catch (error) {
      if (
        error instanceof BadRequestError ||
        error instanceof InternalServerError ||
        error instanceof QuotaExceededError
      )
        throw error;
      throw new InternalServerError({
        debugMessage: "Transcription failed",
        nestedError: error,
      });
    }
  });

  fastify.get<{ Reply: GlossaryListReply }>("/voice/glossary", { preHandler: requireAuth }, async (request) => {
    const userId = new ObjectId(request.user!.userId);
    const words = await VoiceService.getGlossaryWords(userId);
    return { words };
  });

  fastify.post<{ Body: GlossaryAddBody; Reply: GlossaryAddReply }>(
    "/voice/glossary",
    { preHandler: requireAuth },
    async (request) => {
      const bodyResult = glossaryAddBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        throw new BadRequestError({ debugMessage: "Invalid request body", nestedError: bodyResult.error.issues });
      }

      const userId = new ObjectId(request.user!.userId);
      const added = await VoiceService.addGlossaryWords({ userId, words: bodyResult.data.words });
      return { added };
    },
  );

  fastify.delete<{ Body: GlossaryRemoveBody; Reply: GlossaryRemoveReply }>(
    "/voice/glossary",
    { preHandler: requireAuth },
    async (request) => {
      const bodyResult = glossaryRemoveBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        throw new BadRequestError({ debugMessage: "Invalid request body", nestedError: bodyResult.error.issues });
      }

      const userId = new ObjectId(request.user!.userId);
      const removed = await VoiceService.removeGlossaryWords({ userId, words: bodyResult.data.words });
      return { removed };
    },
  );
};
