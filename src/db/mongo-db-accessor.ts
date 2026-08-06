import {
  Collection,
  Db,
  MongoServerError,
  type Document,
  type IndexSpecification,
  type CreateIndexesOptions,
} from "mongodb";
import { MongoDbDatabase, AuthDbCollection } from "../types/mongo.js";
import { MongoDbConnector } from "./mongo-db-connector.js";

export type IndexDefinition = {
  spec: IndexSpecification;
  options?: CreateIndexesOptions;
};

type DatabaseConfig<C extends string> = {
  collections: Record<C, IndexDefinition[]>;
};

const DATABASE_CONFIG: Record<MongoDbDatabase, DatabaseConfig<string>> = {
  [MongoDbDatabase.Auth]: {
    collections: {
      [AuthDbCollection.Users]: [],
      [AuthDbCollection.OAuthAccounts]: [
        { spec: { provider: 1, providerUserId: 1 }, options: { unique: true } },
        { spec: { userId: 1 } },
      ],
      [AuthDbCollection.PasswordAccounts]: [
        { spec: { email: 1 }, options: { unique: true } },
        { spec: { userId: 1 }, options: { unique: true } },
      ],
      [AuthDbCollection.GlossaryEntries]: [{ spec: { userId: 1, projectKey: 1, word: 1 }, options: { unique: true } }],
      [AuthDbCollection.DailyUsage]: [{ spec: { userId: 1, date: 1 }, options: { unique: true } }],
      [AuthDbCollection.DeviceTokens]: [
        { spec: { token: 1 }, options: { unique: true } },
        { spec: { userId: 1, createdAt: 1 } },
      ],
      [AuthDbCollection.Bridges]: [
        { spec: { bridgeId: 1 }, options: { unique: true } },
        // Covers the hot /auth/me path: findByUserId and revokeAllForUser
        // filter on { userId, revokedAt: null }. No query filters on status.
        { spec: { userId: 1, revokedAt: 1 } },
        { spec: { userId: 1, addedAt: 1 } },
      ],
      [AuthDbCollection.ActivationStates]: [
        { spec: { userId: 1 }, options: { unique: true } },
        // Reminder sweeps filter on stage-completion and sent-marker equality,
        // then range on the baseline. Keep equality fields before the range;
        // the two bridge reminders need separate indexes for their sent markers.
        // See .plans/activation-reminders/CONSIDERATIONS.md, "Index Design".
        { spec: { bridgeSetupAt: 1, bridgeReminder1SentAt: 1, bridgeReminderBaseAt: 1 } },
        { spec: { bridgeSetupAt: 1, bridgeReminder2SentAt: 1, bridgeReminderBaseAt: 1 } },
        { spec: { firstSessionAt: 1, sessionReminderSentAt: 1, sessionReminderBaseAt: 1 } },
      ],
      // One settings document per (user, device): the unique compound key both
      // enforces that invariant and serves the sole read path (findByUserAndDevice).
      [AuthDbCollection.SettingsConfiguration]: [{ spec: { userId: 1, deviceId: 1 }, options: { unique: true } }],
    },
  } satisfies DatabaseConfig<AuthDbCollection>,
};

export function indexKeyMatches(a: IndexSpecification, b: IndexSpecification): boolean {
  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const keysA = Object.keys(aRec);
  const keysB = Object.keys(bRec);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k, i) => k === keysB[i] && aRec[k] === bRec[k]);
}

export function indexMatchesDesired(existing: Record<string, unknown>, desired: IndexDefinition): boolean {
  if (!indexKeyMatches(existing.key as IndexSpecification, desired.spec)) return false;

  const desiredOpts = desired.options ?? {};
  const relevantKeys = new Set(["unique", ...Object.keys(desiredOpts)]);

  for (const key of relevantKeys) {
    const desiredValue = desiredOpts[key as keyof CreateIndexesOptions] ?? false;
    const existingValue = existing[key] ?? false;
    if (desiredValue !== existingValue) return false;
  }

  return true;
}

/**
 * Rejects every glossary target-index option that changes duplicate or lookup
 * semantics; `indexMatchesDesired` compares only key and `unique`, which is too
 * weak for this guard. This deliberately covers semantics, not the migration's
 * complete metadata audit: `--verify` additionally rejects `v: 1`, storage-engine
 * options, and type-specific fields, all of which leave duplicate behavior
 * unchanged. Startup therefore never accepts an index whose behavior differs
 * from the migrated state, but the operator command remains the authority on
 * exact index shape. Keep these predicates aligned when either side changes.
 */
function isExactGlossaryTargetIndex(index: Record<string, unknown>): boolean {
  const collation = index.collation as { locale?: unknown } | undefined;

  return (
    indexKeyMatches(index.key as IndexSpecification, { userId: 1, projectKey: 1, word: 1 }) &&
    index.unique === true &&
    index.sparse !== true &&
    index.hidden !== true &&
    index.prepareUnique !== true &&
    index.partialFilterExpression === undefined &&
    index.expireAfterSeconds === undefined &&
    (collation === undefined || collation.locale === "simple")
  );
}

export class MongoDbAccessor {
  readonly #connector: MongoDbConnector;

  constructor(connector: MongoDbConnector) {
    this.#connector = connector;
  }

  getDb(name: MongoDbDatabase): Db {
    return this.#connector.getDb(name);
  }

  getCollection<T extends Document>(database: MongoDbDatabase, collection: string): Collection<T> {
    return this.getDb(database).collection(collection);
  }

  async ensureIndexes(): Promise<void> {
    for (const dbName of Object.values(MongoDbDatabase)) {
      const dbConfig = DATABASE_CONFIG[dbName];
      const db = this.getDb(dbName);

      const existingCollections = new Set((await db.listCollections().toArray()).map((c) => c.name));

      for (const [collectionName, indexes] of Object.entries(dbConfig.collections)) {
        if (!existingCollections.has(collectionName)) {
          await db.createCollection(collectionName);
        }

        const collection = db.collection(collectionName);
        const existingIndexes = await collection.indexes();

        for (const desired of indexes) {
          const alreadyExists = existingIndexes.some((idx) => indexMatchesDesired(idx, desired));
          if (alreadyExists) continue;

          try {
            await collection.createIndex(desired.spec, desired.options ?? {});
          } catch (error) {
            if (error instanceof MongoServerError && error.code === 86) {
              const specKeys = Object.keys(desired.spec).join(",");
              console.warn(
                `Index conflict on ${collectionName} (${specKeys}): existing index differs from desired config. Manual cleanup may be required.`,
              );
              continue;
            }
            throw error;
          }
        }

        // A partial glossary cutover leaves the legacy {userId, word} unique
        // index in place, which rejects the same term in a second project and
        // makes the repository report it as an ordinary duplicate — silent word
        // loss. Refuse to serve until the operator migration finished. Index
        // ownership stays with the migration command; startup never drops here.
        if (dbName === MongoDbDatabase.Auth && collectionName === AuthDbCollection.GlossaryEntries) {
          const currentIndexes = await collection.indexes();
          const legacyIndex = currentIndexes.find((index) =>
            indexKeyMatches(index.key as IndexSpecification, { userId: 1, word: 1 }),
          );
          // Exactly one index may own the target key: duplicates on the same key
          // are a mismatched cutover state that `--verify` also refuses.
          const targetKeyIndexes = currentIndexes.filter((index) =>
            indexKeyMatches(index.key as IndexSpecification, { userId: 1, projectKey: 1, word: 1 }),
          );
          const targetExists = targetKeyIndexes.length === 1 && isExactGlossaryTargetIndex(targetKeyIndexes[0]);
          // A non-simple default collation is inherited by lookups such as the
          // repository's `word: { $in: [...] }` delete, silently changing match
          // semantics, so the collection itself must be simple.
          const [collectionMetadata] = await db
            .listCollections({ name: collectionName }, { nameOnly: false })
            .toArray();
          const collectionLocale = collectionMetadata?.options?.collation?.locale;
          const collationIsSimple = collectionLocale === undefined || collectionLocale === "simple";

          if (legacyIndex || !targetExists || !collationIsSimple) {
            throw new Error(
              "Glossary index migration incomplete: expected only the unique {userId, projectKey, word} index. " +
                "Run `npm run migrate-project-glossary-index -- --apply` with this instance stopped, then --verify.",
            );
          }
        }

        // The compound lookup index supersedes PR1's user-only token index.
        // Drop the old index only after confirming its replacement exists.
        if (dbName === MongoDbDatabase.Auth && collectionName === AuthDbCollection.DeviceTokens) {
          const currentIndexes = await collection.indexes();
          const replacementExists = currentIndexes.some((index) =>
            indexMatchesDesired(index, { spec: { userId: 1, createdAt: 1 } }),
          );
          const superseded = currentIndexes.find((index) =>
            indexKeyMatches(index.key as IndexSpecification, { userId: 1 }),
          );
          if (replacementExists && superseded?.name) {
            await collection.dropIndex(superseded.name);
          }
        }
      }
    }
  }
}
