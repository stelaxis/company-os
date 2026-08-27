const TYPES_CODE = `/** One document in the Book, without its body. */
export interface BookDocumentSummary {
  /** Path within the Book, e.g. "src/edge.md". */
  path: string;
  /** File name. */
  name: string;
  /** First heading in the document, or the file name when it has none. */
  title: string;
  /** First prose paragraph, clamped. Empty when the document has no prose. */
  description: string;
}

/** One document in the Book, with its body. */
export interface BookDocumentContent extends BookDocumentSummary {
  body: string;
}

/** One search result. */
export interface BookSearchHit {
  path: string;
  title: string;
  description: string;
  /** Text around the first body match, when the match was in the body. */
  snippet?: string;
  /** Higher is a better match. Title hits outweigh description hits, which outweigh body hits. */
  score: number;
}

/** Freshness of the mirror. */
export interface BookStatus {
  /** Commit the mirror reflects, or null before the first successful sync. */
  commitSha: string | null;
  /** ISO timestamp of the last successful sync, or null. */
  syncedAt: string | null;
  documentCount: number;
  /** Why the most recent attempt failed, when it did. Documents remain readable regardless. */
  lastError: string | null;
}

/**
 * Read-only access to the organization's Book, mirrored from Git.
 *
 * The mirror refreshes on its own schedule; nothing here writes to it or to the repository behind
 * it. Every call records an observation before returning content.
 */
export interface BookSession {
  /** Documents in the Book, optionally limited to those under a path prefix. */
  listDocuments(prefix?: string): Promise<BookDocumentSummary[]>;
  /** One document with its body, or null when the path is not in the Book. */
  readDocument(path: string): Promise<BookDocumentContent | null>;
  /** Documents matching every-token scoring, best first. */
  search(query: string, limit?: number): Promise<BookSearchHit[]>;
  /** How current the mirror is. Records no observation: it exposes no document content. */
  getStatus(): Promise<BookStatus>;
}
`;

export default TYPES_CODE;
