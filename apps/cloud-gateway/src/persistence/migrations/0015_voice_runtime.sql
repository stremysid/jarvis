-- R1 runtime control state. Additive, independent of memory projection 0014.
-- Sending an owner alert precedes its acknowledged receipt. An abandoned
-- lease can retry after expiry, possibly duplicating an unacknowledged send.
CREATE TABLE capacity_alert_crossings (
  owner_principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  alert_key TEXT NOT NULL CHECK (length(alert_key) BETWEEN 1 AND 96),
  claim_id TEXT NOT NULL CHECK (
    length(claim_id) = 26 AND substr(claim_id, 1, 1) BETWEEN '0' AND '7'
    AND claim_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('sending', 'sent')),
  claimed_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at) IS claimed_at),
  lease_expires_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at) IS lease_expires_at
    AND lease_expires_at > claimed_at
  ),
  sent_at TEXT CHECK (sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', sent_at) IS sent_at),
  PRIMARY KEY (owner_principal_id, alert_key),
  CHECK ((state = 'sending' AND sent_at IS NULL)
    OR (state = 'sent' AND sent_at IS NOT NULL AND sent_at >= claimed_at))
) STRICT;
