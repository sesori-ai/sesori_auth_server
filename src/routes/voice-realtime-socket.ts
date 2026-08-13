import type { FastifyRequest } from "fastify";
import type { RawData, WebSocket } from "ws";
import type { RealtimeSessionCallbacks } from "../services/realtime-transcription-events.js";
import { RealtimeAdmissionError } from "../services/realtime-transcription-errors.js";
import type { RealtimeTranscriptionService } from "../services/realtime-transcription-service.js";
import { RealtimeProtocolErrorCode } from "../types/transcription.js";
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
      abortStarting(context);
      context.state = "closed";
      const code = isBinary ? RealtimeProtocolErrorCode.InvalidAudio : RealtimeProtocolErrorCode.InvalidMessage;
      sendTerminalError(context.socket, code, context.routePolicy);
      closeSocket(context.socket, CLOSE_CODE.policy);
      return;
    }

    if (context.state === "awaiting_start") {
      clearTimeout(startTimer);
      context.state = "starting";
    }

    void handleSocketMessage({ context, data, isBinary })
      .then((state) => {
        if (context.state === "closed") {
          if (context.session !== null) {
            void context.session.disconnect().catch(() => undefined);
          }
          return;
        }

        context.state = state;
      })
      .catch((error: unknown) => {
        const code =
          error instanceof RealtimeAuthenticatedUserMissing
            ? RealtimeProtocolErrorCode.InternalError
            : RealtimeProtocolErrorCode.ProviderUnavailable;
        beginRouteError(context, code);
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

async function handleSocketMessage(args: SocketMessageArgs): Promise<RouteState> {
  if (args.context.state === "starting") {
    return startSession(args);
  }

  if (args.isBinary) {
    return handleAudio(args);
  }

  const control = parseControlFrame(args.data, args.context.routePolicy);
  switch (control.kind) {
    case "finish":
      await args.context.session?.finish();
      return "finishing";
    case "cancel":
      await args.context.session?.cancel();
      closeSocket(args.context.socket, CLOSE_CODE.normal);
      return "closed";
    case "invalid":
      await terminateActive(args, RealtimeProtocolErrorCode.InvalidMessage, CLOSE_CODE.policy);
      return "closed";
  }
}

function handleAudio(args: SocketMessageArgs): RouteState {
  const frame = rawDataToBuffer(args.data);
  if (
    frame.byteLength < 2 ||
    frame.byteLength > args.context.routePolicy.maxAudioFrameBytes ||
    frame.byteLength % 2 !== 0
  ) {
    void terminateActive(args, RealtimeProtocolErrorCode.InvalidAudio, CLOSE_CODE.policy);
    return "closed";
  }

  args.context.session?.sendAudio(frame);
  return args.context.state;
}

async function startSession(args: SocketMessageArgs): Promise<RouteState> {
  if (args.isBinary) {
    sendTerminalError(args.context.socket, RealtimeProtocolErrorCode.InvalidAudio, args.context.routePolicy);
    closeSocket(args.context.socket, CLOSE_CODE.policy);
    return "closed";
  }

  const startFrame = parseStartFrame(args.data, args.context.routePolicy);
  if (startFrame.kind === "unsupported") {
    sendTerminalError(args.context.socket, RealtimeProtocolErrorCode.UnsupportedProtocol, args.context.routePolicy);
    closeSocket(args.context.socket, CLOSE_CODE.policy);
    return "closed";
  }

  if (startFrame.kind === "invalid") {
    sendTerminalError(args.context.socket, RealtimeProtocolErrorCode.InvalidMessage, args.context.routePolicy);
    closeSocket(args.context.socket, CLOSE_CODE.policy);
    return "closed";
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
      return "closed";
    }
    return "streaming";
  } catch (error) {
    args.context.startAbortController = null;
    if (args.context.state === "closed") {
      return "closed";
    }
    const code = error instanceof RealtimeAdmissionError ? error.code : RealtimeProtocolErrorCode.ProviderUnavailable;
    beginRouteError(args.context, code);
    return "closed";
  }
}

function createCallbacks(context: SocketContext): RealtimeSessionCallbacks {
  return {
    onReady: (event) => {
      if (context.state !== "closed") {
        sendEvent(context.socket, event, context.routePolicy);
      }
    },
    onTranscript: (event) => {
      if (context.state !== "closed") {
        sendEvent(context.socket, event, context.routePolicy);
      }
    },
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
    await context.session.cancel();
  }
  sendTerminalError(context.socket, code, context.routePolicy);
  closeSocket(context.socket, closeCode);
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
