import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { createTestApp, type TestContext } from "../helpers/setup.js";
import { Collections } from "../../src/db/collections.js";

const VALID_BRIDGE_PAYLOAD = {
  relayUrl: "wss://relay.example.com/ws",
  roomCode: "ROOM-001",
  publicKey: "test-public-key-base64",
};

describe("Bridge registry routes", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  // ── Authentication guard ────────────────────────────────────────────────────

  describe("Authentication guard", () => {
    it("POST /bridge/register rejects unauthenticated requests with 401", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/bridge/register",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify(VALID_BRIDGE_PAYLOAD),
      });

      assert.equal(res.statusCode, 401);
    });

    it("POST /bridge/heartbeat rejects unauthenticated requests with 401", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/bridge/heartbeat",
      });

      assert.equal(res.statusCode, 401);
    });

    it("GET /bridge/mine rejects unauthenticated requests with 401", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/bridge/mine",
      });

      assert.equal(res.statusCode, 401);
    });

    it("DELETE /bridge/deregister rejects unauthenticated requests with 401", async () => {
      const res = await ctx.app.inject({
        method: "DELETE",
        url: "/bridge/deregister",
      });

      assert.equal(res.statusCode, 401);
    });
  });

  // ── POST /bridge/register ───────────────────────────────────────────────────

  describe("POST /bridge/register", () => {
    it("creates a bridge registration and returns bridgeId", async () => {
      const user = await ctx.createUser();

      const res = await ctx.app.inject({
        method: "POST",
        url: "/bridge/register",
        headers: {
          authorization: `Bearer ${user.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify(VALID_BRIDGE_PAYLOAD),
      });

      assert.equal(res.statusCode, 200);
      const body = res.json<{ bridgeId: string }>();
      assert.ok(body.bridgeId, "Should return a bridgeId");

      // Verify the document was persisted
      const doc = await Collections.bridgeRegistrations().findOne({
        userId: new ObjectId(user.userId),
      });
      assert.ok(doc, "Bridge registration should exist in DB");
      assert.equal(doc.relayUrl, VALID_BRIDGE_PAYLOAD.relayUrl);
      assert.equal(doc.roomCode, VALID_BRIDGE_PAYLOAD.roomCode);
      assert.equal(doc.publicKey, VALID_BRIDGE_PAYLOAD.publicKey);
    });

    it("upserts on re-registration — updates fields, keeps single document", async () => {
      const user = await ctx.createUser();

      // First registration
      await ctx.app.inject({
        method: "POST",
        url: "/bridge/register",
        headers: {
          authorization: `Bearer ${user.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify(VALID_BRIDGE_PAYLOAD),
      });

      // Second registration with a different relayUrl
      const updatedPayload = {
        ...VALID_BRIDGE_PAYLOAD,
        relayUrl: "wss://new-relay.example.com/ws",
      };

      const res = await ctx.app.inject({
        method: "POST",
        url: "/bridge/register",
        headers: {
          authorization: `Bearer ${user.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify(updatedPayload),
      });

      assert.equal(res.statusCode, 200);

      // Should still have exactly one document for this user
      const count = await Collections.bridgeRegistrations().countDocuments({
        userId: new ObjectId(user.userId),
      });
      assert.equal(count, 1, "Should have exactly one bridge registration");

      // Should reflect the updated relayUrl
      const doc = await Collections.bridgeRegistrations().findOne({
        userId: new ObjectId(user.userId),
      });
      assert.equal(doc!.relayUrl, updatedPayload.relayUrl);
    });
  });

  // ── POST /bridge/heartbeat ──────────────────────────────────────────────────

  describe("POST /bridge/heartbeat", () => {
    it("updates lastHeartbeat timestamp for a registered bridge", async () => {
      const user = await ctx.createUser();

      // Register first
      await ctx.app.inject({
        method: "POST",
        url: "/bridge/register",
        headers: {
          authorization: `Bearer ${user.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify(VALID_BRIDGE_PAYLOAD),
      });

      const before = await Collections.bridgeRegistrations().findOne({
        userId: new ObjectId(user.userId),
      });
      const beforeTime = before!.lastHeartbeat.getTime();

      // Small delay to ensure the new timestamp is strictly later
      await new Promise((resolve) => setTimeout(resolve, 20));

      const res = await ctx.app.inject({
        method: "POST",
        url: "/bridge/heartbeat",
        headers: { authorization: `Bearer ${user.accessToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { ok: true });

      const after = await Collections.bridgeRegistrations().findOne({
        userId: new ObjectId(user.userId),
      });
      assert.ok(
        after!.lastHeartbeat.getTime() >= beforeTime,
        "lastHeartbeat should be updated"
      );
    });

    it("returns 404 when no bridge is registered for the user", async () => {
      const user = await ctx.createUser();

      const res = await ctx.app.inject({
        method: "POST",
        url: "/bridge/heartbeat",
        headers: { authorization: `Bearer ${user.accessToken}` },
      });

      assert.equal(res.statusCode, 404);
      assert.equal(res.json<{ error: string }>().error, "no_bridge_registered");
    });
  });

  // ── GET /bridge/mine ────────────────────────────────────────────────────────

  describe("GET /bridge/mine", () => {
    it("returns the active bridge registration", async () => {
      const user = await ctx.createUser();

      await ctx.app.inject({
        method: "POST",
        url: "/bridge/register",
        headers: {
          authorization: `Bearer ${user.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify(VALID_BRIDGE_PAYLOAD),
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: "/bridge/mine",
        headers: { authorization: `Bearer ${user.accessToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json<{
        bridgeId: string;
        relayUrl: string;
        roomCode: string;
        publicKey: string;
      }>();
      assert.ok(body.bridgeId);
      assert.equal(body.relayUrl, VALID_BRIDGE_PAYLOAD.relayUrl);
      assert.equal(body.roomCode, VALID_BRIDGE_PAYLOAD.roomCode);
      assert.equal(body.publicKey, VALID_BRIDGE_PAYLOAD.publicKey);
    });

    it("returns 404 when no bridge is registered", async () => {
      const user = await ctx.createUser();

      const res = await ctx.app.inject({
        method: "GET",
        url: "/bridge/mine",
        headers: { authorization: `Bearer ${user.accessToken}` },
      });

      assert.equal(res.statusCode, 404);
      assert.equal(res.json<{ error: string }>().error, "no_bridge_online");
    });

    it("returns 404 when the last heartbeat is older than 60 seconds (stale)", async () => {
      const user = await ctx.createUser();

      // Insert a stale bridge registration directly into the DB
      await Collections.bridgeRegistrations().insertOne({
        _id: new ObjectId(),
        userId: new ObjectId(user.userId),
        relayUrl: VALID_BRIDGE_PAYLOAD.relayUrl,
        roomCode: VALID_BRIDGE_PAYLOAD.roomCode,
        publicKey: VALID_BRIDGE_PAYLOAD.publicKey,
        lastHeartbeat: new Date(Date.now() - 120_000), // 2 minutes ago
        createdAt: new Date(),
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: "/bridge/mine",
        headers: { authorization: `Bearer ${user.accessToken}` },
      });

      assert.equal(res.statusCode, 404);
      assert.equal(res.json<{ error: string }>().error, "no_bridge_online");
    });
  });

  // ── DELETE /bridge/deregister ───────────────────────────────────────────────

  describe("DELETE /bridge/deregister", () => {
    it("removes the bridge registration and returns { ok: true }", async () => {
      const user = await ctx.createUser();

      // Register first
      await ctx.app.inject({
        method: "POST",
        url: "/bridge/register",
        headers: {
          authorization: `Bearer ${user.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify(VALID_BRIDGE_PAYLOAD),
      });

      const res = await ctx.app.inject({
        method: "DELETE",
        url: "/bridge/deregister",
        headers: { authorization: `Bearer ${user.accessToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { ok: true });

      // Verify the document was removed
      const doc = await Collections.bridgeRegistrations().findOne({
        userId: new ObjectId(user.userId),
      });
      assert.equal(doc, null, "Bridge registration should be deleted");
    });
  });

  // ── Cross-user isolation ────────────────────────────────────────────────────

  describe("Cross-user isolation", () => {
    it("user B cannot see user A's bridge registration via GET /bridge/mine", async () => {
      const userA = await ctx.createUser();
      const userB = await ctx.createUser();

      // Register a bridge for user A
      await ctx.app.inject({
        method: "POST",
        url: "/bridge/register",
        headers: {
          authorization: `Bearer ${userA.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify(VALID_BRIDGE_PAYLOAD),
      });

      // User B queries their own bridge — should get 404
      const res = await ctx.app.inject({
        method: "GET",
        url: "/bridge/mine",
        headers: { authorization: `Bearer ${userB.accessToken}` },
      });

      assert.equal(res.statusCode, 404);
    });

    it("user B's heartbeat does not affect user A's registration", async () => {
      const userA = await ctx.createUser();
      const userB = await ctx.createUser();

      // Register bridge for user A
      await ctx.app.inject({
        method: "POST",
        url: "/bridge/register",
        headers: {
          authorization: `Bearer ${userA.accessToken}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify(VALID_BRIDGE_PAYLOAD),
      });

      // User B sends heartbeat — should get 404 (no registration for B)
      const res = await ctx.app.inject({
        method: "POST",
        url: "/bridge/heartbeat",
        headers: { authorization: `Bearer ${userB.accessToken}` },
      });

      assert.equal(res.statusCode, 404);

      // User A's registration should still be intact
      const doc = await Collections.bridgeRegistrations().findOne({
        userId: new ObjectId(userA.userId),
      });
      assert.ok(doc, "User A's bridge registration should still exist");
    });
  });
});
