import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Returns an AbortSignal that fires if and only if the client goes away
 * before the response is delivered. If the connection is already gone on
 * entry, an already-aborted signal is returned without registering listeners.
 *
 * All listeners are removed on the first terminal event: a delivered response
 * (`finish`), or a socket/response `close` (which also aborts when the reply
 * was still undelivered). `abortIfUndelivered` performs that cleanup itself,
 * so the standalone `removeListeners` registrations are no-ops on that path.
 */
export function createRequestCloseSignal(params: { request: FastifyRequest; reply: FastifyReply }): AbortSignal {
  const controller = new AbortController();

  if (!isClientConnectionOpen(params)) {
    controller.abort();
    return controller.signal;
  }

  const removeListeners = () => {
    params.request.socket.off("close", abortIfUndelivered);
    params.reply.raw.off("close", abortIfUndelivered);
    params.reply.raw.off("finish", removeListeners);
    params.reply.raw.off("close", removeListeners);
  };
  const abortIfUndelivered = () => {
    if (!params.reply.raw.writableEnded) {
      controller.abort();
    }
    removeListeners();
  };

  // A request stream can close normally on a healthy keep-alive connection.
  // Socket/response events identify whether a reply can still be delivered.
  params.request.socket.once("close", abortIfUndelivered);
  params.reply.raw.once("close", abortIfUndelivered);
  params.reply.raw.once("finish", removeListeners);
  params.reply.raw.once("close", removeListeners);

  return controller.signal;
}

/**
 * Returns true while the underlying transport is still open and the response
 * has not been committed. Used as a post-await guard before writing a
 * long-poll reply. `reply.raw.destroyed` is checked separately from
 * `writableEnded` because the server can destroy a response object without it
 * ever having ended cleanly.
 */
export function isClientConnectionOpen(params: { request: FastifyRequest; reply: FastifyReply }): boolean {
  return (
    !params.request.raw.destroyed &&
    !params.request.socket.destroyed &&
    !params.reply.raw.destroyed &&
    !params.reply.raw.writableEnded
  );
}
