import {
  DurableObject,
  RpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { GitHubSource } from "./github.js";
import {
  BookMirror, SyncOutcome, recordSyncFailure, syncMirror,
} from "./mirror.js";
import type {
  BookDocumentContent, BookDocumentSummary, BookSearchHit, BookSession, BookStatus,
} from "./types.js";
import type {
  AppUiContext, GatekeeperUiFrame,
} from "@gadgets/workshop-shared/gatekeeper";
import type { BookAdminApi, BookViewerInfo, RefreshResult } from "./ui-api.js";
import { BOOK_SINGLETON } from "./constants.js";
import TYPES_CODE from "./types-code.js";
import APP_HTML from "./generated/app.txt";

const BOOK_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' stroke='currentColor' stroke-width='20'><path d='M32 48h72a32 32 0 0 1 24 12 32 32 0 0 1 24-12h72v148h-72a32 32 0 0 0-24 12 32 32 0 0 0-24-12H32z'/><path d='M128 60v148'/></svg>",
    ),
};

type ObservationQueue = Pick<ApprovalQueue, "authorizeObservation"> &
  Partial<{ [Symbol.dispose](): void }>;

/** Reads the repository coordinates from the environment, failing loudly on a missing secret. */
export function sourceFromEnv(env: Cloudflare.Env): GitHubSource {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not set. Install it with `wrangler secret put GITHUB_TOKEN --name " +
      "<book worker name>`; the Book cannot be mirrored from a private repository without it.",
    );
  }
  return {
    owner: env.BOOK_REPO_OWNER,
    repo: env.BOOK_REPO_NAME,
    branch: env.BOOK_REPO_BRANCH,
    path: env.BOOK_REPO_PATH,
    token,
  };
}

export function describeBookVendor(env: Cloudflare.Env): VendorDescription {
  return {
    displayName: env.BOOK_DISPLAY_NAME,
    url: `https://github.com/${env.BOOK_REPO_OWNER}/${env.BOOK_REPO_NAME}`,
    logo: BOOK_ICON,
    color: "#f3efe6",
    tagline: "The organization's engineering handbook",
    description:
      `Read-only access to ${env.BOOK_DISPLAY_NAME}, mirrored from ` +
      `${env.BOOK_REPO_PATH} and refreshed on a schedule.`,
    autoProvisionsAccount: true,
    providesAuth: false,
  };
}

export function describeBookAccount(env: Cloudflare.Env): AccountDescription {
  return {
    displayName: env.BOOK_DISPLAY_NAME,
    avatar: BOOK_ICON,
    singleton: { tsType: "BookSession" },
    providesUi: { title: env.BOOK_DISPLAY_NAME, icon: BOOK_ICON },
  };
}

/**
 * The agent-facing capability. Holds a reader over the mirror and nothing that can write to it, so
 * no sequence of session calls can alter the mirror or reach the repository behind it.
 */
@validateRpc()
export class BookSessionImpl extends RpcTarget implements BookSession {
  readonly #approvalQueue: ObservationQueue;
  /**
   * The mirror-holding singleton, reached by name.
   *
   * Not this object's own storage: the Workshop instantiates the session class as a facet of each
   * workspace's Overseer DO (see overseer.ts getGatekeeperFacet), so `ctx.storage` here belongs to
   * a per-workspace instance that the cron never writes to and that would answer every read empty.
   */
  readonly #mirror: DurableObjectStub<BookMirrorStore>;
  readonly #bookName: string;

  constructor(
    approvalQueue: ObservationQueue,
    mirror: DurableObjectStub<BookMirrorStore>,
    bookName: string,
  ) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#mirror = mirror;
    this.#bookName = bookName;
  }

  async listDocuments(prefix?: string): Promise<BookDocumentSummary[]> {
    // Read first, then authorize: the description names the actual count, which is more useful to
    // a reviewer than the request would have been. Nothing is returned before authorization.
    const summaries = await this.#mirror.listDocuments(prefix);
    await this.#approvalQueue.authorizeObservation({
      title: `List documents in ${this.#bookName}`,
      description: prefix
        ? `Read the titles of ${summaries.length} document(s) under "${prefix}".`
        : `Read the titles of all ${summaries.length} document(s) in the book.`,
    });
    return summaries;
  }

  async readDocument(path: string): Promise<BookDocumentContent | null> {
    const doc = await this.#mirror.readDocument(path);
    await this.#approvalQueue.authorizeObservation({
      title: `Read "${path}" from ${this.#bookName}`,
      description: doc
        ? `Read the full text of "${doc.title}" (${doc.body.length} characters).`
        : `Attempt to read "${path}", which is not in the book.`,
    });
    if (!doc) return null;
    return {
      path: doc.path,
      name: doc.name,
      title: doc.title,
      description: doc.description,
      body: doc.body,
    };
  }

  async search(query: string, limit?: number): Promise<BookSearchHit[]> {
    const hits = await this.#mirror.searchDocuments(query, limit);
    await this.#approvalQueue.authorizeObservation({
      title: `Search ${this.#bookName}`,
      description:
        `Search for "${query}" and read ${hits.length} matching excerpt(s).`,
    });
    return hits;
  }

  async getStatus(): Promise<BookStatus> {
    // No observation: this exposes how fresh the mirror is, never document content.
    return await this.#mirror.getStatus();
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]?.();
  }
}

/**
 * The mirror itself: one Durable Object per deployment, named {@link BOOK_SINGLETON}.
 *
 * Separate from {@link BookGatekeeper} because the two have genuinely different lifetimes. The
 * Workshop instantiates a gatekeeper as a *facet* of each workspace's Overseer DO
 * (overseer.ts `getGatekeeperFacet`), so there is one gatekeeper per workspace but only ever one
 * store -- the one the scheduled handler syncs. Folding both into a single class gave every
 * workspace its own empty storage and made `env.BOOK.getStatus()` answer nulls while the
 * management app, reading the named instance, showed a full mirror.
 *
 * `sync()` is the only mutating entry point, and no session can reach it.
 */
@validateRpc()
export class BookMirrorStore extends DurableObject<Cloudflare.Env> {
  #syncing = false;

  /**
   * Pull the mirror up to the branch head.
   *
   * Overlapping runs are dropped rather than queued: the cron fires every five minutes and a first
   * sync reads every blob, so a slow run would otherwise stack ticks behind it. Skipping is safe
   * because the next tick recomputes the same delta from storage.
   */
  async sync(): Promise<SyncOutcome | { busy: true }> {
    if (this.#syncing) return { busy: true };
    this.#syncing = true;
    try {
      return await syncMirror(this.ctx.storage.kv, sourceFromEnv(this.env));
    } catch (error) {
      // Recorded, then rethrown: the documents from the last good sync stay readable, and the
      // scheduled handler still sees a failure it can log.
      recordSyncFailure(this.ctx.storage.kv, error);
      throw error;
    } finally {
      this.#syncing = false;
    }
  }

  async getStatus(): Promise<BookStatus> {
    return new BookMirror(this.ctx.storage.kv).getStatus();
  }

  /** Summaries only: listings never drag whole bodies across the wire. */
  async listDocuments(prefix?: string): Promise<BookDocumentSummary[]> {
    return new BookMirror(this.ctx.storage.kv).list(prefix);
  }

  async readDocument(path: string): Promise<BookDocumentContent | null> {
    const doc = new BookMirror(this.ctx.storage.kv).get(path);
    if (!doc) return null;
    return {
      path: doc.path,
      name: doc.name,
      title: doc.title,
      description: doc.description,
      body: doc.body,
    };
  }

  async searchDocuments(query: string, limit?: number): Promise<BookSearchHit[]> {
    return new BookMirror(this.ctx.storage.kv).search(query, limit);
  }
}

/** The one store, by name. The only way any other class reaches the mirror. */
export function mirrorStore(
  exports: Cloudflare.Exports,
): DurableObjectStub<BookMirrorStore> {
  return exports.BookMirrorStore.getByName(BOOK_SINGLETON);
}

/**
 * The gatekeeper the Workshop instantiates, once per workspace. Holds no storage of its own: every
 * read resolves through {@link mirrorStore}.
 */
@validateRpc()
export class BookGatekeeper extends DurableObject<Cloudflare.Env>
    implements Gatekeeper<BookSession> {
  async describe(): Promise<ResourceDescription> {
    const status = await mirrorStore(this.ctx.exports).getStatus();
    return {
      url: "book://" + this.env.BOOK_REPO_PATH,
      title: this.env.BOOK_DISPLAY_NAME,
      snippet: status.commitSha
        ? `${status.documentCount} document(s), mirrored from ` +
          `${this.env.BOOK_REPO_OWNER}/${this.env.BOOK_REPO_NAME}.`
        : `Not yet synchronized from ${this.env.BOOK_REPO_OWNER}/${this.env.BOOK_REPO_NAME}.`,
      suggestedBindingName: "BOOK",
      tsType: "BookSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<BookSession> {
    return new BookSessionImpl(
      approvalQueue.dup(),
      mirrorStore(this.ctx.exports),
      this.env.BOOK_DISPLAY_NAME,
    );
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  async applyAction(action: number): Promise<void> {
    throw new Error(`The Book gatekeeper is read-only and has no actions (${action}).`);
  }

  async rejectAction(_action: number): Promise<void> {}

  async revertAction(_action: number): Promise<void> {
    throw new Error("The Book gatekeeper is read-only and has no actions to revert.");
  }
}

@validateRpc()
export class BookAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return describeBookAccount(this.env);
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<BookSession>>> {
    return this.ctx.exports.BookGatekeeper({});
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("The Book gatekeeper has no URL-addressed resources.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("The Book gatekeeper has no URL-addressed resources.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async revoke(): Promise<void> {}

  /** The full-page management UI: mirror freshness, the document list, and a manual refresh. */
  async startAppUi(context: AppUiContext): Promise<GatekeeperUiFrame> {
    const book = mirrorStore(this.ctx.exports);
    return {
      iframeHtml: APP_HTML,
      ui: new RpcStub(new BookAdminApiImpl(book, this.env, context.isAdmin)),
    };
  }

  reconnect(): Promise<{ url: string }> {
    throw new Error("The Book gatekeeper is auto-provisioned and has no credentials to reconnect.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.BookVerifier({});
  }
}

/**
 * The management app's capability.
 *
 * Deliberately not part of `BookSession`: this is reached through `startAppUi`, which the Workshop
 * opens for a signed-in user, whereas a session is what agent code holds. Keeping `refresh()` here
 * is what lets the gatekeeper stay read-only to agents while still being refreshable by a person.
 *
 * Reads record no observation. An observation is the record of data leaving a gatekeeper into a
 * gadget's context, where an agent may act on it; this app renders to the user who opened it and
 * feeds nothing back to a model.
 */
@validateRpc()
export class BookAdminApiImpl extends RpcTarget implements BookAdminApi {
  readonly #book: DurableObjectStub<BookMirrorStore>;
  readonly #env: Cloudflare.Env;
  readonly #isAdmin: boolean;

  constructor(
    book: DurableObjectStub<BookMirrorStore>,
    env: Cloudflare.Env,
    isAdmin: boolean,
  ) {
    super();
    this.#book = book;
    this.#env = env;
    this.#isAdmin = isAdmin;
  }

  async getViewerInfo(): Promise<BookViewerInfo> {
    return {
      canRefresh: this.#isAdmin,
      source: {
        owner: this.#env.BOOK_REPO_OWNER,
        repo: this.#env.BOOK_REPO_NAME,
        branch: this.#env.BOOK_REPO_BRANCH,
        path: this.#env.BOOK_REPO_PATH,
      },
    };
  }

  async getStatus(): Promise<BookStatus> {
    return await this.#book.getStatus();
  }

  async listDocuments(): Promise<BookDocumentSummary[]> {
    return await this.#book.listDocuments();
  }

  async refresh(): Promise<RefreshResult> {
    // Enforced here rather than only by hiding the button: the capability is reachable from the
    // iframe, and a UI that merely omits a control is not an authorization boundary.
    if (!this.#isAdmin) {
      return { outcome: "failed", error: "Only administrators can refresh the book." };
    }
    try {
      const outcome = await this.#book.sync();
      if ("busy" in outcome) return { outcome: "busy" };
      return outcome.changed
        ? {
            outcome: "updated",
            commitSha: outcome.commitSha,
            documentCount: outcome.documentCount,
            fetched: outcome.fetched,
            removed: outcome.removed,
          }
        : {
            outcome: "unchanged",
            commitSha: outcome.commitSha,
            documentCount: outcome.documentCount,
          };
    } catch (error) {
      return {
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/**
 * Observer policy.
 *
 * Every observer is accepted, which is only defensible because the mirror holds one corpus that is
 * uniform in sensitivity and already gated: the deployment sits behind Cloudflare Access, so an
 * observer is by construction someone entitled to read the book. If the mirrored directory ever
 * grows content that is not safe for every signed-in user -- customer data, third-party material
 * under redistribution terms -- this must become a real check before that content is mirrored.
 */
@validateRpc()
export class BookVerifier extends WorkerEntrypoint<Cloudflare.Env>
    implements GatekeeperUserVerifier {
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return describeBookVendor(this.env);
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.BookAccount({});
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("The Book gatekeeper is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
