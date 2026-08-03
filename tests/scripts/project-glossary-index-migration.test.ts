import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { AggregationCursor, Collection, MongoClient, ObjectId, type Db, type Document } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  GlossaryCollectionState,
  GlossaryIndexMigrationMode,
  GlossaryIndexMigrationOutcome,
  GlossaryIndexState,
  legacyGlossaryIndexName,
  legacyGlossaryIndexSpec,
  projectScopedGlossaryIndexName,
  projectScopedGlossaryIndexSpec,
  runGlossaryIndexMigration,
} from "../../src/db/glossary-index-migration.js";
import { MongoDbConnector } from "../../src/db/mongo-db-connector.js";
import {
  parseProjectGlossaryIndexMigrationArgs,
  runProjectGlossaryIndexMigrationCli,
} from "../../src/scripts/migrate-project-glossary-index.js";
import { AuthDbCollection, MongoDbDatabase } from "../../src/types/mongo.js";

const validProjectKey = `prj_v1_${"A".repeat(43)}`;
const canaryWord = "PRIVATE_GLOSSARY_CANARY";

describe("project glossary index migration", () => {
  let memoryServer: MongoMemoryServer | null = null;
  let client: MongoClient;
  let db: Db;
  let mongodbUri: string;

  before(async () => {
    if (process.env.MONGODB_URI_TEST) {
      mongodbUri = process.env.MONGODB_URI_TEST;
    } else {
      memoryServer = await MongoMemoryServer.create({ binary: { version: "7.0.24" } });
      mongodbUri = memoryServer.getUri();
    }
    client = new MongoClient(mongodbUri);
    await client.connect();
    db = client.db(MongoDbDatabase.Auth);
  });

  after(async () => {
    await client.close();
    await memoryServer?.stop();
  });

  beforeEach(async () => {
    mock.restoreAll();
    await db.dropDatabase();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  function collection(): Collection<Document> {
    return db.collection(AuthDbCollection.GlossaryEntries);
  }

  async function createLegacyIndex(): Promise<void> {
    await collection().createIndex(legacyGlossaryIndexSpec, { unique: true });
  }

  async function createTargetIndex(options: { unique?: boolean; sparse?: boolean } = {}): Promise<void> {
    const indexOptions: { unique: boolean; sparse?: boolean } = { unique: options.unique ?? true };
    if (options.sparse !== undefined) {
      indexOptions.sparse = options.sparse;
    }
    await collection().createIndex(projectScopedGlossaryIndexSpec, indexOptions);
  }

  function glossaryDocument(input: { projectKey?: string; word?: string; userId?: ObjectId } = {}): Document {
    const document: Document = {
      _id: new ObjectId(),
      userId: input.userId ?? new ObjectId(),
      word: input.word ?? canaryWord,
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
    };
    if (input.projectKey !== undefined) {
      document.projectKey = input.projectKey;
    }
    return document;
  }

  async function indexKeys(): Promise<Record<string, unknown>[]> {
    return (await collection().listIndexes().toArray()).map((index) => index.key as Record<string, unknown>);
  }

  it("parses one explicit mode and rejects duplicate, mixed, or unknown flags", () => {
    assert.deepEqual(parseProjectGlossaryIndexMigrationArgs([]), {
      mode: GlossaryIndexMigrationMode.DryRun,
      help: false,
    });
    assert.deepEqual(parseProjectGlossaryIndexMigrationArgs(["--apply"]), {
      mode: GlossaryIndexMigrationMode.Apply,
      help: false,
    });
    assert.deepEqual(parseProjectGlossaryIndexMigrationArgs(["--verify"]), {
      mode: GlossaryIndexMigrationMode.Verify,
      help: false,
    });
    assert.deepEqual(parseProjectGlossaryIndexMigrationArgs(["--rollback"]), {
      mode: GlossaryIndexMigrationMode.Rollback,
      help: false,
    });
    assert.deepEqual(parseProjectGlossaryIndexMigrationArgs(["--help"]), {
      mode: GlossaryIndexMigrationMode.DryRun,
      help: true,
    });
    assert.throws(() => parseProjectGlossaryIndexMigrationArgs(["--apply", "--verify"]));
    assert.throws(() => parseProjectGlossaryIndexMigrationArgs(["--apply", "--apply"]));
    assert.throws(() => parseProjectGlossaryIndexMigrationArgs(["--unknown"]));
  });

  it("dry-runs empty legacy state without mutating indexes", async () => {
    await createLegacyIndex();

    const report = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.DryRun });

    assert.deepEqual(report, {
      mode: GlossaryIndexMigrationMode.DryRun,
      outcome: GlossaryIndexMigrationOutcome.Completed,
      collectionState: GlossaryCollectionState.Simple,
      documentCount: 0,
      missingProjectKeyCount: 0,
      invalidProjectKeyCount: 0,
      invalidDocumentCount: 0,
      duplicateTargetKeyCount: 0,
      legacyIndexState: GlossaryIndexState.Exact,
      targetIndexState: GlossaryIndexState.Absent,
    });
    assert.deepEqual(await indexKeys(), [{ _id: 1 }, legacyGlossaryIndexSpec]);
  });

  it("fails closed on legacy, invalid, malformed, and duplicate target documents", async () => {
    await createLegacyIndex();
    await collection().insertOne(glossaryDocument());
    let report = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.DryRun });
    assert.equal(report.outcome, GlossaryIndexMigrationOutcome.RepairRequired);
    assert.equal(report.missingProjectKeyCount, 1);

    await db.dropDatabase();
    await createLegacyIndex();
    await collection().insertOne(glossaryDocument({ projectKey: "invalid" }));
    report = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.DryRun });
    assert.equal(report.invalidProjectKeyCount, 1);
    assert.equal(report.invalidDocumentCount, 1);

    await db.dropDatabase();
    const duplicateUserId = new ObjectId();
    await collection().insertMany([
      glossaryDocument({ projectKey: validProjectKey, word: canaryWord, userId: duplicateUserId }),
      glossaryDocument({ projectKey: validProjectKey, word: canaryWord, userId: duplicateUserId }),
    ]);
    report = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.DryRun });
    assert.equal(report.duplicateTargetKeyCount, 1);
    assert.equal(report.outcome, GlossaryIndexMigrationOutcome.RepairRequired);
  });

  it("fails before mutation for non-simple collection collation and mismatched indexes", async () => {
    await db.createCollection(AuthDbCollection.GlossaryEntries, { collation: { locale: "en", strength: 2 } });
    let report = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.Apply });
    assert.equal(report.collectionState, GlossaryCollectionState.NonSimpleCollation);
    assert.equal(report.outcome, GlossaryIndexMigrationOutcome.RepairRequired);
    assert.deepEqual(await indexKeys(), [{ _id: 1 }]);

    await db.dropDatabase();
    await createLegacyIndex();
    await createTargetIndex({ unique: false });
    report = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.Apply });
    assert.equal(report.targetIndexState, GlossaryIndexState.Mismatch);
    assert.equal(report.outcome, GlossaryIndexMigrationOutcome.RepairRequired);
    assert.ok((await indexKeys()).some((key) => key.projectKey === 1));
  });

  it("returns repair_required for a conflicting target index name", async () => {
    await createLegacyIndex();
    await collection().createIndex({ createdAt: 1 }, { name: projectScopedGlossaryIndexName });

    const report = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.Apply });

    assert.equal(report.outcome, GlossaryIndexMigrationOutcome.RepairRequired);
    assert.equal(report.targetIndexState, GlossaryIndexState.Mismatch);
    assert.equal(report.legacyIndexState, GlossaryIndexState.Exact);
  });

  it("returns repair_required for a conflicting legacy index name", async () => {
    await createTargetIndex();
    await collection().createIndex({ createdAt: 1 }, { name: legacyGlossaryIndexName });

    const report = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.Rollback });

    assert.equal(report.outcome, GlossaryIndexMigrationOutcome.RepairRequired);
    assert.equal(report.legacyIndexState, GlossaryIndexState.Mismatch);
    assert.equal(report.targetIndexState, GlossaryIndexState.Exact);
  });

  it("rejects unsupported collection metadata and malformed aggregation counts", async () => {
    await db.createCollection(AuthDbCollection.GlossaryEntries, {
      validator: { word: { $type: "string" } },
    });
    await assert.rejects(
      runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.DryRun }),
      /GlossaryIndexMigrationPersistenceError/,
    );

    await db.dropDatabase();
    await createLegacyIndex();
    mock.method(AggregationCursor.prototype, "toArray", async () => [{ duplicateTargetKeyCount: -1 }]);
    await assert.rejects(
      runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.DryRun }),
      /GlossaryIndexMigrationPersistenceError/,
    );
  });

  it("applies scoped data in create-verify-drop order and is idempotent", async () => {
    await createLegacyIndex();
    const document = glossaryDocument({ projectKey: validProjectKey });
    await collection().insertOne(document);

    let report = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.Apply });
    assert.equal(report.outcome, GlossaryIndexMigrationOutcome.Completed);
    assert.equal(report.legacyIndexState, GlossaryIndexState.Absent);
    assert.equal(report.targetIndexState, GlossaryIndexState.Exact);
    assert.deepEqual(await collection().findOne({ _id: document._id }), document);

    report = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.Apply });
    assert.equal(report.outcome, GlossaryIndexMigrationOutcome.Completed);
    assert.deepEqual(await indexKeys(), [{ _id: 1 }, projectScopedGlossaryIndexSpec]);
  });

  it("resumes the exact-both interruption state and verifies target-only state", async () => {
    await createLegacyIndex();
    await createTargetIndex();

    const applied = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.Apply });
    assert.equal(applied.outcome, GlossaryIndexMigrationOutcome.Completed);

    const verified = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.Verify });
    assert.equal(verified.outcome, GlossaryIndexMigrationOutcome.Completed);
    assert.equal(verified.legacyIndexState, GlossaryIndexState.Absent);
    assert.equal(verified.targetIndexState, GlossaryIndexState.Exact);
  });

  it("rolls back only an empty collection, old-first, and idempotently", async () => {
    await createTargetIndex();

    let report = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.Rollback });
    assert.equal(report.outcome, GlossaryIndexMigrationOutcome.Completed);
    assert.deepEqual(await indexKeys(), [{ _id: 1 }, legacyGlossaryIndexSpec]);

    report = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.Rollback });
    assert.equal(report.outcome, GlossaryIndexMigrationOutcome.Completed);

    await collection().insertOne(glossaryDocument());
    report = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.Rollback });
    assert.equal(report.outcome, GlossaryIndexMigrationOutcome.RepairRequired);
    assert.equal(report.documentCount, 1);
  });

  it("returns repair_required when a legacy row appears during the old-index drop", async () => {
    await createLegacyIndex();
    const originalDropIndex = Collection.prototype.dropIndex;
    mock.method(Collection.prototype, "dropIndex", async function (this: Collection, indexName, options) {
      await this.insertOne(glossaryDocument());
      return originalDropIndex.call(this, indexName, options);
    });

    const report = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.Apply });

    assert.equal(report.outcome, GlossaryIndexMigrationOutcome.RepairRequired);
    assert.equal(report.missingProjectKeyCount, 1);
    assert.equal(report.legacyIndexState, GlossaryIndexState.Absent);
    assert.equal(report.targetIndexState, GlossaryIndexState.Exact);
  });

  it("returns repair_required when conflicting DDL replaces the target after the old-index drop", async () => {
    await createLegacyIndex();
    const originalDropIndex = Collection.prototype.dropIndex;
    mock.method(Collection.prototype, "dropIndex", async function (this: Collection, indexName, options) {
      const result = await originalDropIndex.call(this, indexName, options);
      const indexes = await this.listIndexes().toArray();
      const target = indexes.find((index) => (index.key as Record<string, unknown>).projectKey === 1);
      assert.ok(target?.name);
      await originalDropIndex.call(this, target.name);
      await this.createIndex(projectScopedGlossaryIndexSpec, { unique: false });
      return result;
    });

    const report = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.Apply });

    assert.equal(report.outcome, GlossaryIndexMigrationOutcome.RepairRequired);
    assert.equal(report.targetIndexState, GlossaryIndexState.Mismatch);
  });

  it("returns repair_required when a document appears during the target-index rollback drop", async () => {
    await createTargetIndex();
    const originalDropIndex = Collection.prototype.dropIndex;
    mock.method(Collection.prototype, "dropIndex", async function (this: Collection, indexName, options) {
      await this.insertOne(glossaryDocument({ projectKey: validProjectKey }));
      return originalDropIndex.call(this, indexName, options);
    });

    const report = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.Rollback });

    assert.equal(report.outcome, GlossaryIndexMigrationOutcome.RepairRequired);
    assert.equal(report.documentCount, 1);
    assert.equal(report.legacyIndexState, GlossaryIndexState.Exact);
    assert.equal(report.targetIndexState, GlossaryIndexState.Absent);
  });

  it("returns repair_required when conflicting DDL replaces the legacy index after rollback drop", async () => {
    await createTargetIndex();
    const originalDropIndex = Collection.prototype.dropIndex;
    mock.method(Collection.prototype, "dropIndex", async function (this: Collection, indexName, options) {
      const result = await originalDropIndex.call(this, indexName, options);
      const indexes = await this.listIndexes().toArray();
      const legacy = indexes.find((index) => {
        const key = index.key as Record<string, unknown>;
        return key.userId === 1 && key.word === 1 && key.projectKey === undefined;
      });
      assert.ok(legacy?.name);
      await originalDropIndex.call(this, legacy.name);
      await this.createIndex(legacyGlossaryIndexSpec, { unique: false });
      return result;
    });

    const report = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.Rollback });

    assert.equal(report.outcome, GlossaryIndexMigrationOutcome.RepairRequired);
    assert.equal(report.legacyIndexState, GlossaryIndexState.Mismatch);
  });

  it("uses safe_to_rerun for a valid missing-index state and converges on rerun", async () => {
    await createLegacyIndex();
    const originalCreateIndex = Collection.prototype.createIndex;
    let calls = 0;
    mock.method(Collection.prototype, "createIndex", async function (this: Collection, spec, options) {
      calls += 1;
      if (calls === 1) {
        throw new Error("simulated create interruption");
      }
      return originalCreateIndex.call(this, spec, options);
    });

    let report = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.Apply });
    assert.equal(report.outcome, GlossaryIndexMigrationOutcome.SafeToRerun);

    mock.restoreAll();
    report = await runGlossaryIndexMigration({ db, mode: GlossaryIndexMigrationMode.Apply });
    assert.equal(report.outcome, GlossaryIndexMigrationOutcome.Completed);
  });

  it("keeps CLI output content-redacted and closes its connector", async () => {
    await createLegacyIndex();
    const document = glossaryDocument();
    await collection().insertOne(document);
    const calls: unknown[][] = [];
    let closeCalls = 0;
    const originalClose = MongoDbConnector.prototype.close;
    mock.method(console, "log", (...args: unknown[]) => calls.push(args));
    mock.method(console, "error", (...args: unknown[]) => calls.push(args));
    mock.method(MongoDbConnector.prototype, "close", async function (this: MongoDbConnector) {
      closeCalls += 1;
      return originalClose.call(this);
    });

    const exitCode = await runProjectGlossaryIndexMigrationCli({ argv: [], env: { MONGODB_URI: mongodbUri } });

    assert.equal(exitCode, 1);
    const output = JSON.stringify(calls);
    assert.equal(output.includes(canaryWord), false);
    assert.equal(output.includes(validProjectKey), false);
    assert.equal(output.includes(document._id.toHexString()), false);
    assert.equal(closeCalls, 1);
  });

  it("handles help and missing configuration without connecting", async () => {
    mock.method(console, "log", () => {});
    mock.method(console, "error", () => {});
    assert.equal(await runProjectGlossaryIndexMigrationCli({ argv: ["--help"], env: {} }), 0);
    assert.equal(await runProjectGlossaryIndexMigrationCli({ argv: [], env: {} }), 1);
  });
});
