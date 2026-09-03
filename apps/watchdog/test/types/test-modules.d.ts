/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The one module shape that exists only under the test runner.
 *
 * `cloudflare:test` is supplied by the Workers vitest pool at runtime and has
 * no file on disk, so without this a typecheck of the test tree fails on the
 * import line of nearly every test and never reaches the code worth checking.
 */

declare namespace Cloudflare {
  /**
   * Binds the pool's `env` to the watchdog's own bindings, not the gateway's.
   *
   * The watchdog's Env declares DB as optional, because the Worker has to be
   * able to say out loud that it has no database rather than fail to start.
   * The pool's env always has it, so tests read `env.DB` through this.
   */
  interface Env {
    DB: D1Database;
  }
}
