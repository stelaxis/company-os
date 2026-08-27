// Minimal GitHub REST client for mirroring one directory of one branch.
//
// Deliberately not isomorphic-git, which is what gatekeeper-context uses. That gatekeeper clones
// because an Artifacts repository is small and purpose-built for it; the repository behind the Book
// is a 1,196-commit monorepo whose .git is 86 MB, over the 64 MB packed ceiling
// (MAX_GIT_DIR_BYTES) that upstream's clone path works under. Even `depth: 1, singleBranch` would
// transfer the whole 21.7 MB HEAD tree to reach ~250 KB of markdown.
//
// The Trees API inverts that. Every blob arrives with its own sha, so an unchanged branch head
// costs exactly one request, and a changed one re-reads only the blobs whose sha moved.

/** Everything needed to address one directory of one branch. */
export interface GitHubSource {
  owner: string;
  repo: string;
  branch: string;
  /** Directory prefix to mirror, without a trailing slash (e.g. "docs/book"). */
  path: string;
  /** Fine-grained token with Contents: Read. Never logged. */
  token: string;
}

/** One blob under {@link GitHubSource.path}. */
export interface TreeBlob {
  /** Repository-relative path, e.g. "docs/book/src/edge.md". */
  path: string;
  /** Blob sha. The only thing compared to decide whether a re-read is needed. */
  sha: string;
  /** Blob size in bytes as GitHub reports it, before any decoding. */
  size: number;
}

/**
 * Raised for any non-2xx GitHub response. Carries the status so callers can tell a rate limit or a
 * revoked token (which should keep the last good mirror) from a 404 (which usually means the branch
 * or path moved and is worth surfacing).
 */
export class GitHubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

const API = "https://api.github.com";

async function githubJson<T>(source: GitHubSource, url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${source.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      // GitHub rejects requests with no User-Agent.
      "user-agent": "cloudflare-os-gatekeeper-book",
    },
  });
  if (!response.ok) {
    // The body can carry a token in an error echo, and the remaining-quota header is the only
    // detail worth keeping, so the message is assembled rather than passed through.
    const remaining = response.headers.get("x-ratelimit-remaining");
    const detail = remaining === "0"
      ? " (rate limit exhausted)"
      : "";
    throw new GitHubError(
      response.status,
      `GitHub responded ${response.status} for ${new URL(url).pathname}${detail}.`,
    );
  }
  return await response.json() as T;
}

/** Current commit sha at the branch head. One small request; the whole steady-state poll. */
export async function headCommitSha(source: GitHubSource): Promise<string> {
  const { owner, repo, branch } = source;
  const commit = await githubJson<{ sha?: string }>(
    source,
    `${API}/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
  );
  if (!commit.sha) {
    throw new GitHubError(200, `GitHub returned no commit sha for ${owner}/${repo}@${branch}.`);
  }
  return commit.sha;
}

/**
 * Every blob under {@link GitHubSource.path} at `commitSha`.
 *
 * `recursive=1` walks the whole tree, so the response covers the repository rather than just the
 * mirrored directory; filtering happens here rather than in the request because the API has no
 * path-scoped recursive form. GitHub truncates trees past its own internal limit and says so in
 * `truncated`, which is treated as an error: a silently short tree would read as "these files were
 * deleted" and empty the mirror.
 */
export async function listBlobs(source: GitHubSource, commitSha: string): Promise<TreeBlob[]> {
  const { owner, repo } = source;
  const tree = await githubJson<{
    truncated?: boolean;
    tree?: { path?: string; type?: string; sha?: string; size?: number }[];
  }>(source, `${API}/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`);

  if (tree.truncated) {
    throw new GitHubError(200, `GitHub truncated the tree for ${owner}/${repo}@${commitSha}.`);
  }

  const prefix = `${source.path.replace(/\/+$/, "")}/`;
  const blobs: TreeBlob[] = [];
  for (const entry of tree.tree ?? []) {
    if (entry.type !== "blob" || !entry.path || !entry.sha) continue;
    if (!entry.path.startsWith(prefix)) continue;
    blobs.push({ path: entry.path, sha: entry.sha, size: entry.size ?? 0 });
  }
  return blobs;
}

/**
 * One blob's bytes, decoded as UTF-8.
 *
 * The Blobs API answers base64 for anything it will not inline, so the encoding is checked rather
 * than assumed; a future `encoding` value this does not understand is an error instead of silently
 * mirrored garbage.
 */
export async function readBlobText(source: GitHubSource, blobSha: string): Promise<string> {
  const { owner, repo } = source;
  const blob = await githubJson<{ content?: string; encoding?: string }>(
    source,
    `${API}/repos/${owner}/${repo}/git/blobs/${blobSha}`,
  );
  if (blob.encoding === "utf-8") return blob.content ?? "";
  if (blob.encoding !== "base64") {
    throw new GitHubError(200, `Unsupported blob encoding "${blob.encoding}" for ${blobSha}.`);
  }
  const binary = atob((blob.content ?? "").replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
