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
  }, change("create-st-remy"));
  tree = addTopic(tree, {
    topicId: "website",
    name: "Website",
    parentTopicId: "st-remy",
  }, change("create-website"));
  return addTopic(tree, {
    topicId: "checkout",
    name: "Checkout",
    parentTopicId: "website",
  }, change("create-checkout"));
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
    }, change("file-memory-1"));

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
    }, change("file-memory-1"));

    expect(() =>
      fileMemory(once, {
        filingId: "filing-2",
        memoryId: "memory-1",
        topicId: "checkout",
        relation: "primary",
        filedBy: "model",
        confidence: 0.8,
      }, change("file-memory-2")),
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
    }, change("create-work"));
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
    }, change("create-digital"));
    tree = fileMemory(tree, {
      filingId: "filing-1",
      memoryId: "memory-1",
      topicId: "website",
      relation: "primary",
      filedBy: "model",
      confidence: 0.9,
    }, change("file-memory-1"));
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
      movedChildTopicIds: ["checkout"],
      movedFilingIds: ["filing-1"],
      addedAliases: ["Website"],
    });
  });

  it("records topic creation and filing as reversible transitions", () => {
    let tree = createTopicTree({ topicId: "root", name: "Memory" });
    tree = addTopic(tree, {
      topicId: "personal",
      name: "Personal",
      parentTopicId: "root",
    }, change("create-personal"));
    tree = fileMemory(tree, {
      filingId: "filing-1",
      memoryId: "memory-1",
      topicId: "personal",
      relation: "primary",
      filedBy: "model",
      confidence: 0.8,
    }, change("file-memory-1"));

    expect(tree.history).toEqual([
      expect.objectContaining({
        transitionId: "create-personal",
        operation: "create",
        topicId: "personal",
        toName: "Personal",
        toParentTopicId: "root",
      }),
      expect.objectContaining({
        transitionId: "file-memory-1",
        operation: "file",
        filingId: "filing-1",
        memoryId: "memory-1",
        topicId: "personal",
        relation: "primary",
        filedBy: "model",
        confidence: 0.8,
      }),
    ]);
  });

  it("rejects invalid root, cycle, duplicate-name, confidence, and transition changes", () => {
    let tree = nestedTree();
    tree = addTopic(tree, {
      topicId: "digital",
      name: "Digital",
      parentTopicId: "st-remy",
    }, change("create-digital"));

    expect(() => addTopic(tree, {
      topicId: "website-duplicate",
      name: "website",
      parentTopicId: "st-remy",
    }, change("create-duplicate"))).toThrow("topic_sibling_name_exists");
    expect(() => moveTopic(tree, "root", "st-remy", change("move-root"))).toThrow(
      "topic_root_cannot_move",
    );
    expect(() => mergeTopics(tree, "root", "st-remy", change("merge-root"))).toThrow(
      "topic_root_cannot_merge",
    );
    expect(() => mergeTopics(tree, "st-remy", "checkout", change("merge-cycle"))).toThrow(
      "topic_merge_cycle",
    );
    expect(() => fileMemory(tree, {
      filingId: "filing-too-confident",
      memoryId: "memory-too-confident",
      topicId: "website",
      relation: "primary",
      filedBy: "model",
      confidence: 1.01,
    }, change("file-too-confident"))).toThrow("topic_filing_confidence_invalid");
    expect(() => renameTopic(tree, "website", "Web", change("create-digital"))).toThrow(
      "topic_transition_id_exists",
    );
  });

  it("rejects a merge that would create duplicate child names", () => {
    let tree = nestedTree();
    tree = addTopic(tree, {
      topicId: "digital",
      name: "Digital",
      parentTopicId: "st-remy",
    }, change("create-digital"));
    tree = addTopic(tree, {
      topicId: "digital-checkout",
      name: "Checkout",
      parentTopicId: "digital",
    }, change("create-digital-checkout"));

    expect(() => mergeTopics(tree, "website", "digital", change("merge-duplicate"))).toThrow(
      "topic_sibling_name_exists",
    );
  });

  it("reparents merged children so walking the target includes grandchildren", () => {
    let tree = nestedTree();
    tree = addTopic(tree, {
      topicId: "digital",
      name: "Digital",
      parentTopicId: "st-remy",
    }, change("create-digital"));
    tree = fileMemory(tree, {
      filingId: "filing-checkout",
      memoryId: "memory-checkout",
      topicId: "checkout",
      relation: "primary",
      filedBy: "model",
      confidence: 0.9,
    }, change("file-checkout"));

    const merged = mergeTopics(tree, "website", "digital", change("merge-website"));

    expect(merged.topics.find((topic) => topic.topicId === "checkout")?.parentTopicId).toBe(
      "digital",
    );
    expect(walkTopic(merged, "digital")).toEqual({
      topicIds: ["digital", "checkout"],
      filings: [merged.filings[0]],
    });
  });

  it("deduplicates merge aliases that differ only in case", () => {
    let tree = nestedTree();
    tree = addTopic(tree, {
      topicId: "digital",
      name: "Digital",
      parentTopicId: "st-remy",
    }, change("create-digital"));
    tree = renameTopic(tree, "website", "Web platform", change("rename-website"));
    tree = renameTopic(tree, "digital", "WEBSITE", change("rename-digital"));

    const merged = mergeTopics(tree, "website", "digital", change("merge-case-alias"));
    const target = merged.topics.find((topic) => topic.topicId === "digital");

    expect(target?.aliases).toEqual(["Digital", "Web platform"]);
    expect(merged.history.at(-1)).toMatchObject({
      operation: "merge",
      addedAliases: ["Web platform"],
    });
  });
});
