type LegalDocumentServiceArgs = {
  termsText: string;
  privacyText: string;
  cookiesText: string;
};

export class LegalDocumentService {
  readonly #termsText: string;
  readonly #privacyText: string;
  readonly #cookiesText: string;

  constructor(args: LegalDocumentServiceArgs) {
    this.#termsText = args.termsText;
    this.#privacyText = args.privacyText;
    this.#cookiesText = args.cookiesText;
  }

  getTerms(): string {
    return this.#termsText;
  }

  getPrivacy(): string {
    return this.#privacyText;
  }

  getCookies(): string {
    return this.#cookiesText;
  }
}
