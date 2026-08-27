// The Book management app: mirror freshness, the document list, and a manual refresh.
//
// Vanilla DOM rather than React, unlike the Context Library and Scheduler apps. Those render file
// managers and schedule editors; this renders a status block, a list, and one button. Pulling React
// in for that would triple the bundle the Worker has to carry as a string literal for no gain.

import { RpcTarget, newMessagePortRpcSession, type RpcStub } from "capnweb";
import "./styles.css";
import { applyAccentColor, type GatekeeperAppTheme } from "@gadgets/workshop-shared/theme";
import type { BookAdminApi, BookViewerInfo, RefreshResult } from "../src/ui-api.js";
import type { BookDocumentSummary, BookStatus } from "../src/types.js";

/** What the Workshop exposes to this frame. `ui` is the gatekeeper's own capability. */
interface HostCapability extends RpcTarget {
  readonly ui: RpcStub<BookAdminApi>;
  subscribeTheme(receiver: AppFrame): Promise<GatekeeperAppTheme>;
}

/** Our side of the host session: the theme receiver. */
class AppFrame extends RpcTarget {
  setTheme(theme: GatekeeperAppTheme): void {
    applyTheme(theme);
  }
}

function applyTheme(theme: GatekeeperAppTheme): void {
  document.documentElement.style.colorScheme = theme.mode;
  applyAccentColor(document.documentElement.style, theme.accentColor);
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** "3 minutes ago" for a timestamp, or "never". Recomputed on every render, not on a timer. */
function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function describeRefresh(result: RefreshResult): { text: string; tone: "ok" | "warn" | "bad" } {
  switch (result.outcome) {
    case "updated":
      return {
        tone: "ok",
        text: `Updated to ${result.commitSha.slice(0, 7)} — ${result.fetched} file(s) re-read, `
          + `${result.removed} removed, ${result.documentCount} in the book.`,
      };
    case "unchanged":
      return { tone: "ok", text: `Already current at ${result.commitSha.slice(0, 7)}.` };
    case "busy":
      return { tone: "warn", text: "A refresh is already running. Try again in a moment." };
    case "failed":
      return { tone: "bad", text: result.error };
  }
}

class App {
  #status: BookStatus | null = null;
  #documents: BookDocumentSummary[] = [];
  #viewer: BookViewerInfo | null = null;
  #refreshing = false;
  #lastResult: RefreshResult | null = null;
  #loadError: string | null = null;

  constructor(private readonly ui: RpcStub<BookAdminApi>, private readonly root: HTMLElement) {}

  async load(): Promise<void> {
    try {
      // Sequential rather than Promise.all: the capability is rate-limited by the host, and three
      // reads on open is not worth the concurrency.
      this.#viewer = await this.ui.getViewerInfo();
      this.#status = await this.ui.getStatus();
      this.#documents = await this.ui.listDocuments();
      this.#loadError = null;
    } catch (error) {
      this.#loadError = error instanceof Error ? error.message : String(error);
    }
    this.render();
  }

  async #refresh(): Promise<void> {
    if (this.#refreshing) return;
    this.#refreshing = true;
    this.#lastResult = null;
    this.render();
    try {
      this.#lastResult = await this.ui.refresh();
    } catch (error) {
      this.#lastResult = {
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.#refreshing = false;
    // Re-read rather than trusting the result: a refresh that failed part-way still moves the
    // document count, and the status block should show what is actually stored.
    try {
      this.#status = await this.ui.getStatus();
      this.#documents = await this.ui.listDocuments();
    } catch { /* keep the previous view; the result line already carries the error */ }
    this.render();
  }

  render(): void {
    this.root.replaceChildren();
    const page = el("div", "page");

    if (this.#loadError) {
      const banner = el("div", "banner bad");
      banner.append(el("strong", undefined, "Could not load the book. "), document.createTextNode(this.#loadError));
      page.append(banner);
      this.root.append(page);
      return;
    }

    page.append(this.#renderHeader(), this.#renderStatus());
    if (this.#lastResult) page.append(this.#renderResult(this.#lastResult));
    page.append(this.#renderDocuments());
    this.root.append(page);
  }

  #renderHeader(): HTMLElement {
    const header = el("header", "header");
    header.append(el("h1", undefined, "Book"));
    const source = this.#viewer?.source;
    if (source) {
      const sub = el("p", "muted");
      sub.append(document.createTextNode("Mirrored from "));
      const code = el("code", undefined, `${source.owner}/${source.repo}/${source.path}`);
      sub.append(code, document.createTextNode(` on ${source.branch}`));
      header.append(sub);
    }
    return header;
  }

  #renderStatus(): HTMLElement {
    const status = this.#status;
    const card = el("section", "card");
    const synced = status?.commitSha;

    const row = el("div", "row");
    const dot = el("span", `dot ${status?.lastError ? "bad" : synced ? "ok" : "idle"}`);
    const headline = el("div", "headline", synced
      ? `${status!.documentCount} document${status!.documentCount === 1 ? "" : "s"}`
      : "Not yet synchronized");
    row.append(dot, headline);

    if (this.#viewer?.canRefresh) {
      const button = el("button", "primary", this.#refreshing ? "Refreshing…" : "Refresh now");
      button.disabled = this.#refreshing;
      button.addEventListener("click", () => void this.#refresh());
      row.append(button);
    }
    card.append(row);

    const facts = el("dl", "facts");
    const fact = (label: string, value: string, mono = false) => {
      facts.append(el("dt", undefined, label));
      facts.append(el("dd", mono ? "mono" : undefined, value));
    };
    fact("Commit", synced ? status!.commitSha!.slice(0, 12) : "—", true);
    fact("Last synced", relativeTime(status?.syncedAt ?? null));
    fact("Refreshes", "every 5 minutes");
    card.append(facts);

    if (status?.lastError) {
      const banner = el("div", "banner bad");
      banner.append(
        el("strong", undefined, "Last refresh failed. "),
        document.createTextNode(status.lastError),
      );
      // Said explicitly: a stale mirror that still answers is easy to mistake for a healthy one.
      banner.append(el("p", "muted", synced
        ? "The documents below are from the last successful sync and remain readable."
        : "Nothing has been mirrored yet, so the book is empty."));
      card.append(banner);
    }
    return card;
  }

  #renderResult(result: RefreshResult): HTMLElement {
    const { text, tone } = describeRefresh(result);
    return el("div", `banner ${tone}`, text);
  }

  #renderDocuments(): HTMLElement {
    const section = el("section", "card");
    section.append(el("h2", undefined, "Documents"));
    if (this.#documents.length === 0) {
      section.append(el("p", "muted", "No documents mirrored yet."));
      return section;
    }
    const list = el("ul", "docs");
    for (const doc of this.#documents) {
      const item = el("li");
      item.append(el("div", "doc-title", doc.title));
      item.append(el("div", "doc-path mono", doc.path));
      if (doc.description) item.append(el("div", "muted", doc.description));
      list.append(item);
    }
    section.append(list);
    return section;
  }
}

function main(): void {
  const root = document.getElementById("root");
  if (!root) throw new Error("missing #root");

  const { port1, port2 } = new MessageChannel();
  // An opaque-origin iframe cannot name its parent's origin. The parent accepts this handshake
  // only from this frame at a null origin, and the message transfers nothing but a private port.
  window.parent.postMessage({ type: "handshake" }, "*", [port2]);
  const frame = new AppFrame();
  const host = newMessagePortRpcSession<HostCapability>(port1, frame);
  host.subscribeTheme(frame).then(applyTheme).catch(() => { /* keep the default palette */ });

  void new App(host.ui, root).load();
}

main();
