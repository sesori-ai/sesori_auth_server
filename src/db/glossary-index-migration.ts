import { UUID, type Collection, type Db, type Document } from "mongodb";
import { z } from "zod";
import { legacyGlossaryEntryMigrationSchema, projectScopedGlossaryEntryMigrationSchema } from "../models/documents.js";
import { projectKeySchema } from "../models/voice.js";
import { AuthDbCollection } from "../types/mongo.js";

export const legacyGlossaryIndexSpec = { userId: 1, word: 1 } as const;
export const projectScopedGlossaryIndexSpec = { userId: 1, projectKey: 1, word: 1 } as const;
export const legacyGlossaryIndexName = "userId_1_word_1";
export const projectScopedGlossaryIndexName = "userId_1_projectKey_1_word_1";

export enum GlossaryIndexMigrationMode {
  DryRun = "dry-run",
  Apply = "apply",
  Verify = "verify",
  Rollback = "rollback",
}

export enum GlossaryIndexMigrationOutcome {
  Completed = "completed",
  SafeToRerun = "safe_to_rerun",
  RepairRequired = "repair_required",
}

export enum GlossaryIndexState {
  Absent = "absent",
  Exact = "exact",
  Mismatch = "mismatch",
}

export enum GlossaryCollectionState {
  Absent = "absent",
  Simple = "simple",
  NonSimpleCollation = "non_simple_collation",
}

export type GlossaryIndexMigrationReport = {
  mode: GlossaryIndexMigrationMode;
  outcome: GlossaryIndexMigrationOutcome;
  collectionState: GlossaryCollectionState;
  documentCount: number;
  missingProjectKeyCount: number;
  invalidProjectKeyCount: number;
  invalidDocumentCount: number;
  duplicateTargetKeyCount: number;
  legacyIndexState: GlossaryIndexState;
  targetIndexState: GlossaryIndexState;
};

type ParsedIndex = z.infer<typeof indexMetadataSchema>;
type Audit = Omit<GlossaryIndexMigrationReport, "mode" | "outcome"> & {
  legacyIndexName: string | null;
  targetIndexName: string | null;
};

const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const indexDirectionSchema = z.union([z.number().finite(), z.string().min(1)]);
const indexKeySchema = z.record(z.string(), indexDirectionSchema);
const collationSchema = z
  .object({
    locale: z.string().min(1),
    caseLevel: z.boolean().optional(),
    caseFirst: z.enum(["upper", "lower", "off"]).optional(),
    strength: z.number().int().min(1).max(5).optional(),
    numericOrdering: z.boolean().optional(),
    alternate: z.enum(["non-ignorable", "shifted"]).optional(),
    maxVariable: z.enum(["punct", "space"]).optional(),
    normalization: z.boolean().optional(),
    backwards: z.boolean().optional(),
    version: z.string().min(1).optional(),
  })
  .strict();
const unknownRecordSchema = z.record(z.string(), z.unknown());
const indexMetadataSchema = z
  .object({
    v: nonnegativeSafeIntegerSchema,
    key: indexKeySchema,
    name: z.string().min(1),
    ns: z.string().min(1).optional(),
    unique: z.boolean().optional(),
    sparse: z.boolean().optional(),
    hidden: z.boolean().optional(),
    prepareUnique: z.boolean().optional(),
    partialFilterExpression: unknownRecordSchema.optional(),
    collation: collationSchema.optional(),
    expireAfterSeconds: z.number().finite().optional(),
    storageEngine: unknownRecordSchema.optional(),
    weights: unknownRecordSchema.optional(),
    default_language: z.string().optional(),
    language_override: z.string().optional(),
    textIndexVersion: nonnegativeSafeIntegerSchema.optional(),
    "2dsphereIndexVersion": nonnegativeSafeIntegerSchema.optional(),
    bits: nonnegativeSafeIntegerSchema.optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    bucketSize: z.number().finite().optional(),
    wildcardProjection: unknownRecordSchema.optional(),
  })
  .strict();
const collectionMetadataSchema = z
  .object({
    name: z.literal(AuthDbCollection.GlossaryEntries),
    type: z.literal("collection"),
    options: z.object({ collation: collationSchema.optional() }).strict(),
    info: z.object({ readOnly: z.literal(false), uuid: z.instanceof(UUID) }).strict(),
    idIndex: indexMetadataSchema,
  })
  .strict();
const collectionMetadataListSchema = z.array(collectionMetadataSchema).max(1);
const indexMetadataListSchema = z.array(indexMetadataSchema).min(1);
const duplicateCountResultSchema = z
  .array(z.object({ duplicateTargetKeyCount: nonnegativeSafeIntegerSchema }).strict())
  .max(1);

class GlossaryIndexMigrationPersistenceError extends Error {
  constructor() {
    super("GlossaryIndexMigrationPersistenceError");
    this.name = "GlossaryIndexMigrationPersistenceError";
  }
}

function parsePersistence<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new GlossaryIndexMigrationPersistenceError();
  }

  return result.data;
}

function incrementCount(value: number): number {
  return parsePersistence(nonnegativeSafeIntegerSchema, value + 1);
}

function indexKeyMatches(index: ParsedIndex, expected: Readonly<Record<string, number>>): boolean {
  const actualEntries = Object.entries(index.key);
  const expectedEntries = Object.entries(expected);
  return (
    actualEntries.length === expectedEntries.length &&
    actualEntries.every(([key, value], indexPosition) => {
      const expectedEntry = expectedEntries[indexPosition];
      return expectedEntry?.[0] === key && expectedEntry[1] === value;
    })
  );
}

function isExactUniqueIndex(index: ParsedIndex): boolean {
  return (
    index.v === 2 &&
    index.unique === true &&
    index.sparse !== true &&
    index.hidden !== true &&
    index.prepareUnique !== true &&
    index.partialFilterExpression === undefined &&
    index.collation === undefined &&
    index.expireAfterSeconds === undefined &&
    index.storageEngine === undefined &&
    index.weights === undefined &&
    index.default_language === undefined &&
    index.language_override === undefined &&
    index.textIndexVersion === undefined &&
    index["2dsphereIndexVersion"] === undefined &&
    index.bits === undefined &&
    index.min === undefined &&
    index.max === undefined &&
    index.bucketSize === undefined &&
    index.wildcardProjection === undefined
  );
}

function classifyIndex(
  indexes: ParsedIndex[],
  expected: Readonly<Record<string, number>>,
  canonicalName: string,
): { state: GlossaryIndexState; name: string | null } {
  const matching = indexes.filter((index) => indexKeyMatches(index, expected));
  if (matching.length === 0) {
    if (indexes.some((index) => index.name === canonicalName)) {
      return { state: GlossaryIndexState.Mismatch, name: null };
    }
    return { state: GlossaryIndexState.Absent, name: null };
  }

  if (matching.length !== 1 || !isExactUniqueIndex(matching[0])) {
    return { state: GlossaryIndexState.Mismatch, name: null };
  }

  return { state: GlossaryIndexState.Exact, name: matching[0].name };
}

async function auditDocuments(collection: Collection<Document>): Promise<{
  documentCount: number;
  missingProjectKeyCount: number;
  invalidProjectKeyCount: number;
  invalidDocumentCount: number;
}> {
  let documentCount = 0;
  let missingProjectKeyCount = 0;
  let invalidProjectKeyCount = 0;
  let invalidDocumentCount = 0;
  const cursor = collection.find({});

  try {
    for await (const document of cursor) {
      documentCount = incrementCount(documentCount);
      if (!Object.hasOwn(document, "projectKey")) {
        missingProjectKeyCount = incrementCount(missingProjectKeyCount);
        if (!legacyGlossaryEntryMigrationSchema.safeParse(document).success) {
          invalidDocumentCount = incrementCount(invalidDocumentCount);
        }
        continue;
      }

      if (!projectKeySchema.safeParse(document.projectKey).success) {
        invalidProjectKeyCount = incrementCount(invalidProjectKeyCount);
      }
      if (!projectScopedGlossaryEntryMigrationSchema.safeParse(document).success) {
        invalidDocumentCount = incrementCount(invalidDocumentCount);
      }
    }
  } finally {
    await cursor.close();
  }

  return { documentCount, missingProjectKeyCount, invalidProjectKeyCount, invalidDocumentCount };
}

async function countDuplicateTargetKeys(collection: Collection<Document>): Promise<number> {
  const rawResult = await collection
    .aggregate(
      [
        {
          $group: {
            _id: { userId: "$userId", projectKey: "$projectKey", word: "$word" },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
        { $count: "duplicateTargetKeyCount" },
      ],
      { allowDiskUse: true },
    )
    .toArray();
  const result = parsePersistence(duplicateCountResultSchema, rawResult);
  return result[0]?.duplicateTargetKeyCount ?? 0;
}

async function audit(db: Db): Promise<Audit> {
  const rawCollections = await db
    .listCollections({ name: AuthDbCollection.GlossaryEntries }, { nameOnly: false })
    .toArray();
  const collections = parsePersistence(collectionMetadataListSchema, rawCollections);
  if (collections.length === 0) {
    return {
      collectionState: GlossaryCollectionState.Absent,
      documentCount: 0,
      missingProjectKeyCount: 0,
      invalidProjectKeyCount: 0,
      invalidDocumentCount: 0,
      duplicateTargetKeyCount: 0,
      legacyIndexState: GlossaryIndexState.Absent,
      targetIndexState: GlossaryIndexState.Absent,
      legacyIndexName: null,
      targetIndexName: null,
    };
  }

  const collectionMetadata = collections[0];
  const collectionState = collectionMetadata.options.collation
    ? GlossaryCollectionState.NonSimpleCollation
    : GlossaryCollectionState.Simple;
  const collection = db.collection(AuthDbCollection.GlossaryEntries);
  const documents = await auditDocuments(collection);
  const duplicateTargetKeyCount = await countDuplicateTargetKeys(collection);
  const indexes = parsePersistence(indexMetadataListSchema, await collection.listIndexes().toArray());
  const legacyIndex = classifyIndex(indexes, legacyGlossaryIndexSpec, legacyGlossaryIndexName);
  const targetIndex = classifyIndex(indexes, projectScopedGlossaryIndexSpec, projectScopedGlossaryIndexName);

  return {
    collectionState,
    ...documents,
    duplicateTargetKeyCount,
    legacyIndexState: legacyIndex.state,
    targetIndexState: targetIndex.state,
    legacyIndexName: legacyIndex.name,
    targetIndexName: targetIndex.name,
  };
}

function toReport(
  mode: GlossaryIndexMigrationMode,
  outcome: GlossaryIndexMigrationOutcome,
  state: Audit,
): GlossaryIndexMigrationReport {
  return {
    mode,
    outcome,
    collectionState: state.collectionState,
    documentCount: state.documentCount,
    missingProjectKeyCount: state.missingProjectKeyCount,
    invalidProjectKeyCount: state.invalidProjectKeyCount,
    invalidDocumentCount: state.invalidDocumentCount,
    duplicateTargetKeyCount: state.duplicateTargetKeyCount,
    legacyIndexState: state.legacyIndexState,
    targetIndexState: state.targetIndexState,
  };
}

function hasSafeData(state: Audit): boolean {
  return (
    state.missingProjectKeyCount === 0 &&
    state.invalidProjectKeyCount === 0 &&
    state.invalidDocumentCount === 0 &&
    state.duplicateTargetKeyCount === 0
  );
}

function hasSafeIndexes(state: Audit): boolean {
  return (
    state.legacyIndexState !== GlossaryIndexState.Mismatch && state.targetIndexState !== GlossaryIndexState.Mismatch
  );
}

function canApply(state: Audit): boolean {
  return (
    state.collectionState !== GlossaryCollectionState.NonSimpleCollation && hasSafeData(state) && hasSafeIndexes(state)
  );
}

function canRollback(state: Audit): boolean {
  return canApply(state) && state.documentCount === 0;
}

function isApplied(state: Audit): boolean {
  return (
    canApply(state) &&
    state.collectionState === GlossaryCollectionState.Simple &&
    state.legacyIndexState === GlossaryIndexState.Absent &&
    state.targetIndexState === GlossaryIndexState.Exact
  );
}

function isRolledBack(state: Audit): boolean {
  return (
    canRollback(state) &&
    state.collectionState === GlossaryCollectionState.Simple &&
    state.legacyIndexState === GlossaryIndexState.Exact &&
    state.targetIndexState === GlossaryIndexState.Absent
  );
}

function classifyRecovery(mode: GlossaryIndexMigrationMode, state: Audit): GlossaryIndexMigrationOutcome {
  if (mode === GlossaryIndexMigrationMode.Apply && isApplied(state)) {
    return GlossaryIndexMigrationOutcome.Completed;
  }
  if (mode === GlossaryIndexMigrationMode.Rollback && isRolledBack(state)) {
    return GlossaryIndexMigrationOutcome.Completed;
  }
  if (mode === GlossaryIndexMigrationMode.Apply ? canApply(state) : canRollback(state)) {
    return GlossaryIndexMigrationOutcome.SafeToRerun;
  }
  return GlossaryIndexMigrationOutcome.RepairRequired;
}

async function recoverAfterMutationFailure(
  db: Db,
  mode: GlossaryIndexMigrationMode.Apply | GlossaryIndexMigrationMode.Rollback,
): Promise<GlossaryIndexMigrationReport> {
  const state = await audit(db);
  return toReport(mode, classifyRecovery(mode, state), state);
}

async function applyMigration(db: Db, initialState: Audit): Promise<GlossaryIndexMigrationReport> {
  if (!canApply(initialState)) {
    return toReport(GlossaryIndexMigrationMode.Apply, GlossaryIndexMigrationOutcome.RepairRequired, initialState);
  }

  const collection = db.collection(AuthDbCollection.GlossaryEntries);
  try {
    if (initialState.targetIndexState === GlossaryIndexState.Absent) {
      await collection.createIndex(projectScopedGlossaryIndexSpec, {
        name: projectScopedGlossaryIndexName,
        unique: true,
      });
    }

    const beforeDrop = await audit(db);
    if (!canApply(beforeDrop) || beforeDrop.targetIndexState !== GlossaryIndexState.Exact) {
      return toReport(
        GlossaryIndexMigrationMode.Apply,
        classifyRecovery(GlossaryIndexMigrationMode.Apply, beforeDrop),
        beforeDrop,
      );
    }

    if (beforeDrop.legacyIndexState === GlossaryIndexState.Exact && beforeDrop.legacyIndexName) {
      await collection.dropIndex(beforeDrop.legacyIndexName);
    }

    const finalState = await audit(db);
    return toReport(
      GlossaryIndexMigrationMode.Apply,
      classifyRecovery(GlossaryIndexMigrationMode.Apply, finalState),
      finalState,
    );
  } catch {
    return recoverAfterMutationFailure(db, GlossaryIndexMigrationMode.Apply);
  }
}

async function rollbackMigration(db: Db, initialState: Audit): Promise<GlossaryIndexMigrationReport> {
  if (!canRollback(initialState)) {
    return toReport(GlossaryIndexMigrationMode.Rollback, GlossaryIndexMigrationOutcome.RepairRequired, initialState);
  }

  const collection = db.collection(AuthDbCollection.GlossaryEntries);
  try {
    if (initialState.legacyIndexState === GlossaryIndexState.Absent) {
      await collection.createIndex(legacyGlossaryIndexSpec, { name: legacyGlossaryIndexName, unique: true });
    }

    const beforeDrop = await audit(db);
    if (!canRollback(beforeDrop) || beforeDrop.legacyIndexState !== GlossaryIndexState.Exact) {
      return toReport(
        GlossaryIndexMigrationMode.Rollback,
        classifyRecovery(GlossaryIndexMigrationMode.Rollback, beforeDrop),
        beforeDrop,
      );
    }

    if (beforeDrop.targetIndexState === GlossaryIndexState.Exact && beforeDrop.targetIndexName) {
      await collection.dropIndex(beforeDrop.targetIndexName);
    }

    const finalState = await audit(db);
    return toReport(
      GlossaryIndexMigrationMode.Rollback,
      classifyRecovery(GlossaryIndexMigrationMode.Rollback, finalState),
      finalState,
    );
  } catch {
    return recoverAfterMutationFailure(db, GlossaryIndexMigrationMode.Rollback);
  }
}

export async function runGlossaryIndexMigration(input: {
  db: Db;
  mode: GlossaryIndexMigrationMode;
}): Promise<GlossaryIndexMigrationReport> {
  const state = await audit(input.db);
  if (input.mode === GlossaryIndexMigrationMode.DryRun) {
    return toReport(
      input.mode,
      canApply(state) ? GlossaryIndexMigrationOutcome.Completed : GlossaryIndexMigrationOutcome.RepairRequired,
      state,
    );
  }
  if (input.mode === GlossaryIndexMigrationMode.Verify) {
    return toReport(
      input.mode,
      isApplied(state) ? GlossaryIndexMigrationOutcome.Completed : GlossaryIndexMigrationOutcome.RepairRequired,
      state,
    );
  }
  if (input.mode === GlossaryIndexMigrationMode.Apply) {
    return applyMigration(input.db, state);
  }
  return rollbackMigration(input.db, state);
}
