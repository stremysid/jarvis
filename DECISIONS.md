# Decisions

- D1 is the authoritative operational store; bootstrap-token hashes are consumed atomically with initial principal and device creation.
- R2 is the archive store.
- Authentication state does not use eventually consistent KV.
