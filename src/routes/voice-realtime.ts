import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { getAuthenticatedUserId, startRealtimeSocket, type RealtimeRouteService } from "./voice-realtime-socket.js";
import { DEFAULT_REALTIME_ROUTE_POLICY, type RealtimeRoutePolicy } from "./voice-realtime-support.js";

export type VoiceRealtimeRouteOptions = {
  readonly realtimeService: RealtimeRouteService;
  readonly routePolicy: RealtimeRoutePolicy;
  readonly preAuthRateLimit: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  readonly requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

export const voiceRealtimeRoutes: FastifyPluginAsync<VoiceRealtimeRouteOptions> = async (fastify, opts) => {
  const routePolicy = Object.freeze({ ...DEFAULT_REALTIME_ROUTE_POLICY, ...opts.routePolicy });
  const postAuthRateLimit = fastify.rateLimit({
    max: 12,
    timeWindow: "1 minute",
    keyGenerator: (request) => `user:${getAuthenticatedUserId(request)}`,
  });

  fastify.get(
    "/voice/realtime",
    {
      websocket: true,
      config: { rateLimit: false },
      onRequest: opts.preAuthRateLimit,
      preHandler: [opts.requireAuth, postAuthRateLimit],
    },
    (socket, request) => {
      startRealtimeSocket({
        socket,
        request,
        realtimeService: opts.realtimeService,
        routePolicy,
        state: "awaiting_start",
        session: null,
        terminalSent: false,
        startAbortController: null,
      });
    },
  );
};
