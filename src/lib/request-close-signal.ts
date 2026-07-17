import type { FastifyReply, FastifyRequest } from "fastify";

export function createRequestCloseSignal(params: { request: FastifyRequest; reply: FastifyReply }): AbortSignal {
  const controller = new AbortController();

  if (params.request.raw.destroyed || params.request.socket.destroyed || params.reply.raw.writableEnded) {
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
