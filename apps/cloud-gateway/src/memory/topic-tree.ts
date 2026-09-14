import { hasFactTextControls } from "../../../../packages/contracts/src/memory-projection.js";

export type TopicActor = "owner" | "rules" | "model";
export type TopicRelation = "primary" | "related";

export interface TopicNode {
  readonly topicId: string;
  readonly name: string;
  readonly parentTopicId: string | null;
  readonly aliases: readonly string[];
  readonly status: "active" | "merged";
  readonly redirectToTopicId: string | null;
}

export interface TopicFiling {
  readonly filingId: string;
  readonly memoryId: string;
  readonly topicId: string;
  readonly relation: TopicRelation;
  readonly filedBy: TopicActor;
  readonly confidence: number;
}

export interface TopicTransition {
  readonly transitionId: string;
  readonly occurredAt: string;
  readonly actor: TopicActor;
  readonly operation: "rename" | "move" | "merge";
  readonly topicId: string;
  readonly fromName?: string;
  readonly toName?: string;
  readonly fromParentTopicId?: string;
  readonly toParentTopicId?: string;
  readonly mergedIntoTopicId?: string;
}

export interface TopicTree {
  readonly rootTopicId: string;
  readonly topics: readonly TopicNode[];
  readonly filings: readonly TopicFiling[];
  readonly history: readonly TopicTransition[];
}

export interface TopicChange {
  readonly transitionId: string;
  readonly occurredAt: string;
  readonly actor: TopicActor;
}

export interface TopicWalk {
  readonly topicIds: readonly string[];
  readonly filings: readonly TopicFiling[];
}

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const RFC3339_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_NAME_BYTES = 256;

function freezeTopic(topic: TopicNode): TopicNode {
  return Object.freeze({ ...topic, aliases: Object.freeze([...topic.aliases]) });
}

function freezeTree(tree: TopicTree): TopicTree {
  return Object.freeze({
    rootTopicId: tree.rootTopicId,
    topics: Object.freeze(tree.topics.map(freezeTopic)),
    filings: Object.freeze(tree.filings.map((filing) => Object.freeze({ ...filing }))),
    history: Object.freeze(tree.history.map((entry) => Object.freeze({ ...entry }))),
  });
}

function requireIdentifier(value: string, error: string): void {
  if (!IDENTIFIER.test(value)) throw new TypeError(error);
}

function normalizeName(name: string): string {
  const normalized = name.normalize("NFC").trim();
  if (normalized.length === 0
    || hasFactTextControls(normalized)
    || new TextEncoder().encode(normalized).byteLength > MAX_NAME_BYTES) {
    throw new TypeError("topic_name_invalid");
  }
  return normalized;
}

function nameKey(name: string): string {
  return name.normalize("NFC").toLocaleLowerCase("en-US");
}

function findTopic(tree: TopicTree, topicId: string): TopicNode {
  const topic = tree.topics.find((candidate) => candidate.topicId === topicId);
  if (topic === undefined) throw new RangeError("topic_not_found");
  return topic;
}

function activeTopic(tree: TopicTree, topicId: string): TopicNode {
  const topic = findTopic(tree, topicId);
  if (topic.status !== "active") throw new RangeError("topic_not_active");
  return topic;
}

function requireUniqueSiblingName(
  tree: TopicTree,
  parentTopicId: string | null,
  name: string,
  exceptTopicId?: string,
): void {
  const duplicate = tree.topics.some((topic) =>
    topic.status === "active"
      && topic.parentTopicId === parentTopicId
      && topic.topicId !== exceptTopicId
      && nameKey(topic.name) === nameKey(name));
  if (duplicate) throw new RangeError("topic_sibling_name_exists");
}

function validateChange(tree: TopicTree, change: TopicChange): void {
  requireIdentifier(change.transitionId, "topic_transition_id_invalid");
  if (!RFC3339_MILLISECONDS.test(change.occurredAt)
    || Number.isNaN(Date.parse(change.occurredAt))) {
    throw new TypeError("topic_transition_time_invalid");
  }
  if (tree.history.some((entry) => entry.transitionId === change.transitionId)) {
    throw new RangeError("topic_transition_id_exists");
  }
}

function withTransition(
  tree: TopicTree,
  topics: readonly TopicNode[],
  transition: TopicTransition,
): TopicTree {
  return freezeTree({
    ...tree,
    topics,
    history: [...tree.history, transition],
  });
}

export function createTopicTree(root: { readonly topicId: string; readonly name: string }): TopicTree {
  requireIdentifier(root.topicId, "topic_id_invalid");
  const name = normalizeName(root.name);
  return freezeTree({
    rootTopicId: root.topicId,
    topics: [{
      topicId: root.topicId,
      name,
      parentTopicId: null,
      aliases: [],
      status: "active",
      redirectToTopicId: null,
    }],
    filings: [],
    history: [],
  });
}

export function resolveTopicId(tree: TopicTree, topicId: string): string {
  const visited = new Set<string>();
  let current = findTopic(tree, topicId);
  while (current.status === "merged") {
    if (current.redirectToTopicId === null || visited.has(current.topicId)) {
      throw new Error("topic_redirect_cycle");
    }
    visited.add(current.topicId);
    current = findTopic(tree, current.redirectToTopicId);
  }
  return current.topicId;
}

export function addTopic(
  tree: TopicTree,
  input: {
    readonly topicId: string;
    readonly name: string;
    readonly parentTopicId: string;
  },
): TopicTree {
  requireIdentifier(input.topicId, "topic_id_invalid");
  if (tree.topics.some((topic) => topic.topicId === input.topicId)) {
    throw new RangeError("topic_id_exists");
  }
  const parentTopicId = resolveTopicId(tree, input.parentTopicId);
  activeTopic(tree, parentTopicId);
  const name = normalizeName(input.name);
  requireUniqueSiblingName(tree, parentTopicId, name);
  return freezeTree({
    ...tree,
    topics: [...tree.topics, {
      topicId: input.topicId,
      name,
      parentTopicId,
      aliases: [],
      status: "active",
      redirectToTopicId: null,
    }],
  });
}

export function fileMemory(
  tree: TopicTree,
  input: {
    readonly filingId: string;
    readonly memoryId: string;
    readonly topicId: string;
    readonly relation: TopicRelation;
    readonly filedBy: TopicActor;
    readonly confidence: number;
  },
): TopicTree {
  requireIdentifier(input.filingId, "topic_filing_id_invalid");
  requireIdentifier(input.memoryId, "topic_memory_id_invalid");
  if (tree.filings.some((filing) => filing.filingId === input.filingId)) {
    throw new RangeError("topic_filing_id_exists");
  }
  if (!Number.isFinite(input.confidence)
    || input.confidence < 0
    || input.confidence > 1) {
    throw new RangeError("topic_filing_confidence_invalid");
  }
  if (input.relation === "primary"
    && tree.filings.some((filing) =>
      filing.memoryId === input.memoryId && filing.relation === "primary")) {
    throw new RangeError("topic_primary_filing_exists");
  }
  const topicId = resolveTopicId(tree, input.topicId);
  activeTopic(tree, topicId);
  return freezeTree({
    ...tree,
    filings: [...tree.filings, Object.freeze({ ...input, topicId })],
  });
}

export function topicPath(tree: TopicTree, topicId: string): readonly string[] {
  const path: string[] = [];
  const visited = new Set<string>();
  let current = activeTopic(tree, resolveTopicId(tree, topicId));
  while (true) {
    if (visited.has(current.topicId)) throw new Error("topic_parent_cycle");
    visited.add(current.topicId);
    path.unshift(current.name);
    if (current.parentTopicId === null) break;
    current = activeTopic(tree, resolveTopicId(tree, current.parentTopicId));
  }
  return Object.freeze(path);
}

function descendantIds(tree: TopicTree, rootTopicId: string): readonly string[] {
  const ordered: string[] = [];
  const visit = (topicId: string): void => {
    ordered.push(topicId);
    const children = tree.topics
      .filter((topic) => topic.status === "active" && topic.parentTopicId === topicId)
      .toSorted((left, right) =>
        nameKey(left.name).localeCompare(nameKey(right.name), "en-US")
          || left.topicId.localeCompare(right.topicId, "en-US"));
    for (const child of children) visit(child.topicId);
  };
  visit(rootTopicId);
  return ordered;
}

export function walkTopic(tree: TopicTree, topicId: string): TopicWalk {
  const canonicalTopicId = resolveTopicId(tree, topicId);
  const topicIds = descendantIds(tree, canonicalTopicId);
  const included = new Set(topicIds);
  const filings = tree.filings.filter((filing) =>
    included.has(resolveTopicId(tree, filing.topicId)));
  return Object.freeze({
    topicIds: Object.freeze([...topicIds]),
    filings: Object.freeze([...filings]),
  });
}

export function renameTopic(
  tree: TopicTree,
  topicId: string,
  nextName: string,
  change: TopicChange,
): TopicTree {
  validateChange(tree, change);
  const topic = activeTopic(tree, topicId);
  const name = normalizeName(nextName);
  if (name === topic.name) throw new RangeError("topic_name_unchanged");
  requireUniqueSiblingName(tree, topic.parentTopicId, name, topic.topicId);
  const aliases = topic.aliases.includes(topic.name)
    ? topic.aliases
    : [...topic.aliases, topic.name];
  const topics = tree.topics.map((candidate) => candidate.topicId === topicId
    ? { ...candidate, name, aliases }
    : candidate);
  return withTransition(tree, topics, {
    ...change,
    operation: "rename",
    topicId,
    fromName: topic.name,
    toName: name,
  });
}

export function moveTopic(
  tree: TopicTree,
  topicId: string,
  nextParentTopicId: string,
  change: TopicChange,
): TopicTree {
  validateChange(tree, change);
  const topic = activeTopic(tree, topicId);
  if (topic.topicId === tree.rootTopicId) throw new RangeError("topic_root_cannot_move");
  const parentTopicId = resolveTopicId(tree, nextParentTopicId);
  activeTopic(tree, parentTopicId);
  if (descendantIds(tree, topicId).includes(parentTopicId)) {
    throw new RangeError("topic_move_cycle");
  }
  if (topic.parentTopicId === parentTopicId) throw new RangeError("topic_parent_unchanged");
  requireUniqueSiblingName(tree, parentTopicId, topic.name, topic.topicId);
  const topics = tree.topics.map((candidate) => candidate.topicId === topicId
    ? { ...candidate, parentTopicId }
    : candidate);
  return withTransition(tree, topics, {
    ...change,
    operation: "move",
    topicId,
    fromParentTopicId: topic.parentTopicId ?? tree.rootTopicId,
    toParentTopicId: parentTopicId,
  });
}

export function mergeTopics(
  tree: TopicTree,
  sourceTopicId: string,
  targetTopicId: string,
  change: TopicChange,
): TopicTree {
  validateChange(tree, change);
  const source = activeTopic(tree, sourceTopicId);
  const target = activeTopic(tree, targetTopicId);
  if (source.topicId === tree.rootTopicId) throw new RangeError("topic_root_cannot_merge");
  if (source.topicId === target.topicId) throw new RangeError("topic_merge_same_topic");
  if (descendantIds(tree, source.topicId).includes(target.topicId)) {
    throw new RangeError("topic_merge_cycle");
  }

  const movingChildren = tree.topics.filter((topic) =>
    topic.status === "active" && topic.parentTopicId === source.topicId);
  for (const child of movingChildren) {
    requireUniqueSiblingName(tree, target.topicId, child.name, child.topicId);
  }
  const targetAliases = [...target.aliases];
  for (const alias of [source.name, ...source.aliases]) {
    if (!targetAliases.includes(alias) && alias !== target.name) targetAliases.push(alias);
  }

  const topics = tree.topics.map((topic) => {
    if (topic.topicId === source.topicId) {
      return {
        ...topic,
        status: "merged" as const,
        redirectToTopicId: target.topicId,
      };
    }
    if (topic.topicId === target.topicId) return { ...topic, aliases: targetAliases };
    if (topic.parentTopicId === source.topicId && topic.status === "active") {
      return { ...topic, parentTopicId: target.topicId };
    }
    return topic;
  });
  return withTransition(tree, topics, {
    ...change,
    operation: "merge",
    topicId: source.topicId,
    mergedIntoTopicId: target.topicId,
  });
}
