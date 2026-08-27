// Declarations that augment the auto-generated Cloudflare.Env.
// (worker-configuration.d.ts is written by `wrangler types` and should not be edited.)

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "BookGatekeeper" | "BookMirrorStore";
  }

  interface Env {
    /**
     * GitHub credential for the mirrored repository. A Wrangler secret, so it is absent from the
     * generated types and optional here -- `sourceFromEnv` turns a missing value into an error
     * naming the command that installs it. A fine-grained token with Contents: Read is enough.
     */
    GITHUB_TOKEN?: string;
  }
}
