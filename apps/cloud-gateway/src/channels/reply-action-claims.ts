/** Receipt-bound final guard for owner Telegram model output. */
import type {
  ModelAdapter,
  ModelAdapterStreamInput,
  ModelToken,
} from "../model/model-types.js";

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const HONEST_EXTERNAL_LIMIT = "I can't send messages, make calls or bookings, pay, submit, register, apply, or contact anyone yet; I can draft or prepare it for you.";
const HONEST_IN_APP_LIMIT = "I couldn't verify that in-app change from this turn, so I won't say it was saved.";

export type ReplyActionKind =
  | "email"
  | "text"
  | "message"
  | "call"
  | "book"
  | "reserve"
  | "pay"
  | "buy"
  | "submit"
  | "upload"
  | "register"
  | "apply"
  | "contact"
  | "notify"
  | "share"
  | "accept-offer"
  | "decline-offer"
  | "school-plan"
  | "university-tracker"
  | "study-coach"
  | "memory"
  | "brightspace-refresh"
  | "reminder";

const EXTERNAL_ACTIONS = new Set<ReplyActionKind>([
  "email", "text", "message", "call", "book", "reserve", "pay", "buy",
  "submit", "upload", "register", "apply", "contact", "notify", "share",
  "accept-offer", "decline-offer",
]);

declare const replyActionReceiptBrand: unique symbol;
export interface ReplyActionReceipt {
  readonly [replyActionReceiptBrand]: true;
}

interface IssuedReceipt {
  readonly turnId: string;
  readonly kind: ReplyActionKind;
}

const issuedReceipts = new WeakMap<object, IssuedReceipt>();
const tokenReceipts = new WeakMap<object, readonly ReplyActionReceipt[]>();

function requireTurnId(turnId: string): void {
  if (!ULID.test(turnId)) throw new TypeError("reply_action_receipt_turn_invalid");
}

/** Mints authority for one action kind on one exact conversation turn. */
export function issueReplyActionReceipt(turnId: string, kind: ReplyActionKind): ReplyActionReceipt {
  requireTurnId(turnId);
  const receipt = Object.freeze(Object.create(null)) as ReplyActionReceipt;
  issuedReceipts.set(receipt, Object.freeze({ turnId, kind }));
  return receipt;
}

/** Emits model text carrying a receipt that cannot be reconstructed from its wording. */
export function issueReplyActionToken(
  turnId: string,
  text: string,
  kinds: readonly ReplyActionKind[],
): ModelToken {
  const receipts = Object.freeze(kinds.map((kind) => issueReplyActionReceipt(turnId, kind)));
  const token = Object.freeze({ index: 0, text });
  tokenReceipts.set(token, receipts);
  return token;
}

interface Segment {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function sentenceSegments(value: string): readonly Segment[] {
  const segments: Segment[] = [];
  let start = 0;
  const push = (end: number): void => {
    const text = value.slice(start, end).trim();
    if (text.length > 0) segments.push(Object.freeze({ text, start, end }));
    start = end;
    while (start < value.length && /\s/u.test(value[start]!)) start += 1;
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "\n") {
      push(index);
      start = index + 1;
      continue;
    }
    if (character !== "." && character !== "!" && character !== "?") continue;
    if (character === "." && /(?:^|\s)(?:mr|mrs|ms|dr|prof)\.$/iu.test(value.slice(start, index + 1))) continue;
    let end = index + 1;
    while (end < value.length && /[.!?"'’]/u.test(value[end]!)) end += 1;
    if (end === value.length || /\s/u.test(value[end]!)) {
      push(end);
      index = start - 1;
    }
  }
  if (start < value.length) push(value.length);
  return Object.freeze(segments);
}

function draftContext(value: string): boolean {
  return /\bhere(?:['’]s|\s+is)\s+a\s+draft\b|^\s*draft(?:\s+(?:email|reply|message|text))?\s+(?:for|to)\b|\bcreated\s+a\s+draft\b/iu
    .test(value);
}

function deniedAction(value: string): boolean {
  return /\b(?:i|we|jarvis)\b.{0,20}\b(?:can(?:not|'t)|could(?:\s+not|n't)|will\s+not|won't|did\s+not|didn't|have\s+not|haven't|am\s+not|not\s+able\s+to)\b/iu
    .test(value);
}

function ownerActionReport(value: string): boolean {
  return /\byou\s+(?:already\s+|just\s+)?(?:submitted|uploaded|sent|paid|booked|registered|applied|accepted|declined)\b|\b(?:submitted|uploaded|sent|paid|booked|registered|applied|accepted|declined)\s+by\s+you\b/iu
    .test(value);
}

function externalObject(value: string): boolean {
  return /\b(?:waterloo|western|queen['’]s|mcgill|ubc|ouac|admissions?|registrar|guidance|m(?:s|r)\.?\s+\p{L}+|dr\.?\s+\p{L}+|prof(?:essor)?\.?\s+\p{L}+|mom|mother|dad|father|teacher|counsell?or|dentist|restaurant|pai|application|aif|offer|acceptance|spot|seat|deposit|fee|payment|transcript|reference|request|essay|form|message|voicemail|appointment|reservation|table|campus\s+visit|interview|housing|residence)\b/iu
    .test(value);
}

function actionKindFromWords(value: string): ReplyActionKind | null {
  if (/\be-?mail(?:ed|ing)?\b/iu.test(value)) return "email";
  if (/\btext(?:ed|ing)\b/iu.test(value)) return "text";
  if (/\bmessag(?:e[ds]?|ing)\b|\bdm(?:ed|ing)?\b/iu.test(value)) return "message";
  if (/\bcall(?:ed|ing)?\b|\bphon(?:e[ds]?|ing)\b|\brang\b|\bvoicemail\b/iu.test(value)) return "call";
  if (/\breserv(?:e[ds]?|ing|ation)\b|\bbook(?:ed|ing)\b|\bschedul(?:e[ds]?|ing)\b/iu.test(value)) return "book";
  if (/\b(?:held|hold(?:ing)?)\b.{0,28}\b(?:spot|seat|place)\b|\b(?:spot|seat|place)\b.{0,28}\b(?:held|locked|secured)\b/iu.test(value)) return "reserve";
  if (/\bpay(?:ment|ments|ing|ed)?\b|\bpaid\b|\bwent\s+through\b/iu.test(value)) return "pay";
  if (/\bb(?:uy|ought|uying)\b|\bpurchas(?:e[ds]?|ing)\b|\border(?:ed|ing)\b/iu.test(value)) return "buy";
  if (/\bupload(?:ed|ing)?\b/iu.test(value)) return "upload";
  if (/\bsubmit(?:ted|ting)?\b|\bsent\s+in\b|\bturn(?:ed|ing)\s+in\b|\bhand(?:ed|ing)\s+in\b|\bfiled\b/iu.test(value)) return "submit";
  if (/\bregist(?:er(?:ed|ing)?|ration)\b|\bsign(?:ed|ing)\s+up\b|\benrol(?:led|ling)\b/iu.test(value)) return "register";
  if (/\bappl(?:y|ied|ying)\b/iu.test(value)) return "apply";
  if (/\bnotif(?:y|ied|ying)\b|\btold\b|\blet\b.{0,24}\bknow\b/iu.test(value)) return "notify";
  if (/\bshar(?:e[ds]?|ing)\b|\bforward(?:ed|ing)?\b|\bgave\b/iu.test(value)) return "share";
  if (/\bcontact(?:ed|ing)?\b|\breach(?:ed|ing)\s+out\b|\bspoke\s+to\b|\bask(?:ed|ing)\b/iu.test(value)) return "contact";
  if (/\bdeclin(?:e[ds]?|ing)\b|\bturn(?:ed|ing)\s+down\b|\breject(?:ed|ing)?\b/iu.test(value)) return "decline-offer";
  if (/\baccept(?:ed|ing)?\b|\bacceptd\b|\bacccepted\b|\bsaid\s+yes\b|\baceptado\b|\baccepté\b|\bakzeptiert\b/iu.test(value)) return "accept-offer";
  if (/\bsent\b|\bsending\b/iu.test(value)) return "message";
  return null;
}

function internalActionKinds(value: string): readonly ReplyActionKind[] {
  const kinds = new Set<ReplyActionKind>();
  if (/\b(?:remembered|forgot|forgotten|lifted|suppressed)\b.{0,48}\bmemor(?:y|ies)\b|\bmemor(?:y|ies)\b.{0,48}\b(?:remembered|forgotten|suppressed|active)\b/iu.test(value)) {
    kinds.add("memory");
  }
  if (/\b(?:recorded|logged|tracked|noted|marked|updated|saved)\b.{0,72}\b(?:offer|application|aif|essay|reference|transcript|workflow|tracker|fee\s+step)\b|\b(?:offer|application|aif|essay|reference|transcript|workflow|tracker|fee\s+step)\b.{0,72}\b(?:recorded|logged|tracked|noted|marked|updated|saved|ready|done)\b/iu.test(value)) {
    kinds.add("university-tracker");
  }
  if (/\b(?:created|set\s+up|ordered|confirmed|added|updated|saved|put|accepted|declined)\b.{0,72}\b(?:study\s+plan|plan|study\s+blocks?|tasks?|draft|checklist|correction|date)\b|\b(?:study\s+plan|plan|study\s+blocks?|tasks?|draft|checklist)\b.{0,72}\b(?:created|set\s+up|ordered|confirmed|added|updated|saved)\b/iu.test(value)) {
    kinds.add("school-plan");
  }
  if (/\b(?:recorded|retired|forgot|stopped|created)\b.{0,72}\b(?:study-coach|evidence|signal|quiz|practice)\b|\bquiz\s+(?:stopped|closed|complete)\b/iu.test(value)) {
    kinds.add("study-coach");
  }
  if (/\b(?:i['’]ll|i\s+will|we['’]ll|we\s+will|jarvis\s+will)\s+remind\b/iu.test(value)) kinds.add("reminder");
  return Object.freeze([...kinds]);
}

function externalActionKinds(value: string): readonly ReplyActionKind[] {
  if (draftContext(value) || deniedAction(value) || ownerActionReport(value)) return Object.freeze([]);
  if (/\b(?:ordered\s+your\s+tasks|accepted\s+your\s+correction|declined\s+to\s+add\s+a\s+date)\b/iu.test(value)) {
    return Object.freeze([]);
  }
  const trackerStatus = /\b(?:marked|recorded|logged|tracked|noted|updated|saved)\b.{0,80}\b(?:submitted|ready|done|owner-reported)\b/iu
    .test(value);
  if (/^\s*(?:once|after|when|until|before|whether|if|make\s+sure|check)\b/iu.test(value)
    && !/\b(?:i|we|jarvis)\b/iu.test(value)) return Object.freeze([]);

  const kinds = new Set<ReplyActionKind>();
  const directKind = actionKindFromWords(value);
  const agentClaim = /\b(?:i|we|jarvis)(?:['’](?:ve|m|ll|re|d))?\b.{0,48}\b(?:have\s+|am\s+|will\s+|went\s+ahead\s+and\s+|did\s+|hit\s+|just\s+|now\s+|already\s+|successfully\s+)*(?:e-?mail|text|messag|dm|call|phon|rang|book|reserv|schedul|pay|paid|bought|buy|purchas|order|submit|upload|register|sign\s+up|enrol|appl|contact|notif|told|shar|forward|gave|accept|acceptd|acccept|declin|reject|sent|sending|spoke|ask|left|held|said\s+yes)\w*/iu
    .test(value);
  const progressiveOrBare = /^\s*(?:[-*•]\s*)?(?:(?:on\s+it\s*[,—-]\s*)?(?:accepting|booking|reserving|scheduling|paying|buying|submitting|uploading|registering|applying|emailing|texting|messaging|calling|contacting|notifying|sharing)\b|(?:just\s+)?(?:accepted|acceptd|acccepted|booked|reserved|scheduled|paid|bought|submitted|uploaded|registered|applied|emailed|texted|messaged|called|contacted|notified|shared|sent)\b|done\b)/iu
    .test(value);
  if (directKind !== null && (agentClaim || progressiveOrBare) && !trackerStatus) kinds.add(directKind);

  const object = externalObject(value);
  if (object && (/\b(?:get(?:s|ting)?\s+accepted|is\s+accepted|offer\s+accepted|acceptance\s*:\s*complete|acceptd|acccepted|aceptado|akzeptiert|said\s+yes|received\s+your\s+acceptance)\b|✅/iu.test(value)
    || /accepté/iu.test(value))) {
    kinds.add("accept-offer");
  }
  if (object && !trackerStatus && /\b(?:is|was|gets?|got|has\s+been|have\s+been)?\s*(?:submitted|sent\s+in|turned\s+in|filed)\b|\boff\s+to\s+admissions\b/iu.test(value)) kinds.add("submit");
  if (object && /\b(?:is|was|gets?|got|has\s+been|have\s+been)?\s*uploaded\b/iu.test(value)) kinds.add("upload");
  if (object && !trackerStatus && /\b(?:deposit|fee|payment)\b.{0,40}\b(?:paid|went\s+through|done|complete)\b|\b(?:paid|done(?:\s+and\s+dusted)?)\b.{0,40}\b(?:deposit|fee|payment)\b|✔️/iu.test(value)) kinds.add("pay");
  if (object && /\b(?:visit|interview|appointment|reservation|table)\b.{0,40}\b(?:booked|confirmed|scheduled)\b|\b(?:booked|scheduled)\b/iu.test(value)) kinds.add("book");
  if (object && /\b(?:spot|seat|place|housing)\b.{0,40}\b(?:confirmed|locked|secured|held)\b|\bconfirmed\b.{0,24}\b(?:spot|seat|place)\b|\ball\s+set\s+with\b|\bofficially\s+going\s+to\b/iu.test(value)) kinds.add("reserve");
  if (object && /\bregistered\s+with\b/iu.test(value)) kinds.add("register");
  if (object && /\b(?:message|email|text|note)\b.{0,32}\b(?:sent|delivered)\b/iu.test(value)) kinds.add("message");
  if (object && /\b(?:transcript|reference|request)\b.{0,40}(?:['’]s|\bis\b)\s+(?:now\s+)?with\b/iu.test(value)) kinds.add("share");
  if (object && /\b(?:waterloo|western|queen['’]s|mcgill|ubc)\b.{0,32}\bgets?\b.{0,24}\b(?:transcript|reference|application|aif)\b/iu.test(value)) kinds.add("share");
  if (object && /\b(?:has|now\s+has)\s+everything\b/iu.test(value)) kinds.add("submit");
  if (object && /\b(?:application|aif|offer|acceptance|spot|deposit|fee|payment|transcript|reference|request|reservation|housing)\b.{0,48}(?:✅|✔️)/iu.test(value)) {
    kinds.add(directKind ?? "submit");
  }
  return Object.freeze([...kinds]);
}

function claimKinds(value: string): readonly ReplyActionKind[] {
  return Object.freeze([...new Set([...internalActionKinds(value), ...externalActionKinds(value)])]);
}

function receiptKinds(turnId: string, receipts: readonly ReplyActionReceipt[]): ReadonlySet<ReplyActionKind> {
  const kinds = new Set<ReplyActionKind>();
  for (const receipt of receipts) {
    const issued = issuedReceipts.get(receipt as object);
    if (issued?.turnId === turnId) kinds.add(issued.kind);
  }
  return kinds;
}

export interface GuardedReplyActionClaims {
  readonly text: string;
  readonly removedSentences: number;
  readonly refusedKinds: readonly ReplyActionKind[];
}

/** Pure text decision once the caller supplies the receipt authority for this turn. */
export function guardReplyActionClaims(
  turnId: string,
  reply: string,
  receipts: readonly ReplyActionReceipt[] = Object.freeze([]),
): GuardedReplyActionClaims {
  requireTurnId(turnId);
  const allowed = receiptKinds(turnId, receipts);
  const segments = sentenceSegments(reply);
  const refused = new Set<ReplyActionKind>();
  const kept: string[] = [];
  let removedSentences = 0;
  let draftStarted = false;
  for (const segment of segments) {
    if (draftStarted || draftContext(segment.text)) {
      draftStarted = true;
      kept.push(segment.text);
      continue;
    }
    const missing = claimKinds(segment.text).filter((kind) => !allowed.has(kind));
    if (missing.length === 0) {
      kept.push(segment.text);
      continue;
    }
    removedSentences += 1;
    for (const kind of missing) refused.add(kind);
  }
  if (removedSentences === 0) {
    return Object.freeze({ text: reply, removedSentences: 0, refusedKinds: Object.freeze([]) });
  }
  const honest = [...refused].some((kind) => EXTERNAL_ACTIONS.has(kind))
    ? HONEST_EXTERNAL_LIMIT
    : HONEST_IN_APP_LIMIT;
  kept.push(honest);
  return Object.freeze({
    text: kept.join(" ").trim(),
    removedSentences,
    refusedKinds: Object.freeze([...refused]),
  });
}

export class DelegatedReplyTracker {
  readonly #tokens = new WeakSet<object>();

  wrap(model: ModelAdapter): ModelAdapter {
    const tracker = this;
    return Object.freeze({
      async *stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
        for await (const token of model.stream(input)) {
          tracker.#tokens.add(token);
          yield token;
        }
      },
    });
  }

  has(token: ModelToken): boolean {
    return this.#tokens.has(token);
  }
}

export interface ReplyActionClaimGuardModelOptions {
  readonly model: ModelAdapter;
  /** A non-delegated token from the memory adapter is its code-issued receipt. */
  readonly memoryFallback?: DelegatedReplyTracker;
}

/** Final owner-Telegram model boundary, after every feature adapter. */
export class ReplyActionClaimGuardModelAdapter implements ModelAdapter {
  constructor(private readonly options: ReplyActionClaimGuardModelOptions) {}

  async *stream(input: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    const tokens: ModelToken[] = [];
    const receipts: ReplyActionReceipt[] = [];
    for await (const token of this.options.model.stream(input)) {
      tokens.push(token);
      receipts.push(...(tokenReceipts.get(token) ?? []));
    }
    if (tokens.length === 0) return;
    if (this.options.memoryFallback !== undefined
      && tokens.every((token) => !this.options.memoryFallback?.has(token))) {
      receipts.push(issueReplyActionReceipt(input.correlationId, "memory"));
    }
    const reply = tokens.map((token) => token.text).join("");
    const guarded = guardReplyActionClaims(input.correlationId, reply, receipts);
    if (guarded.text === reply) {
      yield* tokens;
      return;
    }
    yield Object.freeze({ index: 0, text: guarded.text });
  }
}
