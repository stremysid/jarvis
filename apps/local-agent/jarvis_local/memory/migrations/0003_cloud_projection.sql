CREATE TABLE memory_projection_cursor (
    gateway_origin       TEXT NOT NULL CHECK (length(gateway_origin) BETWEEN 1 AND 2048),
    principal_id         TEXT NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 512),
    device_id            TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 512),
    published_version    INTEGER NOT NULL CHECK (published_version BETWEEN 0 AND 2147483647),
    published_digest     TEXT,
    published_manifest   TEXT,
    updated_at           TEXT NOT NULL,
    PRIMARY KEY (gateway_origin, principal_id, device_id),
    CHECK (
        (published_version = 0 AND published_digest IS NULL AND published_manifest IS NULL)
        OR
        (published_version > 0
         AND published_digest IS NOT NULL
         AND length(published_digest) = 64
         AND published_digest NOT GLOB '*[^0-9a-f]*'
         AND published_manifest IS NOT NULL
         AND length(published_manifest) = 64
         AND published_manifest NOT GLOB '*[^0-9a-f]*')
    )
) STRICT;

CREATE TABLE memory_projection_pending (
    gateway_origin       TEXT NOT NULL CHECK (length(gateway_origin) BETWEEN 1 AND 2048),
    principal_id         TEXT NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 512),
    device_id            TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 512),
    projection_version   INTEGER NOT NULL CHECK (projection_version BETWEEN 1 AND 2147483647),
    content_digest       TEXT NOT NULL CHECK (
        length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'
    ),
    manifest_hash        TEXT NOT NULL CHECK (
        length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9a-f]*'
    ),
    page_count           INTEGER NOT NULL CHECK (page_count BETWEEN 1 AND 32),
    total_fact_count     INTEGER NOT NULL CHECK (total_fact_count BETWEEN 0 AND 1024),
    created_at           TEXT NOT NULL,
    PRIMARY KEY (gateway_origin, principal_id, device_id),
    UNIQUE (gateway_origin, principal_id, device_id, projection_version),
    FOREIGN KEY (gateway_origin, principal_id, device_id)
        REFERENCES memory_projection_cursor(gateway_origin, principal_id, device_id)
) STRICT;

CREATE TABLE memory_projection_pending_page (
    gateway_origin       TEXT NOT NULL CHECK (length(gateway_origin) BETWEEN 1 AND 2048),
    principal_id         TEXT NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 512),
    device_id            TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 512),
    projection_version   INTEGER NOT NULL CHECK (projection_version BETWEEN 1 AND 2147483647),
    page_index           INTEGER NOT NULL CHECK (page_index BETWEEN 0 AND 31),
    page_hash            TEXT NOT NULL CHECK (
        length(page_hash) = 64 AND page_hash NOT GLOB '*[^0-9a-f]*'
    ),
    page_json            TEXT NOT NULL CHECK (
        length(CAST(page_json AS BLOB)) BETWEEN 1 AND 65536
    ),
    PRIMARY KEY (gateway_origin, principal_id, device_id, page_index),
    FOREIGN KEY (gateway_origin, principal_id, device_id, projection_version)
        REFERENCES memory_projection_pending(
            gateway_origin, principal_id, device_id, projection_version
        )
        ON DELETE CASCADE
) STRICT;
