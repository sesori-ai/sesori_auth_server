import { Collection, ObjectId } from "mongodb";
import { z } from "zod";
import type { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import type { OAuthAccount, PasswordAccount, User } from "../models/documents.js";
import type {
  OptionalEmailRecipientLookup,
  OptionalEmailRecipientResolution,
} from "../services/optional-email-eligibility-service.js";
import { AuthDbCollection, MongoDbDatabase } from "../types/mongo.js";

const emailSchema = z
  .string()
  .trim()
  .email()
  .transform((value) => value.toLowerCase());

export class OptionalEmailRecipientRepository implements OptionalEmailRecipientLookup {
  readonly #users: Collection<User>;
  readonly #oauthAccounts: Collection<OAuthAccount>;
  readonly #passwordAccounts: Collection<PasswordAccount>;

  constructor(accessor: MongoDbAccessor) {
    this.#users = accessor.getCollection<User>(MongoDbDatabase.Auth, AuthDbCollection.Users);
    this.#oauthAccounts = accessor.getCollection<OAuthAccount>(MongoDbDatabase.Auth, AuthDbCollection.OAuthAccounts);
    this.#passwordAccounts = accessor.getCollection<PasswordAccount>(
      MongoDbDatabase.Auth,
      AuthDbCollection.PasswordAccounts,
    );
  }

  async resolve(input: { userId: string }): Promise<OptionalEmailRecipientResolution> {
    if (!ObjectId.isValid(input.userId)) {
      return { status: "missing_user" };
    }
    const userId = new ObjectId(input.userId);
    if (!(await this.#users.findOne({ _id: userId }, { projection: { _id: 1 } }))) {
      return { status: "missing_user" };
    }

    const [passwordAccount, oauthAccounts] = await Promise.all([
      this.#passwordAccounts.findOne({ userId }, { projection: { email: 1 } }),
      this.#oauthAccounts.find({ userId }, { projection: { email: 1 } }).toArray(),
    ]);
    const values: unknown[] = [passwordAccount?.email, ...oauthAccounts.map((account) => account.email)].filter(
      (value) => value !== null && value !== undefined,
    );
    const parsed = values.map((value) => emailSchema.safeParse(value));
    if (parsed.some((result) => !result.success)) {
      return { status: "ambiguous_recipient" };
    }
    const unique = new Set(parsed.map((result) => (result.success ? result.data : "")));
    if (unique.size === 0) {
      return { status: "missing_recipient" };
    }
    if (unique.size !== 1) {
      return { status: "ambiguous_recipient" };
    }
    return { status: "unique", email: [...unique][0] as string };
  }
}
