import { Collection, ObjectId } from "mongodb";
import { z } from "zod";
import type { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import type { OAuthAccount, PasswordAccount, User } from "../models/documents.js";
import { type OptionalEmailRecipientResolution, OptionalEmailRecipientStatus } from "../types/optional-email.js";
import { AuthDbCollection, MongoDbDatabase } from "../types/mongo.js";

const normalizedEmailSchema = z
  .string()
  .trim()
  .email()
  .transform((value) => value.toLowerCase());

export class OptionalEmailRecipientRepository {
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
      return { status: OptionalEmailRecipientStatus.MissingUser };
    }

    const userId = new ObjectId(input.userId);
    const user = await this.#users.findOne({ _id: userId }, { projection: { _id: 1 } });
    if (!user) {
      return { status: OptionalEmailRecipientStatus.MissingUser };
    }

    const [passwordAccount, oauthAccounts] = await Promise.all([
      this.#passwordAccounts.findOne({ userId }, { projection: { email: 1 } }),
      this.#oauthAccounts.find({ userId }, { projection: { email: 1 } }).toArray(),
    ]);
    const addresses = [passwordAccount?.email, ...oauthAccounts.map((account) => account.email)].filter(
      (value): value is string => value !== null && value !== undefined,
    );
    const parsed = addresses.map((value) => normalizedEmailSchema.safeParse(value));
    if (parsed.some((result) => !result.success)) {
      return { status: OptionalEmailRecipientStatus.AmbiguousRecipient };
    }

    const unique = new Set(parsed.map((result) => (result.success ? result.data : "")));
    if (unique.size === 0) {
      return { status: OptionalEmailRecipientStatus.MissingRecipient };
    }

    if (unique.size !== 1) {
      return { status: OptionalEmailRecipientStatus.AmbiguousRecipient };
    }

    return { status: OptionalEmailRecipientStatus.Unique, email: [...unique][0] as string };
  }
}
