import type { FastifyRequest } from "fastify";
import type { RawData, WebSocket } from "ws";
import type { RealtimeSessionCallbacks } from "../services/realtime-transcription-events.js";
import { RealtimeAdmissionError } from "../services/realtime-transcription-errors.js";
import type { RealtimeTranscriptionService } from "../services/realtime-transcription-service.js";
import { RealtimeClientMessageType, RealtimeProtocolErrorCode } from "../types/transcription.js";
import {
  CLOSE_CODE,
  closeCodeForError,
  closeSocket,
  parseControlFrame,
  parseStartFrame,
  rawDataToBuffer,
  type RealtimeRoutePolicy,
  sendEvent,
  sendTerminalError,
} from "./voice-realtime-support.js";

export type RealtimeRouteSession = Awaited<ReturnType<RealtimeTranscriptionService["start"]>>;

export type RealtimeRouteService = {
  start(request: Parameters<RealtimeTranscriptionService["start"]>[0]): Promise<RealtimeRouteSession>;
  dispose(): Promise<void>;
};

type RouteState = "awaiting_start" | "starting" | "streaming" | "finishing" | "closed";

export type SocketContext = {
  readonly socket: WebSocket;
  readonly request: FastifyRequest;
  readonly realtimeService: RealtimeRouteService;
  readonly routePolicy: RealtimeRoutePolicy;
  state: RouteState;
  session: RealtimeRouteSession | null;
  terminalSent: boolean;
  startAbortController: AbortController | null;
};

type SocketMessageArgs = Readonly<{ context: SocketContext; data: RawData; isBinary: boolean }>;

export class RealtimeAuthenticatedUserMissing extends Error {
  constructor() {
    super("Realtime route requires a verified authenticated user");
    this.name = "RealtimeAuthenticatedUserMissing";
  }
}

export function startRealtimeSocket(context: SocketContext): void {
  const startTimer = setTimeout(() => {
    if (context.state !== "awaiting_start") {
      return;
    }

    abortStarting(context);
    context.state = "closed";
    context.terminalSent = true;
    sendTerminalError(context.socket, RealtimeProtocolErrorCode.StartTimeout, context.routePolicy);
    closeSocket(context.socket, CLOSE_CODE.unavailable);
  }, context.routePolicy.firstFrameTimeoutMs);
  startTimer.unref();

  const disconnect = (): void => {
    abortStarting(context);
    context.state = "closed";
    context.terminalSent = true;
    clearTimeout(startTimer);
    if (context.session !== null) {
      void context.session.disconnect().catch(() => undefined);
    }
  };

  context.socket.once("close", disconnect);
  context.socket.once("error", disconnect);
  context.socket.on("message", (data, isBinary) => {
    if (context.state === "closed") {
      return;
    }

    if (context.state === "finishing") {
      if (isBinary) {
        void terminateActive({ context, data, isBinary }, RealtimeProtocolErrorCode.InvalidAudio, CLOSE_CODE.policy);
      }
      return;
    }

    if (context.state === "starting") {
      beginRouteError(
        context,
        isBinary ? RealtimeProtocolErrorCode.InvalidAudio : RealtimeProtocolErrorCode.InvalidMessage,
      );
      return;
    }

    if (context.state === "awaiting_start") {
      clearTimeout(startTimer);
      context.state = "starting";
    }

    // `context.state` has exactly one owner: the handler that performs the
    // transition. It used to be written both here from a returned value and
    // directly inside the handlers, which meant the eager write the `finish`
    // path depends on — a frame arriving mid-`finish()` must not be seen as
    // `streaming` — silently disagreed with the deferred one.
    void handleSocketMessage({ context, data, isBinary }).catch(() => {
      beginRouteError(context, RealtimeProtocolErrorCode.ProviderUnavailable);
    });
  });
}

export function getAuthenticatedUserId(request: FastifyRequest): string {
  const userId = request.user?.userId;
  if (typeof userId !== "string") {
    throw new RealtimeAuthenticatedUserMissing();
  }
  return userId;
}

async function handleSocketMessage(args: SocketMessageArgs): Promise<void> {
  if (args.context.state === "starting") {
    await startSession(args);
    return;
  }

  if (args.isBinary) {
    handleAudio(args);
    return;
  }

  const control = parseControlFrame(args.data, args.context.routePolicy);
  switch (control.kind) {
    case RealtimeClientMessageType.Finish:
      args.context.state = "finishing";
      await args.context.session?.finish();
      return;
    case RealtimeClientMessageType.Cancel:
      await args.context.session?.cancel();
      args.context.state = "closed";
      closeSocket(args.context.socket, CLOSE_CODE.normal);
      return;
    case "invalid":
      await terminateActive(args, RealtimeProtocolErrorCode.InvalidMessage, CLOSE_CODE.policy);
      return;
  }
}

function handleAudio(args: SocketMessageArgs): void {
  const frame = rawDataToBuffer(args.data);
  if (
    frame.byteLength < 2 ||
    frame.byteLength > args.context.routePolicy.maxAudioFrameBytes ||
    frame.byteLength % 2 !== 0
  ) {
    void terminateActive(args, RealtimeProtocolErrorCode.InvalidAudio, CLOSE_CODE.policy);
    return;
  }

  const { session } = args.context;
  if (session === null) {
    // `streaming` is only reachable once `start` resolved with a session, so a
    // null here is a state-machine defect. Optional chaining used to swallow it
    // and drop audio the client believed we had accepted; failing loudly means
    // the bug surfaces instead of turning into a silently truncated transcript.
    beginRouteError(args.context, RealtimeProtocolErrorCode.InternalError);
    return;
  }

  session.sendAudio(frame);
}

async function startSession(args: SocketMessageArgs): Promise<void> {
  if (args.isBinary) {
    beginRouteError(args.context, RealtimeProtocolErrorCode.InvalidAudio);
    return;
  }

  const startFrame = parseStartFrame(args.data, args.context.routePolicy);
  if (startFrame.kind === "unsupported") {
    beginRouteError(args.context, RealtimeProtocolErrorCode.UnsupportedProtocol);
    return;
  }

  if (startFrame.kind === "invalid") {
    beginRouteError(args.context, RealtimeProtocolErrorCode.InvalidMessage);
    return;
  }

  try {
    const startAbortController = new AbortController();
    args.context.startAbortController = startAbortController;
    args.context.session = await args.context.realtimeService.start({
      userId: getAuthenticatedUserId(args.context.request),
      projectKey: startFrame.data.projectKey,
      audio: startFrame.data.audio,
      callbacks: createCallbacks(args.context),
      signal: startAbortController.signal,
    });
    args.context.startAbortController = null;
    if (args.context.state === "closed") {
      await args.context.session.disconnect();
      args.context.session = null;
      return;
    }

    args.context.state = "streaming";
  } catch (error) {
    args.context.startAbortController = null;
    if (args.context.state === "closed") {
      return;
    }

    beginRouteError(args.context, mapStartSessionError(error));
  }
}

function mapStartSessionError(error: unknown): RealtimeProtocolErrorCode {
  if (error instanceof RealtimeAdmissionError) {
    return error.code;
  }

  if (error instanceof RealtimeAuthenticatedUserMissing) {
    return RealtimeProtocolErrorCode.InternalError;
  }

  return RealtimeProtocolErrorCode.ProviderUnavailable;
}

function createCallbacks(context: SocketContext): RealtimeSessionCallbacks {
  const forwardOrAbandon = (event: object): void => {
    if (context.state === "closed") {
      return;
    }

    if (!sendEvent(context.socket, event, context.routePolicy)) {
      abandonUnreachableClient(context);
    }
  };

  return {
    onReady: forwardOrAbandon,
    onTranscript: forwardOrAbandon,
    onComplete: (event) => {
      if (!context.terminalSent) {
        context.terminalSent = true;
        context.state = "closed";
        sendEvent(context.socket, event, context.routePolicy);
        closeSocket(context.socket, CLOSE_CODE.normal);
      }
    },
    onError: (event) => {
      if (!context.terminalSent) {
        context.terminalSent = true;
        context.state = "closed";
        sendEvent(context.socket, event, context.routePolicy);
        closeSocket(context.socket, closeCodeForError(event.code));
      }
    },
  };
}

async function terminateActive(
  args: SocketMessageArgs,
  code: RealtimeProtocolErrorCode,
  closeCode: number,
): Promise<void> {
  const { context } = args;
  context.terminalSent = true;
  context.state = "closed";
  abortStarting(context);
  if (context.session !== null) {
    await context.session.cancel().catch(() => undefined);
  }
  sendTerminalError(context.socket, code, context.routePolicy);
  closeSocket(context.socket, closeCode);
}

/**
 * Tears the session down when an event could not be handed to the client.
 *
 * `sendEvent` has already emitted whatever terminal it could and closed the
 * socket, but a `ws` close is a handshake with a 30 second timeout and a peer
 * too slow to drain is precisely the one that will not answer it. Leaving
 * provider teardown to the socket `close` event therefore kept the Soniox
 * session streaming — and billing — for up to that long after we had decided
 * the client was unreachable.
 *
 * `session` is still null when `ready` fails this way, because the callback
 * fires while `start` is in flight; `startSession` observes the closed state on
 * resume and disconnects the session it was handed.
 */
function abandonUnreachableClient(context: SocketContext): void {
  context.terminalSent = true;
  context.state = "closed";
  abortStarting(context);
  if (context.session !== null) {
    void context.session.cancel().catch(() => undefined);
  }
}

function beginRouteError(context: SocketContext, code: RealtimeProtocolErrorCode): void {
  if (context.terminalSent) {
    return;
  }

  context.terminalSent = true;
  context.state = "closed";
  abortStarting(context);
  sendTerminalError(context.socket, code, context.routePolicy);
  closeSocket(context.socket, closeCodeForError(code));
}

function abortStarting(context: SocketContext): void {
  context.startAbortController?.abort();
}
