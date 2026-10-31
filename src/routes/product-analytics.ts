import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ClientIpRequest } from "../lib/client-ip.js";
import { BadRequestError, InternalServerError, UnauthenticatedError } from "../lib/errors.js";
import { buildAccountRateLimitKey } from "../middleware/account-rate-limit-key.js";
import {
  productAnalyticsPreferenceConflictReplySchema,
  productAnalyticsPreferenceReplySchema,
  updateProductAnalyticsPreferenceBodySchema,
  type ProductAnalyticsPreferenceConflictReply,
  type ProductAnalyticsPreferenceReply,
} from "../models/api.js";
import type { ProductAnalyticsEventService } from "../services/product-analytics-event-service.js";
import type { ProductAnalyticsPreferenceService } from "../services/product-analytics-preference-service.js";
import type { TokenService } from "../services/token-service.js";
import {
  productAnalyticsEventBodySchema,
  ProductAnalyticsPreferenceUpdateOutcome,
} from "../types/product-analytics.js";

const PRODUCT_ANALYTICS_EVENT_BODY_LIMIT_BYTES = 1024;
// Far above human use for the desktop's event rate.
const PRODUCT_ANALYTICS_EVENT_MAX_PER_MINUTE = 60;

export type ProductAnalyticsRouteOptions = {
  productAnalyticsPreferenceService: ProductAnalyticsPreferenceService;
  productAnalyticsEventService: ProductAnalyticsEventService;
  tokenService: TokenService;
  resolveClientIp: (request: ClientIpRequest) => string;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

export const productAnalyticsRoutes: FastifyPluginAsync<ProductAnalyticsRouteOptions> = async (fastify, opts) => {
  fastify.get<{ Reply: ProductAnalyticsPreferenceReply }>(
    "/product-analytics/preference",
    { preHandler: opts.requireAuth },
    async (request) => {
      const record = await opts.productAnalyticsPreferenceService.getPreference({
        userId: getUserId({ request }),
      });
      const replyResult = productAnalyticsPreferenceReplySchema.safeParse({
        preference: record.preference,
        revision: record.revision,
        userKey: record.userKey,
      });
      if (!replyResult.success) {
        throw new InternalServerError({
          debugMessage: "Invalid product analytics preference reply",
          nestedError: replyResult.error.issues,
        });
      }
      return replyResult.data;
    },
  );

  fastify.put<{
    Body: unknown;
    Reply: ProductAnalyticsPreferenceReply | ProductAnalyticsPreferenceConflictReply;
  }>("/product-analytics/preference", { preHandler: opts.requireAuth }, async (request, reply) => {
    const bodyResult = updateProductAnalyticsPreferenceBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new BadRequestError({
        debugMessage: "Invalid product analytics preference request body",
        nestedError: bodyResult.error.issues,
      });
    }

    const result = await opts.productAnalyticsPreferenceService.updatePreference({
      userId: getUserId({ request }),
      ...bodyResult.data,
    });
    const candidateReply = {
      preference: result.record.preference,
      revision: result.record.revision,
      userKey: result.userKey,
    };
    if (result.outcome === ProductAnalyticsPreferenceUpdateOutcome.Conflict) {
      const conflictResult = productAnalyticsPreferenceConflictReplySchema.safeParse({
        error: "conflict",
        ...candidateReply,
      });
      if (!conflictResult.success) {
        throw new InternalServerError({
          debugMessage: "Invalid product analytics preference conflict reply",
          nestedError: conflictResult.error.issues,
        });
      }
      return reply.status(409).send(conflictResult.data);
    }

    const successResult = productAnalyticsPreferenceReplySchema.safeParse(candidateReply);
    if (!successResult.success) {
      throw new InternalServerError({
        debugMessage: "Invalid product analytics preference update reply",
        nestedError: successResult.error.issues,
      });
    }
    return successResult.data;
  });

  fastify.post<{ Body: unknown }>(
    "/product-analytics/events",
    {
      bodyLimit: PRODUCT_ANALYTICS_EVENT_BODY_LIMIT_BYTES,
      preHandler: opts.requireAuth,
      config: {
        rateLimit: {
          max: PRODUCT_ANALYTICS_EVENT_MAX_PER_MINUTE,
          timeWindow: "1 minute",
          keyGenerator: buildAccountRateLimitKey(opts.tokenService, opts.resolveClientIp),
        },
      },
    },
    async (request, reply) => {
      const bodyResult = productAnalyticsEventBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        // Only code and path are safe to log: an unrecognized_keys issue also
        // carries the raw key names the caller sent.
        throw new BadRequestError({
          debugMessage: "Invalid product analytics event",
          nestedError: bodyResult.error.issues.map(({ code, path }) => ({ code, path })),
        });
      }

      await opts.productAnalyticsEventService.record({ userId: getUserId({ request }), event: bodyResult.data });
      // Stored, already stored and dropped by the preference are deliberately not distinguished.
      return reply.status(204).send();
    },
  );
};

function getUserId(input: { request: FastifyRequest }): string {
  if (!input.request.user) {
    throw new UnauthenticatedError();
  }
  return input.request.user.userId;
}
