import { FastifyPluginAsync } from "fastify";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { BadRequestError, InternalServerError } from "../lib/errors.js";
import type {
  TranscribeReply,
  GlossaryListReply,
  GlossaryAddBody,
  GlossaryAddReply,
  GlossaryRemoveBody,
  GlossaryRemoveReply,
} from "../models/api.js";
import type { VoiceService } from "../services/voice-service.js";

const AUDIO_MAX_FILE_SIZE = 25 * 1024 * 1024;
const ALLOWED_AUDIO_MIMES = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/wav",
  "audio/webm",
  "audio/ogg",
  "audio/flac",
]);
const TRANSCRIBE_RATE_LIMIT = { max: 10, timeWindow: "1 minute" };

const glossaryAddBodySchema = z.object({
  words: z.array(z.string().min(1).max(200)).min(1).max(100),
});

const glossaryRemoveBodySchema = z.object({
  words: z.array(z.string().min(1)).min(1).max(100),
});

export type VoiceRouteOptions = {
  voiceService: VoiceService;
  requireAuth: (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
};

export const voiceRoutes: FastifyPluginAsync<VoiceRouteOptions> = async (fastify, opts) => {
  const { voiceService, requireAuth } = opts;

  await fastify.register(multipart, {
    limits: { fileSize: AUDIO_MAX_FILE_SIZE, files: 1 },
  });

  fastify.post<{ Reply: TranscribeReply }>(
    "/voice/transcribe",
    { preHandler: requireAuth, config: { rateLimit: TRANSCRIBE_RATE_LIMIT } },
    async (request) => {
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

      if (!ALLOWED_AUDIO_MIMES.has(file.mimetype)) {
        throw new BadRequestError({ debugMessage: `Unsupported audio MIME type: ${file.mimetype}` });
      }

      const buffer = await file.toBuffer();
      if (buffer.length === 0) {
        throw new BadRequestError({ debugMessage: "Audio file is empty" });
      }

      const userId = request.user!.userId;

      try {
        const text = await voiceService.transcribe({
          userId,
          fileBuffer: buffer,
          filename: file.filename,
          mimetype: file.mimetype,
        });

        if (!text || text.trim().length === 0) {
          throw new InternalServerError({ debugMessage: "Transcription returned empty text" });
        }

        return { text };
      } catch (error) {
        if (error instanceof BadRequestError || error instanceof InternalServerError) throw error;
        throw new InternalServerError({
          debugMessage: "Transcription failed",
          nestedError: error,
        });
      }
    },
  );

  fastify.get<{ Reply: GlossaryListReply }>("/voice/glossary", { preHandler: requireAuth }, async (request) => {
    const userId = request.user!.userId;
    const words = await voiceService.getGlossaryWords(userId);
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

      const userId = request.user!.userId;
      const added = await voiceService.addGlossaryWords({ userId, words: bodyResult.data.words });
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

      const userId = request.user!.userId;
      const removed = await voiceService.removeGlossaryWords({ userId, words: bodyResult.data.words });
      return { removed };
    },
  );
};
