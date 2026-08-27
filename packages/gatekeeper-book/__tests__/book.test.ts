import { afterEach, describe, expect, test } from "vitest";
import type { GitHubSource } from "../src/github.js";
import {
  BookMirror, extractDescription, extractTitle, isMirrorablePath, recordSyncFailure, syncMirror,
} from "../src/mirror.js";

const SOURCE: GitHubSource = {
  owner: "acme", repo: "acme", branch: "main", path: "docs/book", token: "t",
};

/** In-memory stand-in for the Durable Object's synchronous KV. */
class FakeKv implements SyncKvStorage {
  readonly map = new Map<string, unknown>();

  get<T = unknown>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }

  list<T = unknown>(options?: SyncKvListOptions): Iterable<[string, T]> {
    let entries = [...this.map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (options?.prefix) entries = entries.filter(([k]) => k.startsWith(options.prefix!));
    return entries as [string, T][];
  }

  put<T>(key: string, value: T): void {
    this.map.set(key, value);
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }
}

type Blob = { path: string; sha: string; size?: number; body: string };

/** Serves the three GitHub endpoints the sync uses, counting requests per endpoint. */
function stubGitHub(head: string, blobs: Blob[]) {
  const calls = { commits: 0, trees: 0, blobs: 0 };
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

    if (url.includes("/commits/")) {
      calls.commits++;
      return json({ sha: head });
    }
    if (url.includes("/git/trees/")) {
      calls.trees++;
      return json({
        truncated: false,
        tree: blobs.map((b) => ({
          path: b.path, type: "blob", sha: b.sha, size: b.size ?? b.body.length,
        })),
      });
    }
    if (url.includes("/git/blobs/")) {
      calls.blobs++;
      const sha = url.slice(url.lastIndexOf("/") + 1);
      const blob = blobs.find((b) => b.sha === sha);
      return json({ content: btoa(blob?.body ?? ""), encoding: "base64" });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("path filtering", () => {
  test("mirrors text documents and rejects everything else", () => {
    expect(isMirrorablePath("src/edge.md")).toBe(true);
    expect(isMirrorablePath("book.toml")).toBe(true);
    // The Book directory carries a 2.6 MB minified bundle and rendered assets; neither is context.
    expect(isMirrorablePath("mermaid.min.js")).toBe(false);
    expect(isMirrorablePath("src/diagram.png")).toBe(false);
    expect(isMirrorablePath("LICENSE")).toBe(false);
  });
});

describe("metadata extraction", () => {
  test("takes the first heading as the title", () => {
    expect(extractTitle("# Edge\n\nSome prose.", "edge.md")).toBe("Edge");
  });

  test("ignores headings inside fenced code", () => {
    const body = "```sh\n# not a title\n```\n\n# Real Title\n";
    expect(extractTitle(body, "x.md")).toBe("Real Title");
  });

  test("falls back to the file name when there is no heading", () => {
    expect(extractTitle("just prose\n", "notes.md")).toBe("notes.md");
  });

  test("takes the first prose paragraph as the description", () => {
    expect(extractDescription("# Title\n\nThe summary line.\n\nMore.")).toBe("The summary line.");
  });

  test("skips front matter, lists and tables", () => {
    const body = "---\ntitle: x\n---\n\n# H\n\n- a list item\n\n| a | b |\n\nActual prose.";
    expect(extractDescription(body)).toBe("Actual prose.");
  });
});

describe("sync", () => {
  test("mirrors the tree and indexes documents", async () => {
    const stub = stubGitHub("c1", [
      { path: "docs/book/src/edge.md", sha: "b1", body: "# Edge\n\nHow the edge works." },
      { path: "docs/book/book.toml", sha: "b2", body: "title = \"Book\"" },
      { path: "docs/book/mermaid.min.js", sha: "b3", body: "console.log(1)" },
    ]);
    restore = stub.restore;
    const kv = new FakeKv();

    const outcome = await syncMirror(kv, SOURCE);

    expect(outcome.changed).toBe(true);
    expect(outcome.commitSha).toBe("c1");
    expect(outcome.documentCount).toBe(2);
    expect(outcome.fetched).toBe(2);
    expect(outcome.skipped).toEqual([
      { path: "mermaid.min.js", reason: "not a mirrored text type" },
    ]);

    const mirror = new BookMirror(kv);
    expect(mirror.list().map((d) => d.path)).toEqual(["book.toml", "src/edge.md"]);
    expect(mirror.get("src/edge.md")?.title).toBe("Edge");
    expect(mirror.getStatus().commitSha).toBe("c1");
  });

  test("an unchanged head costs one request and reads no blobs", async () => {
    const blobs = [{ path: "docs/book/src/edge.md", sha: "b1", body: "# Edge\n" }];
    const first = stubGitHub("c1", blobs);
    restore = first.restore;
    const kv = new FakeKv();
    await syncMirror(kv, SOURCE);
    first.restore();

    const second = stubGitHub("c1", blobs);
    restore = second.restore;
    const outcome = await syncMirror(kv, SOURCE);

    expect(outcome.changed).toBe(false);
    expect(second.calls.commits).toBe(1);
    // The whole point of the sha comparison: no tree walk, no blob reads.
    expect(second.calls.trees).toBe(0);
    expect(second.calls.blobs).toBe(0);
  });

  test("re-reads only blobs whose sha moved", async () => {
    const before = stubGitHub("c1", [
      { path: "docs/book/a.md", sha: "b1", body: "# A\n" },
      { path: "docs/book/b.md", sha: "b2", body: "# B\n" },
    ]);
    restore = before.restore;
    const kv = new FakeKv();
    await syncMirror(kv, SOURCE);
    before.restore();

    const after = stubGitHub("c2", [
      { path: "docs/book/a.md", sha: "b1", body: "# A\n" },
      { path: "docs/book/b.md", sha: "b2-new", body: "# B changed\n" },
    ]);
    restore = after.restore;
    const outcome = await syncMirror(kv, SOURCE);

    expect(outcome.fetched).toBe(1);
    expect(new BookMirror(kv).get("b.md")?.title).toBe("B changed");
  });

  test("drops documents that disappeared upstream", async () => {
    const before = stubGitHub("c1", [
      { path: "docs/book/a.md", sha: "b1", body: "# A\n" },
      { path: "docs/book/gone.md", sha: "b2", body: "# Gone\n" },
    ]);
    restore = before.restore;
    const kv = new FakeKv();
    await syncMirror(kv, SOURCE);
    before.restore();

    const after = stubGitHub("c2", [{ path: "docs/book/a.md", sha: "b1", body: "# A\n" }]);
    restore = after.restore;
    const outcome = await syncMirror(kv, SOURCE);

    expect(outcome.removed).toBe(1);
    expect(new BookMirror(kv).get("gone.md")).toBeUndefined();
    expect(new BookMirror(kv).list().map((d) => d.path)).toEqual(["a.md"]);
  });

  test("skips a blob past the document ceiling without failing the sync", async () => {
    const stub = stubGitHub("c1", [
      { path: "docs/book/huge.md", sha: "b1", size: 2_000_000, body: "x" },
      { path: "docs/book/ok.md", sha: "b2", body: "# Ok\n" },
    ]);
    restore = stub.restore;
    const kv = new FakeKv();

    const outcome = await syncMirror(kv, SOURCE);

    expect(outcome.documentCount).toBe(1);
    expect(outcome.skipped[0].path).toBe("huge.md");
    expect(new BookMirror(kv).get("huge.md")).toBeUndefined();
  });

  test("a failed attempt leaves the previous documents readable", async () => {
    const ok = stubGitHub("c1", [{ path: "docs/book/a.md", sha: "b1", body: "# A\n" }]);
    restore = ok.restore;
    const kv = new FakeKv();
    await syncMirror(kv, SOURCE);
    ok.restore();

    recordSyncFailure(kv, new Error("GitHub responded 403"));

    const mirror = new BookMirror(kv);
    expect(mirror.get("a.md")?.title).toBe("A");
    expect(mirror.getStatus().documentCount).toBe(1);
    expect(mirror.getStatus().lastError).toBe("GitHub responded 403");
    // The commit sha survives, so the next tick still knows where the mirror stood.
    expect(mirror.getStatus().commitSha).toBe("c1");
  });

  test("retries the delta after a failure even when the head has not moved", async () => {
    const blobs = [{ path: "docs/book/a.md", sha: "b1", body: "# A\n" }];
    const first = stubGitHub("c1", blobs);
    restore = first.restore;
    const kv = new FakeKv();
    await syncMirror(kv, SOURCE);
    first.restore();
    recordSyncFailure(kv, new Error("transient"));

    const retry = stubGitHub("c1", blobs);
    restore = retry.restore;
    const outcome = await syncMirror(kv, SOURCE);

    // lastError set means the mirror is not trusted as current, so the tree is walked again.
    expect(outcome.changed).toBe(true);
    expect(retry.calls.trees).toBe(1);
    expect(new BookMirror(kv).getStatus().lastError).toBeNull();
  });
});

describe("search", () => {
  async function seeded() {
    const stub = stubGitHub("c1", [
      { path: "docs/book/edge.md", sha: "b1", body: "# Edge routing\n\nHow requests reach us." },
      { path: "docs/book/ledger.md", sha: "b2", body: "# Ledger\n\nDouble entry. Mentions edge." },
    ]);
    restore = stub.restore;
    const kv = new FakeKv();
    await syncMirror(kv, SOURCE);
    return new BookMirror(kv);
  }

  test("ranks title matches above body matches", async () => {
    const hits = (await seeded()).search("edge");
    expect(hits.map((h) => h.path)).toEqual(["edge.md", "ledger.md"]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  test("returns a snippet around a body match", async () => {
    const hits = (await seeded()).search("double");
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain("Double entry");
  });

  test("an empty query matches nothing", async () => {
    expect((await seeded()).search("   ")).toEqual([]);
  });
});
