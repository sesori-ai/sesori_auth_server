import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { OptionalEmailDailyQuotaRepository } from "../../src/repositories/optional-email-daily-quota-repo.js";
import { InternalServerError } from "../../src/lib/errors.js";
import { createTestApp, type TestContext } from "../helpers/setup.js";

describe("OptionalEmailDailyQuotaRepository", () => {
  let ctx: TestContext;
  let repo: OptionalEmailDailyQuotaRepository;

  before(async () => {
    ctx = await createTestApp();
    repo = new OptionalEmailDailyQuotaRepository(ctx.dbAccessor);
  });

  after(async () => {
    await ctx.cleanup();
  });

  it("atomically enforces a UTC daily limit and starts a new counter the next day", async () => {
    const firstDay = new Date("2026-09-06T23:59:59.000Z");
    const attempts = await Promise.all(Array.from({ length: 20 }, () => repo.reserve({ at: firstDay, dailyCap: 3 })));

    assert.equal(attempts.filter((attempt) => attempt.reserved).length, 3);
    assert.deepEqual(await repo.getUsage({ at: firstDay, dailyCap: 3 }), {
      date: "2026-09-06",
      used: 3,
      remaining: 0,
    });
    assert.deepEqual(await repo.reserve({ at: new Date("2026-09-07T00:00:00.000Z"), dailyCap: 3 }), {
      reserved: true,
      date: "2026-09-07",
      used: 1,
      remaining: 2,
    });
  });

  it("rejects a cap above 80 so free-plan headroom cannot be configured away", async () => {
    await assert.rejects(repo.reserve({ at: new Date("2026-09-08T00:00:00.000Z"), dailyCap: 81 }), InternalServerError);
  });
});
