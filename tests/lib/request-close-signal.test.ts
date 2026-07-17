import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { describe, it } from "node:test";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createRequestCloseSignal } from "../../src/lib/request-close-signal.js";

describe("createRequestCloseSignal", () => {
  it("aborts on an undelivered socket close and removes every listener", () => {
    const fixture = createFixture();
    const signal = createRequestCloseSignal(fixture.params);

    fixture.socket.emit("close");

    assert.equal(signal.aborted, true);
    assertNoListeners(fixture);
  });

  it("does not abort a delivered response and removes every listener on finish", () => {
    const fixture = createFixture();
    const signal = createRequestCloseSignal(fixture.params);
    fixture.replyRaw.writableEnded = true;

    fixture.replyRaw.emit("finish");

    assert.equal(signal.aborted, false);
    assertNoListeners(fixture);
  });

  it("returns an already-aborted signal without listeners for a closed request", () => {
    const fixture = createFixture();
    fixture.requestRaw.destroyed = true;

    const signal = createRequestCloseSignal(fixture.params);

    assert.equal(signal.aborted, true);
    assertNoListeners(fixture);
  });
});

function createFixture(): {
  params: { request: FastifyRequest; reply: FastifyReply };
  socket: EventEmitter & { destroyed: boolean };
  requestRaw: { destroyed: boolean };
  replyRaw: EventEmitter & { writableEnded: boolean };
} {
  const socket = Object.assign(new EventEmitter(), { destroyed: false });
  const requestRaw = { destroyed: false };
  const replyRaw = Object.assign(new EventEmitter(), { writableEnded: false });
  return {
    params: {
      request: { raw: requestRaw, socket } as unknown as FastifyRequest,
      reply: { raw: replyRaw } as unknown as FastifyReply,
    },
    socket,
    requestRaw,
    replyRaw,
  };
}

function assertNoListeners(fixture: ReturnType<typeof createFixture>): void {
  assert.equal(getEventListeners(fixture.socket, "close").length, 0);
  assert.equal(getEventListeners(fixture.replyRaw, "close").length, 0);
  assert.equal(getEventListeners(fixture.replyRaw, "finish").length, 0);
}
