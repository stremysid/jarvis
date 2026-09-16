import { newUlid, type Ulid } from "../../../../packages/contracts/src/index.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u;
const USD_MICROS = 1_000_000;
const TOKEN_PRICE_DENOMINATOR = 1_000_000;
const REQUEST_TOKEN_OVERHEAD = 512;
const MAX_REQUEST_BYTES = 131_072;
const MAX_OUTPUT_TOKENS = 2_048;
const TORONTO = "America/Toronto";

export const MEMORY_EXTRACTION_PRICE_PREPARATION_D1_STATEMENT_CEILING = 3;
export const MEMORY_EXTRACTION_PROVIDER_D1_STATEMENT_CEILING = 8;

export interface MemoryExtractionPrice {
  readonly modelId: string;
  readonly providerModelId: `deepseek:${string}`;
  readonly effectiveAt: string;
  readonly inputMicrosPerMillion: number;
  readonly outputMicrosPerMillion: number;
  readonly cacheReadMicrosPerMillion: number;
  readonly sourceReceipt: string;
}

/**
 * Peak rates are deliberate. The scheduled hour can cross a price window, so
 * reserving at DeepSeek's highest published rate is the only static table that
 * cannot under-reserve. Source reviewed 2026-09-16:
 * https://api-docs.deepseek.com/quick_start/pricing
 */
export const DEEPSEEK_MEMORY_EXTRACTION_PRICES: Readonly<Record<string, MemoryExtractionPrice>> = Object.freeze({
  "deepseek-flash": Object.freeze({
    modelId: "deepseek-flash",
    providerModelId: "deepseek:deepseek-flash",
    effectiveAt: "2026-08-16T16:00:00.000Z",
    inputMicrosPerMillion: 300_000,
    outputMicrosPerMillion: 1_200_000,
    cacheReadMicrosPerMillion: 6_000,
    sourceReceipt: "DeepSeek API pricing reviewed 2026-09-16; peak USD rates; https://api-docs.deepseek.com/quick_start/pricing",
  }),
  "deepseek-v4-pro": Object.freeze({
    modelId: "deepseek-v4-pro",
    providerModelId: "deepseek:deepseek-v4-pro",
    effectiveAt: "2026-08-16T16:00:00.000Z",
    inputMicrosPerMillion: 1_320_000,
    outputMicrosPerMillion: 3_960_000,
    cacheReadMicrosPerMillion: 44_000,
    sourceReceipt: "DeepSeek API pricing reviewed 2026-09-16; peak USD rates; https://api-docs.deepseek.com/quick_start/pricing",
  }),
});

export type MemoryExtractionFailureCode =
  | "memory_extraction_cap_invalid"
  | "memory_extraction_monthly_cap_exceeded"
  | "memory_extraction_model_unknown"
  | "memory_extraction_price_unavailable"
  | "memory_extraction_settlement_failed"
  | "memory_extraction_usage_invalid";

const issuedFailures = new WeakSet<object>();

/** Fixed-code failures only. Provider bodies, settings and ledger rows stay private. */
export class MemoryExtractionFailure extends Error {
  constructor(readonly code: MemoryExtractionFailureCode) {
    super(code);
    this.name = "MemoryExtractionFailure";
    Object.freeze(this);
    issuedFailures.add(this);
  }
}

export function snapshotMemoryExtractionFailure(error: unknown): MemoryExtractionFailureCode | null {
  if (!(error instanceof MemoryExtractionFailure) || !issuedFailures.has(error) || !Object.isFrozen(error)) return null;
  return error.code;
}

export interface PreparedMemoryExtractionPrice {
  readonly priceId: Ulid;
  readonly providerModelId: `deepseek:${string}`;
  readonly d1Statements: number;
}

export interface MemoryExtractionReservation {
  readonly reservationEntryId: Ulid;
  readonly principalId: string;
  readonly runId: Ulid;
  readonly priceId: Ulid;
  readonly providerModelId: `deepseek:${string}`;
  readonly reservedCostMicros: number;
  readonly inputTokenCeiling: number;
  readonly maxOutputTokens: number;
  readonly reservedAt: string;
  readonly monthKey: string;
  readonly monthStartAt: string;
  readonly monthEndAt: string;
}

export interface MemoryExtractionReportedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
}

export interface SettledMemoryExtractionUsage extends MemoryExtractionReportedUsage {
  readonly priceId: Ulid;
  readonly reservedCostMicros: number;
  readonly settledCostMicros: number;
  /** Charged at the declared ceiling so the hourly budget cannot under-count a warning path. */
  readonly d1Statements: number;
}

export interface MemoryExtractionNotice {
  send(text: string): Promise<void>;
}

export interface MemoryExtractionBudgetPort {
  readonly providerModelId: `deepseek:${string}`;
  prepare(principalId: string): Promise<PreparedMemoryExtractionPrice>;
  reserve(input: Readonly<{
    principalId: string;
    runId: Ulid;
    priceId: Ulid;
    requestBytes: number;
    maxOutputTokens: number;
  }>): Promise<MemoryExtractionReservation>;
  settle(
    reservation: MemoryExtractionReservation,
    usage: MemoryExtractionReportedUsage,
  ): Promise<SettledMemoryExtractionUsage>;
  notifyCreditBlocked?(principalId: string): Promise<void>;
}

export interface TorontoBillingMonth {
  readonly key: string;
  readonly label: string;
  readonly startAt: string;
  readonly endAt: string;
}

interface PriceRow {
  readonly price_id: unknown;
  readonly provider: unknown;
  readonly model_id: unknown;
  readonly effective_at: unknown;
  readonly input_micros_per_million: unknown;
  readonly output_micros_per_million: unknown;
  readonly cache_read_micros_per_million: unknown;
  readonly currency: unknown;
  readonly source_receipt: unknown;
}

export interface MemoryExtractionBudgetOptions {
  readonly database: D1Database;
  readonly modelId: string;
  readonly monthlyCapUsd?: string;
  readonly now: () => Date;
  readonly notice?: MemoryExtractionNotice;
  readonly nextId?: (now: Date) => Ulid;
}

const priceFields = new Set([
  "price_id", "provider", "model_id", "effective_at", "input_micros_per_million",
  "output_micros_per_million", "cache_read_micros_per_million", "currency", "source_receipt",
]);

const torontoParts = new Intl.DateTimeFormat("en-CA-u-ca-iso8601", {
  timeZone: TORONTO,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function failure(code: MemoryExtractionFailureCode): never {
  throw new MemoryExtractionFailure(code);
}

function exactRow(value: object, fields: ReadonlySet<string>): void {
  const keys = Reflect.ownKeys(value);
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== fields.size
    || keys.some((key) => typeof key !== "string" || !fields.has(key))) {
    failure("memory_extraction_price_unavailable");
  }
}

function safeText(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
    || value.normalize("NFC") !== value || !SAFE_TEXT.test(value)
    || new TextEncoder().encode(value).byteLength > maximumBytes) {
    failure("memory_extraction_price_unavailable");
  }
  return value;
}

function safeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    failure("memory_extraction_price_unavailable");
  }
  return value as number;
}

function dateParts(date: Date): Readonly<{ year: number; month: number; day: number; hour: number; minute: number; second: number }> {
  const values = new Map(torontoParts.formatToParts(date).map((part) => [part.type, part.value]));
  const parsed = {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
  };
  if (Object.values(parsed).some((value) => !Number.isSafeInteger(value))) {
    failure("memory_extraction_price_unavailable");
  }
  return Object.freeze(parsed);
}

function torontoMidnight(year: number, month: number): Date {
  const target = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
  let instant = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = dateParts(new Date(instant));
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
    const difference = represented - target;
    if (difference === 0) break;
    instant -= difference;
  }
  const result = new Date(instant);
  const parts = dateParts(result);
  if (parts.year !== year || parts.month !== month || parts.day !== 1
    || parts.hour !== 0 || parts.minute !== 0 || parts.second !== 0) {
    failure("memory_extraction_price_unavailable");
  }
  return result;
}

export function torontoBillingMonth(now: Date): TorontoBillingMonth {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) failure("memory_extraction_price_unavailable");
  const current = dateParts(now);
  const nextYear = current.month === 12 ? current.year + 1 : current.year;
  const nextMonth = current.month === 12 ? 1 : current.month + 1;
  const label = new Intl.DateTimeFormat("en-CA", {
    timeZone: TORONTO,
    month: "long",
    year: "numeric",
  }).format(torontoMidnight(current.year, current.month));
  return Object.freeze({
    key: `${current.year.toString().padStart(4, "0")}-${current.month.toString().padStart(2, "0")}`,
    label,
    startAt: torontoMidnight(current.year, current.month).toISOString(),
    endAt: torontoMidnight(nextYear, nextMonth).toISOString(),
  });
}

export function memoryExtractionCapMicros(value: string | undefined): number | null {
  const selected = value ?? "5";
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/u.test(selected)) return null;
  const [whole, fraction = ""] = selected.split(".");
  const micros = Number(whole) * USD_MICROS + Number(fraction.padEnd(6, "0"));
  return Number.isSafeInteger(micros) && micros > 0 ? micros : null;
}

function quotedCostMicros(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  price: MemoryExtractionPrice,
): number {
  const cacheMissTokens = inputTokens - cacheReadTokens;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)
    || !Number.isSafeInteger(cacheReadTokens) || inputTokens < 0 || outputTokens < 0
    || cacheReadTokens < 0 || cacheMissTokens < 0) failure("memory_extraction_usage_invalid");
  const numerator = cacheMissTokens * price.inputMicrosPerMillion
    + cacheReadTokens * price.cacheReadMicrosPerMillion
    + outputTokens * price.outputMicrosPerMillion;
  if (!Number.isSafeInteger(numerator) || numerator < 0) failure("memory_extraction_usage_invalid");
  return Math.ceil(numerator / TOKEN_PRICE_DENOMINATOR);
}

function deepSeekPeakAt(value: Date): boolean {
  const day = value.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = value.getUTCHours();
  return hour >= 1 && hour < 4 || hour >= 6 && hour < 10;
}

function settlementPrice(
  price: MemoryExtractionPrice,
  startedAt: Date,
  completedAt: Date,
): MemoryExtractionPrice {
  if (deepSeekPeakAt(startedAt) || deepSeekPeakAt(completedAt)) return price;
  return Object.freeze({
    ...price,
    inputMicrosPerMillion: Math.ceil(price.inputMicrosPerMillion / 2),
    outputMicrosPerMillion: Math.ceil(price.outputMicrosPerMillion / 2),
    cacheReadMicrosPerMillion: Math.ceil(price.cacheReadMicrosPerMillion / 2),
  });
}

export const MEMORY_EXTRACTION_MONTH_ENTRIES_SQL = `SELECT cost_entry_id, entry_type,
    reservation_entry_id, amount_micros
  FROM memory_cost_ledger INDEXED BY memory_cost_ledger_month_lookup
  WHERE principal_id = ?1 AND budget_class = 'normal_monthly'
    AND occurred_at >= ?2 AND occurred_at < ?3`;

const MEMORY_EXTRACTION_MONTH_SPEND_SQL = `SELECT COALESCE(sum(CASE
    WHEN release.cost_entry_id IS NOT NULL THEN 0
    WHEN settlement.cost_entry_id IS NOT NULL
      THEN settlement.amount_micros + COALESCE(overrun.amount_micros, 0)
    ELSE reservation.amount_micros
  END), 0) AS amount
  FROM month_entries reservation
  LEFT JOIN month_entries release
    ON release.reservation_entry_id = reservation.cost_entry_id
      AND release.entry_type = 'release'
  LEFT JOIN month_entries settlement
    ON settlement.reservation_entry_id = reservation.cost_entry_id
      AND settlement.entry_type = 'settlement'
  LEFT JOIN month_entries overrun
    ON overrun.reservation_entry_id = reservation.cost_entry_id
      AND overrun.entry_type = 'overrun'
  WHERE reservation.entry_type = 'reservation'`;

function formatUsd(micros: number): string {
  const whole = Math.floor(micros / USD_MICROS);
  const fraction = (micros % USD_MICROS).toString().padStart(6, "0").replace(/0+$/u, "");
  return `$${whole}${fraction.length === 0 ? ".00" : `.${fraction}`}`;
}

/** Atomic normal-month reservations and settlements over the existing 0016 ledger. */
export class MemoryExtractionBudget implements MemoryExtractionBudgetPort {
  readonly providerModelId: `deepseek:${string}`;
  private readonly price: MemoryExtractionPrice | null;
  private readonly capMicros: number | null;
  private readonly nextId: (now: Date) => Ulid;
  private readonly prepared = new Map<string, Ulid>();

  constructor(private readonly options: MemoryExtractionBudgetOptions) {
    this.price = DEEPSEEK_MEMORY_EXTRACTION_PRICES[options.modelId] ?? null;
    this.providerModelId = `deepseek:${options.modelId}`;
    this.capMicros = memoryExtractionCapMicros(options.monthlyCapUsd);
    this.nextId = options.nextId ?? newUlid;
  }

  async prepare(principalIdValue: string): Promise<PreparedMemoryExtractionPrice> {
    const principalId = safeText(principalIdValue, 256);
    const price = this.price;
    if (price === null) failure("memory_extraction_model_unknown");
    let d1Statements = 1;
    let row = await this.readPrice(principalId, price);
    if (row === null) {
      const now = this.now();
      const priceId = this.nextId(now);
      if (!ULID.test(priceId)) failure("memory_extraction_price_unavailable");
      d1Statements += 1;
      try {
        await this.options.database.prepare(`INSERT INTO memory_model_prices (
          price_id, principal_id, provider, model_id, effective_at,
          input_micros_per_million, output_micros_per_million,
          cache_read_micros_per_million, currency, source_receipt, created_at
        ) VALUES (?, ?, 'deepseek', ?, ?, ?, ?, ?, 'USD', ?, ?)`)
          .bind(
            priceId,
            principalId,
            price.providerModelId,
            price.effectiveAt,
            price.inputMicrosPerMillion,
            price.outputMicrosPerMillion,
            price.cacheReadMicrosPerMillion,
            price.sourceReceipt,
            now.toISOString(),
          ).run();
        row = priceId;
      } catch {
        d1Statements += 1;
        row = await this.readPrice(principalId, price);
        if (row === null) failure("memory_extraction_price_unavailable");
      }
    }
    this.prepared.set(principalId, row);
    return Object.freeze({ priceId: row, providerModelId: price.providerModelId, d1Statements });
  }

  async reserve(input: Readonly<{
    principalId: string;
    runId: Ulid;
    priceId: Ulid;
    requestBytes: number;
    maxOutputTokens: number;
  }>): Promise<MemoryExtractionReservation> {
    const capMicros = this.capMicros;
    if (capMicros === null) failure("memory_extraction_cap_invalid");
    const price = this.price;
    if (price === null) failure("memory_extraction_model_unknown");
    const principalId = safeText(input.principalId, 256);
    if (!ULID.test(input.runId) || !ULID.test(input.priceId)
      || this.prepared.get(principalId) !== input.priceId
      || !Number.isSafeInteger(input.requestBytes) || input.requestBytes <= 0 || input.requestBytes > MAX_REQUEST_BYTES
      || !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0
      || input.maxOutputTokens > MAX_OUTPUT_TOKENS) {
      failure("memory_extraction_price_unavailable");
    }
    const inputTokenCeiling = input.requestBytes + REQUEST_TOKEN_OVERHEAD;
    const reservedCostMicros = quotedCostMicros(inputTokenCeiling, input.maxOutputTokens, 0, price);
    if (reservedCostMicros <= 0) failure("memory_extraction_price_unavailable");
    const now = this.now();
    const month = torontoBillingMonth(now);
    const reservationEntryId = this.nextId(now);
    if (!ULID.test(reservationEntryId)) failure("memory_extraction_price_unavailable");
    const inserted = await this.options.database.prepare(`WITH month_entries AS (
        ${MEMORY_EXTRACTION_MONTH_ENTRIES_SQL}
      ), month_spend AS (
        ${MEMORY_EXTRACTION_MONTH_SPEND_SQL}
      )
      INSERT INTO memory_cost_ledger (
        cost_entry_id, principal_id, run_id, entry_type, reservation_entry_id,
        provider, model_id, budget_class, reprocess_job_id, amount_micros,
        price_id, occurred_at
      ) SELECT ?4, ?1, ?5, 'reservation', NULL, 'deepseek', ?6,
        'normal_monthly', NULL, ?7, ?8, ?9
      WHERE ?7 + (SELECT amount FROM month_spend) <= ?10
      RETURNING cost_entry_id`)
      .bind(
        principalId,
        month.startAt,
        month.endAt,
        reservationEntryId,
        input.runId,
        price.providerModelId,
        reservedCostMicros,
        input.priceId,
        now.toISOString(),
        capMicros,
      ).first<{ cost_entry_id: unknown }>();
    if (inserted === null) failure("memory_extraction_monthly_cap_exceeded");
    if (inserted.cost_entry_id !== reservationEntryId) failure("memory_extraction_price_unavailable");
    return Object.freeze({
      reservationEntryId,
      principalId,
      runId: input.runId,
      priceId: input.priceId,
      providerModelId: price.providerModelId,
      reservedCostMicros,
      inputTokenCeiling,
      maxOutputTokens: input.maxOutputTokens,
      reservedAt: now.toISOString(),
      monthKey: month.key,
      monthStartAt: month.startAt,
      monthEndAt: month.endAt,
    });
  }

  async settle(
    reservation: MemoryExtractionReservation,
    usage: MemoryExtractionReportedUsage,
  ): Promise<SettledMemoryExtractionUsage> {
    const price = this.price;
    const capMicros = this.capMicros;
    if (price === null || capMicros === null
      || reservation.providerModelId !== price.providerModelId
      || this.prepared.get(reservation.principalId) !== reservation.priceId
      || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0
      || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0
      || !Number.isSafeInteger(usage.cacheReadTokens) || usage.cacheReadTokens < 0
      || usage.cacheReadTokens > usage.inputTokens
      || usage.inputTokens > reservation.inputTokenCeiling
      || usage.outputTokens > reservation.maxOutputTokens) {
      failure("memory_extraction_usage_invalid");
    }
    const completedAt = this.now();
    const reservedAt = new Date(reservation.reservedAt);
    if (!Number.isFinite(reservedAt.getTime()) || reservedAt.toISOString() !== reservation.reservedAt
      || completedAt < reservedAt) failure("memory_extraction_usage_invalid");
    const settledCostMicros = quotedCostMicros(
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      settlementPrice(price, reservedAt, completedAt),
    );
    if (settledCostMicros > reservation.reservedCostMicros) failure("memory_extraction_usage_invalid");
    const now = completedAt;
    const settlementId = this.nextId(now);
    if (!ULID.test(settlementId)) failure("memory_extraction_settlement_failed");
    try {
      await this.options.database.prepare(`INSERT INTO memory_cost_ledger (
        cost_entry_id, principal_id, run_id, entry_type, reservation_entry_id,
        provider, model_id, budget_class, reprocess_job_id, amount_micros,
        price_id, occurred_at
      ) VALUES (?, ?, ?, 'settlement', ?, 'deepseek', ?, 'normal_monthly',
        NULL, ?, ?, ?)`)
        .bind(
          settlementId,
          reservation.principalId,
          reservation.runId,
          reservation.reservationEntryId,
          reservation.providerModelId,
          settledCostMicros,
          reservation.priceId,
          now.toISOString(),
        ).run();
    } catch {
      failure("memory_extraction_settlement_failed");
    }
    try {
      await this.warnAtEightyPercent(reservation, capMicros);
    } catch {
      // Spend is already durable. The monthly claim remains available for a
      // later settled call to recover without changing extraction admission.
    }
    return Object.freeze({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      priceId: reservation.priceId,
      reservedCostMicros: reservation.reservedCostMicros,
      settledCostMicros,
      d1Statements: MEMORY_EXTRACTION_PROVIDER_D1_STATEMENT_CEILING,
    });
  }

  private now(): Date {
    const value = this.options.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) failure("memory_extraction_price_unavailable");
    return new Date(value.getTime());
  }

  private async readPrice(principalId: string, price: MemoryExtractionPrice): Promise<Ulid | null> {
    const row = await this.options.database.prepare(`SELECT price_id, provider, model_id, effective_at,
        input_micros_per_million, output_micros_per_million,
        cache_read_micros_per_million, currency, source_receipt
      FROM memory_model_prices
      WHERE principal_id = ? AND model_id = ? AND effective_at = ?`)
      .bind(principalId, price.providerModelId, price.effectiveAt).first<PriceRow>();
    if (row === null) return null;
    exactRow(row, priceFields);
    if (typeof row.price_id !== "string" || !ULID.test(row.price_id)
      || row.provider !== "deepseek" || row.model_id !== price.providerModelId
      || row.effective_at !== price.effectiveAt
      || safeInteger(row.input_micros_per_million) !== price.inputMicrosPerMillion
      || safeInteger(row.output_micros_per_million) !== price.outputMicrosPerMillion
      || safeInteger(row.cache_read_micros_per_million) !== price.cacheReadMicrosPerMillion
      || row.currency !== "USD" || row.source_receipt !== price.sourceReceipt) {
      failure("memory_extraction_price_unavailable");
    }
    return row.price_id as Ulid;
  }

  private async monthSpend(reservation: MemoryExtractionReservation): Promise<number> {
    const row = await this.options.database.prepare(`WITH month_entries AS (
        ${MEMORY_EXTRACTION_MONTH_ENTRIES_SQL}
      )
      ${MEMORY_EXTRACTION_MONTH_SPEND_SQL}`)
      .bind(reservation.principalId, reservation.monthStartAt, reservation.monthEndAt)
      .first<{ amount: unknown }>();
    if (row === null) failure("memory_extraction_settlement_failed");
    return safeInteger(row.amount);
  }

  private async warnAtEightyPercent(
    reservation: MemoryExtractionReservation,
    capMicros: number,
  ): Promise<void> {
    const notice = this.options.notice;
    if (notice === undefined) return;
    const spent = await this.monthSpend(reservation);
    if (spent * 100 < capMicros * 80) return;
    const alertKey = `memory-extraction:${reservation.monthKey}:80`;
    const month = torontoBillingMonth(new Date(reservation.monthStartAt));
    await this.sendClaimedNotice(
      reservation.principalId,
      alertKey,
      `Memory extraction has used at least 80% of its ${formatUsd(capMicros)} limit for ${month.label}. `
        + "I will stop extracting new memories before that limit is exceeded.",
    );
  }

  async notifyCreditBlocked(principalIdValue: string): Promise<void> {
    if (this.options.notice === undefined) return;
    const principalId = safeText(principalIdValue, 256);
    const now = this.now();
    const parts = dateParts(now);
    const dayKey = `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}`
      + `-${parts.day.toString().padStart(2, "0")}`;
    await this.sendClaimedNotice(
      principalId,
      `memory-extraction:provider-credit:${dayKey}`,
      "DeepSeek refused memory extraction because its provider credit is unavailable. "
        + "Jarvis will retry automatically, but new automatic memories may be delayed.",
    );
  }

  private async sendClaimedNotice(principalId: string, alertKey: string, text: string): Promise<void> {
    const notice = this.options.notice;
    if (notice === undefined) return;
    const now = this.now();
    const claimId = this.nextId(now);
    const expiresAt = new Date(now.getTime() + 30_000).toISOString();
    const claim = await this.options.database.prepare(`INSERT INTO capacity_alert_crossings
      (owner_principal_id, alert_key, claim_id, state, claimed_at, lease_expires_at, sent_at)
      VALUES (?1, ?2, ?3, 'sending', ?4, ?5, NULL)
      ON CONFLICT(owner_principal_id, alert_key) DO UPDATE SET
        claim_id = excluded.claim_id, state = 'sending', claimed_at = excluded.claimed_at,
        lease_expires_at = excluded.lease_expires_at, sent_at = NULL
      WHERE capacity_alert_crossings.state = 'sending'
        AND capacity_alert_crossings.lease_expires_at <= ?4
      RETURNING claim_id`)
      .bind(principalId, alertKey, claimId, now.toISOString(), expiresAt)
      .first<{ claim_id: unknown }>();
    if (claim === null) return;
    if (claim.claim_id !== claimId) failure("memory_extraction_settlement_failed");
    await notice.send(text);
    const sentAt = this.now().toISOString();
    const recorded = await this.options.database.prepare(`UPDATE capacity_alert_crossings
      SET state = 'sent', sent_at = ?
      WHERE owner_principal_id = ? AND alert_key = ? AND claim_id = ?
        AND state = 'sending' AND lease_expires_at > ?`)
      .bind(sentAt, principalId, alertKey, claimId, sentAt).run();
    if (recorded.meta.changes !== 1) failure("memory_extraction_settlement_failed");
  }
}
