import type { Ulid } from "../../../../packages/contracts/src/index.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const MAX_REFERENCED_ITEMS = 8;
const MAX_PENDING_TURNS = 256;

const pendingReferences = new Map<Ulid, readonly Ulid[]>();

/**
 * Carries references across the model/repository boundary for one request.
 * The durable copy is written into the staged assistant event; this map never
 * serves a later request and is bounded in case a model finishes but staging
 * cannot start.
 */
export function recordPendingTelegramMemoryReferences(
  turnId: Ulid,
  itemIds: readonly Ulid[],
): void {
  if (!ULID.test(turnId) || itemIds.length > MAX_REFERENCED_ITEMS
    || itemIds.some((itemId) => !ULID.test(itemId))) {
    throw new TypeError("telegram_memory_references_invalid");
  }
  const unique = [...new Set(itemIds)];
  if (unique.length !== itemIds.length) throw new TypeError("telegram_memory_references_invalid");
  if (unique.length === 0) {
    pendingReferences.delete(turnId);
    return;
  }
  if (!pendingReferences.has(turnId) && pendingReferences.size >= MAX_PENDING_TURNS) {
    const oldest = pendingReferences.keys().next().value as Ulid | undefined;
    if (oldest !== undefined) pendingReferences.delete(oldest);
  }
  pendingReferences.set(turnId, Object.freeze([...unique]));
}

export function takePendingTelegramMemoryReferences(turnId: Ulid): readonly Ulid[] {
  const itemIds = pendingReferences.get(turnId) ?? Object.freeze([] as Ulid[]);
  pendingReferences.delete(turnId);
  return itemIds;
}
