export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  CALL_SESSION: DurableObjectNamespace;
}
