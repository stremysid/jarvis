import { describe, expect, it } from "vitest";

import {
  addTopic,
  createTopicTree,
  fileMemory,
  mergeTopics,
  moveTopic,
  renameTopic,
  resolveTopicId,
  topicPath,
  walkTopic,
} from "../../src/memory/topic-tree.js";

const change = (transitionId: string) => ({
  transitionId,
  occurredAt: "2026-09-14T12:00:00.000Z",
  actor: "model" as const,
});

const nestedTree = () => {
  let tree = createTopicTree({ topicId: "root", name: "Memory" });
  tree = addTopic(tree, {
    topicId: "st-remy",
    name: "St. Remy",
    parentTopicId: "root",
  });
  tree = addTopic(tree, {
    topicId: "website",
    name: "Website",
    parentTopicId: "st-remy",
  });
  return addTopic(tree, {
    topicId: "checkout",
    name: "Checkout",
    parentTopicId: "website",
  });
};

describe("topic tree", () => {
  it("walks areas, sub-areas, and deeper descendants with filed memories", () => {
    const tree = fileMemory(nestedTree(), {
      filingId: "filing-1",
      memoryId: "memory-1",
      topicId: "checkout",
      relation: "primary",
      filedBy: "model",
      confidence: 0.86,
    });

    expect(topicPath(tree, "checkout")).toEqual([
      "Memory",
      "St. Remy",
      "Website",
      "Checkout",
    ]);
    expect(walkTopic(tree, "st-remy")).toEqual({
      topicIds: ["st-remy", "website", "checkout"],
      filings: [tree.filings[0]],
    });
  });

  it("prevents a memory from having two primary filings", () => {
    const once = fileMemory(nestedTree(), {
      filingId: "filing-1",
      memoryId: "memory-1",
      topicId: "website",
      relation: "primary",
      filedBy: "model",
      confidence: 0.7,
    });

    expect(() =>
      fileMemory(once, {
        filingId: "filing-2",
        memoryId: "memory-1",
        topicId: "checkout",
        relation: "primary",
        filedBy: "model",
        confidence: 0.8,
      }),
    ).toThrow("topic_primary_filing_exists");
  });

  it("renames a topic without losing its stable identity or old name", () => {
    const renamed = renameTopic(nestedTree(), "website", "Web platform", change("t-1"));

    expect(topicPath(renamed, "checkout")).toEqual([
      "Memory",
      "St. Remy",
      "Web platform",
      "Checkout",
    ]);
    expect(renamed.topics.find((topic) => topic.topicId === "website")?.aliases).toEqual([
      "Website",
    ]);
    expect(renamed.history.at(-1)).toMatchObject({
      transitionId: "t-1",
      operation: "rename",
      topicId: "website",
      fromName: "Website",
      toName: "Web platform",
    });
  });

  it("moves a topic with history and rejects a move beneath its own descendant", () => {
    let tree = nestedTree();
    tree = addTopic(tree, {
      topicId: "work",
      name: "Work",
      parentTopicId: "root",
    });
    const moved = moveTopic(tree, "website", "work", change("t-2"));

    expect(topicPath(moved, "checkout")).toEqual([
      "Memory",
      "Work",
      "Website",
      "Checkout",
    ]);
    expect(moved.history.at(-1)).toMatchObject({
      operation: "move",
      topicId: "website",
      fromParentTopicId: "st-remy",
      toParentTopicId: "work",
    });
    expect(() => moveTopic(tree, "st-remy", "checkout", change("t-3"))).toThrow(
      "topic_move_cycle",
    );
    expect(topicPath(tree, "checkout")).toEqual([
      "Memory",
      "St. Remy",
      "Website",
      "Checkout",
    ]);
  });

  it("merges topics through redirects while preserving filing and transition history", () => {
    let tree = nestedTree();
    tree = addTopic(tree, {
      topicId: "digital",
      name: "Digital",
      parentTopicId: "st-remy",
    });
    tree = fileMemory(tree, {
      filingId: "filing-1",
      memoryId: "memory-1",
      topicId: "website",
      relation: "primary",
      filedBy: "model",
      confidence: 0.9,
    });
    const merged = mergeTopics(tree, "website", "digital", change("t-4"));

    expect(resolveTopicId(merged, "website")).toBe("digital");
    expect(topicPath(merged, "checkout")).toEqual([
      "Memory",
      "St. Remy",
      "Digital",
      "Checkout",
    ]);
    expect(walkTopic(merged, "digital").filings).toEqual([merged.filings[0]]);
    expect(merged.filings[0]?.topicId).toBe("website");
    expect(merged.history.at(-1)).toMatchObject({
      operation: "merge",
      topicId: "website",
      mergedIntoTopicId: "digital",
    });
  });
});
