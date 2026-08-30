/** D1 batches are the only transaction primitive used by the persistence layer. */
export class TransactionRunner {
  constructor(private readonly database: D1Database) {}

  batch(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<unknown>[]> {
    return this.database.batch([...statements]);
  }
}
