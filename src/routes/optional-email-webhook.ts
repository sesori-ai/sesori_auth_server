import type { FastifyPluginAsync } from "fastify";
import {
  InvalidResendWebhookEventError,
  type OptionalEmailWebhookService,
} from "../services/optional-email-webhook-service.js";
import type { ResendWebhookVerifier } from "../services/resend-webhook-verifier.js";
import { OptionalEmailWebhookStatus } from "../types/optional-email.js";

const MAX_WEBHOOK_BODY_BYTES = 256 * 1_024;
const RETRY_AFTER_SECONDS = 60;

export type OptionalEmailWebhookRouteOptions = {
  service: OptionalEmailWebhookService;
  verifier: ResendWebhookVerifier;
};

export const optionalEmailWebhookRoutes: FastifyPluginAsync<OptionalEmailWebhookRouteOptions> = async (
  app,
  options,
) => {
  // Keep the exact bytes represented by the incoming UTF-8 JSON string. Parsing
  // and re-serializing before HMAC verification would invalidate the signature.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: MAX_WEBHOOK_BODY_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.post("/webhooks/resend", { config: { rateLimit: false } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const messageId = request.headers["svix-id"];
    const timestamp = request.headers["svix-timestamp"];
    const signature = request.headers["svix-signature"];
    if (
      typeof request.body !== "string" ||
      typeof messageId !== "string" ||
      typeof timestamp !== "string" ||
      typeof signature !== "string"
    ) {
      return reply.status(400).type("text/plain; charset=utf-8").send("Invalid webhook");
    }

    let event: unknown;
    try {
      event = options.verifier.verify({ rawBody: request.body, messageId, timestamp, signature });
    } catch {
      return reply.status(400).type("text/plain; charset=utf-8").send("Invalid webhook");
    }

    let result;
    try {
      result = await options.service.handleVerified({ eventId: messageId, event });
    } catch (error) {
      if (error instanceof InvalidResendWebhookEventError) {
        return reply.status(400).type("text/plain; charset=utf-8").send("Invalid webhook");
      }
      throw error;
    }

    if (result.status === OptionalEmailWebhookStatus.Retry) {
      reply.header("Retry-After", String(RETRY_AFTER_SECONDS));
      return reply.status(503).send();
    }
    return reply.status(204).send();
  });
};
