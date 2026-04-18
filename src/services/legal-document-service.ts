export class LegalDocumentService {
  readonly #termsText: string;
  readonly #privacyText: string;

  constructor(termsText: string, privacyText: string) {
    this.#termsText = termsText;
    this.#privacyText = privacyText;
  }

  getTerms(): string {
    return this.#termsText;
  }

  getPrivacy(): string {
    return this.#privacyText;
  }
}
