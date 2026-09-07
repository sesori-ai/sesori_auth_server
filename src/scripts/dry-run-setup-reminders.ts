import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { MongoDbConnector } from "../db/mongo-db-connector.js";
import { ActivationStateRepository } from "../repositories/activation-state-repo.js";
import { OptionalEmailPreferenceRepository } from "../repositories/optional-email-preference-repo.js";
import { OptionalEmailRecipientRepository } from "../repositories/optional-email-recipient-repo.js";
import { UserRepository } from "../repositories/user-repo.js";
import {
  OptionalEmailDryRunService,
  type OptionalEmailDryRunReport,
} from "../services/optional-email-dry-run-service.js";
import { OptionalEmailEligibilityService } from "../services/optional-email-eligibility-service.js";
import { OPTIONAL_EMAIL_MAX_DAILY_CAP, OptionalEmailRecipientBasis } from "../types/optional-email.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export type OptionalEmailDryRunCliOptions = {
  help: boolean;
  batchLimit: number;
};

const DEFAULT_BATCH_LIMIT = 500;
const USAGE = "Usage: npm run optional-email:dry-run -- [--batch-limit 1..1000]";

const disabledByDefaultBooleanSchema = z
  .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
  .optional()
  .transform((value) => value === "true" || value === "1");

const optionalEmailDryRunEnvironmentSchema = z.object({
  MONGODB_URI: z.string().min(1),
  OPTIONAL_EMAIL_SENDING_ENABLED: disabledByDefaultBooleanSchema,
  OPTIONAL_EMAIL_RECIPIENT_BASIS: z
    .nativeEnum(OptionalEmailRecipientBasis)
    .default(OptionalEmailRecipientBasis.Unapproved),
  OPTIONAL_EMAIL_DAILY_CAP: z.coerce
    .number()
    .int()
    .positive()
    .max(OPTIONAL_EMAIL_MAX_DAILY_CAP)
    .default(OPTIONAL_EMAIL_MAX_DAILY_CAP),
});

export type OptionalEmailDryRunRuntimeConfig = {
  mongoUri: string;
  sendingEnabled: boolean;
  recipientBasis: OptionalEmailRecipientBasis;
  dailyCap: number;
};

export type OptionalEmailDryRunRuntime = {
  run(input: { batchLimit: number }): Promise<OptionalEmailDryRunReport>;
  close(): Promise<void>;
};

export type OptionalEmailDryRunCliDependencies = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  createRuntime: (config: OptionalEmailDryRunRuntimeConfig) => Promise<OptionalEmailDryRunRuntime>;
};

export async function createOptionalEmailDryRunRuntime(
  config: OptionalEmailDryRunRuntimeConfig,
): Promise<OptionalEmailDryRunRuntime> {
  const connector = new MongoDbConnector({ connectionString: config.mongoUri });
  const dbAccessor = new MongoDbAccessor(connector);
  const users = new UserRepository(dbAccessor);
  const activationStates = new ActivationStateRepository(dbAccessor);
  const eligibility = new OptionalEmailEligibilityService({
    policy: {
      sendingEnabled: config.sendingEnabled,
      recipientBasis: config.recipientBasis,
    },
    recipients: new OptionalEmailRecipientRepository(dbAccessor),
    preferences: new OptionalEmailPreferenceRepository(dbAccessor),
    activationStates: {
      findByUserId: ({ userId }) => activationStates.findByUserId(userId),
    },
  });
  const service = new OptionalEmailDryRunService({
    users: {
      findIdBatch: ({ afterUserId, batchLimit, createdAtOrBefore }) =>
        users.findIdBatch(afterUserId, batchLimit, createdAtOrBefore),
    },
    activationStates: {
      findByUserId: ({ userId }) => activationStates.findByUserId(userId),
    },
    eligibility,
    policy: {
      sendingEnabled: config.sendingEnabled,
      recipientBasis: config.recipientBasis,
      dailyCap: config.dailyCap,
    },
  });

  return {
    run: (input) => service.run(input),
    close: () => connector.close(),
  };
}

export function parseOptionalEmailDryRunArgs(argv: string[]): OptionalEmailDryRunCliOptions {
  const options: OptionalEmailDryRunCliOptions = { help: false, batchLimit: DEFAULT_BATCH_LIMIT };
  let hasBatchLimit = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }

    let batchLimitValue: string | undefined;
    if (argument === "--batch-limit") {
      batchLimitValue = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--batch-limit=")) {
      batchLimitValue = argument.slice("--batch-limit=".length);
    } else {
      throw new Error("UnknownOptionalEmailDryRunArgument");
    }

    if (hasBatchLimit) {
      throw new Error("DuplicateOptionalEmailDryRunBatchLimit");
    }
    hasBatchLimit = true;

    const batchLimit = Number(batchLimitValue);
    if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 1_000) {
      throw new Error("InvalidOptionalEmailDryRunBatchLimit");
    }
    options.batchLimit = batchLimit;
  }

  return options;
}

export async function runOptionalEmailDryRunCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  dependencies: OptionalEmailDryRunCliDependencies,
): Promise<number> {
  let options: OptionalEmailDryRunCliOptions;
  try {
    options = parseOptionalEmailDryRunArgs(argv);
  } catch {
    dependencies.stderr("Invalid optional-email dry-run arguments");
    return 1;
  }

  if (options.help) {
    dependencies.stdout(USAGE);
    return 0;
  }

  const config = optionalEmailDryRunEnvironmentSchema.safeParse(env);
  if (!config.success) {
    dependencies.stderr("Invalid optional-email dry-run configuration");
    return 1;
  }

  let runtime: OptionalEmailDryRunRuntime | undefined;
  let closeRequired = false;
  try {
    runtime = await dependencies.createRuntime({
      mongoUri: config.data.MONGODB_URI,
      sendingEnabled: config.data.OPTIONAL_EMAIL_SENDING_ENABLED,
      recipientBasis: config.data.OPTIONAL_EMAIL_RECIPIENT_BASIS,
      dailyCap: config.data.OPTIONAL_EMAIL_DAILY_CAP,
    });
    closeRequired = true;
    const report = await runtime.run({ batchLimit: options.batchLimit });
    closeRequired = false;
    await runtime.close();
    dependencies.stdout(JSON.stringify(report));
    return 0;
  } catch {
    if (runtime && closeRequired) {
      await runtime.close().catch(() => undefined);
    }
    dependencies.stderr("Optional-email dry-run failed");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runOptionalEmailDryRunCli(process.argv.slice(2), process.env, {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    createRuntime: createOptionalEmailDryRunRuntime,
  });
}
