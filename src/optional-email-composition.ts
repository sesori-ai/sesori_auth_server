import type { MongoDbAccessor } from "./db/mongo-db-accessor.js";
import { OptionalEmailPreferenceRepository } from "./repositories/optional-email-preference-repo.js";
import { OptionalEmailSendRepository } from "./repositories/optional-email-send-repo.js";
import { OptionalEmailWebhookEventRepository } from "./repositories/optional-email-webhook-event-repo.js";
import {
  OptionalEmailUnsubscribeService,
  OptionalEmailUnsubscribeTokenService,
} from "./services/optional-email-unsubscribe-service.js";
import { OptionalEmailWebhookService } from "./services/optional-email-webhook-service.js";
import { ResendWebhookVerifier } from "./services/resend-webhook-verifier.js";

export type OptionalEmailRouteServices = {
  unsubscribeService?: OptionalEmailUnsubscribeService;
  webhook?: {
    verifier: ResendWebhookVerifier;
    service: OptionalEmailWebhookService;
  };
};

export function createOptionalEmailRouteServices(input: {
  dbAccessor: MongoDbAccessor;
  unsubscribeSigningSecret: string | undefined;
  webhookSigningSecret: string | undefined;
}): OptionalEmailRouteServices | undefined {
  if (!input.unsubscribeSigningSecret && !input.webhookSigningSecret) {
    return undefined;
  }

  const preferenceRepo = new OptionalEmailPreferenceRepository(input.dbAccessor);
  const services: OptionalEmailRouteServices = {};
  if (input.unsubscribeSigningSecret) {
    services.unsubscribeService = new OptionalEmailUnsubscribeService({
      tokenService: new OptionalEmailUnsubscribeTokenService({
        signingSecret: Buffer.from(input.unsubscribeSigningSecret, "utf8"),
      }),
      preferenceRepo,
    });
  }

  if (input.webhookSigningSecret) {
    services.webhook = {
      verifier: new ResendWebhookVerifier({ signingSecret: input.webhookSigningSecret }),
      service: new OptionalEmailWebhookService({
        eventRepo: new OptionalEmailWebhookEventRepository(input.dbAccessor),
        preferenceRepo,
        sendHistory: new OptionalEmailSendRepository(input.dbAccessor),
      }),
    };
  }

  return services;
}
