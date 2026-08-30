import type { ArchiveManifest } from "./archive-repository.js";

export interface ArchiveSegmentRunner {
  archiveEligible(now: Date, maxEvents: number): Promise<ArchiveManifest | null>;
}

/** Bounded cron seam; real scheduling is deliberately outside foundation Task 7. */
export class ArchivalWorker {
  constructor(private readonly archive: ArchiveSegmentRunner) {}

  run(now: Date, maxEvents: number): Promise<ArchiveManifest | null> {
    return this.archive.archiveEligible(now, maxEvents);
  }
}
