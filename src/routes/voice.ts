import { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { ApiError, BadRequestError, InternalServerError, UnauthenticatedError } from "../lib/errors.js";
import type {
  TranscribeReply,
  GlossaryListQuery,
  GlossaryListReply,
  GlossaryAddBody,
  GlossaryAddReply,
  GlossaryRemoveBody,
  GlossaryRemoveReply,
} from "../models/api.js";
import {
  glossaryAddBodySchema,
  glossaryListQuerySchema,
  glossaryRemoveBodySchema,
  transcribeMultipartSchema,
  type ProjectKey,
} from "../models/voice.js";
import type { GlossaryService } from "../services/glossary-service.js";
import type { VoiceService } from "../services/voice-service.js";

const AUDIO_MAX_FILE_SIZE = 25 * 1024 * 1024;
const AUDIO_FIELD_NAME = "audio";
const TRANSCRIBE_FIELD_MAX_SIZE = 1024;

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

export type VoiceRouteOptions = {
  voiceService: VoiceService;
  glossaryService: GlossaryService;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

/**
 * Returns the authenticated user's ID from the request.
 * Throws UnauthenticatedError defensively if requireAuth somehow did not set the user.
 */
function getUserId(request: FastifyRequest): string {
  if (!request.user) throw new UnauthenticatedError();
  return request.user.userId;
}

/** Reports whether the multipart parser rejected the upload for exceeding the file-size limit. */
function isFileTooLargeError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "FST_REQ_FILE_TOO_LARGE";
}

/**
 * Reads the transcription multipart body: exactly one `audio` file plus at most
 * one optional `projectKey` text field, accepted in any part order.
 */
async function readTranscribeRequest(request: FastifyRequest): Promise<{
  audio: { buffer: Buffer; filename: string; mimetype: string };
  projectKey: ProjectKey | null;
}> {
  let audio: { buffer: Buffer; filename: string; mimetype: string } | null = null;
  const fields: Record<string, string> = {};

  try {
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== AUDIO_FIELD_NAME || audio !== null) {
          throw new BadRequestError({ debugMessage: "Unexpected file part" });
        }

        if (!ALLOWED_AUDIO_MIMES.has(part.mimetype)) {
          throw new BadRequestError({ debugMessage: `Unsupported audio MIME type: ${part.mimetype}` });
        }

        audio = { buffer: await part.toBuffer(), filename: part.filename, mimetype: part.mimetype };
        continue;
      }

      if (Object.hasOwn(fields, part.fieldname) || part.valueTruncated || typeof part.value !== "string") {
        throw new BadRequestError({ debugMessage: "Invalid text part" });
      }

      fields[part.fieldname] = part.value;
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;

    // FST_REQ_FILE_TOO_LARGE carries its own 413; the global handler must keep
    // that status rather than see an oversized upload reported as a 400.
    if (isFileTooLargeError(error)) throw error;

    throw new BadRequestError({
      debugMessage: "Request must be multipart/form-data with an audio file",
      nestedError: error,
    });
  }

  if (!audio) {
    throw new BadRequestError({ debugMessage: "No audio file provided" });
  }

  if (audio.buffer.length === 0) {
    throw new BadRequestError({ debugMessage: "Audio file is empty" });
  }

  const parsedFields = transcribeMultipartSchema.safeParse(fields);
  if (!parsedFields.success) {
    throw new BadRequestError({ debugMessage: "Invalid multipart fields", nestedError: parsedFields.error.issues });
  }

  // COMPATIBILITY 2026-08-06 (v0.1.0): Apps at or before 1.6.1 omit projectKey. Omission means no glossary context — never a global glossary. Remove with the optional schema member once every supported app sends project context.
  return { audio, projectKey: parsedFields.data.projectKey ?? null };
}

export const voiceRoutes: FastifyPluginAsync<VoiceRouteOptions> = async (fastify, opts) => {
  const { voiceService, glossaryService, requireAuth } = opts;

  await fastify.register(multipart, {
    limits: { fileSize: AUDIO_MAX_FILE_SIZE, files: 1, fieldSize: TRANSCRIBE_FIELD_MAX_SIZE },
  });

  fastify.post<{ Reply: TranscribeReply }>(
    "/voice/transcribe",
    { preHandler: requireAuth, config: { rateLimit: TRANSCRIBE_RATE_LIMIT } },
    async (request) => {
      const { audio, projectKey } = await readTranscribeRequest(request);
      const userId = getUserId(request);

      try {
        const { text, dailySecondsRemaining } = await voiceService.transcribe({
          userId,
          projectKey,
          fileBuffer: audio.buffer,
          filename: audio.filename,
          mimetype: audio.mimetype,
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

  fastify.get<{ Querystring: GlossaryListQuery; Reply: GlossaryListReply }>(
    "/voice/glossary",
    { preHandler: requireAuth },
    async (request) => {
      const queryResult = glossaryListQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        throw new BadRequestError({ debugMessage: "Invalid query", nestedError: queryResult.error.issues });
      }

      const userId = getUserId(request);
      const words = await glossaryService.listWords({ userId, projectKey: queryResult.data.projectKey });
      return { words };
    },
  );

  fastify.post<{ Body: GlossaryAddBody; Reply: GlossaryAddReply }>(
    "/voice/glossary",
    { preHandler: requireAuth },
    async (request) => {
      const bodyResult = glossaryAddBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        throw new BadRequestError({ debugMessage: "Invalid request body", nestedError: bodyResult.error.issues });
      }

      const userId = getUserId(request);
      const added = await glossaryService.addWords({
        userId,
        projectKey: bodyResult.data.projectKey,
        words: bodyResult.data.words,
      });
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
      const removed = await glossaryService.removeWords({
        userId,
        projectKey: bodyResult.data.projectKey,
        words: bodyResult.data.words,
      });
      return { removed };
    },
  );
};
