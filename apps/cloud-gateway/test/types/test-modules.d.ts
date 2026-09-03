/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The two module shapes that exist only under the test runner.
 *
 * `cloudflare:test` is supplied by the Workers vitest pool at runtime, and
 * `?raw` by Vite's asset handling. Neither has a real file on disk, so
 * without these declarations a typecheck of the test tree fails on the import
 * line of nearly every test and never reaches the code worth checking.
 */

declare namespace Cloudflare {
  /**
   * Binds the pool's `env` to this Worker's own bindings.
   *
   * An alias rather than an interface extending it: nothing else in the tree
   * declares `Cloudflare.Env`, so there is no declaration to merge with, and
   * the alias states the equality directly.
   */
  type Env = import("../../src/env").Env;
}

declare module "*.sql?raw" {
  const content: string;
  export default content;
}
