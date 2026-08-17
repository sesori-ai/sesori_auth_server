import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { getAuthenticatedUserId, startRealtimeSocket, type RealtimeRouteService } from "./voice-realtime-socket.js";
import type { RealtimeRoutePolicy } from "./voice-realtime-support.js";

/**
 * Post-auth realtime session starts allowed per verified user per minute.
 *
 * Deliberately a compile-time constant rather than config, matching
 * `SETTINGS_WRITE_MAX_PER_MINUTE`: retuning it is a reviewed deploy, not an env
 * flip. It bounds how often a user may *start* a session — reconnect storms and
 * start/abort loops — and not how many sessions may be held at once, which is
 * what the concurrency ceilings in `RealtimeTranscriptionService` exist for.
 * Well above real use: a person speaking starts one session and streams into it.
 */
const REALTIME_START_MAX_PER_MINUTE = 12;

export type VoiceRealtimeRouteOptions = {
  readonly realtimeService: RealtimeRouteService;
  readonly routePolicy: RealtimeRoutePolicy;
  readonly preAuthRateLimit: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  readonly requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

export const voiceRealtimeRoutes: FastifyPluginAsync<VoiceRealtimeRouteOptions> = async (fastify, opts) => {
  // Every field of RealtimeRoutePolicy is required, so the injected policy is
  // always complete: there is no default layer to merge under it.
  const routePolicy = Object.freeze({ ...opts.routePolicy });
  // fastify.rateLimit() merges these options over the globally registered params
  // (Object.assign in @fastify/rate-limit's mergeParams), so an omitted allowList
  // inherits the global one — which exempts loopback socket peers. Behind a
  // same-host proxy or tunnel daemon every peer is loopback, which would disable
  // this limiter for every user. An own allowList property replaces the inherited
  // value, and returning false means no connection is ever exempt.
  const postAuthRateLimit = fastify.rateLimit({
    max: REALTIME_START_MAX_PER_MINUTE,
    timeWindow: "1 minute",
    allowList: () => false,
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
