// The mirror: what is stored, and how a sync decides what to re-read.
//
// Kept apart from the gatekeeper RPC surface so the sync can be driven directly in tests without
// standing up a session, and so the only code that writes to storage lives in one file. Nothing
// the session exposes reaches these writers -- that is what makes the gatekeeper read-only
// structurally rather than by convention.

import {
  GitHubError, GitHubSource, TreeBlob, headCommitSha, listBlobs, readBlobText,
} from "./github.js";

/** Upstream's own per-document ceiling (gatekeeper-context's MAX_DOCUMENT_BODY_BYTES). */
export const MAX_DOCUMENT_BODY_BYTES = 1_400_000;

/**
 * Extensions mirrored as text. An allowlist rather than a binary sniff: the Book directory also
 * carries mermaid.min.js (2.6 MB) and rendered assets, none of which are useful as agent context
 * and all of which would otherwise occupy the mirror.
 */
const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "txt", "toml", "yaml", "yml", "json", "csv",
]);

const DOC_PREFIX = "doc:";
const META_KEY = "meta";

/** One mirrored file. */
export interface BookDocument {
  /** Path relative to the mirrored directory, e.g. "src/edge.md". */
  path: string;
  /** Display name, derived from the file name. */
  name: string;
  /** First heading, when the file has one; otherwise the file name. */
  title: string;
  /** First prose paragraph, clamped. Empty when nothing suitable was found. */
  description: string;
  /** Blob sha this body came from. The whole basis of incremental sync. */
  blobSha: string;
  body: string;
}

/** Summary form, for listings that must not drag whole bodies through RPC. */
export type BookDocumentSummary = Omit<BookDocument, "body" | "blobSha">;

/** State of the mirror as a whole. */
export interface BookSyncStatus {
  /** Commit sha the mirror reflects, or null before the first successful sync. */
  commitSha: string | null;
  /** ISO timestamp of the last successful sync, or null. */
  syncedAt: string | null;
  documentCount: number;
  /** Failure text from the most recent attempt. Null once an attempt succeeds. */
  lastError: string | null;
}

/** What one sync attempt did, for logging and tests. */
export interface SyncOutcome {
  /** False when the branch head was unchanged and nothing was read. */
  changed: boolean;
  commitSha: string;
  documentCount: number;
  /** Blobs whose body was re-read. Zero on an unchanged head. */
  fetched: number;
  /** Paths dropped because they disappeared upstream. */
  removed: number;
  /** Paths skipped for size or extension, with the reason. */
  skipped: { path: string; reason: string }[];
}

function docKey(path: string): string {
  return DOC_PREFIX + path;
}

/** Whether a repository path is mirrored at all. */
export function isMirrorablePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * First ATX heading in a markdown body, ignoring fenced code so a `# comment` inside a shell block
 * cannot be mistaken for the document's title.
 */
export function extractTitle(body: string, fallback: string): string {
  let fenced = false;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^#{1,6}\s+(.*\S)\s*$/.exec(trimmed);
    if (heading) return heading[1];
  }
  return fallback;
}

/** First prose paragraph, skipping headings, fences, and front matter. Clamped to 300 chars. */
export function extractDescription(body: string): string {
  let fenced = false;
  let inFrontMatter = false;
  let seenFrontMatter = false;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (i === 0 && trimmed === "---") {
      inFrontMatter = true;
      seenFrontMatter = true;
      continue;
    }
    if (inFrontMatter) {
      if (trimmed === "---") inFrontMatter = false;
      continue;
    }
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || trimmed === "") continue;
    if (trimmed.startsWith("#")) continue;
    // Tables, lists and block quotes read poorly as a one-line summary.
    if (/^[-*+>|]/.test(trimmed)) continue;
    const text = trimmed.length > 300 ? `${trimmed.slice(0, 297)}...` : trimmed;
    return text;
  }
  return seenFrontMatter ? "" : "";
}

/** How well a token sits in a field: not present, inside a larger word, or standing alone. */
const enum MatchKind { None = 0, Partial = 1, Word = 2 }

/** Letters, digits and underscore. A match flanked by anything else is a whole-word match. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

function matchKind(haystack: string, token: string): MatchKind {
  let at = haystack.indexOf(token);
  if (at < 0) return MatchKind.None;
  while (at >= 0) {
    const before = at === 0 ? "" : haystack[at - 1];
    const after = haystack[at + token.length] ?? "";
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return MatchKind.Word;
    at = haystack.indexOf(token, at + 1);
  }
  return MatchKind.Partial;
}

function weigh(kind: MatchKind, whole: number, partial: number): number {
  return kind === MatchKind.Word ? whole : kind === MatchKind.Partial ? partial : 0;
}

/** Reader half of the mirror. Everything the session is allowed to touch. */
export class BookMirror {
  constructor(private readonly kv: SyncKvStorage) {}

  getStatus(): BookSyncStatus {
    return this.kv.get<BookSyncStatus>(META_KEY) ?? {
      commitSha: null,
      syncedAt: null,
      documentCount: 0,
      lastError: null,
    };
  }

  get(path: string): BookDocument | undefined {
    return this.kv.get<BookDocument>(docKey(path));
  }

  list(prefix?: string): BookDocumentSummary[] {
    const scan = prefix ? DOC_PREFIX + prefix : DOC_PREFIX;
    const summaries: BookDocumentSummary[] = [];
    for (const [, doc] of this.kv.list<BookDocument>({ prefix: scan })) {
      summaries.push({
        path: doc.path,
        name: doc.name,
        title: doc.title,
        description: doc.description,
      });
    }
    summaries.sort((a, b) => a.path.localeCompare(b.path));
    return summaries;
  }

  /**
   * Token scoring in the shape gatekeeper-context uses (title 10, description 5, body 1, with a
   * window around the first body hit), with one deliberate divergence: a match that lands inside a
   * larger word scores well below one that stands alone. Upstream compares with `includes()`, so
   * searching "edge" ranks a document titled "Ledger" above one titled "Edge routing" -- the
   * substring is in both, and the title weight is all that decides. Whole-word hits keep the full
   * weight; mid-word hits keep a small one, since a prefix is still worth surfacing.
   *
   * A linear pass is the right tool at this size: the Book is a few dozen files and well under a
   * megabyte, so an index would cost more to maintain than it saves.
   */
  search(query: string, limit = 20): {
    path: string; title: string; description: string; snippet?: string; score: number;
  }[] {
    const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return [];

    const results: {
      path: string; title: string; description: string; snippet?: string; score: number;
    }[] = [];

    for (const [, doc] of this.kv.list<BookDocument>({ prefix: DOC_PREFIX })) {
      let score = 0;
      let snippet: string | undefined;
      const titleLower = doc.title.toLowerCase();
      const descLower = doc.description.toLowerCase();
      const bodyLower = doc.body.toLowerCase();

      for (const token of tokens) {
        score += weigh(matchKind(titleLower, token), 10, 3);
        score += weigh(matchKind(descLower, token), 5, 2);

        const body = matchKind(bodyLower, token);
        if (body !== MatchKind.None) {
          score += weigh(body, 1, 0.5);
          if (!snippet) {
            const at = bodyLower.indexOf(token);
            const start = Math.max(0, at - 40);
            const end = Math.min(doc.body.length, at + token.length + 80);
            snippet = (start > 0 ? "..." : "") + doc.body.slice(start, end)
              + (end < doc.body.length ? "..." : "");
          }
        }
      }

      if (score > 0) {
        results.push({
          path: doc.path, title: doc.title, description: doc.description, snippet, score,
        });
      }
    }

    results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return results.slice(0, limit);
  }
}

function relativePath(source: GitHubSource, blob: TreeBlob): string {
  const prefix = `${source.path.replace(/\/+$/, "")}/`;
  return blob.path.slice(prefix.length);
}

/**
 * Pull the mirrored directory up to the branch head.
 *
 * Returns without reading anything when the head is unchanged, which is what makes a five-minute
 * cadence cheap: one request per tick in the common case.
 *
 * Writes are ordered so a failure part-way cannot present a half-empty mirror as authoritative --
 * documents land first, deletions and the new commit sha last. A throw leaves the previous
 * commit sha in place, so the next tick re-reads the same delta rather than believing it is
 * current.
 */
export async function syncMirror(
  kv: SyncKvStorage,
  source: GitHubSource,
): Promise<SyncOutcome> {
  const head = await headCommitSha(source);
  const mirror = new BookMirror(kv);
  const status = mirror.getStatus();

  if (status.commitSha === head && status.lastError === null) {
    return {
      changed: false,
      commitSha: head,
      documentCount: status.documentCount,
      fetched: 0,
      removed: 0,
      skipped: [],
    };
  }

  const blobs = await listBlobs(source, head);
  const skipped: SyncOutcome["skipped"] = [];
  const keep = new Set<string>();
  let fetched = 0;

  for (const blob of blobs) {
    const path = relativePath(source, blob);
    if (!isMirrorablePath(path)) {
      skipped.push({ path, reason: "not a mirrored text type" });
      continue;
    }
    if (blob.size > MAX_DOCUMENT_BODY_BYTES) {
      skipped.push({ path, reason: `${blob.size} bytes exceeds the document ceiling` });
      continue;
    }

    const key = docKey(path);
    keep.add(key);

    const existing = kv.get<BookDocument>(key);
    if (existing?.blobSha === blob.sha) continue;

    const body = await readBlobText(source, blob.sha);
    fetched++;
    const name = path.slice(path.lastIndexOf("/") + 1);
    kv.put<BookDocument>(key, {
      path,
      name,
      title: extractTitle(body, name),
      description: extractDescription(body),
      blobSha: blob.sha,
      body,
    });
  }

  let removed = 0;
  for (const [key] of [...kv.list<BookDocument>({ prefix: DOC_PREFIX })]) {
    if (!keep.has(key)) {
      kv.delete(key);
      removed++;
    }
  }

  kv.put<BookSyncStatus>(META_KEY, {
    commitSha: head,
    syncedAt: new Date().toISOString(),
    documentCount: keep.size,
    lastError: null,
  });

  return { changed: true, commitSha: head, documentCount: keep.size, fetched, removed, skipped };
}

/** Record a failed attempt without disturbing the documents the last good sync left behind. */
export function recordSyncFailure(kv: SyncKvStorage, error: unknown): void {
  const previous = new BookMirror(kv).getStatus();
  const message = error instanceof GitHubError
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error);
  kv.put<BookSyncStatus>(META_KEY, { ...previous, lastError: message });
}
