import { describe, expect, test } from "vitest";
import { BookAdminApiImpl, BookSessionImpl } from "../src/book.js";
import type { SyncOutcome } from "../src/mirror.js";

type StubBehaviour = {
  sync?: () => Promise<SyncOutcome | { busy: true }>;
  documents?: { path: string; name: string; title: string; description: string }[];
};

/** Stands in for the Durable Object stub, recording whether sync() was ever reached. */
function fakeBook(behaviour: StubBehaviour = {}) {
  const calls = { sync: 0, getStatus: 0, listDocuments: 0 };
  const stub = {
    async sync() {
      calls.sync++;
      return behaviour.sync
        ? await behaviour.sync()
        : {
            changed: true, commitSha: "c1", documentCount: 1,
            fetched: 1, removed: 0, skipped: [],
          } satisfies SyncOutcome;
    },
    async getStatus() {
      calls.getStatus++;
      return { commitSha: "c1", syncedAt: "2026-08-27T00:00:00.000Z", documentCount: 1, lastError: null };
    },
    async listDocuments() {
      calls.listDocuments++;
      return behaviour.documents ?? [];
    },
  };
  return { stub, calls };
}

const ENV = {
  BOOK_DISPLAY_NAME: "Acme Book",
  BOOK_REPO_OWNER: "acme",
  BOOK_REPO_NAME: "acme",
  BOOK_REPO_BRANCH: "main",
  BOOK_REPO_PATH: "docs/book",
} as unknown as Cloudflare.Env;

function api(isAdmin: boolean, behaviour: StubBehaviour = {}) {
  const { stub, calls } = fakeBook(behaviour);
  return { api: new BookAdminApiImpl(stub as never, ENV, isAdmin), calls };
}

describe("viewer info", () => {
  test("reports the repository coordinates for display", async () => {
    const info = await api(false).api.getViewerInfo();
    expect(info.source).toEqual({
      owner: "acme", repo: "acme", branch: "main", path: "docs/book",
    });
  });

  test("only administrators are offered a refresh", async () => {
    expect((await api(true).api.getViewerInfo()).canRefresh).toBe(true);
    expect((await api(false).api.getViewerInfo()).canRefresh).toBe(false);
  });
});

describe("refresh authorization", () => {
  test("a non-administrator is refused and never reaches the Durable Object", async () => {
    const { api: subject, calls } = api(false);
    const result = await subject.refresh();

    expect(result).toEqual({
      outcome: "failed",
      error: "Only administrators can refresh the book.",
    });
    // The point of the test: hiding the button is not the boundary, the capability is.
    expect(calls.sync).toBe(0);
  });

  test("an administrator reaches it", async () => {
    const { api: subject, calls } = api(true);
    await subject.refresh();
    expect(calls.sync).toBe(1);
  });
});

describe("refresh outcomes", () => {
  test("reports an updated mirror", async () => {
    const { api: subject } = api(true, {
      sync: async () => ({
        changed: true, commitSha: "abc123", documentCount: 39,
        fetched: 4, removed: 1, skipped: [],
      }),
    });
    expect(await subject.refresh()).toEqual({
      outcome: "updated", commitSha: "abc123", documentCount: 39, fetched: 4, removed: 1,
    });
  });

  test("reports an unchanged head", async () => {
    const { api: subject } = api(true, {
      sync: async () => ({
        changed: false, commitSha: "abc123", documentCount: 39,
        fetched: 0, removed: 0, skipped: [],
      }),
    });
    expect(await subject.refresh()).toEqual({
      outcome: "unchanged", commitSha: "abc123", documentCount: 39,
    });
  });

  test("reports a concurrent refresh rather than queueing behind it", async () => {
    const { api: subject } = api(true, { sync: async () => ({ busy: true }) });
    expect(await subject.refresh()).toEqual({ outcome: "busy" });
  });

  test("turns a thrown sync into a displayable failure instead of breaking the app", async () => {
    const { api: subject } = api(true, {
      sync: async () => { throw new Error("GitHub responded 403 (rate limit exhausted)."); },
    });
    expect(await subject.refresh()).toEqual({
      outcome: "failed", error: "GitHub responded 403 (rate limit exhausted).",
    });
  });
});

// Regression: the session used to read `this.ctx.storage` on the gatekeeper, but the Workshop
// instantiates the gatekeeper as a per-workspace facet of the Overseer DO, so that storage is
// never the one the cron syncs. Symptom was `env.BOOK.getStatus()` answering nulls while the
// management app showed a full mirror. These assert every read leaves for the store.
describe("session reads resolve through the mirror store", () => {
  const approvals: { title: string }[] = [];
  const queue = {
    async authorizeObservation(o: { title: string }) { approvals.push(o); },
  };

  function session(behaviour: Record<string, unknown> = {}) {
    approvals.length = 0;
    const calls: string[] = [];
    const store = {
      async listDocuments(prefix?: string) {
        calls.push(`listDocuments:${prefix ?? ""}`);
        return behaviour.documents ?? [];
      },
      async readDocument(path: string) {
        calls.push(`readDocument:${path}`);
        return behaviour.doc ?? null;
      },
      async searchDocuments(query: string) {
        calls.push(`searchDocuments:${query}`);
        return behaviour.hits ?? [];
      },
      async getStatus() {
        calls.push("getStatus");
        return { commitSha: "c1", syncedAt: null, documentCount: 39, lastError: null };
      },
    };
    return { subject: new BookSessionImpl(queue, store as never, "Acme Book"), calls };
  }

  test("listDocuments delegates and records an observation", async () => {
    const { subject, calls } = session({ documents: [{ path: "a.md", name: "a.md", title: "A", description: "" }] });
    const out = await subject.listDocuments("src");
    expect(calls).toEqual(["listDocuments:src"]);
    expect(out).toHaveLength(1);
    expect(approvals[0].title).toBe("List documents in Acme Book");
  });

  test("readDocument delegates", async () => {
    const doc = { path: "a.md", name: "a.md", title: "A", description: "", body: "hello" };
    const { subject, calls } = session({ doc });
    expect(await subject.readDocument("a.md")).toEqual(doc);
    expect(calls).toEqual(["readDocument:a.md"]);
  });

  test("search delegates", async () => {
    const { subject, calls } = session({ hits: [] });
    await subject.search("ledger");
    expect(calls).toEqual(["searchDocuments:ledger"]);
  });

  test("getStatus delegates and records no observation", async () => {
    const { subject, calls } = session();
    expect((await subject.getStatus()).documentCount).toBe(39);
    expect(calls).toEqual(["getStatus"]);
    // Freshness is not document content, so it is not an observation.
    expect(approvals).toHaveLength(0);
  });
});
