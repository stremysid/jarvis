import type { AppendedEvent, SyncEventReader } from "../persistence/event-repository.js";
import type { ArchiveState } from "./archive-repository.js";

export interface ArchivedEventReader {
  readArchivedRange(afterSequence: number, limit: number): Promise<readonly AppendedEvent[]>;
}

export interface ArchiveStateReader {
  readState(): Promise<ArchiveState>;
}

export interface TieredEventReaderOptions {
  archive: ArchivedEventReader;
  live: SyncEventReader;
  state: ArchiveStateReader;
}

function requireRange(afterSequence: number, limit: number): void {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new RangeError("afterSequence must be a non-negative integer");
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) throw new RangeError("limit must be between 1 and 1000");
}

function requireClosed(state: ArchiveState): void {
  if (state.circuitState !== "closed") throw new Error("archive_circuit_open");
}

function requireContiguous(
  events: readonly AppendedEvent[],
  firstSequence: number,
  expectedCount: number | null,
  errorCode: string,
): void {
  if (expectedCount !== null && events.length !== expectedCount) throw new Error(errorCode);
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]!.eventSequence !== firstSequence + index) throw new Error(errorCode);
  }
}

/** Reads one global event sequence from verified R2 below the seal and D1 above it. */
export class TieredEventReader implements SyncEventReader {
  constructor(private readonly options: TieredEventReaderOptions) {}

  async latestSequence(): Promise<number> {
    const state = await this.options.state.readState();
    requireClosed(state);
    const liveLatest = await this.options.live.latestSequence();
    if (!Number.isSafeInteger(liveLatest) || liveLatest < 0) throw new Error("event_sequence_invalid");
    return Math.max(state.sealedThrough, liveLatest);
  }

  async readRange(afterSequence: number, limit: number): Promise<readonly AppendedEvent[]> {
    requireRange(afterSequence, limit);
    const state = await this.options.state.readState();
    requireClosed(state);
    const events: AppendedEvent[] = [];

    if (afterSequence < state.sealedThrough) {
      const archivedCount = Math.min(limit, state.sealedThrough - afterSequence);
      const archived = await this.options.archive.readArchivedRange(afterSequence, archivedCount);
      requireContiguous(archived, afterSequence + 1, archivedCount, "tiered_archive_range_incomplete");
      events.push(...archived);
    }

    if (events.length < limit) {
      const liveAfter = Math.max(afterSequence, state.sealedThrough);
      const live = await this.options.live.readRange(liveAfter, limit - events.length);
      requireContiguous(live, liveAfter + 1, null, "tiered_live_range_incomplete");
      events.push(...live);
    }
    requireContiguous(events, afterSequence + 1, null, "tiered_event_range_incomplete");
    return events;
  }
}
