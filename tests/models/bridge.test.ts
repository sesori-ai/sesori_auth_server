import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BridgeStatus, bridgeStatusFromWire } from "../../src/models/bridge.js";

describe("bridgeStatusFromWire", () => {
  it("maps the relay wire vocabulary onto the internal enum", () => {
    assert.equal(bridgeStatusFromWire("connected"), BridgeStatus.active);
    assert.equal(bridgeStatusFromWire("disconnected"), BridgeStatus.inactive);
  });
});
