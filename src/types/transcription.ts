/**
 * Provider-neutral transcription domain types. Nothing here names a provider,
 * so services and routes stay independent of which client is configured.
 */

/** Closed set of transcription failures a provider client may report. */
export enum TranscriptionFailureReason {
  InvalidInput = "invalid_input",
  Capacity = "capacity",
  Unavailable = "unavailable",
  Timeout = "timeout",
  ProviderRejected = "provider_rejected",
  MalformedOutput = "malformed_output",
  Cancelled = "cancelled",
  Internal = "internal",
}

/** Deploy-time async provider selection. Single source for the config schema and the composition-root branch. */
export enum AsyncTranscriptionProvider {
  OpenAI = "openai",
  Soniox = "soniox",
}

/** Explicit regional REST endpoints. Resolved locally so SDK environment precedence can never redirect audio or credentials. */
export const SONIOX_REST_URL_BY_REGION = {
  eu: "https://api.eu.soniox.com",
} as const satisfies Record<string, string>;

/**
 * The single glossary-prompt format. Shared so the budget reserved by
 * `GlossaryService` and the string rendered by a provider adapter cannot drift.
 */
export const TRANSCRIPTION_PROMPT_PREFIX = "The following terms may appear in the audio: ";
export const TRANSCRIPTION_PROMPT_SUFFIX = ".";

export function renderTranscriptionPrompt(terms: string[]): string | null {
  if (terms.length === 0) {
    return null;
  }

  return `${TRANSCRIPTION_PROMPT_PREFIX}${terms.join(", ")}${TRANSCRIPTION_PROMPT_SUFFIX}`;
}

export type TranscriptionRequest = {
  audio: Buffer;
  filename: string;
  mimeType: string;
  /** Glossary context for this project, already trimmed and bounded. */
  terms: string[];
  signal?: AbortSignal;
};

export type TranscriptionResult = {
  text: string;
  durationSeconds: number;
};

/**
 * The single failure type provider clients throw. The original error is kept
 * only as `cause` for local debugging and is never surfaced to a client.
 */
export class TranscriptionFailure extends Error {
  readonly reason: TranscriptionFailureReason;

  constructor(reason: TranscriptionFailureReason, options?: { cause?: unknown }) {
    super(reason, options);
    this.name = "TranscriptionFailure";
    this.reason = reason;
  }
}
