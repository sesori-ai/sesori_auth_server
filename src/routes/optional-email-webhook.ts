import type { FastifyPluginAsync } from "fastify";
import type { OptionalEmailWebhookService } from "../services/optional-email-webhook-service.js";
import type { ResendWebhookVerifier } from "../services/resend-webhook-verifier.js";

export type OptionalEmailWebhookRouteOptions = {
  service: OptionalEmailWebhookService;
  verifier: ResendWebhookVerifier;
};

export const optionalEmailWebhookRoutes: FastifyPluginAsync<OptionalEmailWebhookRouteOptions> = async (
  app,
  options,
) => {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: 256 * 1_024 },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post("/webhooks/resend", async (request, reply) => {
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
      if (error instanceof Error && error.message === "InvalidResendWebhookEvent") {
        return reply.status(400).type("text/plain; charset=utf-8").send("Invalid webhook");
      }
      throw error;
    }

    if (result.status === "retry") {
      reply.header("Retry-After", "60");
      return reply.status(503).send();
    }
    return reply.status(204).send();
  });
};
