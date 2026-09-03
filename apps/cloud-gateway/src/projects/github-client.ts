/**
 * A thin GitHub REST client for exactly two questions: what is the latest
 * commit on the default branch, and what does one named file contain at that
 * commit.
 *
 * Nothing more is needed. The tracked projects are private repositories that
 * already carry the four status documents, so the poller does not need issues,
 * pull requests, or the tree -- and every endpoint not used here is one fewer
 * shape of untrusted data to reason about.
 *
 * Everything this returns -- file contents, commit messages, any other field --
 * is untrusted text written by whoever can push to the repository. It is
 * returned as data for the poller to hash and excerpt. It is never interpreted
 * as an instruction, and it never appears in a failure string: a failure
 * recorded from a response body would let a repository write arbitrary text
 * into our own alerting.
 */

const DEFAULT_API_ORIGIN = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * GitHub rejects a request with no User-Agent outright, with a 403 that looks
 * nothing like a permissions problem. Sending one is not optional.
 */
const DEFAULT_USER_AGENT = "jarvis-cloud-gateway";

/** Pinning the API version keeps a GitHub-side default change from silently altering a response shape. */
const API_VERSION = "2022-11-28";

/**
 * A ceiling on a single status document.
 *
 * The hash must cover the whole file or change detection goes blind past the
 * cut -- a KNOWN_ISSUES.md edited in its second half would hash identically
 * and read as unchanged. So the whole file is read, and a file too large to
 * read is an explicit failure rather than a silent truncation.
 */
export const MAX_DOCUMENT_BYTES = 1_048_576;

export type GitHubFailureCode =
  /** Primary or secondary rate limit. The caller must back off, not retry immediately. */
  | "rate_limited"
  /** Bad or missing credentials, or a private repository the token cannot see. */
  | "authentication"
  /** The repository does not exist, or is invisible to this token. */
  | "not_found"
  /** The repository exists but has no commits -- there is nothing to observe. */
  | "empty_repository"
  | "unavailable"
  | "timeout"
  /** A 2xx whose body was not the shape the API documents. */
  | "malformed_response"
  | "too_large";

/**
 * A failed GitHub call, carrying only values this file produced: a code from
 * the union above and an HTTP status. The response body is deliberately not
 * captured -- see the note at the top of the file.
 */
export class GitHubFailure extends Error {
  readonly code: GitHubFailureCode;
  readonly status: number | null;
  /** Seconds GitHub asked us to wait, when it said. Null otherwise. */
  readonly retryAfterSeconds: number | null;

  constructor(code: GitHubFailureCode, status: number | null = null, retryAfterSeconds: number | null = null) {
    super(code);
    this.name = "GitHubFailure";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface GitHubCommit {
  /** 40 lowercase hex characters, as the schema's CHECK requires. */
  readonly sha: string;
  /** Canonical `YYYY-MM-DDTHH:MM:SS.sssZ`, so stored timestamps compare as strings. */
  readonly committedAt: string;
}

export type GitHubFileRead =
  | { readonly outcome: "present"; readonly content: string }
  /**
   * A 404 on a file. Normal, not a failure: a project may legitimately have no
   * DECISIONS.md yet. Kept distinct from a failed request because conflating
   * them is exactly how a poller starts reporting "nothing to see" about a
   * repository it can no longer reach.
   */
  | { readonly outcome: "absent" };

export interface GitHubClientOptions {
  /** A fine-grained or classic token with read access. Private repos need one. */
  readonly token?: string;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
  readonly apiOrigin?: string;
}

/**
 * GitHub account and repository names. Validated rather than trusted because
 * a tracked project is a database row: an owner of `../../orgs` would
 * otherwise build a URL pointing somewhere else entirely.
 */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/u;

const SHA = /^[0-9a-f]{40}$/u;

function requireSlug(owner: string, repository: string): void {
  if (!OWNER.test(owner)) throw new TypeError("github_owner_invalid");
  if (!REPOSITORY.test(repository)) throw new TypeError("github_repository_invalid");
}

/**
 * Map an HTTP status onto the failure the poller records.
 *
 * The rate-limit distinction is the load-bearing one. GitHub answers a primary
 * limit with 403 and `x-ratelimit-remaining: 0`, and a secondary limit with
 * 403 or 429 plus a `retry-after`; a plain 403 is a permissions problem.
 * Classifying a rate limit as an authentication failure would send someone to
 * rotate a token that was never wrong, and classifying a permissions failure
 * as a rate limit would wait forever for a limit that is not going to lift.
 */
function failureFor(response: Response): GitHubFailure {
  const status = response.status;
  const retryAfter = positiveInteger(response.headers.get("retry-after"));
  const exhausted = response.headers.get("x-ratelimit-remaining") === "0";

  if (status === 429) return new GitHubFailure("rate_limited", status, retryAfter);
  if (status === 403 && (exhausted || retryAfter !== null)) {
    return new GitHubFailure("rate_limited", status, retryAfter);
  }
  if (status === 401 || status === 403) return new GitHubFailure("authentication", status);
  if (status === 404) return new GitHubFailure("not_found", status);
  if (status === 409) return new GitHubFailure("empty_repository", status);
  return new GitHubFailure("unavailable", status);
}

function positiveInteger(value: string | null): number | null {
  if (value === null || !/^\d{1,9}$/u.test(value)) return null;
  const parsed = Number(value);
  return parsed > 0 ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Canonicalise a GitHub timestamp, or reject it. A timestamp we cannot read is not a date we can compare against a threshold. */
function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = new Date(value);
  const epoch = parsed.valueOf();
  if (!Number.isFinite(epoch)) return null;
  return parsed.toISOString();
}

function commitDateOf(commit: unknown): string | null {
  if (!isRecord(commit)) return null;
  // Committer date, not author date: a rebase or a cherry-pick rewrites the
  // committer date and leaves the author date at the original writing, and
  // "when was this repository last touched" is the former.
  const committer = canonicalTimestamp(isRecord(commit.committer) ? commit.committer.date : null);
  if (committer !== null) return committer;
  return canonicalTimestamp(isRecord(commit.author) ? commit.author.date : null);
}

export class GitHubClient {
  readonly #token: string | null;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #userAgent: string;
  readonly #apiOrigin: string;

  constructor(options: GitHubClientOptions = {}) {
    this.#token = options.token ?? null;
    // Bound to globalThis. The Workers runtime rejects native fetch called
    // with any other `this`, and storing it as a class field then calling
    // this.#fetch(...) supplies the instance -- raising "Illegal invocation"
    // at runtime. Node has no such restriction, so this passes every test and
    // fails only in production.
    this.#fetch = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#apiOrigin = options.apiOrigin ?? DEFAULT_API_ORIGIN;
  }

  /**
   * The latest commit on the repository's default branch.
   *
   * `GET /repos/{owner}/{repo}/commits?per_page=1` answers this in one request
   * -- it lists the default branch newest first -- where reading the
   * repository for its `default_branch` and then that branch would take two.
   */
  async readHeadCommit(owner: string, repository: string): Promise<GitHubCommit> {
    requireSlug(owner, repository);
    const url = `${this.#apiOrigin}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits?per_page=1`;
    const response = await this.#request(url, "application/vnd.github+json");
    if (!response.ok) throw failureFor(response);

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new GitHubFailure("malformed_response", response.status);
    }

    // An empty list from a 200 is the plan's empty-fetch case: it means we
    // asked a question and got nothing, which must alert rather than pass for
    // an unchanged repository.
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new GitHubFailure("malformed_response", response.status);
    }

    const first: unknown = parsed[0];
    const sha = isRecord(first) && typeof first.sha === "string" ? first.sha.toLowerCase() : null;
    const committedAt = isRecord(first) ? commitDateOf(first.commit) : null;
    // The schema's CHECK requires 40 lowercase hex. Catching a bad sha here
    // rather than at INSERT keeps a malformed response from aborting the write
    // of the very observation that would have recorded the problem.
    if (sha === null || !SHA.test(sha) || committedAt === null) {
      throw new GitHubFailure("malformed_response", response.status);
    }

    return Object.freeze({ sha, committedAt });
  }

  /**
   * The contents of one file at a specific commit.
   *
   * Pinned to `ref` rather than to the branch so all four documents come from
   * the same tree as the commit recorded alongside them. A push landing
   * mid-poll would otherwise produce an observation whose head_sha and whose
   * documents describe different states of the repository.
   */
  async readFileAtCommit(
    owner: string,
    repository: string,
    path: string,
    ref: string,
  ): Promise<GitHubFileRead> {
    requireSlug(owner, repository);
    if (!SHA.test(ref)) throw new TypeError("github_ref_invalid");
    const url = `${this.#apiOrigin}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
      + `/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
    // The raw media type returns the file body itself; the default JSON shape
    // would return it base64-encoded inside an envelope, for no gain.
    const response = await this.#request(url, "application/vnd.github.raw");

    if (response.status === 404) return Object.freeze({ outcome: "absent" as const });
    if (!response.ok) throw failureFor(response);

    // Refuse before reading when GitHub tells us the size up front, and again
    // while reading when it does not: a body with no content-length is still
    // a body we would otherwise buffer without limit.
    const declared = positiveInteger(response.headers.get("content-length"));
    if (declared !== null && declared > MAX_DOCUMENT_BYTES) {
      throw new GitHubFailure("too_large", response.status);
    }

    const content = await this.#readBounded(response);
    return Object.freeze({ outcome: "present" as const, content });
  }

  async #readBounded(response: Response): Promise<string> {
    if (response.body === null) return "";
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > MAX_DOCUMENT_BYTES) throw new GitHubFailure("too_large", response.status);
        parts.push(result.value.slice());
      }
    } finally {
      reader.releaseLock();
    }

    const joined = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    // Not fatal: a status document with a stray invalid byte should still be
    // observable. Replacement characters are deterministic, so a file that
    // does not change still hashes the same.
    return new TextDecoder("utf-8").decode(joined);
  }

  async #request(url: string, accept: string): Promise<Response> {
    const headers: Record<string, string> = {
      accept,
      "user-agent": this.#userAgent,
      "x-github-api-version": API_VERSION,
    };
    if (this.#token !== null) headers.authorization = `Bearer ${this.#token}`;

    // A hung request would hold a Worker invocation open until the platform
    // kills it, so the timeout is enforced here rather than relied upon.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      return await this.#fetch(url, { method: "GET", headers, signal: controller.signal });
    } catch {
      // Distinguished by whether we are the ones who gave up. A DNS or TLS
      // failure is not a timeout, and recording it as one would send whoever
      // reads the failure looking at latency.
      throw new GitHubFailure(controller.signal.aborted ? "timeout" : "unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}
