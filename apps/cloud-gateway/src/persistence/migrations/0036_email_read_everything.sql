-- Read every message sent to the school ingest address, and label its provenance.
--
-- The owner's decision is that the whole school mail stream reaches Jarvis, so
-- a delivery is no longer refused for coming from a sender nobody pinned. What
-- replaces the refusal is a recorded authenticity level. `verified` means the
-- positive authentication evidence KNOWN_ISSUES.md already describes -- a DKIM
-- signature naming a pinned domain, the receiving MTA's own dkim=pass for a
-- pinned header.d, or an ARC chain sealed by a pinned forwarder whose original
-- authentication passed. `unverified` is everything else, and it is still
-- read, still stored, and still usable, labelled wherever the owner sees it.
--
-- The column is additive with a default, so every receipt written before this
-- migration is `unverified` rather than silently promoted to proven. Nothing
-- about the DKIM, DMARC or ARC evaluation itself changes -- the verdict now
-- sets a label instead of deciding whether the body survives.
--
-- Retention moves from a quarantine-row cap to a bound on retained raw bodies,
-- because the newest-five rule was sized for refused mail and reading
-- everything means normal school mail flows through this table. The hash, the
-- header names, the measured authentication record, the structured event and
-- the authenticity level are kept. Only the raw MIME is pruned, and only the
-- two conditions the repository enforces -- newest
-- MAXIMUM_RETAINED_RAW_RECEIPTS bodies per owner, and nothing older than
-- RAW_RECEIPT_RETENTION_MS. A body referenced by a derived grade observation
-- is never pruned at all.
ALTER TABLE d2l_email_messages ADD COLUMN authenticity TEXT NOT NULL DEFAULT 'unverified'
  CHECK (authenticity IN ('verified', 'unverified'));

-- The digest asks one question of this table: what provenance did the message
-- that produced this deadline carry. The external id the parser read out of the
-- body is what makes the join possible, and it lives inside the structured
-- JSON. Indexed as an expression rather than stored in a generated column:
-- both make the lookup a seek instead of a scan of every message the owner has
-- ever received, and the expression version adds no second copy of the id that
-- could disagree with the JSON it came from.
CREATE INDEX d2l_email_messages_source_external_idx
ON d2l_email_messages(principal_id, json_extract(structured_json, '$.externalId'));

-- Replaced, not added: the old guard allowed exactly two transitions, and
-- pruning a retained body is a third. It is one column wide on purpose. A
-- cleared body must be empty forever after, so a pruned receipt cannot quietly
-- regain different bytes under the same hash, and a clear may not carry a
-- status or notice change along with it.
--
-- The body-clear clause is itself a replacement rather than an addition, and
-- the new form is the second half of a lesson from mutating this trigger: the
-- first version checked the body was empty and then listed the columns the
-- clear must not touch. Every mutation that loosened one of those columns left
-- the suite green, because the pre-existing clauses -- which require a
-- non-pending transition to leave the body byte-identical -- reject the clear
-- outright the moment any other column is named. Deleting them one at a time
-- was therefore invisible, and a guard that cannot be shown to be load-bearing
-- is indistinguishable from one that is not there at all.
--
-- So the new form asks for the state a clear is allowed to produce, and proves
-- it *cannot* name anything else: the transition is exactly "has a body, ends
-- with none, and nothing else about the row differs". The absolute statuses are
-- what make that decidable -- a conjunction of `IS OLD` comparisons is only
-- ever satisfied by one state.
DROP TRIGGER d2l_email_messages_update_guard;
CREATE TRIGGER d2l_email_messages_update_guard
BEFORE UPDATE ON d2l_email_messages
WHEN NOT (
  NEW.principal_id IS OLD.principal_id
  AND NEW.email_id IS OLD.email_id
  AND NEW.ingestion_key IS OLD.ingestion_key
  AND NEW.raw_sha256 IS OLD.raw_sha256
  AND NEW.provider_message_id IS OLD.provider_message_id
  AND NEW.header_names_json IS OLD.header_names_json
  AND NEW.authentication_json IS OLD.authentication_json
  AND NEW.envelope_from_domain IS OLD.envelope_from_domain
  AND NEW.from_domain IS OLD.from_domain
  AND NEW.authenticity IS OLD.authenticity
  AND NEW.event_kind IS OLD.event_kind
  AND NEW.structured_json IS OLD.structured_json
  AND NEW.received_at IS OLD.received_at
  AND (
    -- A body is cleared from a row that has one, and the row that results is
    -- the row with the body removed: same status, same timestamps, same
    -- reason, same notice marker. Naming any other column here makes the
    -- disjunct unsatisfiable, which is the point.
    (
      OLD.raw_mime_base64 <> ''
      AND NEW.raw_mime_base64 = ''
      AND NEW.status = OLD.status
      AND NEW.processed_at IS OLD.processed_at
      AND NEW.quarantine_reason IS OLD.quarantine_reason
      AND NEW.verification_notified_at IS OLD.verification_notified_at
      AND (
        (OLD.status = 'pending' AND OLD.processed_at IS NULL AND OLD.quarantine_reason IS NULL)
        OR (OLD.status = 'quarantined' AND OLD.processed_at IS NOT NULL AND OLD.quarantine_reason IS NOT NULL)
        OR (OLD.status = 'ingested' AND OLD.processed_at IS NOT NULL AND OLD.quarantine_reason IS NULL)
      )
    )
    OR (
      OLD.status = 'pending'
      AND NEW.status IN ('ingested', 'quarantined')
      AND OLD.processed_at IS NULL
      AND NEW.processed_at IS NOT NULL
      AND OLD.quarantine_reason IS NULL
      AND NEW.verification_notified_at IS NULL
      AND NEW.raw_mime_base64 IS OLD.raw_mime_base64
    )
    OR (
      OLD.status = 'ingested'
      AND NEW.status = OLD.status
      AND NEW.processed_at IS OLD.processed_at
      AND NEW.quarantine_reason IS OLD.quarantine_reason
      AND OLD.event_kind = 'address_verification'
      AND OLD.verification_notified_at IS NULL
      AND NEW.verification_notified_at IS NOT NULL
      AND NEW.raw_mime_base64 IS OLD.raw_mime_base64
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'd2l_email_message_update_invalid');
END;

