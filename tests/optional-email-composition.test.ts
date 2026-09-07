import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createOptionalEmailRouteServices } from "../src/optional-email-composition.js";
import { createTestApp, type TestContext } from "./helpers/setup.js";

describe("optional email route composition", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("constructs only the safety routes backed by configured signing secrets", () => {
    assert.equal(
      createOptionalEmailRouteServices({
        dbAccessor: ctx.dbAccessor,
        unsubscribeSigningSecret: undefined,
        webhookSigningSecret: undefined,
      }),
      undefined,
    );

    const unsubscribeOnly = createOptionalEmailRouteServices({
      dbAccessor: ctx.dbAccessor,
      unsubscribeSigningSecret: "u".repeat(32),
      webhookSigningSecret: undefined,
    });
    assert.ok(unsubscribeOnly?.unsubscribeService);
    assert.equal(unsubscribeOnly?.webhook, undefined);

    const webhookOnly = createOptionalEmailRouteServices({
      dbAccessor: ctx.dbAccessor,
      unsubscribeSigningSecret: undefined,
      webhookSigningSecret: `whsec_${Buffer.alloc(32, 7).toString("base64")}`,
    });
    assert.equal(webhookOnly?.unsubscribeService, undefined);
    assert.ok(webhookOnly?.webhook?.verifier);
    assert.ok(webhookOnly?.webhook?.service);
  });
});
