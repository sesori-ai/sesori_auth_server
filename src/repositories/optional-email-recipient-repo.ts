import { Collection, ObjectId } from "mongodb";
import { z } from "zod";
import type { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import type { OAuthAccount, PasswordAccount } from "../models/documents.js";
import { AUTH_PROVIDER_EMAIL, OAuthProviderName } from "../types/oauth.js";
import {
  OptionalEmailRecipientAccountKind,
  OptionalEmailRecipientField,
  type OptionalEmailRecipientResolution,
  OptionalEmailRecipientResolutionStatus,
} from "../types/optional-email.js";
import { AuthDbCollection, MongoDbDatabase } from "../types/mongo.js";

const normalizedEmailSchema = z
  .string()
  .trim()
  .email()
  .transform((value) => value.toLowerCase());

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }
  return 0;
}

/**
 * Resolves only persisted identity fields linked to one user. `Resolved` means
 * syntactically valid and unambiguous within that user; it does not establish
 * verification, deliverability, permission, eligibility, or cross-user
 * uniqueness.
 */
export class OptionalEmailRecipientRepository {
  readonly #oauthAccounts: Collection<OAuthAccount>;
  readonly #passwordAccounts: Collection<PasswordAccount>;

  constructor(accessor: MongoDbAccessor) {
    this.#oauthAccounts = accessor.getCollection<OAuthAccount>(MongoDbDatabase.Auth, AuthDbCollection.OAuthAccounts);
    this.#passwordAccounts = accessor.getCollection<PasswordAccount>(
      MongoDbDatabase.Auth,
      AuthDbCollection.PasswordAccounts,
    );
  }

  async resolve(input: { userId: string }): Promise<OptionalEmailRecipientResolution> {
    if (!ObjectId.isValid(input.userId)) {
      return { status: OptionalEmailRecipientResolutionStatus.Missing };
    }

    const userId = new ObjectId(input.userId);
    const [oauthAccounts, passwordAccounts] = await Promise.all([
      this.#oauthAccounts.find({ userId }, { projection: { provider: 1, providerUsername: 1, email: 1 } }).toArray(),
      this.#passwordAccounts.find({ userId }, { projection: { email: 1 } }).toArray(),
    ]);
    if (passwordAccounts.length > 1) {
      return { status: OptionalEmailRecipientResolutionStatus.Ambiguous };
    }

    if (oauthAccounts.some((account) => typeof account.provider !== "string" || account.provider.trim().length === 0)) {
      return { status: OptionalEmailRecipientResolutionStatus.Ambiguous };
    }

    const candidates = [
      ...oauthAccounts.flatMap((account) => {
        const accountCandidates = [];
        if (account.email !== null && account.email !== undefined) {
          accountCandidates.push({
            value: account.email,
            provenance: {
              accountKind: OptionalEmailRecipientAccountKind.OAuth,
              provider: account.provider,
              field: OptionalEmailRecipientField.Email,
            },
          });
        }

        // Both released Apple auth paths map the authenticated token's email
        // claim into providerUsername, and upsert retains it when later tokens
        // omit email. No other providerUsername field has an address-bearing
        // contract.
        if (
          account.provider === OAuthProviderName.Apple &&
          account.providerUsername !== null &&
          account.providerUsername !== undefined
        ) {
          accountCandidates.push({
            value: account.providerUsername,
            provenance: {
              accountKind: OptionalEmailRecipientAccountKind.OAuth,
              provider: account.provider,
              field: OptionalEmailRecipientField.LegacyAppleProviderUsername,
            },
          });
        }

        return accountCandidates;
      }),
      ...passwordAccounts.map((account) => ({
        value: account.email,
        provenance: {
          accountKind: OptionalEmailRecipientAccountKind.Password,
          provider: AUTH_PROVIDER_EMAIL,
          field: OptionalEmailRecipientField.Email,
        },
      })),
    ];
    if (candidates.length === 0) {
      return { status: OptionalEmailRecipientResolutionStatus.Missing };
    }

    const parsed = candidates.map((candidate) => ({
      result: normalizedEmailSchema.safeParse(candidate.value),
      provenance: candidate.provenance,
    }));
    if (parsed.some((candidate) => !candidate.result.success)) {
      return { status: OptionalEmailRecipientResolutionStatus.Ambiguous };
    }

    const addresses = new Set(parsed.map((candidate) => (candidate.result.success ? candidate.result.data : "")));
    if (addresses.size !== 1) {
      return { status: OptionalEmailRecipientResolutionStatus.Ambiguous };
    }

    return {
      status: OptionalEmailRecipientResolutionStatus.Resolved,
      address: [...addresses][0] as string,
      provenance: parsed
        .map((candidate) => candidate.provenance)
        .sort(
          (left, right) =>
            compareStrings(left.accountKind, right.accountKind) ||
            compareStrings(left.provider, right.provider) ||
            compareStrings(left.field, right.field),
        ),
    };
  }
}
