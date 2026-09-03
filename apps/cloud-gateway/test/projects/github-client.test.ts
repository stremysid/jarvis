import { describe, expect, it } from "vitest";
import {
  GitHubClient,
  GitHubFailure,
  MAX_DOCUMENT_BYTES,
} from "../../src/projects/github-client.js";
import {
  FIXTURE_SHA,
  commitsResponse,
  fileResponse,
  githubFetch,
  missingResponse,
  rateLimitedResponse,
} from "./project-fixture.js";

/**
 * What matters here is the classification.
 *
 * The poller records a 404 on a file as "this project has no DECISIONS.md" and
 * anything else as "we could not see this project". Getting that boundary
 * wrong in either direction is a real defect: a failure read as an absence
 * makes an unreachable repository look like a tidy one, and an absence read as
 * a failure makes every project without a DECISIONS.md permanently broken.
 */

function clientWith(routes: Parameters<typeof githubFetch>[0]): {
  client: GitHubClient;
  calls: { url: string; headers: Headers }[];
} {
  const stub = githubFetch(routes);
  return {
    client: new GitHubClient({ token: "test-token", fetchImplementation: stub.implementation }),
    calls: stub.calls,
  };
}

describe("GitHubClient", () => {
  it("reads the latest commit on the default branch in one request", async () => {
    const { client, calls } = clientWith({
      head: () => commitsResponse(FIXTURE_SHA, "2026-08-20T10:00:00Z"),
    });

    const commit = await client.readHeadCommit("sid", "jarvis");

    expect(commit).toEqual({ sha: FIXTURE_SHA, committedAt: "2026-08-20T10:00:00.000Z" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/sid/jarvis/commits?per_page=1");
  });

  it("sends a User-Agent, which GitHub rejects a request without", async () => {
    const { client, calls } = clientWith({ head: () => commitsResponse(FIXTURE_SHA, "2026-08-20T10:00:00Z") });
    await client.readHeadCommit("sid", "jarvis");

    expect(calls[0].headers.get("user-agent")).toBe("jarvis-cloud-gateway");
    expect(calls[0].headers.get("authorization")).toBe("Bearer test-token");
  });

  it("reports a missing file as absent rather than as a failure", async () => {
    const { client } = clientWith({ file: () => missingResponse() });

    await expect(client.readFileAtCommit("sid", "jarvis", "DECISIONS.md", FIXTURE_SHA))
      .resolves.toEqual({ outcome: "absent" });
  });

  it("pins a file read to the commit it was asked for", async () => {
    const { client, calls } = clientWith({ file: () => fileResponse("# Next steps\n") });

    const read = await client.readFileAtCommit("sid", "jarvis", "NEXT_STEPS.md", FIXTURE_SHA);

    expect(read).toEqual({ outcome: "present", content: "# Next steps\n" });
    expect(new URL(calls[0].url).searchParams.get("ref")).toBe(FIXTURE_SHA);
  });

  it("distinguishes a rate limit from an authentication failure", async () => {
    const limited = clientWith({ head: () => rateLimitedResponse() });
    const forbidden = clientWith({ head: () => new Response("no", { status: 403 }) });

    const limitedFailure = await limited.client.readHeadCommit("sid", "jarvis").catch((error: unknown) => error);
    const forbiddenFailure = await forbidden.client.readHeadCommit("sid", "jarvis").catch((error: unknown) => error);

    expect(limitedFailure).toBeInstanceOf(GitHubFailure);
    expect((limitedFailure as GitHubFailure).code).toBe("rate_limited");
    expect((limitedFailure as GitHubFailure).retryAfterSeconds).toBe(60);
    expect((forbiddenFailure as GitHubFailure).code).toBe("authentication");
  });

  it("reports a repository it cannot see as not found rather than as empty", async () => {
    const { client } = clientWith({ head: () => new Response("Not Found", { status: 404 }) });
    const failure = await client.readHeadCommit("sid", "jarvis").catch((error: unknown) => error);
    expect((failure as GitHubFailure).code).toBe("not_found");
  });

  it("reports a repository with no commits distinctly from one that failed", async () => {
    const { client } = clientWith({ head: () => new Response("empty", { status: 409 }) });
    const failure = await client.readHeadCommit("sid", "jarvis").catch((error: unknown) => error);
    expect((failure as GitHubFailure).code).toBe("empty_repository");
  });

  it("treats an empty commit list as a failure rather than as an unchanged repository", async () => {
    // The plan's rule: an empty fetch alerts. A 200 carrying nothing is a
    // question we asked and did not get an answer to.
    const { client } = clientWith({ head: () => new Response("[]", { status: 200 }) });
    const failure = await client.readHeadCommit("sid", "jarvis").catch((error: unknown) => error);
    expect((failure as GitHubFailure).code).toBe("malformed_response");
  });

  it("refuses a commit sha the schema would reject at insert time", async () => {
    const { client } = clientWith({
      head: () => new Response(
        JSON.stringify([{ sha: "not-a-sha", commit: { committer: { date: "2026-08-20T10:00:00Z" } } }]),
        { status: 200 },
      ),
    });
    const failure = await client.readHeadCommit("sid", "jarvis").catch((error: unknown) => error);
    expect((failure as GitHubFailure).code).toBe("malformed_response");
  });

  it("refuses a commit with no readable date, which cannot be compared to a stale threshold", async () => {
    const { client } = clientWith({
      head: () => new Response(
        JSON.stringify([{ sha: FIXTURE_SHA, commit: { committer: { date: "whenever" } } }]),
        { status: 200 },
      ),
    });
    const failure = await client.readHeadCommit("sid", "jarvis").catch((error: unknown) => error);
    expect((failure as GitHubFailure).code).toBe("malformed_response");
  });

  it("prefers the committer date, which is when the repository was actually touched", async () => {
    const { client } = clientWith({
      head: () => new Response(JSON.stringify([{
        sha: FIXTURE_SHA,
        commit: { author: { date: "2020-01-01T00:00:00Z" }, committer: { date: "2026-08-20T10:00:00Z" } },
      }]), { status: 200 }),
    });

    await expect(client.readHeadCommit("sid", "jarvis"))
      .resolves.toEqual({ sha: FIXTURE_SHA, committedAt: "2026-08-20T10:00:00.000Z" });
  });

  it("refuses an owner or repository name that would change the URL it requests", async () => {
    // A tracked project is a database row. An owner of "../.." would otherwise
    // build a request to somewhere entirely different from the repository the
    // observation would be filed under.
    const { client, calls } = clientWith({ head: () => commitsResponse(FIXTURE_SHA, "2026-08-20T10:00:00Z") });

    await expect(client.readHeadCommit("../../orgs", "jarvis")).rejects.toThrow("github_owner_invalid");
    await expect(client.readHeadCommit("sid", "jarvis/../other")).rejects.toThrow("github_repository_invalid");
    expect(calls).toHaveLength(0);
  });

  it("refuses a ref that is not a commit sha", async () => {
    const { client } = clientWith({ file: () => fileResponse("x") });
    await expect(client.readFileAtCommit("sid", "jarvis", "NEXT_STEPS.md", "main"))
      .rejects.toThrow("github_ref_invalid");
  });

  it("refuses a document larger than the read bound rather than hashing part of one", async () => {
    // The hash has to cover the whole file or a change past the cut reads as
    // no change at all, so an unreadably large file is a failure, not a
    // truncation.
    const { client } = clientWith({ file: () => fileResponse("x".repeat(MAX_DOCUMENT_BYTES + 1)) });
    const failure = await client.readFileAtCommit("sid", "jarvis", "CHANGELOG.md", FIXTURE_SHA)
      .catch((error: unknown) => error);
    expect((failure as GitHubFailure).code).toBe("too_large");
  });

  it("carries an empty file through as content rather than as an absence", async () => {
    // An empty KNOWN_ISSUES.md is a real state a project can be in, and it
    // hashes to a value that changes the moment someone writes an issue into
    // it. Reporting it as absent would lose that.
    const { client } = clientWith({ file: () => fileResponse("") });
    await expect(client.readFileAtCommit("sid", "jarvis", "KNOWN_ISSUES.md", FIXTURE_SHA))
      .resolves.toEqual({ outcome: "present", content: "" });
  });

  it("reports a transport failure without claiming it was a timeout", async () => {
    const client = new GitHubClient({
      fetchImplementation: (() => Promise.reject(new TypeError("network"))) as unknown as typeof fetch,
    });
    const failure = await client.readHeadCommit("sid", "jarvis").catch((error: unknown) => error);
    expect((failure as GitHubFailure).code).toBe("unavailable");
  });

  it("gives up on a request that never answers", async () => {
    const client = new GitHubClient({
      timeoutMs: 5,
      fetchImplementation: ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { reject(new Error("aborted")); });
      })) as unknown as typeof fetch,
    });
    const failure = await client.readHeadCommit("sid", "jarvis").catch((error: unknown) => error);
    expect((failure as GitHubFailure).code).toBe("timeout");
  });
});
