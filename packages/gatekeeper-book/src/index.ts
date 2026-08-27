export * from "./book.js";

import { mirrorStore } from "./book.js";

export default {
  async fetch(): Promise<Response> {
    return new Response("Book Gatekeeper worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },

  /**
   * Cron entry point. The cadence lives in `wrangler.jsonc`; this only routes the tick to the one
   * Book Durable Object.
   *
   * Failures are logged rather than rethrown. A throw here marks the scheduled invocation failed
   * without changing what happens next -- the next tick still fires, and `sync()` has already
   * recorded the failure where `getStatus()` can surface it.
   */
  async scheduled(
    _controller: ScheduledController,
    _env: Cloudflare.Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const book = mirrorStore(ctx.exports);
    try {
      const outcome = await book.sync();
      if ("busy" in outcome) {
        console.log(JSON.stringify({
          event: "book.sync.skipped",
          reason: "a previous sync is still running",
        }));
        return;
      }
      console.log(JSON.stringify({
        event: outcome.changed ? "book.sync.updated" : "book.sync.unchanged",
        commitSha: outcome.commitSha,
        documentCount: outcome.documentCount,
        fetched: outcome.fetched,
        removed: outcome.removed,
        skipped: outcome.skipped.length,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        event: "book.sync.failed",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  },
};
