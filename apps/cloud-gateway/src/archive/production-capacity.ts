import type { Env } from "../env.js";
import { DeepSeekCreditReader, TwilioUsageReader } from "../providers/capacity-readers.js";
import { TelegramRestProvider } from "../providers/telegram-provider.js";
import { D1CapacityAlertSink } from "./capacity-alert-sink.js";
import { CapacityGuard } from "./capacity-guard.js";
import { ProductionCapacitySource } from "./capacity-source.js";

function positive(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/u.test(value)) {
    throw new TypeError("capacity_configuration_invalid");
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError("capacity_configuration_invalid");
  return number;
}

export function readCapacityConfiguration(env: Env) {
  const d1BudgetBytes = positive(env.CAPACITY_D1_BUDGET_BYTES);
  const r2BudgetBytes = positive(env.CAPACITY_R2_BUDGET_BYTES);
  const modelAllocationUsd = positive(env.CAPACITY_MODEL_ALLOCATION_USD);
  const twilioDailyBudgetUsd = positive(env.CAPACITY_TWILIO_DAILY_BUDGET_USD);
  if (!Number.isSafeInteger(d1BudgetBytes) || !Number.isSafeInteger(r2BudgetBytes)) {
    throw new TypeError("capacity_configuration_invalid");
  }
  return Object.freeze({ d1BudgetBytes, r2BudgetBytes, modelAllocationUsd, twilioDailyBudgetUsd });
}

/** Composes the existing source/sink ports; model migration remains R7. */
export function createProductionCapacityGuard(env: Env, now: () => Date = () => new Date()): CapacityGuard {
  const limits = readCapacityConfiguration(env);
  const model = new DeepSeekCreditReader({ apiKey: env.DEEPSEEK_API_KEY ?? "", currency: "USD", now });
  const voice = new TwilioUsageReader({ accountSid: env.TWILIO_ACCOUNT_SID ?? "", apiKeySid: env.TWILIO_API_KEY_SID ?? "",
    apiKeySecret: env.TWILIO_API_KEY_SECRET ?? "", currency: "USD", now });
  return new CapacityGuard({
    source: new ProductionCapacitySource({
      database: env.DB, archive: env.ARCHIVE, now,
      d1BudgetBytes: limits.d1BudgetBytes, r2BudgetBytes: limits.r2BudgetBytes,
      providers: [
        { resource: "provider:model", mode: "prepaid", budget: limits.modelAllocationUsd, currency: "USD", read: model.read.bind(model) },
        { resource: "provider:voice", mode: "postpaid", budget: limits.twilioDailyBudgetUsd, currency: "USD", read: voice.read.bind(voice) },
      ],
    }),
    sink: new D1CapacityAlertSink({ database: env.DB, ownerPrincipalId: env.OWNER_PRINCIPAL_ID ?? "", now,
      telegram: new TelegramRestProvider({ botToken: env.TELEGRAM_BOT_TOKEN ?? "", timeoutMs: 5000 }),
    }),
    now,
    maximumTelemetryAgeMs: 60_000,
  });
}
