#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { BigQuery } from "@google-cloud/bigquery";
import { z } from "zod";
import { ProductAnalyticsDeletionTargetApi } from "../api/product-analytics-deletion-target-api.js";
import { BigQueryProductAnalyticsDeletionTargetClient } from "../clients/bigquery-product-analytics-deletion-target-client.js";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { MongoDbConnector } from "../db/mongo-db-connector.js";
import { ProductAnalyticsDeletionTargetRepository } from "../repositories/product-analytics-deletion-target-repo.js";
import { UserRepository } from "../repositories/user-repo.js";
import { ProductAnalyticsDeletionService } from "../services/product-analytics-deletion-service.js";
import { ProductAnalyticsPreferenceService } from "../services/product-analytics-preference-service.js";
import { loadProductAnalyticsDeletionConfig } from "./product-analytics-deletion-config.js";

const suppressionInputSchema = z.object({
  userId: z.string().regex(/^[a-fA-F0-9]{24}$/),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
});

export type ProductAnalyticsSuppressionInput = z.infer<typeof suppressionInputSchema>;

export function parseProductAnalyticsSuppressionInput(input: { value: string }): ProductAnalyticsSuppressionInput {
  const result = suppressionInputSchema.safeParse(JSON.parse(input.value));
  if (!result.success) {
    throw new Error("Invalid product analytics suppression input");
  }
  return result.data;
}

async function readProtectedStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 4_096) {
      throw new Error("Product analytics suppression input is too large");
    }
  }
  return value;
}

function safeErrorType(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

export async function runProductAnalyticsSuppression(input: {
  env?: NodeJS.ProcessEnv;
  readInput?: () => Promise<string>;
}): Promise<number> {
  let connector: MongoDbConnector | null = null;
  try {
    const config = loadProductAnalyticsDeletionConfig({ env: input.env });
    const command = parseProductAnalyticsSuppressionInput({ value: await (input.readInput ?? readProtectedStdin)() });
    connector = new MongoDbConnector({
      connectionString: config.MONGODB_URI,
      clientOptions: { appName: "sesori-product-analytics-suppression" },
    });
    const userRepo = new UserRepository(new MongoDbAccessor(connector));
    const bigQuery = new BigQuery({ projectId: config.PRODUCT_ANALYTICS_GCP_PROJECT_ID });
    const deletionTargetApi = new ProductAnalyticsDeletionTargetApi({
      client: new BigQueryProductAnalyticsDeletionTargetClient({
        bigQuery,
        projectId: config.PRODUCT_ANALYTICS_GCP_PROJECT_ID,
        datasetId: config.PRODUCT_ANALYTICS_PRIVACY_DATASET_ID,
        location: config.PRODUCT_ANALYTICS_BIGQUERY_LOCATION,
      }),
    });
    const service = new ProductAnalyticsDeletionService({
      preferenceService: new ProductAnalyticsPreferenceService({ userRepo }),
      deletionTargetRepo: new ProductAnalyticsDeletionTargetRepository({ api: deletionTargetApi }),
    });
    const result = await service.suppressAndHandoff(command);
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    console.error("Product analytics suppression failed", { errorType: safeErrorType(error) });
    return 1;
  } finally {
    await connector?.close();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runProductAnalyticsSuppression({});
}
