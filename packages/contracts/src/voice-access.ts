const capabilityIds = [
  "conversation.basic",
  "research.web",
  "memory.own",
  "reminders.manage",
  "calendar.read",
  "calendar.manage",
  "owner.contact",
  "communications.draft",
  "communications.send",
  "calls.place",
  "files.read",
  "files.write",
  "pc.control",
  "spending.propose",
  "destructive.propose",
] as const;

export type GuestCapabilityId = (typeof capabilityIds)[number];

export const GUEST_CAPABILITY_IDS: readonly GuestCapabilityId[] = Object.freeze([...capabilityIds]);

export type VoiceAccessKind = "owner" | "guest";

export interface VoiceResourceScopesV1 {
  readonly schemaVersion: "1.0";
  readonly calendarConnectionIds: readonly string[];
  readonly fileRootIds: readonly string[];
  readonly pcActionIds: readonly string[];
}

export interface VoiceAccessBinding {
  readonly accessKind: VoiceAccessKind;
  readonly guestGrantId: string | null;
  readonly guestGrantVersion: number | null;
  readonly accessDocumentHash: string | null;
}
