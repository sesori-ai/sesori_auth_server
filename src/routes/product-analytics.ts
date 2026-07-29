import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { BadRequestError, InternalServerError, UnauthenticatedError } from "../lib/errors.js";
import {
  productAnalyticsPreferenceConflictReplySchema,
  productAnalyticsPreferenceReplySchema,
  updateProductAnalyticsPreferenceBodySchema,
  type ProductAnalyticsPreferenceConflictReply,
  type ProductAnalyticsPreferenceReply,
} from "../models/api.js";
import type { ProductAnalyticsPreferenceService } from "../services/product-analytics-preference-service.js";
import { ProductAnalyticsPreferenceUpdateOutcome } from "../types/product-analytics.js";

export type ProductAnalyticsRouteOptions = {
  productAnalyticsPreferenceService: ProductAnalyticsPreferenceService;
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
};

function getUserId(input: { request: FastifyRequest }): string {
  if (!input.request.user) {
    throw new UnauthenticatedError();
  }
  return input.request.user.userId;
}
