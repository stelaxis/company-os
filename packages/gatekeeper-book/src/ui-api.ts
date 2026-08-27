// The capability the management UI talks to, kept apart from `types.d.ts`.
//
// `types.d.ts` is the *agent*-facing surface: it is mirrored verbatim into `types-code.ts` and
// handed to the model as the shape of its `BOOK` binding. Nothing here belongs in that mirror. The
// separation is what keeps the read-only guarantee legible: an agent session reaches `BookSession`
// and cannot name `refresh()`, while a signed-in user reaching this app can.

import type { BookDocumentSummary, BookStatus } from "./types.js";

/** What one manual refresh did. Mirrors SyncOutcome, flattened for display. */
export type RefreshResult =
  | { outcome: "updated"; commitSha: string; documentCount: number; fetched: number; removed: number }
  | { outcome: "unchanged"; commitSha: string; documentCount: number }
  | { outcome: "busy" }
  | { outcome: "failed"; error: string };

/** Who is looking, and therefore what the app may offer them. */
export interface BookViewerInfo {
  /** Whether this viewer may trigger a refresh. Administrators only. */
  canRefresh: boolean;
  /** Repository coordinates, for display. */
  source: { owner: string; repo: string; branch: string; path: string };
}

/** The management app's capability. Reached only through `startAppUi`, never from a session. */
export interface BookAdminApi {
  getViewerInfo(): Promise<BookViewerInfo>;
  getStatus(): Promise<BookStatus>;
  listDocuments(): Promise<BookDocumentSummary[]>;
  /**
   * Pull the mirror up to the branch head now, rather than waiting for the next cron tick.
   * Rejected for non-administrators; the check is here, not only in the UI that hides the button.
   */
  refresh(): Promise<RefreshResult>;
}
