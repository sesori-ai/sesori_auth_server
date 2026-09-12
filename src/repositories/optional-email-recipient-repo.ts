import { Collection, ObjectId } from "mongodb";
import type { MongoDbAccessor } from "../db/mongo-db-accessor.js";
import { normalizeOptionalEmailAddress } from "../lib/optional-email-address-key.js";
import type { OAuthAccount, PasswordAccount } from "../models/documents.js";
import { AUTH_PROVIDER_EMAIL, OAuthProviderName } from "../types/oauth.js";
import {
  OptionalEmailRecipientAccountKind,
  OptionalEmailRecipientField,
  type OptionalEmailRecipientResolution,
  OptionalEmailRecipientResolutionStatus,
} from "../types/optional-email.js";
import { AuthDbCollection, MongoDbDatabase } from "../types/mongo.js";

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

    const normalizedCandidates = [];
    for (const candidate of candidates) {
      const address = normalizeOptionalEmailAddress({ address: candidate.value });
      if (address === null) {
        return { status: OptionalEmailRecipientResolutionStatus.Ambiguous };
      }

      normalizedCandidates.push({ address, provenance: candidate.provenance });
    }

    const addresses = new Set(normalizedCandidates.map((candidate) => candidate.address));
    if (addresses.size !== 1) {
      return { status: OptionalEmailRecipientResolutionStatus.Ambiguous };
    }

    const [address] = addresses;

    return {
      status: OptionalEmailRecipientResolutionStatus.Resolved,
      address,
      provenance: normalizedCandidates
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
