import { z } from "zod";

export const projectKeySchema = z
  .string()
  .regex(/^prj_v1_[A-Za-z0-9_-]{43}$/)
  .brand<"ProjectKey">();

export type ProjectKey = z.infer<typeof projectKeySchema>;

export const glossaryWordSchema = z.string().trim().min(1).max(200);

export const glossaryWordsSchema = z.array(glossaryWordSchema).min(1).max(100);

export const glossaryAddBodySchema = z
  .object({
    projectKey: projectKeySchema,
    words: glossaryWordsSchema,
  })
  .strict();

export const glossaryRemoveBodySchema = glossaryAddBodySchema;

export const glossaryListQuerySchema = z
  .object({
    projectKey: projectKeySchema,
  })
  .strict();

export const transcribeMultipartSchema = z
  .object({
    // COMPATIBILITY 2026-08-06 (v0.1.0): Apps at or before 1.6.1 omit projectKey from multipart transcription requests. Require it after every supported app sends project context.
    projectKey: projectKeySchema.optional(),
  })
  .strict();
