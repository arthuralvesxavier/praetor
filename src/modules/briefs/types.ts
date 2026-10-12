/** Client-safe types of the briefs module (no server imports). */

/** Text of the page a citation points to (citation viewer). */
export type BriefCitationPage = {
  ref: string;
  documentId: string;
  versionId: string;
  title: string;
  versionNumber: number;
  page: number | null;
  pageCount: number | null;
  /** UNTRUSTED content: render as plain text. */
  text: string;
  truncated: boolean;
};
