#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { BigQuery } from "@google-cloud/bigquery";
import { ProductAnalyticsExportApi } from "../api/product-analytics-export-api.js";
import { BigQueryProductAnalyticsClient } from "../clients/bigquery-product-analytics-client.js";
import { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { MongoDbConnector } from "../db/mongo-db-connector.js";
import { ActivationStateRepository } from "../repositories/activation-state-repo.js";
import { ProductAnalyticsControlRepository } from "../repositories/product-analytics-control-repo.js";
import { ProductAnalyticsExportRepository } from "../repositories/product-analytics-export-repo.js";
import { UserRepository } from "../repositories/user-repo.js";
import { ProductAnalyticsExportService } from "../services/product-analytics-export-service.js";
import { safeErrorType } from "./product-analytics-cli-utils.js";
import { loadProductAnalyticsExportConfig } from "./product-analytics-export-config.js";

export async function runProductAnalyticsExport(input: { env?: NodeJS.ProcessEnv; runCutoff?: Date }): Promise<number> {
  let connector: MongoDbConnector | null = null;
  try {
    const config = loadProductAnalyticsExportConfig({ env: input.env });
    const runCutoff = input.runCutoff ?? new Date();
    connector = new MongoDbConnector({
      connectionString: config.MONGODB_URI,
      clientOptions: { appName: "sesori-product-analytics-export" },
    });
    const accessor = new MongoDbAccessor(connector);
    const userRepo = new UserRepository(accessor);
    await userRepo.assertProductAnalyticsPreferenceBackfillComplete();
    const bigQuery = new BigQuery({ projectId: config.PRODUCT_ANALYTICS_GCP_PROJECT_ID });
    const api = new ProductAnalyticsExportApi({
      client: new BigQueryProductAnalyticsClient({
        bigQuery,
        projectId: config.PRODUCT_ANALYTICS_GCP_PROJECT_ID,
        datasetId: config.PRODUCT_ANALYTICS_AUTH_DATASET_ID,
        internalExclusionView: config.PRODUCT_ANALYTICS_INTERNAL_EXCLUSION_VIEW,
        location: config.PRODUCT_ANALYTICS_BIGQUERY_LOCATION,
      }),
    });
    const service = new ProductAnalyticsExportService({
      userRepo,
      activationStateRepo: new ActivationStateRepository(accessor),
      controlRepo: new ProductAnalyticsControlRepository({
        api,
        maxUserKeys: config.PRODUCT_ANALYTICS_INTERNAL_EXCLUSION_MAX_KEYS,
        maxAgeMs: config.PRODUCT_ANALYTICS_INTERNAL_EXCLUSION_MAX_AGE_MS,
      }),
      exportRepo: new ProductAnalyticsExportRepository({ api }),
      batchLimit: config.PRODUCT_ANALYTICS_EXPORT_BATCH_LIMIT,
    });
    const report = await service.run({
      runCutoff,
      onBatchComplete: (progress) => console.log("[ProductAnalyticsExport] Batch completed", progress),
    });
    console.log("[ProductAnalyticsExport] Completed", report);
    return 0;
  } catch (error) {
    console.error("[ProductAnalyticsExport] Failed", { errorType: safeErrorType({ error }) });
    return 1;
  } finally {
    await connector?.close();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runProductAnalyticsExport({});
}
