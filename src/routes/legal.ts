import { FastifyPluginAsync } from "fastify";
import type { LegalDocumentService } from "../services/legal-document-service.js";

export type LegalRouteOptions = {
  legalDocumentService: LegalDocumentService;
};

export const legalRoutes: FastifyPluginAsync<LegalRouteOptions> = async (fastify, opts) => {
  const { legalDocumentService } = opts;

  fastify.get<{ Reply: string }>("/terms", async (_request, reply) => {
    reply.type("text/plain").send(legalDocumentService.getTerms());
  });

  fastify.get<{ Reply: string }>("/privacy", async (_request, reply) => {
    reply.type("text/plain").send(legalDocumentService.getPrivacy());
  });
};
