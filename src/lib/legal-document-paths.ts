const LEGAL_DOCUMENT_FILES = {
  privacy: "privacy.md",
  terms: "terms.md",
} as const;

export type LegalDocumentName = keyof typeof LEGAL_DOCUMENT_FILES;

export function getLegalDocumentUrl(moduleUrl: string, documentName: LegalDocumentName): URL {
  return new URL(`../assets/legal/${LEGAL_DOCUMENT_FILES[documentName]}`, moduleUrl);
}
