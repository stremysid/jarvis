-- A queued acknowledgement is durable, even if the process stops mid-cycle.
-- No fact foreign key: a well-formed unknown id still needs a recorded refusal.
CREATE TABLE memory_projection_retry (
    retry_id INTEGER PRIMARY KEY AUTOINCREMENT,
    gateway_origin TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    fact_id TEXT NOT NULL CHECK (
        length(fact_id) = 37 AND fact_id GLOB 'fact_*'
        AND substr(fact_id, 6) NOT GLOB '*[^0-9a-f]*'
    ),
    outcome TEXT NOT NULL DEFAULT 'queued' CHECK (
        outcome IN ('queued', 'applied', 'not_quarantined', 'failed', 'cancelled')
    ),
    completed_order INTEGER CHECK (
        (outcome = 'queued' AND completed_order IS NULL)
        OR (outcome <> 'queued' AND completed_order IS NOT NULL AND completed_order > 0)
    )
) STRICT;

CREATE UNIQUE INDEX memory_projection_one_pending_retry
ON memory_projection_retry (gateway_origin, principal_id, device_id, fact_id)
WHERE outcome = 'queued';
