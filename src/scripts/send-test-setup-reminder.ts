import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ResendOptionalEmailAdapter } from "../clients/resend-optional-email-adapter.js";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { MongoDbConnector } from "../db/mongo-db-connector.js";
import { ActivationStateRepository } from "../repositories/activation-state-repo.js";
import { OptionalEmailDailyQuotaRepository } from "../repositories/optional-email-daily-quota-repo.js";
import { OptionalEmailPreferenceRepository } from "../repositories/optional-email-preference-repo.js";
import { OptionalEmailRecipientRepository } from "../repositories/optional-email-recipient-repo.js";
import { OptionalEmailSendRepository } from "../repositories/optional-email-send-repo.js";
import { OptionalEmailDeliveryService } from "../services/optional-email-delivery-service.js";
import type { OptionalEmailDeliveryResult } from "../services/optional-email-delivery-service.js";
import { OptionalEmailEligibilityService } from "../services/optional-email-eligibility-service.js";
import { OptionalEmailUnsubscribeTokenService } from "../services/optional-email-unsubscribe-service.js";
import {
  OPTIONAL_EMAIL_MAX_DAILY_CAP,
  OptionalEmailRecipientBasis,
  OptionalEmailReminderKind,
} from "../types/optional-email.js";

export type OptionalEmailTestSendRuntimeConfig = {
  mongoUri: string;
  resendApiKey: string;
  webhookSigningSecret: string;
  unsubscribeSigningSecret: string;
  publicBaseUrl: string;
  from: "Sesori <hello@updates.sesori.com>";
  replyTo: "hello@sesori.com";
  testRecipient: "alex@sesori.com";
  dailyCap: number;
  recipientBasis: OptionalEmailRecipientBasis.AccountActivityApproved;
};

export type OptionalEmailTestSendRuntime = {
  send(input: {
    userId: string;
    operationId: string;
    template: OptionalEmailReminderKind;
    recipient: string;
  }): Promise<OptionalEmailDeliveryResult>;
  close(): Promise<void>;
};

export type OptionalEmailTestSendCliDependencies = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  createRuntime: (config: OptionalEmailTestSendRuntimeConfig) => Promise<OptionalEmailTestSendRuntime>;
};

const testSendEnvironmentSchema = z.object({
  MONGODB_URI: z.string().min(1),
  OPTIONAL_EMAIL_RECIPIENT_BASIS: z.literal(OptionalEmailRecipientBasis.AccountActivityApproved),
  OPTIONAL_EMAIL_DAILY_CAP: z.coerce
    .number()
    .int()
    .positive()
    .max(OPTIONAL_EMAIL_MAX_DAILY_CAP)
    .default(OPTIONAL_EMAIL_MAX_DAILY_CAP),
  RESEND_API_KEY: z.string().min(1),
  RESEND_WEBHOOK_SECRET: z
    .string()
    .min(32)
    .regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/),
  OPTIONAL_EMAIL_UNSUBSCRIBE_SIGNING_SECRET: z.string().min(32),
  AUTH_BASE_URL: z.string().url().startsWith("https://"),
  RESEND_FROM: z.literal("Sesori <hello@updates.sesori.com>").default("Sesori <hello@updates.sesori.com>"),
  RESEND_REPLY_TO: z.literal("hello@sesori.com").default("hello@sesori.com"),
  RESEND_TEST_RECIPIENT: z.literal("alex@sesori.com").default("alex@sesori.com"),
});

export async function createOptionalEmailTestSendRuntime(
  config: OptionalEmailTestSendRuntimeConfig,
  options: { fetchFn?: typeof fetch } = {},
): Promise<OptionalEmailTestSendRuntime> {
  const connector = new MongoDbConnector({ connectionString: config.mongoUri });
  const dbAccessor = new MongoDbAccessor(connector);
  const preferenceRepo = new OptionalEmailPreferenceRepository(dbAccessor);
  const eligibility = new OptionalEmailEligibilityService({
    policy: {
      sendingEnabled: true,
      recipientBasis: config.recipientBasis,
    },
    recipients: new OptionalEmailRecipientRepository(dbAccessor),
    preferences: preferenceRepo,
    activationStates: new ActivationStateRepository(dbAccessor),
  });
  const delivery = new OptionalEmailDeliveryService({
    eligibility,
    sendRepo: new OptionalEmailSendRepository(dbAccessor),
    quotaRepo: new OptionalEmailDailyQuotaRepository(dbAccessor),
    provider: new ResendOptionalEmailAdapter({
      apiKey: config.resendApiKey,
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    }),
    tokenService: new OptionalEmailUnsubscribeTokenService({
      signingSecret: Buffer.from(config.unsubscribeSigningSecret, "utf8"),
    }),
    policy: {
      from: config.from,
      replyTo: config.replyTo,
      publicBaseUrl: config.publicBaseUrl,
      dailyCap: config.dailyCap,
      testRecipient: config.testRecipient,
      testSendEnabled: true,
    },
  });

  return {
    send: ({ userId, operationId, template, recipient }) =>
      delivery.sendTest({
        userId,
        operationId,
        templateKind: template,
        recipient,
      }),
    close: () => connector.close(),
  };
}

export async function runOptionalEmailTestSendCli(
  _argv: string[],
  env: NodeJS.ProcessEnv,
  dependencies: OptionalEmailTestSendCliDependencies,
): Promise<number> {
  if (_argv.includes("--help") || _argv.includes("-h")) {
    dependencies.stdout(
      "Usage: npm run optional-email:test-send -- --user-id <id> --operation-id <slug> --template <bridge_setup|first_session> --confirm-recipient alex@sesori.com --confirm-send SEND_ONE_TEST_EMAIL",
    );
    return 0;
  }

  if (env.OPTIONAL_EMAIL_SENDING_ENABLED !== "true" || env.OPTIONAL_EMAIL_TEST_SEND_ENABLED !== "true") {
    dependencies.stderr("Optional-email test send is disabled");
    return 1;
  }

  const config = testSendEnvironmentSchema.safeParse(env);
  if (!config.success) {
    dependencies.stderr("Optional-email test send configuration is incomplete");
    return 1;
  }

  const expectedFlags = new Set(["--user-id", "--operation-id", "--template", "--confirm-recipient", "--confirm-send"]);
  const suppliedFlags = _argv.filter((_argument, index) => index % 2 === 0);
  if (
    _argv.length !== expectedFlags.size * 2 ||
    suppliedFlags.length !== expectedFlags.size ||
    new Set(suppliedFlags).size !== expectedFlags.size ||
    suppliedFlags.some((flag) => !expectedFlags.has(flag))
  ) {
    dependencies.stderr("Invalid optional-email test-send arguments");
    return 1;
  }

  const recipientFlagIndex = _argv.indexOf("--confirm-recipient");
  if (recipientFlagIndex < 0 || _argv[recipientFlagIndex + 1] !== config.data.RESEND_TEST_RECIPIENT) {
    dependencies.stderr("Invalid optional-email test-send arguments");
    return 1;
  }

  const confirmationFlagIndex = _argv.indexOf("--confirm-send");
  if (confirmationFlagIndex < 0 || _argv[confirmationFlagIndex + 1] !== "SEND_ONE_TEST_EMAIL") {
    dependencies.stderr("Invalid optional-email test-send arguments");
    return 1;
  }

  const userIdFlagIndex = _argv.indexOf("--user-id");
  const userId = _argv[userIdFlagIndex + 1];
  if (userIdFlagIndex < 0 || !userId || !/^[a-f\d]{24}$/i.test(userId)) {
    dependencies.stderr("Invalid optional-email test-send arguments");
    return 1;
  }

  const operationIdFlagIndex = _argv.indexOf("--operation-id");
  const operationId = _argv[operationIdFlagIndex + 1];
  if (operationIdFlagIndex < 0 || !operationId || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(operationId)) {
    dependencies.stderr("Invalid optional-email test-send arguments");
    return 1;
  }

  const templateFlagIndex = _argv.indexOf("--template");
  const template = _argv[templateFlagIndex + 1];
  if (
    templateFlagIndex < 0 ||
    (template !== OptionalEmailReminderKind.BridgeSetup && template !== OptionalEmailReminderKind.FirstSession)
  ) {
    dependencies.stderr("Invalid optional-email test-send arguments");
    return 1;
  }

  let runtime: OptionalEmailTestSendRuntime | undefined;
  try {
    runtime = await dependencies.createRuntime({
      mongoUri: config.data.MONGODB_URI,
      resendApiKey: config.data.RESEND_API_KEY,
      webhookSigningSecret: config.data.RESEND_WEBHOOK_SECRET,
      unsubscribeSigningSecret: config.data.OPTIONAL_EMAIL_UNSUBSCRIBE_SIGNING_SECRET,
      publicBaseUrl: config.data.AUTH_BASE_URL,
      from: config.data.RESEND_FROM,
      replyTo: config.data.RESEND_REPLY_TO,
      testRecipient: config.data.RESEND_TEST_RECIPIENT,
      dailyCap: config.data.OPTIONAL_EMAIL_DAILY_CAP,
      recipientBasis: config.data.OPTIONAL_EMAIL_RECIPIENT_BASIS,
    });
    const result = await runtime.send({
      userId,
      operationId,
      template,
      recipient: config.data.RESEND_TEST_RECIPIENT,
    });
    await runtime.close();
    runtime = undefined;
    dependencies.stdout(JSON.stringify(result));
    return 0;
  } catch {
    if (runtime) {
      try {
        await runtime.close();
      } catch {
        // Preserve the original failure while still keeping output sanitized.
      }
    }
    dependencies.stderr("Optional-email test send failed");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runOptionalEmailTestSendCli(process.argv.slice(2), process.env, {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    createRuntime: createOptionalEmailTestSendRuntime,
  });
}
