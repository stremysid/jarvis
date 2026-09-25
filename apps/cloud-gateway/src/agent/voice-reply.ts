import type { ExecutedTool } from "./owner-agent-core.js";
import { VoiceSentences } from "./voice-sentences.js";
import { Redactor } from "../security/redaction.js";
import { StreamingOutputRedactor } from "../security/streaming-output-redactor.js";
import {
  guardVoiceReplySentence, UNRECEIPTED_VOICE_ACTION, type ReceiptedToolSentence,
} from "../school/school-catchup-model.js";

interface Claim {
  readonly toolName: string;
  readonly receiptIds: readonly string[];
}

interface ClaimSpan {
  readonly start: number;
  readonly end: number;
  readonly claim: Claim;
}

export interface CheckedVoiceSentence {
  readonly text: string;
  readonly replaced: boolean;
}

function parseClaim(header: string): Claim {
  const claim = Object(JSON.parse(header)) as Record<string, unknown>;
  if (Object.keys(claim).sort().join(",") !== "receiptIds,toolName"
    || typeof claim.toolName !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(claim.toolName)
    || !Array.isArray(claim.receiptIds) || claim.receiptIds.length > 4
    || claim.receiptIds.some((id: unknown) => typeof id !== "string" || !/^[A-Za-z0-9:_-]{1,160}$/u.test(id))
    || new Set(claim.receiptIds).size !== claim.receiptIds.length) throw new TypeError("voice_claim_invalid");
  return { toolName: claim.toolName, receiptIds: claim.receiptIds as string[] };
}

/**
 * Markers declare judgment; they do not grant authority. Buffer each marked
 * sentence until its closing marker, strip metadata, redact the original
 * prose, then bind that one sentence to this turn's executed receipts.
 */
export class VoiceReplyStream {
  private pending = "";
  private claim: Claim | null = null;
  private raw = "";
  private redactedPrefix = "";
  private index = 0;
  private readonly spans: ClaimSpan[] = [];
  // Sid's reader. A guest session's reply is redacted again for its own
  // reader by the conversation service's output redactor downstream.
  private readonly redactor = new Redactor("owner");
  private readonly output = new StreamingOutputRedactor(this.redactor, undefined, true);

  constructor(
    private readonly executed: readonly ExecutedTool[],
    private readonly receiptSentences: ReadonlySet<string>,
  ) {}

  push(text: string): readonly CheckedVoiceSentence[] {
    this.pending += text;
    const result: CheckedVoiceSentence[] = [];
    while (this.pending.length > 0) {
      if (this.claim !== null) {
        const close = this.pending.indexOf("[[/claim]]");
        if (close < 0) break;
        const body = this.pending.slice(0, close);
        const sentences = new VoiceSentences();
        if (body.includes("[[") || !/[.!?]["'’”)]*$/u.test(body.trim())
          || [...sentences.push(body), ...sentences.finish()].length !== 1) throw new TypeError("voice_claim_sentence_invalid");
        this.spans.push({ start: this.raw.length, end: this.raw.length + body.length, claim: this.claim });
        this.claim = null;
        this.pending = this.pending.slice(close + "[[/claim]]".length);
        result.push(...this.append(body));
        continue;
      }
      const marker = this.pending.indexOf("[[");
      if (marker < 0) {
        // Retain a lone '[' so a marker split across provider chunks never
        // becomes spoken text before we know whether it opens a declaration.
        const end = this.pending.endsWith("[") ? this.pending.length - 1 : this.pending.length;
        result.push(...this.append(this.pending.slice(0, end)));
        this.pending = this.pending.slice(end);
        break;
      }
      if (marker > 0) {
        result.push(...this.append(this.pending.slice(0, marker)));
        this.pending = this.pending.slice(marker);
      }
      const end = this.pending.indexOf("]]");
      if (end < 0) break;
      if (!this.pending.startsWith("[[claim ")) throw new TypeError("voice_claim_invalid");
      this.claim = parseClaim(this.pending.slice("[[claim ".length, end));
      this.pending = this.pending.slice(end + 2);
    }
    return result;
  }

  finish(): readonly CheckedVoiceSentence[] {
    if (this.claim !== null || this.pending.length > 0) throw new TypeError("voice_claim_incomplete");
    if (this.index === 0) return [];
    this.output.complete();
    return this.output.drain().flatMap((token) => this.check(token.text));
  }

  private append(text: string): readonly CheckedVoiceSentence[] {
    if (text.length === 0) return [];
    this.raw += text;
    return this.output.push({ index: this.index++, text }).flatMap((token) => this.check(token.text));
  }

  private safe(text: string): string {
    const result = this.redactor.redactText(text);
    if (!result.ok) throw new TypeError("voice_redaction_failed");
    return result.text;
  }

  private check(text: string): readonly CheckedVoiceSentence[] {
    const sentences = new VoiceSentences();
    return [...sentences.push(text), ...sentences.finish()].map((sentence) => {
      const start = this.redactedPrefix.length + sentence.length - sentence.trimStart().length;
      this.redactedPrefix += sentence;
      const end = this.redactedPrefix.trimEnd().length;
      const safe = this.safe(this.raw);
      const proofs: ReceiptedToolSentence[] = [];
      let unsupported = false;
      for (const span of this.spans) {
        const before = this.safe(this.raw.slice(0, span.start));
        const through = this.safe(this.raw.slice(0, span.end));
        // A redaction crossing the annotation can erase it. An annotation may
        // exempt text only if both offsets survive as exact redacted prefixes.
        if (!safe.startsWith(before) || !safe.startsWith(through)) throw new TypeError("voice_claim_redaction_overlap");
        const claimStart = before.length + through.slice(before.length).length - through.slice(before.length).trimStart().length;
        const claimEnd = through.trimEnd().length;
        if (claimStart >= end || claimEnd <= start) continue;
        const supported = claimStart === start && claimEnd === end && span.claim.receiptIds.length > 0
          && span.claim.receiptIds.every((id) => this.executed.some((entry) =>
            entry.receiptId === id && entry.providerResult.name === span.claim.toolName));
        if (!supported) unsupported = true;
        else proofs.push({ sentence: sentence.replace(/\s+/gu, " ").trim(), toolNames: [span.claim.toolName] });
      }
      const checked = unsupported ? UNRECEIPTED_VOICE_ACTION
        : guardVoiceReplySentence(sentence, this.receiptSentences, { receiptedInternalSentences: proofs });
      const replaced = checked !== sentence.replace(/\s+/gu, " ").trim();
      // Keep source whitespace on successful speech. Inserting sentence line
      // breaks changes what the downstream credential redactor can recognize.
      return { text: replaced ? `${checked} ` : sentence, replaced };
    });
  }
}
