import { FastifyPluginAsync, FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { ApiError, BadRequestError, InternalServerError, UnauthenticatedError } from "../lib/errors.js";
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

// MIME types accepted by the OpenAI Whisper API.
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

// 10 requests per minute per authenticated user (service-level safety limit).
// keyGenerator keys by Authorization header (user-specific token, available before auth parsing).
// Falls back to IP when no Authorization header is present (unauthenticated requests).
const TRANSCRIBE_RATE_LIMIT = {
  max: 10,
  timeWindow: "1 minute",
  keyGenerator: (request: FastifyRequest) => request.headers.authorization ?? request.ip,
};

const glossaryAddBodySchema = z.object({
  words: z.array(z.string().min(1).max(200)).min(1).max(100),
});

const glossaryRemoveBodySchema = z.object({
  words: z.array(z.string().min(1)).min(1).max(100),
});

export type VoiceRouteOptions = {
  voiceService: VoiceService;
  requireAuth: (request: FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
};

/**
 * Returns the authenticated user's ID from the request.
 * Throws UnauthenticatedError defensively if requireAuth somehow did not set the user.
 */
function getUserId(request: FastifyRequest): string {
  if (!request.user) throw new UnauthenticatedError();
  return request.user.userId;
}

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

      const userId = getUserId(request);

      try {
        const { text, dailySecondsRemaining } = await voiceService.transcribe({
          userId,
          fileBuffer: buffer,
          filename: file.filename,
          mimetype: file.mimetype,
        });

        if (!text || text.trim().length === 0) {
          throw new InternalServerError({ debugMessage: "Transcription returned empty text" });
        }

        return { text, dailySecondsRemaining };
      } catch (error) {
        // Re-throw any ApiError subclass (BadRequestError, InternalServerError, QuotaExceededError, etc.)
        // so the global error handler returns the correct status code.
        if (error instanceof ApiError) throw error;
        throw new InternalServerError({
          debugMessage: "Transcription failed",
          nestedError: error,
        });
      }
    },
  );

  fastify.get<{ Reply: GlossaryListReply }>("/voice/glossary", { preHandler: requireAuth }, async (request) => {
    const userId = getUserId(request);
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

      const userId = getUserId(request);
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

      const userId = getUserId(request);
      const removed = await voiceService.removeGlossaryWords({ userId, words: bodyResult.data.words });
      return { removed };
    },
  );
};
