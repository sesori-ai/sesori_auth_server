import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import type { OptionalEmailUnsubscribeService } from "../services/optional-email-unsubscribe-service.js";

const querySchema = z.object({ token: z.string().min(1).max(2_048) }).strict();

export type OptionalEmailUnsubscribeRouteOptions = {
  service: OptionalEmailUnsubscribeService;
};

function setSafetyHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header(
    "Content-Security-Policy",
    "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
}

export const optionalEmailUnsubscribeRoutes: FastifyPluginAsync<OptionalEmailUnsubscribeRouteOptions> = async (
  app,
  options,
) => {
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 1_024 },
    (_request, body, done) => done(null, body),
  );

  app.get("/email/optional/unsubscribe", async (request, reply) => {
    setSafetyHeaders(reply);
    const query = querySchema.safeParse(request.query);
    if (!query.success || !options.service.isValid({ token: query.data.token })) {
      return reply.status(400).type("text/plain; charset=utf-8").send("Invalid unsubscribe link");
    }

    const action = `/email/optional/unsubscribe?token=${encodeURIComponent(query.data.token)}`;
    return reply.type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Unsubscribe</title></head>
  <body>
    <main>
      <h1>Unsubscribe from optional Sesori setup reminders</h1>
      <p>Security and essential account messages are not affected.</p>
      <form method="post" action="${action}">
        <input type="hidden" name="List-Unsubscribe" value="One-Click">
        <button type="submit">Unsubscribe</button>
      </form>
    </main>
  </body>
</html>`);
  });

  app.post("/email/optional/unsubscribe", async (request, reply) => {
    setSafetyHeaders(reply);
    const query = querySchema.safeParse(request.query);
    const body = typeof request.body === "string" ? new URLSearchParams(request.body) : null;
    const validBody =
      body !== null &&
      [...body.keys()].length === 1 &&
      body.getAll("List-Unsubscribe").length === 1 &&
      body.get("List-Unsubscribe") === "One-Click";
    if (!query.success || !validBody || !(await options.service.unsubscribe({ token: query.data.token }))) {
      return reply.status(400).type("text/plain; charset=utf-8").send("Invalid unsubscribe request");
    }

    return reply.status(200).type("text/plain; charset=utf-8").send("");
  });
};
