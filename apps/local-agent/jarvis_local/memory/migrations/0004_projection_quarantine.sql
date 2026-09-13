-- Keep rejected content locally without allowing it to block unrelated facts.
CREATE TABLE memory_projection_quarantine (
    gateway_origin TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    fact_id TEXT NOT NULL REFERENCES fact(fact_id),
    reason TEXT NOT NULL CHECK (reason IN ('unrepresentable', 'gateway_rejected')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (gateway_origin, principal_id, device_id, fact_id)
) STRICT;

-- A lost abandon response must retry abandon, never the poisoned pages.
CREATE TABLE memory_projection_rejection (
    gateway_origin TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    page_index INTEGER NOT NULL CHECK (page_index BETWEEN 0 AND 31),
    PRIMARY KEY (gateway_origin, principal_id, device_id),
    FOREIGN KEY (gateway_origin, principal_id, device_id)
        REFERENCES memory_projection_pending(gateway_origin, principal_id, device_id)
        ON DELETE CASCADE
) STRICT;
