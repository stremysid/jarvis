/**
 * The one Classroom deadline/observation source this deployment reads.
 *
 * Kept in its own module so both the jobs table and the agent core can name it
 * without importing each other's graph. There is no second Classroom source:
 * `0027_school_observations.sql` binds every observation row to a
 * `kind = 'classroom'` deadline source, and the collector path for Brightspace
 * is separate.
 */
export const CLASSROOM_SOURCE_ID = "google-classroom";
