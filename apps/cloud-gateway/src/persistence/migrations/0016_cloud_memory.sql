PRAGMA foreign_keys = ON;

CREATE TABLE memory_items (
  item_id TEXT PRIMARY KEY CHECK (
    length(item_id) = 26 AND substr(item_id, 1, 1) BETWEEN '0' AND '7'
    AND item_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'plan', 'decision', 'relationship')),
  creation_event_id TEXT NOT NULL CHECK (
    length(creation_event_id) = 26 AND substr(creation_event_id, 1, 1) BETWEEN '0' AND '7'
    AND creation_event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  creation_event_sequence INTEGER NOT NULL CHECK (
    typeof(creation_event_sequence) = 'integer' AND creation_event_sequence > 0
  ),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  UNIQUE (principal_id, item_id)
) STRICT;

CREATE TABLE memory_item_versions (
  version_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id TEXT NOT NULL UNIQUE CHECK (
    length(version_id) = 26 AND substr(version_id, 1, 1) BETWEEN '0' AND '7'
    AND version_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  item_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (typeof(version_number) = 'integer' AND version_number > 0),
  text TEXT NOT NULL CHECK (
    length(CAST(text AS BLOB)) BETWEEN 1 AND 4096
    AND instr(text, char(0)) = 0
    AND text NOT GLOB ('*[' || char(1) || '-' || char(31)
      || char(127) || '-' || char(159) || char(8232) || char(8233) || ']*')
  ),
  text_normalization TEXT NOT NULL CHECK (text_normalization = 'NFC'),
  text_hash TEXT NOT NULL CHECK (length(text_hash) = 64 AND text_hash NOT GLOB '*[^0-9a-f]*'),
  basis TEXT NOT NULL CHECK (basis IN ('stated', 'confirmed', 'observed', 'inferred', 'third_party')),
  origin TEXT NOT NULL CHECK (origin IN (
    'authenticated_first_person', 'deterministic_observation', 'model', 'third_party'
  )),
  uncertain INTEGER NOT NULL CHECK (uncertain IN (0, 1)),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
  valid_from TEXT CHECK (valid_from IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', valid_from) IS valid_from),
  valid_to TEXT CHECK (
    valid_to IS NULL OR (
      strftime('%Y-%m-%dT%H:%M:%fZ', valid_to) IS valid_to
      AND (valid_from IS NULL OR valid_to > valid_from)
    )
  ),
  extractor_version TEXT NOT NULL CHECK (length(CAST(extractor_version AS BLOB)) BETWEEN 1 AND 128),
  extractor_model_id TEXT CHECK (
    extractor_model_id IS NULL OR (
      length(CAST(extractor_model_id AS BLOB)) BETWEEN 3 AND 192
      AND (
        extractor_model_id GLOB 'deepseek:*'
        OR extractor_model_id GLOB 'anthropic:*'
        OR extractor_model_id GLOB 'openai:*'
      )
    )
  ),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  UNIQUE (principal_id, version_id),
  UNIQUE (principal_id, item_id, version_number),
  FOREIGN KEY (principal_id, item_id)
    REFERENCES memory_items(principal_id, item_id) ON DELETE CASCADE,
  CHECK (origin <> 'model' OR (uncertain = 1 AND basis = 'inferred' AND extractor_model_id IS NOT NULL)),
  CHECK (origin <> 'third_party' OR uncertain = 1),
  CHECK (basis NOT IN ('inferred', 'third_party') OR uncertain = 1),
  CHECK (basis <> 'third_party' OR origin = 'third_party')
) STRICT;

CREATE TABLE memory_item_sources (
  source_id TEXT PRIMARY KEY CHECK (
    length(source_id) = 26 AND substr(source_id, 1, 1) BETWEEN '0' AND '7'
    AND source_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  item_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  source_position INTEGER NOT NULL CHECK (typeof(source_position) = 'integer' AND source_position BETWEEN 0 AND 7),
  event_id TEXT NOT NULL CHECK (
    length(event_id) = 26 AND substr(event_id, 1, 1) BETWEEN '0' AND '7'
    AND event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  event_sequence INTEGER NOT NULL CHECK (typeof(event_sequence) = 'integer' AND event_sequence > 0),
  source_location TEXT NOT NULL CHECK (source_location IN ('live', 'archived')),
  r2_segment_id TEXT CHECK (
    r2_segment_id IS NULL OR (length(r2_segment_id) = 64 AND r2_segment_id NOT GLOB '*[^0-9a-f]*')
  ),
  excerpt TEXT NOT NULL CHECK (
    length(CAST(excerpt AS BLOB)) BETWEEN 1 AND 8192
    AND instr(excerpt, char(0)) = 0
    AND excerpt NOT GLOB ('*[' || char(1) || '-' || char(31)
      || char(127) || '-' || char(159) || char(8232) || char(8233) || ']*')
  ),
  excerpt_hash TEXT NOT NULL CHECK (length(excerpt_hash) = 64 AND excerpt_hash NOT GLOB '*[^0-9a-f]*'),
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'voice', 'system')),
  occurred_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS occurred_at),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  UNIQUE (principal_id, source_id),
  UNIQUE (principal_id, version_id, source_position),
  UNIQUE (principal_id, version_id, event_id),
  FOREIGN KEY (principal_id, item_id)
    REFERENCES memory_items(principal_id, item_id) ON DELETE CASCADE,
  FOREIGN KEY (principal_id, version_id)
    REFERENCES memory_item_versions(principal_id, version_id) ON DELETE CASCADE,
  CHECK (
    (source_location = 'live' AND r2_segment_id IS NULL)
    OR (source_location = 'archived' AND r2_segment_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE memory_item_transitions (
  transition_id TEXT PRIMARY KEY CHECK (
    length(transition_id) = 26 AND substr(transition_id, 1, 1) BETWEEN '0' AND '7'
    AND transition_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  item_id TEXT NOT NULL,
  transition_number INTEGER NOT NULL CHECK (typeof(transition_number) = 'integer' AND transition_number > 0),
  version_id TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('proposed', 'active', 'rejected', 'superseded', 'forgotten', 'expired')
  ),
  reason TEXT NOT NULL CHECK (length(CAST(reason AS BLOB)) BETWEEN 1 AND 512),
  actor TEXT NOT NULL CHECK (actor IN ('owner', 'rules')),
  policy_version TEXT NOT NULL CHECK (length(CAST(policy_version AS BLOB)) BETWEEN 1 AND 128),
  owner_authorizing_event_id TEXT CHECK (
    owner_authorizing_event_id IS NULL OR (
      length(owner_authorizing_event_id) = 26
      AND substr(owner_authorizing_event_id, 1, 1) BETWEEN '0' AND '7'
      AND owner_authorizing_event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
    )
  ),
  occurred_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS occurred_at),
  UNIQUE (principal_id, transition_id),
  UNIQUE (principal_id, item_id, transition_number),
  FOREIGN KEY (principal_id, item_id)
    REFERENCES memory_items(principal_id, item_id) ON DELETE CASCADE,
  FOREIGN KEY (principal_id, version_id)
    REFERENCES memory_item_versions(principal_id, version_id) ON DELETE CASCADE,
  CHECK (
    (actor = 'owner' AND owner_authorizing_event_id IS NOT NULL)
    OR (actor = 'rules' AND owner_authorizing_event_id IS NULL)
  )
) STRICT;

CREATE TABLE memory_item_state (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  item_id TEXT NOT NULL,
  current_version_id TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('proposed', 'active', 'rejected', 'superseded', 'forgotten', 'expired')
  ),
  last_transition_id TEXT NOT NULL,
  last_transition_number INTEGER NOT NULL CHECK (
    typeof(last_transition_number) = 'integer' AND last_transition_number > 0
  ),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  PRIMARY KEY (principal_id, item_id),
  FOREIGN KEY (principal_id, item_id)
    REFERENCES memory_items(principal_id, item_id) ON DELETE CASCADE,
  FOREIGN KEY (principal_id, current_version_id)
    REFERENCES memory_item_versions(principal_id, version_id) ON DELETE CASCADE,
  FOREIGN KEY (principal_id, last_transition_id)
    REFERENCES memory_item_transitions(principal_id, transition_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE memory_event_suppressions (
  suppression_id TEXT PRIMARY KEY CHECK (
    length(suppression_id) = 26 AND substr(suppression_id, 1, 1) BETWEEN '0' AND '7'
    AND suppression_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  target_event_id TEXT CHECK (
    target_event_id IS NULL OR (
      length(target_event_id) = 26 AND substr(target_event_id, 1, 1) BETWEEN '0' AND '7'
      AND target_event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
    )
  ),
  start_event_sequence INTEGER CHECK (
    start_event_sequence IS NULL OR (typeof(start_event_sequence) = 'integer' AND start_event_sequence > 0)
  ),
  end_event_sequence INTEGER CHECK (
    end_event_sequence IS NULL OR (
      typeof(end_event_sequence) = 'integer' AND end_event_sequence >= start_event_sequence
    )
  ),
  owner_authorizing_event_id TEXT NOT NULL CHECK (
    length(owner_authorizing_event_id) = 26
    AND substr(owner_authorizing_event_id, 1, 1) BETWEEN '0' AND '7'
    AND owner_authorizing_event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  forgotten_transition_id TEXT,
  source_id TEXT,
  reason TEXT NOT NULL CHECK (length(CAST(reason AS BLOB)) BETWEEN 1 AND 512),
  newly_hidden_turn_count INTEGER NOT NULL CHECK (
    typeof(newly_hidden_turn_count) = 'integer' AND newly_hidden_turn_count >= 0
  ),
  total_covered_turn_count INTEGER NOT NULL CHECK (
    typeof(total_covered_turn_count) = 'integer'
    AND total_covered_turn_count > 0
    AND total_covered_turn_count >= newly_hidden_turn_count
  ),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  UNIQUE (principal_id, suppression_id),
  FOREIGN KEY (principal_id, forgotten_transition_id)
    REFERENCES memory_item_transitions(principal_id, transition_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, source_id)
    REFERENCES memory_item_sources(principal_id, source_id) ON DELETE RESTRICT,
  CHECK (
    (target_event_id IS NOT NULL AND start_event_sequence IS NULL AND end_event_sequence IS NULL)
    OR (target_event_id IS NULL AND start_event_sequence IS NOT NULL AND end_event_sequence IS NOT NULL)
  ),
  CHECK (
    (forgotten_transition_id IS NULL AND source_id IS NULL)
    OR (forgotten_transition_id IS NOT NULL AND source_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE memory_event_suppression_lifts (
  lift_id TEXT PRIMARY KEY CHECK (
    length(lift_id) = 26 AND substr(lift_id, 1, 1) BETWEEN '0' AND '7'
    AND lift_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  suppression_id TEXT NOT NULL,
  owner_authorizing_event_id TEXT NOT NULL CHECK (
    length(owner_authorizing_event_id) = 26
    AND substr(owner_authorizing_event_id, 1, 1) BETWEEN '0' AND '7'
    AND owner_authorizing_event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  correction_transition_id TEXT,
  reason TEXT NOT NULL CHECK (length(CAST(reason AS BLOB)) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  UNIQUE (suppression_id),
  UNIQUE (principal_id, lift_id),
  FOREIGN KEY (principal_id, suppression_id)
    REFERENCES memory_event_suppressions(principal_id, suppression_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, correction_transition_id)
    REFERENCES memory_item_transitions(principal_id, transition_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE memory_item_links (
  link_id TEXT PRIMARY KEY CHECK (
    length(link_id) = 26 AND substr(link_id, 1, 1) BETWEEN '0' AND '7'
    AND link_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  source_item_id TEXT NOT NULL,
  target_item_id TEXT NOT NULL,
  link_type TEXT NOT NULL CHECK (link_type IN ('supersedes', 'duplicate_of', 'contradicts', 'related')),
  authorizing_transition_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  UNIQUE (principal_id, link_id),
  UNIQUE (principal_id, source_item_id, target_item_id, link_type),
  FOREIGN KEY (principal_id, source_item_id)
    REFERENCES memory_items(principal_id, item_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, target_item_id)
    REFERENCES memory_items(principal_id, item_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, authorizing_transition_id)
    REFERENCES memory_item_transitions(principal_id, transition_id) ON DELETE RESTRICT,
  CHECK (source_item_id <> target_item_id)
) STRICT;

CREATE TABLE memory_topics (
  topic_id TEXT PRIMARY KEY CHECK (
    length(topic_id) = 26 AND substr(topic_id, 1, 1) BETWEEN '0' AND '7'
    AND topic_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  parent_topic_id TEXT,
  display_name TEXT NOT NULL CHECK (
    length(CAST(display_name AS BLOB)) BETWEEN 1 AND 256
    AND instr(display_name, char(0)) = 0
    AND display_name NOT GLOB ('*[' || char(1) || '-' || char(31)
      || char(127) || '-' || char(159) || char(8232) || char(8233) || ']*')
  ),
  normalized_name TEXT NOT NULL CHECK (length(CAST(normalized_name AS BLOB)) BETWEEN 1 AND 256),
  status TEXT NOT NULL CHECK (status IN ('active', 'merged')),
  redirect_to_topic_id TEXT,
  last_topic_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at AND updated_at >= created_at
  ),
  UNIQUE (principal_id, topic_id),
  FOREIGN KEY (principal_id, parent_topic_id)
    REFERENCES memory_topics(principal_id, topic_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, redirect_to_topic_id)
    REFERENCES memory_topics(principal_id, topic_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'active' AND redirect_to_topic_id IS NULL)
    OR (status = 'merged' AND redirect_to_topic_id IS NOT NULL)
  ),
  CHECK (redirect_to_topic_id IS NULL OR redirect_to_topic_id <> topic_id)
) STRICT;

CREATE UNIQUE INDEX memory_topics_one_root
ON memory_topics(principal_id)
WHERE parent_topic_id IS NULL;

CREATE UNIQUE INDEX memory_topics_sibling_name
ON memory_topics(principal_id, COALESCE(parent_topic_id, ''), normalized_name)
WHERE status = 'active';

CREATE TABLE memory_topic_events (
  topic_event_id TEXT PRIMARY KEY CHECK (
    length(topic_event_id) = 26 AND substr(topic_event_id, 1, 1) BETWEEN '0' AND '7'
    AND topic_event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  topic_id TEXT NOT NULL CHECK (
    length(topic_id) = 26 AND substr(topic_id, 1, 1) BETWEEN '0' AND '7'
    AND topic_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  operation TEXT NOT NULL CHECK (operation IN ('create', 'rename', 'move', 'merge')),
  previous_parent_topic_id TEXT,
  new_parent_topic_id TEXT,
  previous_display_name TEXT,
  previous_normalized_name TEXT,
  new_display_name TEXT,
  new_normalized_name TEXT,
  merge_target_topic_id TEXT,
  reparented_child_ids_json TEXT NOT NULL CHECK (
    json_valid(reparented_child_ids_json)
    AND json_type(reparented_child_ids_json) = 'array'
    AND json_array_length(reparented_child_ids_json) <= 128
    AND length(CAST(reparented_child_ids_json AS BLOB)) <= 16384
  ),
  moved_placement_ids_json TEXT NOT NULL CHECK (
    json_valid(moved_placement_ids_json)
    AND json_type(moved_placement_ids_json) = 'array'
    AND json_array_length(moved_placement_ids_json) <= 512
    AND length(CAST(moved_placement_ids_json AS BLOB)) <= 65536
  ),
  added_aliases_json TEXT NOT NULL CHECK (
    json_valid(added_aliases_json)
    AND json_type(added_aliases_json) = 'array'
    AND json_array_length(added_aliases_json) <= 128
    AND length(CAST(added_aliases_json AS BLOB)) <= 32768
  ),
  reason TEXT NOT NULL CHECK (length(CAST(reason AS BLOB)) BETWEEN 1 AND 512),
  actor TEXT NOT NULL CHECK (actor IN ('owner', 'rules', 'model')),
  owner_authorizing_event_id TEXT CHECK (
    owner_authorizing_event_id IS NULL OR (
      length(owner_authorizing_event_id) = 26
      AND substr(owner_authorizing_event_id, 1, 1) BETWEEN '0' AND '7'
      AND owner_authorizing_event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
    )
  ),
  occurred_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS occurred_at),
  UNIQUE (principal_id, topic_event_id),
  CHECK (
    (actor = 'owner' AND owner_authorizing_event_id IS NOT NULL)
    OR (actor IN ('rules', 'model') AND owner_authorizing_event_id IS NULL)
  ),
  CHECK (
    (operation = 'create'
      AND previous_parent_topic_id IS NULL
      AND previous_display_name IS NULL
      AND previous_normalized_name IS NULL
      AND new_display_name IS NOT NULL
      AND new_normalized_name IS NOT NULL
      AND merge_target_topic_id IS NULL)
    OR (operation = 'rename'
      AND previous_display_name IS NOT NULL
      AND previous_normalized_name IS NOT NULL
      AND new_display_name IS NOT NULL
      AND new_normalized_name IS NOT NULL
      AND merge_target_topic_id IS NULL)
    OR (operation = 'move'
      AND previous_parent_topic_id IS NOT NULL
      AND new_parent_topic_id IS NOT NULL
      AND previous_display_name IS NULL
      AND new_display_name IS NULL
      AND merge_target_topic_id IS NULL)
    OR (operation = 'merge'
      AND previous_display_name IS NOT NULL
      AND previous_normalized_name IS NOT NULL
      AND new_display_name IS NULL
      AND new_normalized_name IS NULL
      AND merge_target_topic_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE memory_topic_aliases (
  alias_id TEXT PRIMARY KEY CHECK (
    length(alias_id) = 26 AND substr(alias_id, 1, 1) BETWEEN '0' AND '7'
    AND alias_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  topic_id TEXT NOT NULL,
  display_alias TEXT NOT NULL CHECK (length(CAST(display_alias AS BLOB)) BETWEEN 1 AND 256),
  normalized_alias TEXT NOT NULL CHECK (length(CAST(normalized_alias AS BLOB)) BETWEEN 1 AND 256),
  path_alias TEXT NOT NULL CHECK (length(CAST(path_alias AS BLOB)) BETWEEN 1 AND 2048),
  created_by_topic_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  UNIQUE (principal_id, alias_id),
  UNIQUE (principal_id, normalized_alias, path_alias),
  FOREIGN KEY (principal_id, topic_id)
    REFERENCES memory_topics(principal_id, topic_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, created_by_topic_event_id)
    REFERENCES memory_topic_events(principal_id, topic_event_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE memory_item_placement_events (
  placement_event_id TEXT PRIMARY KEY CHECK (
    length(placement_event_id) = 26 AND substr(placement_event_id, 1, 1) BETWEEN '0' AND '7'
    AND placement_event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  placement_id TEXT NOT NULL CHECK (
    length(placement_id) = 26 AND substr(placement_id, 1, 1) BETWEEN '0' AND '7'
    AND placement_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  placement_event_number INTEGER NOT NULL CHECK (
    typeof(placement_event_number) = 'integer' AND placement_event_number > 0
  ),
  item_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('place', 'refile', 'remove')),
  previous_topic_id TEXT,
  new_topic_id TEXT,
  relation TEXT NOT NULL CHECK (relation IN ('primary', 'related')),
  filing_source TEXT NOT NULL CHECK (filing_source IN ('owner', 'rule', 'model')),
  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  reason TEXT NOT NULL CHECK (length(CAST(reason AS BLOB)) BETWEEN 1 AND 512),
  owner_authorizing_event_id TEXT CHECK (
    owner_authorizing_event_id IS NULL OR (
      length(owner_authorizing_event_id) = 26
      AND substr(owner_authorizing_event_id, 1, 1) BETWEEN '0' AND '7'
      AND owner_authorizing_event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
    )
  ),
  occurred_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS occurred_at),
  UNIQUE (principal_id, placement_event_id),
  UNIQUE (principal_id, placement_id, placement_event_number),
  FOREIGN KEY (principal_id, item_id)
    REFERENCES memory_items(principal_id, item_id) ON DELETE RESTRICT,
  CHECK (
    (filing_source = 'owner' AND owner_authorizing_event_id IS NOT NULL)
    OR (filing_source IN ('rule', 'model') AND owner_authorizing_event_id IS NULL)
  ),
  CHECK (
    (operation = 'place' AND previous_topic_id IS NULL AND new_topic_id IS NOT NULL)
    OR (operation = 'refile' AND previous_topic_id IS NOT NULL AND new_topic_id IS NOT NULL)
    OR (operation = 'remove' AND previous_topic_id IS NOT NULL AND new_topic_id IS NULL)
  )
) STRICT;

CREATE TABLE memory_item_placement_state (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  placement_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('primary', 'related')),
  status TEXT NOT NULL CHECK (status IN ('active', 'removed')),
  last_event_kind TEXT NOT NULL CHECK (last_event_kind IN ('placement', 'topic')),
  last_event_id TEXT NOT NULL,
  last_placement_event_number INTEGER NOT NULL CHECK (
    typeof(last_placement_event_number) = 'integer' AND last_placement_event_number > 0
  ),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  PRIMARY KEY (principal_id, placement_id),
  FOREIGN KEY (principal_id, item_id)
    REFERENCES memory_items(principal_id, item_id) ON DELETE CASCADE,
  FOREIGN KEY (principal_id, topic_id)
    REFERENCES memory_topics(principal_id, topic_id) ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE UNIQUE INDEX memory_item_one_primary_placement
ON memory_item_placement_state(principal_id, item_id)
WHERE relation = 'primary' AND status = 'active';

CREATE TABLE memory_episodes (
  episode_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id TEXT NOT NULL UNIQUE CHECK (
    length(episode_id) = 26 AND substr(episode_id, 1, 1) BETWEEN '0' AND '7'
    AND episode_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  local_day TEXT NOT NULL CHECK (local_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  start_event_sequence INTEGER NOT NULL CHECK (typeof(start_event_sequence) = 'integer' AND start_event_sequence > 0),
  end_event_sequence INTEGER NOT NULL CHECK (
    typeof(end_event_sequence) = 'integer' AND end_event_sequence >= start_event_sequence
  ),
  source_count INTEGER NOT NULL CHECK (
    typeof(source_count) = 'integer' AND source_count BETWEEN 1 AND 256
  ),
  text TEXT NOT NULL CHECK (
    length(CAST(text AS BLOB)) BETWEEN 1 AND 16384
    AND instr(text, char(0)) = 0
    AND text NOT GLOB ('*[' || char(1) || '-' || char(31)
      || char(127) || '-' || char(159) || char(8232) || char(8233) || ']*')
  ),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  summarizer_version TEXT NOT NULL CHECK (length(CAST(summarizer_version AS BLOB)) BETWEEN 1 AND 128),
  summarizer_model_id TEXT NOT NULL CHECK (
    summarizer_model_id GLOB 'deepseek:*'
    OR summarizer_model_id GLOB 'anthropic:*'
    OR summarizer_model_id GLOB 'openai:*'
  ),
  supersedes_episode_id TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  UNIQUE (principal_id, episode_id),
  FOREIGN KEY (principal_id, supersedes_episode_id)
    REFERENCES memory_episodes(principal_id, episode_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE memory_episode_sources (
  source_id TEXT PRIMARY KEY CHECK (
    length(source_id) = 26 AND substr(source_id, 1, 1) BETWEEN '0' AND '7'
    AND source_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  episode_id TEXT NOT NULL,
  source_position INTEGER NOT NULL CHECK (typeof(source_position) = 'integer' AND source_position BETWEEN 0 AND 255),
  event_id TEXT NOT NULL CHECK (
    length(event_id) = 26 AND substr(event_id, 1, 1) BETWEEN '0' AND '7'
    AND event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  event_sequence INTEGER NOT NULL CHECK (typeof(event_sequence) = 'integer' AND event_sequence > 0),
  source_location TEXT NOT NULL CHECK (source_location IN ('live', 'archived')),
  r2_segment_id TEXT CHECK (
    r2_segment_id IS NULL OR (length(r2_segment_id) = 64 AND r2_segment_id NOT GLOB '*[^0-9a-f]*')
  ),
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'voice', 'system')),
  occurred_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS occurred_at),
  UNIQUE (principal_id, source_id),
  UNIQUE (principal_id, episode_id, source_position),
  UNIQUE (principal_id, episode_id, event_id),
  FOREIGN KEY (principal_id, episode_id)
    REFERENCES memory_episodes(principal_id, episode_id) ON DELETE CASCADE,
  CHECK (
    (source_location = 'live' AND r2_segment_id IS NULL)
    OR (source_location = 'archived' AND r2_segment_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE memory_history_chunks (
  chunk_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id TEXT NOT NULL UNIQUE CHECK (
    length(chunk_id) = 26 AND substr(chunk_id, 1, 1) BETWEEN '0' AND '7'
    AND chunk_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  start_event_sequence INTEGER NOT NULL CHECK (typeof(start_event_sequence) = 'integer' AND start_event_sequence > 0),
  end_event_sequence INTEGER NOT NULL CHECK (
    typeof(end_event_sequence) = 'integer' AND end_event_sequence >= start_event_sequence
  ),
  text TEXT NOT NULL CHECK (
    length(CAST(text AS BLOB)) BETWEEN 1 AND 32768
    AND instr(text, char(0)) = 0
    AND text NOT GLOB ('*[' || char(1) || '-' || char(31)
      || char(127) || '-' || char(159) || char(8232) || char(8233) || ']*')
  ),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  source_location TEXT NOT NULL CHECK (source_location IN ('live', 'archived', 'mixed')),
  r2_segment_id TEXT CHECK (
    r2_segment_id IS NULL OR (length(r2_segment_id) = 64 AND r2_segment_id NOT GLOB '*[^0-9a-f]*')
  ),
  source_receipt_hash TEXT NOT NULL CHECK (
    length(source_receipt_hash) = 64 AND source_receipt_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at AND updated_at >= created_at
  ),
  UNIQUE (principal_id, chunk_id),
  CHECK (
    (source_location = 'archived' AND r2_segment_id IS NOT NULL)
    OR (source_location IN ('live', 'mixed') AND r2_segment_id IS NULL)
  )
) STRICT;

CREATE TABLE memory_history_coverage (
  coverage_id TEXT PRIMARY KEY CHECK (
    length(coverage_id) = 26 AND substr(coverage_id, 1, 1) BETWEEN '0' AND '7'
    AND coverage_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  source_location TEXT NOT NULL CHECK (source_location IN ('live', 'archived')),
  start_event_sequence INTEGER NOT NULL CHECK (typeof(start_event_sequence) = 'integer' AND start_event_sequence > 0),
  end_event_sequence INTEGER NOT NULL CHECK (
    typeof(end_event_sequence) = 'integer' AND end_event_sequence >= start_event_sequence
  ),
  r2_segment_id TEXT CHECK (
    r2_segment_id IS NULL OR (length(r2_segment_id) = 64 AND r2_segment_id NOT GLOB '*[^0-9a-f]*')
  ),
  indexing_outcome TEXT NOT NULL CHECK (indexing_outcome IN ('indexed', 'failed')),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  failure_code TEXT CHECK (failure_code IS NULL OR length(CAST(failure_code AS BLOB)) BETWEEN 1 AND 128),
  indexed_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', indexed_at) IS indexed_at),
  UNIQUE (principal_id, coverage_id),
  CHECK (
    (source_location = 'live' AND r2_segment_id IS NULL)
    OR (source_location = 'archived' AND r2_segment_id IS NOT NULL)
  ),
  CHECK (
    (indexing_outcome = 'indexed' AND failure_code IS NULL)
    OR (indexing_outcome = 'failed' AND failure_code IS NOT NULL)
  )
) STRICT;

CREATE TABLE memory_vectors (
  vector_ledger_id TEXT PRIMARY KEY CHECK (
    length(vector_ledger_id) = 26 AND substr(vector_ledger_id, 1, 1) BETWEEN '0' AND '7'
    AND vector_ledger_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('item', 'episode', 'history_chunk')),
  item_id TEXT NOT NULL CHECK (length(CAST(item_id AS BLOB)) BETWEEN 1 AND 128),
  embedding_model TEXT NOT NULL CHECK (embedding_model = '@cf/baai/bge-m3'),
  dimensions INTEGER NOT NULL CHECK (typeof(dimensions) = 'integer' AND dimensions BETWEEN 1 AND 4096),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  mutation_id TEXT NOT NULL UNIQUE CHECK (length(CAST(mutation_id AS BLOB)) BETWEEN 1 AND 128),
  upserted_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', upserted_at) IS upserted_at),
  deleted_at TEXT CHECK (
    deleted_at IS NULL OR (
      strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) IS deleted_at AND deleted_at >= upserted_at
    )
  ),
  UNIQUE (principal_id, vector_ledger_id),
  UNIQUE (principal_id, item_kind, item_id, embedding_model, content_hash)
) STRICT;

CREATE TABLE memory_model_prices (
  price_id TEXT PRIMARY KEY CHECK (
    length(price_id) = 26 AND substr(price_id, 1, 1) BETWEEN '0' AND '7'
    AND price_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('deepseek', 'anthropic', 'openai')),
  model_id TEXT NOT NULL CHECK (
    (provider = 'deepseek' AND model_id GLOB 'deepseek:*')
    OR (provider = 'anthropic' AND model_id GLOB 'anthropic:*')
    OR (provider = 'openai' AND model_id GLOB 'openai:*')
  ),
  effective_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', effective_at) IS effective_at),
  input_micros_per_million INTEGER NOT NULL CHECK (
    typeof(input_micros_per_million) = 'integer' AND input_micros_per_million >= 0
  ),
  output_micros_per_million INTEGER NOT NULL CHECK (
    typeof(output_micros_per_million) = 'integer' AND output_micros_per_million >= 0
  ),
  cache_read_micros_per_million INTEGER NOT NULL CHECK (
    typeof(cache_read_micros_per_million) = 'integer' AND cache_read_micros_per_million >= 0
  ),
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  source_receipt TEXT NOT NULL CHECK (length(CAST(source_receipt AS BLOB)) BETWEEN 1 AND 2048),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  UNIQUE (principal_id, price_id),
  UNIQUE (principal_id, model_id, effective_at)
) STRICT;

CREATE TABLE memory_runs (
  run_id TEXT PRIMARY KEY CHECK (
    length(run_id) = 26 AND substr(run_id, 1, 1) BETWEEN '0' AND '7'
    AND run_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  run_key TEXT NOT NULL CHECK (length(CAST(run_key AS BLOB)) BETWEEN 1 AND 256),
  job TEXT NOT NULL CHECK (job IN ('distillation', 'consolidation', 'reprocessing', 'export')),
  reprocess_job_id TEXT,
  start_event_sequence INTEGER CHECK (
    start_event_sequence IS NULL OR (typeof(start_event_sequence) = 'integer' AND start_event_sequence > 0)
  ),
  end_event_sequence INTEGER CHECK (
    end_event_sequence IS NULL OR (
      typeof(end_event_sequence) = 'integer' AND end_event_sequence >= start_event_sequence
    )
  ),
  provider_model_id TEXT CHECK (
    provider_model_id IS NULL
    OR provider_model_id GLOB 'deepseek:*'
    OR provider_model_id GLOB 'anthropic:*'
    OR provider_model_id GLOB 'openai:*'
  ),
  price_id TEXT,
  input_event_count INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(input_event_count) = 'integer' AND input_event_count >= 0
  ),
  created_item_count INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(created_item_count) = 'integer' AND created_item_count >= 0
  ),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (typeof(input_tokens) = 'integer' AND input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (typeof(output_tokens) = 'integer' AND output_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(cache_read_tokens) = 'integer' AND cache_read_tokens >= 0
  ),
  reserved_cost_micros INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(reserved_cost_micros) = 'integer' AND reserved_cost_micros >= 0
  ),
  settled_cost_micros INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(settled_cost_micros) = 'integer' AND settled_cost_micros >= 0
  ),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'running', 'succeeded', 'nothing_new', 'budget_blocked',
    'provider_credit_blocked', 'failed'
  )),
  started_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', started_at) IS started_at),
  completed_at TEXT CHECK (
    completed_at IS NULL OR (
      strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) IS completed_at AND completed_at >= started_at
    )
  ),
  failure_code TEXT CHECK (failure_code IS NULL OR length(CAST(failure_code AS BLOB)) BETWEEN 1 AND 128),
  UNIQUE (principal_id, run_id),
  UNIQUE (principal_id, run_key),
  FOREIGN KEY (principal_id, price_id)
    REFERENCES memory_model_prices(principal_id, price_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, reprocess_job_id)
    REFERENCES memory_reprocess_jobs(principal_id, job_id) ON DELETE RESTRICT,
  CHECK (
    (job = 'reprocessing' AND reprocess_job_id IS NOT NULL)
    OR (job <> 'reprocessing' AND reprocess_job_id IS NULL)
  ),
  CHECK (
    (start_event_sequence IS NULL AND end_event_sequence IS NULL)
    OR (start_event_sequence IS NOT NULL AND end_event_sequence IS NOT NULL)
  ),
  CHECK (
    (outcome = 'running' AND completed_at IS NULL AND failure_code IS NULL)
    OR (outcome IN ('succeeded', 'nothing_new', 'budget_blocked', 'provider_credit_blocked')
      AND completed_at IS NOT NULL AND failure_code IS NULL)
    OR (outcome = 'failed' AND completed_at IS NOT NULL AND failure_code IS NOT NULL)
  )
) STRICT;

CREATE TABLE memory_reprocess_jobs (
  job_id TEXT PRIMARY KEY CHECK (
    length(job_id) = 26 AND substr(job_id, 1, 1) BETWEEN '0' AND '7'
    AND job_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  owner_authorizing_event_id TEXT NOT NULL CHECK (
    length(owner_authorizing_event_id) = 26
    AND substr(owner_authorizing_event_id, 1, 1) BETWEEN '0' AND '7'
    AND owner_authorizing_event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  start_event_sequence INTEGER CHECK (
    start_event_sequence IS NULL OR (typeof(start_event_sequence) = 'integer' AND start_event_sequence > 0)
  ),
  end_event_sequence INTEGER CHECK (
    end_event_sequence IS NULL OR (
      typeof(end_event_sequence) = 'integer' AND end_event_sequence >= start_event_sequence
    )
  ),
  start_day TEXT CHECK (start_day IS NULL OR start_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  end_day TEXT CHECK (end_day IS NULL OR end_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  maximum_event_count INTEGER NOT NULL CHECK (
    typeof(maximum_event_count) = 'integer' AND maximum_event_count BETWEEN 1 AND 10000
  ),
  provider_model_id TEXT NOT NULL CHECK (
    provider_model_id GLOB 'deepseek:*'
    OR provider_model_id GLOB 'anthropic:*'
    OR provider_model_id GLOB 'openai:*'
  ),
  spend_limit_micros INTEGER NOT NULL CHECK (
    typeof(spend_limit_micros) = 'integer' AND spend_limit_micros BETWEEN 1 AND 1000000000
  ),
  dry_run INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
  checkpoint_event_sequence INTEGER CHECK (
    checkpoint_event_sequence IS NULL OR (
      typeof(checkpoint_event_sequence) = 'integer' AND checkpoint_event_sequence >= 0
    )
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  final_receipt_hash TEXT CHECK (
    final_receipt_hash IS NULL OR (
      length(final_receipt_hash) = 64 AND final_receipt_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  failure_code TEXT CHECK (failure_code IS NULL OR length(CAST(failure_code AS BLOB)) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at AND updated_at >= created_at
  ),
  UNIQUE (principal_id, job_id),
  CHECK (
    (start_event_sequence IS NOT NULL AND end_event_sequence IS NOT NULL AND start_day IS NULL AND end_day IS NULL)
    OR (start_event_sequence IS NULL AND end_event_sequence IS NULL AND start_day IS NOT NULL AND end_day IS NOT NULL)
  ),
  CHECK (start_day IS NULL OR end_day >= start_day),
  CHECK (
    (status IN ('pending', 'running') AND final_receipt_hash IS NULL AND failure_code IS NULL)
    OR (status = 'succeeded' AND final_receipt_hash IS NOT NULL AND failure_code IS NULL)
    OR (status = 'failed' AND final_receipt_hash IS NOT NULL AND failure_code IS NOT NULL)
    OR (status = 'cancelled' AND final_receipt_hash IS NOT NULL)
  )
) STRICT;

CREATE TABLE memory_cost_ledger (
  cost_entry_id TEXT PRIMARY KEY CHECK (
    length(cost_entry_id) = 26 AND substr(cost_entry_id, 1, 1) BETWEEN '0' AND '7'
    AND cost_entry_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('reservation', 'settlement', 'release', 'overrun')),
  reservation_entry_id TEXT,
  provider TEXT NOT NULL CHECK (provider IN ('deepseek', 'anthropic', 'openai')),
  model_id TEXT NOT NULL CHECK (
    (provider = 'deepseek' AND model_id GLOB 'deepseek:*')
    OR (provider = 'anthropic' AND model_id GLOB 'anthropic:*')
    OR (provider = 'openai' AND model_id GLOB 'openai:*')
  ),
  budget_class TEXT NOT NULL CHECK (budget_class IN ('normal_monthly', 'reprocessing')),
  reprocess_job_id TEXT,
  amount_micros INTEGER NOT NULL CHECK (typeof(amount_micros) = 'integer' AND amount_micros >= 0),
  price_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS occurred_at),
  UNIQUE (principal_id, cost_entry_id),
  FOREIGN KEY (principal_id, run_id)
    REFERENCES memory_runs(principal_id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, reservation_entry_id)
    REFERENCES memory_cost_ledger(principal_id, cost_entry_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, reprocess_job_id)
    REFERENCES memory_reprocess_jobs(principal_id, job_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, price_id)
    REFERENCES memory_model_prices(principal_id, price_id) ON DELETE RESTRICT,
  CHECK (
    (entry_type = 'reservation' AND reservation_entry_id IS NULL AND amount_micros > 0)
    OR (entry_type IN ('settlement', 'release') AND reservation_entry_id IS NOT NULL)
    OR (entry_type = 'overrun' AND reservation_entry_id IS NOT NULL AND amount_micros > 0)
  ),
  CHECK (
    (budget_class = 'normal_monthly' AND reprocess_job_id IS NULL)
    OR (budget_class = 'reprocessing' AND reprocess_job_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE memory_cursors (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  cursor_name TEXT NOT NULL CHECK (cursor_name IN (
    'distillation', 'summaries', 'fts_items', 'fts_episodes',
    'fts_history', 'embeddings', 'export'
  )),
  current_event_sequence INTEGER NOT NULL CHECK (
    typeof(current_event_sequence) = 'integer' AND current_event_sequence >= 0
  ),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  PRIMARY KEY (principal_id, cursor_name)
) WITHOUT ROWID;

CREATE VIRTUAL TABLE memory_item_fts USING fts5(
  text,
  content='memory_item_versions',
  content_rowid='version_rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE memory_episode_fts USING fts5(
  text,
  content='memory_episodes',
  content_rowid='episode_rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE memory_history_fts USING fts5(
  text,
  content='memory_history_chunks',
  content_rowid='chunk_rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE VIEW memory_active_event_suppressions AS
SELECT suppression.*
FROM memory_event_suppressions suppression
LEFT JOIN memory_event_suppression_lifts lift
  ON lift.principal_id = suppression.principal_id
  AND lift.suppression_id = suppression.suppression_id
WHERE lift.lift_id IS NULL;

-- A privileged memory mutation is authorized only by a canonical, dedicated
-- owner-command event. Each guarded row additionally binds the command's
-- operation, target and limits to the exact mutation it authorizes.
CREATE VIEW memory_valid_owner_commands AS
SELECT event.sequence, event.event_id, event.subject_id, event.envelope_json
FROM events event
JOIN principals principal ON principal.principal_id = event.subject_id
WHERE event.event_type = 'memory.owner_command'
  AND event.source = 'memory-control'
  AND principal.principal_type = 'human'
  AND principal.status = 'active'
  AND json_type(event.envelope_json, '$') = 'object'
  AND json_extract(event.envelope_json, '$.eventId') = event.event_id
  AND json_extract(event.envelope_json, '$.correlationId') = event.event_id
  AND json_extract(event.envelope_json, '$.eventType') = event.event_type
  AND json_extract(event.envelope_json, '$.source') = event.source
  AND json_extract(event.envelope_json, '$.subjectId') = event.subject_id
  AND json_extract(event.envelope_json, '$.occurredAt') = event.occurred_at
  AND json_extract(event.envelope_json, '$.receivedAt') = event.received_at
  AND json_extract(event.envelope_json, '$.contentHash') = event.content_hash
  AND json_extract(event.envelope_json, '$.producerVersion') = 'memory-control-v1'
  AND json_type(event.envelope_json, '$.payload') = 'object'
  AND json_type(event.envelope_json, '$.payload.operation') = 'text'
  AND json_type(event.envelope_json, '$.payload.targetId') = 'text';

-- Every recent Telegram and voice read uses this anti-joined view before LIMIT.
CREATE VIEW memory_visible_recent_events AS
SELECT event.sequence, event.event_id, event.event_type, event.source,
  event.subject_id, event.occurred_at, event.received_at, event.content_hash,
  event.envelope_json, event.created_at
FROM events event
WHERE event.event_type IN ('conversation.user_committed', 'conversation.assistant_delivered')
  AND NOT EXISTS (
    SELECT 1 FROM memory_active_event_suppressions suppression
    WHERE suppression.principal_id = event.subject_id
      AND (
        suppression.target_event_id = event.event_id
        OR event.sequence BETWEEN suppression.start_event_sequence AND suppression.end_event_sequence
      )
  );

CREATE VIEW memory_retrievable_item_versions AS
SELECT version.*
FROM memory_item_state state
JOIN memory_item_versions version
  ON version.principal_id = state.principal_id
  AND version.version_id = state.current_version_id
WHERE state.lifecycle_state = 'active'
  AND EXISTS (
    SELECT 1 FROM memory_item_sources source
    WHERE source.principal_id = version.principal_id
      AND source.version_id = version.version_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM memory_item_sources source
    JOIN memory_active_event_suppressions suppression
      ON suppression.principal_id = source.principal_id
      AND (
        suppression.target_event_id = source.event_id
        OR source.event_sequence BETWEEN suppression.start_event_sequence AND suppression.end_event_sequence
      )
    WHERE source.principal_id = version.principal_id
      AND source.version_id = version.version_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM memory_active_event_suppressions suppression
    JOIN memory_items item
      ON item.principal_id = version.principal_id
      AND item.item_id = version.item_id
    WHERE suppression.principal_id = item.principal_id
      AND (
        suppression.target_event_id = item.creation_event_id
        OR item.creation_event_sequence BETWEEN suppression.start_event_sequence
          AND suppression.end_event_sequence
      )
  );

CREATE VIEW memory_retrievable_episodes AS
SELECT episode.*
FROM memory_episodes episode
WHERE NOT EXISTS (
    SELECT 1 FROM memory_episodes replacement
    WHERE replacement.principal_id = episode.principal_id
      AND replacement.supersedes_episode_id = episode.episode_id
  )
  AND (
    SELECT count(*) FROM memory_episode_sources source
    WHERE source.principal_id = episode.principal_id
      AND source.episode_id = episode.episode_id
  ) = episode.source_count
  AND NOT EXISTS (
    SELECT 1
    FROM memory_episode_sources source
    JOIN memory_active_event_suppressions suppression
      ON suppression.principal_id = source.principal_id
      AND (
        suppression.target_event_id = source.event_id
        OR source.event_sequence BETWEEN suppression.start_event_sequence AND suppression.end_event_sequence
      )
    WHERE source.principal_id = episode.principal_id
      AND source.episode_id = episode.episode_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM memory_active_event_suppressions suppression
    WHERE suppression.principal_id = episode.principal_id
      AND (
        (suppression.start_event_sequence <= episode.end_event_sequence
          AND suppression.end_event_sequence >= episode.start_event_sequence)
        OR EXISTS (
          SELECT 1 FROM events event
          WHERE event.event_id = suppression.target_event_id
            AND event.sequence BETWEEN episode.start_event_sequence AND episode.end_event_sequence
        )
        OR EXISTS (
          SELECT 1 FROM archive_segment_events archived
          WHERE archived.event_id = suppression.target_event_id
            AND archived.event_sequence BETWEEN episode.start_event_sequence AND episode.end_event_sequence
        )
      )
  );

CREATE VIEW memory_retrievable_history_chunks AS
SELECT chunk.*
FROM memory_history_chunks chunk
WHERE NOT EXISTS (
  SELECT 1 FROM memory_active_event_suppressions suppression
  WHERE suppression.principal_id = chunk.principal_id
    AND (
      suppression.start_event_sequence <= chunk.end_event_sequence
        AND suppression.end_event_sequence >= chunk.start_event_sequence
      OR EXISTS (
        SELECT 1 FROM events event
        WHERE event.event_id = suppression.target_event_id
          AND event.sequence BETWEEN chunk.start_event_sequence AND chunk.end_event_sequence
      )
      OR EXISTS (
        SELECT 1 FROM archive_segment_events archived
        WHERE archived.event_id = suppression.target_event_id
          AND archived.event_sequence BETWEEN chunk.start_event_sequence AND chunk.end_event_sequence
      )
    )
);

CREATE INDEX memory_item_versions_current_lookup
ON memory_item_versions(principal_id, item_id, version_number DESC);

CREATE INDEX memory_item_sources_event_lookup
ON memory_item_sources(principal_id, event_sequence, event_id);

CREATE INDEX memory_event_suppressions_event_lookup
ON memory_event_suppressions(principal_id, target_event_id);

CREATE INDEX memory_event_suppressions_range_lookup
ON memory_event_suppressions(principal_id, start_event_sequence, end_event_sequence);

CREATE INDEX memory_topics_parent_lookup
ON memory_topics(principal_id, parent_topic_id, status);

CREATE INDEX memory_item_placement_topic_lookup
ON memory_item_placement_state(principal_id, topic_id, status, relation);

CREATE INDEX memory_history_coverage_range_lookup
ON memory_history_coverage(principal_id, source_location, start_event_sequence, end_event_sequence);

CREATE INDEX memory_runs_job_started_lookup
ON memory_runs(principal_id, job, started_at DESC);

CREATE INDEX memory_cost_ledger_month_lookup
ON memory_cost_ledger(principal_id, budget_class, occurred_at);

CREATE TRIGGER memory_items_insert_guard
BEFORE INSERT ON memory_items
WHEN EXISTS (
    SELECT 1 FROM memory_items item
    WHERE item.item_id = NEW.item_id
      OR (item.principal_id = NEW.principal_id AND item.item_id = NEW.item_id)
  )
  OR NOT EXISTS (
    SELECT 1 FROM events event
    WHERE event.event_id = NEW.creation_event_id
      AND event.sequence = NEW.creation_event_sequence
      AND event.subject_id = NEW.principal_id
    UNION
    SELECT 1 FROM archive_segment_events archived
    WHERE archived.event_id = NEW.creation_event_id
      AND archived.event_sequence = NEW.creation_event_sequence
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_item_creation_event_invalid');
END;

CREATE TRIGGER memory_items_immutable_update
BEFORE UPDATE ON memory_items
BEGIN
  SELECT RAISE(ABORT, 'memory_item_immutable');
END;

CREATE TRIGGER memory_items_immutable_delete
BEFORE DELETE ON memory_items
BEGIN
  SELECT RAISE(ABORT, 'memory_item_immutable');
END;

CREATE TRIGGER memory_item_versions_immutable_update
BEFORE UPDATE ON memory_item_versions
BEGIN
  SELECT RAISE(ABORT, 'memory_item_version_immutable');
END;

CREATE TRIGGER memory_item_versions_immutable_delete
BEFORE DELETE ON memory_item_versions
BEGIN
  SELECT RAISE(ABORT, 'memory_item_version_immutable');
END;

CREATE TRIGGER memory_item_sources_immutable_update
BEFORE UPDATE ON memory_item_sources
BEGIN
  SELECT RAISE(ABORT, 'memory_item_source_immutable');
END;

CREATE TRIGGER memory_item_sources_immutable_delete
BEFORE DELETE ON memory_item_sources
BEGIN
  SELECT RAISE(ABORT, 'memory_item_source_immutable');
END;

CREATE TRIGGER memory_item_transitions_immutable_update
BEFORE UPDATE ON memory_item_transitions
BEGIN
  SELECT RAISE(ABORT, 'memory_item_transition_immutable');
END;

CREATE TRIGGER memory_item_transitions_immutable_delete
BEFORE DELETE ON memory_item_transitions
BEGIN
  SELECT RAISE(ABORT, 'memory_item_transition_immutable');
END;

CREATE TRIGGER memory_event_suppressions_immutable_update
BEFORE UPDATE ON memory_event_suppressions
BEGIN
  SELECT RAISE(ABORT, 'memory_event_suppression_immutable');
END;

CREATE TRIGGER memory_event_suppressions_immutable_delete
BEFORE DELETE ON memory_event_suppressions
BEGIN
  SELECT RAISE(ABORT, 'memory_event_suppression_immutable');
END;

CREATE TRIGGER memory_event_suppression_lifts_immutable_update
BEFORE UPDATE ON memory_event_suppression_lifts
BEGIN
  SELECT RAISE(ABORT, 'memory_event_suppression_lift_immutable');
END;

CREATE TRIGGER memory_event_suppression_lifts_immutable_delete
BEFORE DELETE ON memory_event_suppression_lifts
BEGIN
  SELECT RAISE(ABORT, 'memory_event_suppression_lift_immutable');
END;

CREATE TRIGGER memory_item_links_immutable_update
BEFORE UPDATE ON memory_item_links
BEGIN
  SELECT RAISE(ABORT, 'memory_item_link_immutable');
END;

CREATE TRIGGER memory_item_links_immutable_delete
BEFORE DELETE ON memory_item_links
BEGIN
  SELECT RAISE(ABORT, 'memory_item_link_immutable');
END;

CREATE TRIGGER memory_topic_events_immutable_update
BEFORE UPDATE ON memory_topic_events
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_event_immutable');
END;

CREATE TRIGGER memory_topic_events_immutable_delete
BEFORE DELETE ON memory_topic_events
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_event_immutable');
END;

CREATE TRIGGER memory_topic_aliases_immutable_update
BEFORE UPDATE ON memory_topic_aliases
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_alias_immutable');
END;

CREATE TRIGGER memory_topic_aliases_immutable_delete
BEFORE DELETE ON memory_topic_aliases
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_alias_immutable');
END;

CREATE TRIGGER memory_item_placement_events_immutable_update
BEFORE UPDATE ON memory_item_placement_events
BEGIN
  SELECT RAISE(ABORT, 'memory_item_placement_event_immutable');
END;

CREATE TRIGGER memory_item_placement_events_immutable_delete
BEFORE DELETE ON memory_item_placement_events
BEGIN
  SELECT RAISE(ABORT, 'memory_item_placement_event_immutable');
END;

CREATE TRIGGER memory_episodes_immutable_update
BEFORE UPDATE ON memory_episodes
BEGIN
  SELECT RAISE(ABORT, 'memory_episode_immutable');
END;

CREATE TRIGGER memory_episodes_immutable_delete
BEFORE DELETE ON memory_episodes
BEGIN
  SELECT RAISE(ABORT, 'memory_episode_immutable');
END;

CREATE TRIGGER memory_episode_sources_immutable_update
BEFORE UPDATE ON memory_episode_sources
BEGIN
  SELECT RAISE(ABORT, 'memory_episode_source_immutable');
END;

CREATE TRIGGER memory_episode_sources_immutable_delete
BEFORE DELETE ON memory_episode_sources
BEGIN
  SELECT RAISE(ABORT, 'memory_episode_source_immutable');
END;

CREATE TRIGGER memory_history_coverage_immutable_update
BEFORE UPDATE ON memory_history_coverage
BEGIN
  SELECT RAISE(ABORT, 'memory_history_coverage_immutable');
END;

CREATE TRIGGER memory_history_coverage_immutable_delete
BEFORE DELETE ON memory_history_coverage
BEGIN
  SELECT RAISE(ABORT, 'memory_history_coverage_immutable');
END;

CREATE TRIGGER memory_model_prices_immutable_update
BEFORE UPDATE ON memory_model_prices
BEGIN
  SELECT RAISE(ABORT, 'memory_model_price_immutable');
END;

CREATE TRIGGER memory_model_prices_immutable_delete
BEFORE DELETE ON memory_model_prices
BEGIN
  SELECT RAISE(ABORT, 'memory_model_price_immutable');
END;

CREATE TRIGGER memory_cost_ledger_immutable_update
BEFORE UPDATE ON memory_cost_ledger
BEGIN
  SELECT RAISE(ABORT, 'memory_cost_entry_immutable');
END;

CREATE TRIGGER memory_cost_ledger_immutable_delete
BEFORE DELETE ON memory_cost_ledger
BEGIN
  SELECT RAISE(ABORT, 'memory_cost_entry_immutable');
END;

CREATE TRIGGER memory_item_versions_insert_guard
BEFORE INSERT ON memory_item_versions
WHEN (NEW.version_rowid IS NOT NULL AND EXISTS (
    SELECT 1 FROM memory_item_versions version
    WHERE version.version_rowid = NEW.version_rowid
  ))
  OR EXISTS (
    SELECT 1 FROM memory_item_versions version
    WHERE version.version_id = NEW.version_id
      OR (version.principal_id = NEW.principal_id
        AND version.item_id = NEW.item_id
        AND version.version_number = NEW.version_number)
  )
  OR NOT EXISTS (
    SELECT 1 FROM memory_items item
    WHERE item.principal_id = NEW.principal_id AND item.item_id = NEW.item_id
  )
  OR NEW.version_number <> COALESCE((
    SELECT MAX(version.version_number) + 1
    FROM memory_item_versions version
    WHERE version.principal_id = NEW.principal_id AND version.item_id = NEW.item_id
  ), 1)
BEGIN
  SELECT RAISE(ABORT, 'memory_item_version_lineage_invalid');
END;

CREATE TRIGGER memory_item_sources_insert_guard
BEFORE INSERT ON memory_item_sources
WHEN EXISTS (
    SELECT 1 FROM memory_item_sources source
    WHERE source.source_id = NEW.source_id
      OR (source.principal_id = NEW.principal_id
        AND source.version_id = NEW.version_id
        AND (source.source_position = NEW.source_position OR source.event_id = NEW.event_id))
  )
  OR NOT EXISTS (
    SELECT 1 FROM memory_item_versions version
    WHERE version.principal_id = NEW.principal_id
      AND version.item_id = NEW.item_id
      AND version.version_id = NEW.version_id
  )
  OR (
    NEW.source_location = 'live'
    AND NOT EXISTS (
      SELECT 1 FROM events event
      WHERE event.event_id = NEW.event_id
        AND event.sequence = NEW.event_sequence
        AND event.subject_id = NEW.principal_id
    )
  )
  OR (
    NEW.source_location = 'archived'
    AND NOT EXISTS (
      SELECT 1 FROM archive_segment_events archived
      WHERE archived.event_id = NEW.event_id
        AND archived.event_sequence = NEW.event_sequence
        AND archived.segment_id = NEW.r2_segment_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_item_source_receipt_invalid');
END;

CREATE TRIGGER memory_item_transitions_insert_guard
BEFORE INSERT ON memory_item_transitions
WHEN EXISTS (
    SELECT 1 FROM memory_item_transitions transition_row
    WHERE transition_row.transition_id = NEW.transition_id
      OR (transition_row.principal_id = NEW.principal_id
        AND transition_row.item_id = NEW.item_id
        AND transition_row.transition_number = NEW.transition_number)
  )
  OR NOT EXISTS (
    SELECT 1 FROM memory_item_versions version
    WHERE version.principal_id = NEW.principal_id
      AND version.item_id = NEW.item_id
      AND version.version_id = NEW.version_id
  )
  OR NEW.transition_number <> COALESCE((
    SELECT state.last_transition_number + 1
    FROM memory_item_state state
    WHERE state.principal_id = NEW.principal_id AND state.item_id = NEW.item_id
  ), 1)
  OR (
    NOT EXISTS (
      SELECT 1 FROM memory_item_state state
      WHERE state.principal_id = NEW.principal_id AND state.item_id = NEW.item_id
    )
    AND NEW.lifecycle_state NOT IN ('proposed', 'active')
  )
  OR EXISTS (
    SELECT 1 FROM memory_item_state state
    JOIN memory_item_versions current_version
      ON current_version.principal_id = state.principal_id
      AND current_version.version_id = state.current_version_id
    JOIN memory_item_versions next_version
      ON next_version.principal_id = NEW.principal_id
      AND next_version.version_id = NEW.version_id
    WHERE state.principal_id = NEW.principal_id AND state.item_id = NEW.item_id
      AND NOT (
        (state.lifecycle_state = 'proposed'
          AND NEW.lifecycle_state IN ('active', 'rejected', 'forgotten', 'expired'))
        OR (state.lifecycle_state = 'active'
          AND NEW.lifecycle_state IN ('superseded', 'forgotten', 'expired'))
        OR (state.lifecycle_state IN ('rejected', 'superseded', 'forgotten', 'expired')
          AND NEW.lifecycle_state IN ('proposed', 'active')
          AND next_version.version_number > current_version.version_number)
      )
  )
  OR (NEW.actor = 'rules' AND NEW.lifecycle_state IN ('rejected', 'superseded', 'forgotten'))
  OR (
    NEW.actor <> 'owner'
    AND EXISTS (
      SELECT 1 FROM memory_item_state state
      WHERE state.principal_id = NEW.principal_id
        AND state.item_id = NEW.item_id
        AND state.lifecycle_state IN ('forgotten', 'rejected')
    )
  )
  OR (
    NEW.actor <> 'owner'
    AND EXISTS (
      SELECT 1
      FROM memory_item_state state
      JOIN memory_item_transitions current_transition
        ON current_transition.principal_id = state.principal_id
        AND current_transition.transition_id = state.last_transition_id
      JOIN memory_item_versions current_version
        ON current_version.principal_id = state.principal_id
        AND current_version.version_id = state.current_version_id
      WHERE state.principal_id = NEW.principal_id
        AND state.item_id = NEW.item_id
        AND current_transition.actor = 'owner'
        AND NOT (
          NEW.lifecycle_state = 'expired'
          AND NEW.version_id = state.current_version_id
          AND current_version.valid_to IS NOT NULL
          AND current_version.valid_to <= NEW.occurred_at
        )
    )
  )
  OR (
    NEW.lifecycle_state = 'active'
    AND (
      NOT EXISTS (
        SELECT 1 FROM memory_item_sources source
        WHERE source.principal_id = NEW.principal_id
          AND source.version_id = NEW.version_id
      )
      OR EXISTS (
      SELECT 1 FROM memory_item_versions version
      WHERE version.principal_id = NEW.principal_id
        AND version.version_id = NEW.version_id
        AND version.origin NOT IN ('authenticated_first_person', 'deterministic_observation')
      )
      OR EXISTS (
        SELECT 1 FROM memory_item_versions version
        WHERE version.principal_id = NEW.principal_id
          AND version.version_id = NEW.version_id
          AND version.basis = 'confirmed'
          AND NEW.actor <> 'owner'
      )
      OR (
        EXISTS (
          SELECT 1 FROM memory_item_versions version
          WHERE version.principal_id = NEW.principal_id
            AND version.version_id = NEW.version_id
            AND version.origin = 'authenticated_first_person'
        )
        AND NOT EXISTS (
          SELECT 1 FROM memory_item_sources source
          JOIN events event
            ON event.event_id = source.event_id
            AND event.sequence = source.event_sequence
          WHERE source.principal_id = NEW.principal_id
            AND source.version_id = NEW.version_id
            AND source.source_location = 'live'
            AND event.subject_id = NEW.principal_id
            AND event.event_type = 'conversation.user_committed'
        )
        AND NOT (
          NEW.actor = 'owner'
          AND EXISTS (
            SELECT 1 FROM memory_item_versions version
            WHERE version.principal_id = NEW.principal_id
              AND version.version_id = NEW.version_id
              AND version.basis = 'confirmed'
          )
          AND EXISTS (
            SELECT 1 FROM memory_item_sources source
            JOIN archive_segment_events archived
              ON archived.event_id = source.event_id
              AND archived.event_sequence = source.event_sequence
              AND archived.segment_id = source.r2_segment_id
            WHERE source.principal_id = NEW.principal_id
              AND source.version_id = NEW.version_id
              AND source.source_location = 'archived'
          )
        )
      )
    )
  )
  OR (
    NEW.actor = 'owner'
    AND NOT EXISTS (
      SELECT 1 FROM memory_valid_owner_commands command
      WHERE command.event_id = NEW.owner_authorizing_event_id
        AND command.subject_id = NEW.principal_id
        AND json_extract(command.envelope_json, '$.payload.targetId') = NEW.transition_id
        AND json_extract(command.envelope_json, '$.payload.operation') = CASE
          WHEN NEW.lifecycle_state = 'forgotten' THEN 'item.forget'
          WHEN EXISTS (
            SELECT 1 FROM memory_item_state state
            WHERE state.principal_id = NEW.principal_id
              AND state.item_id = NEW.item_id
              AND state.lifecycle_state IN ('forgotten', 'rejected')
          ) THEN 'item.correct'
          ELSE 'item.transition'
        END
        AND json_extract(command.envelope_json, '$.payload.itemId') = NEW.item_id
        AND json_extract(command.envelope_json, '$.payload.versionId') = NEW.version_id
        AND json_extract(command.envelope_json, '$.payload.lifecycleState') = NEW.lifecycle_state
        AND command.sequence > COALESCE((
          SELECT previous_command.sequence
          FROM memory_item_state state
          JOIN memory_item_transitions previous_transition
            ON previous_transition.principal_id = state.principal_id
            AND previous_transition.transition_id = state.last_transition_id
          JOIN memory_valid_owner_commands previous_command
            ON previous_command.event_id = previous_transition.owner_authorizing_event_id
          WHERE state.principal_id = NEW.principal_id
            AND state.item_id = NEW.item_id
        ), (
          SELECT item.creation_event_sequence FROM memory_items item
          WHERE item.principal_id = NEW.principal_id AND item.item_id = NEW.item_id
        ))
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_item_transition_invalid');
END;

CREATE TRIGGER memory_item_transitions_apply_state
AFTER INSERT ON memory_item_transitions
BEGIN
  INSERT INTO memory_item_state (
    principal_id, item_id, current_version_id, lifecycle_state,
    last_transition_id, last_transition_number, updated_at
  ) SELECT
    NEW.principal_id, NEW.item_id, NEW.version_id, NEW.lifecycle_state,
    NEW.transition_id, NEW.transition_number, NEW.occurred_at
  WHERE NOT EXISTS (
    SELECT 1 FROM memory_item_state state
    WHERE state.principal_id = NEW.principal_id AND state.item_id = NEW.item_id
  );

  UPDATE memory_item_state SET
    current_version_id = NEW.version_id,
    lifecycle_state = NEW.lifecycle_state,
    last_transition_id = NEW.transition_id,
    last_transition_number = NEW.transition_number,
    updated_at = NEW.occurred_at
  WHERE principal_id = NEW.principal_id
    AND item_id = NEW.item_id
    AND last_transition_number = NEW.transition_number - 1;
END;

CREATE TRIGGER memory_item_state_insert_guard
BEFORE INSERT ON memory_item_state
WHEN EXISTS (
    SELECT 1 FROM memory_item_state state
    WHERE state.principal_id = NEW.principal_id AND state.item_id = NEW.item_id
  )
  OR NOT EXISTS (
  SELECT 1 FROM memory_item_transitions transition_row
  WHERE transition_row.principal_id = NEW.principal_id
    AND transition_row.item_id = NEW.item_id
    AND transition_row.transition_id = NEW.last_transition_id
    AND transition_row.transition_number = NEW.last_transition_number
    AND transition_row.version_id = NEW.current_version_id
    AND transition_row.lifecycle_state = NEW.lifecycle_state
    AND transition_row.occurred_at = NEW.updated_at
)
BEGIN
  SELECT RAISE(ABORT, 'memory_item_state_requires_transition');
END;

CREATE TRIGGER memory_item_state_update_guard
BEFORE UPDATE ON memory_item_state
WHEN NEW.principal_id <> OLD.principal_id
  OR NEW.item_id <> OLD.item_id
  OR NEW.last_transition_number <> OLD.last_transition_number + 1
  OR NOT EXISTS (
    SELECT 1 FROM memory_item_transitions transition_row
    WHERE transition_row.principal_id = NEW.principal_id
      AND transition_row.item_id = NEW.item_id
      AND transition_row.transition_id = NEW.last_transition_id
      AND transition_row.transition_number = NEW.last_transition_number
      AND transition_row.version_id = NEW.current_version_id
      AND transition_row.lifecycle_state = NEW.lifecycle_state
      AND transition_row.occurred_at = NEW.updated_at
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_item_state_requires_transition');
END;

CREATE TRIGGER memory_item_state_delete_guard
BEFORE DELETE ON memory_item_state
BEGIN
  SELECT RAISE(ABORT, 'memory_item_state_delete_forbidden');
END;

CREATE TRIGGER memory_event_suppressions_insert_guard
BEFORE INSERT ON memory_event_suppressions
WHEN EXISTS (
    SELECT 1 FROM memory_event_suppressions suppression
    WHERE suppression.suppression_id = NEW.suppression_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM memory_valid_owner_commands command
    WHERE command.event_id = NEW.owner_authorizing_event_id
      AND command.subject_id = NEW.principal_id
      AND (
        (NEW.forgotten_transition_id IS NULL
          AND json_extract(command.envelope_json, '$.payload.operation') = 'history.suppress'
          AND json_extract(command.envelope_json, '$.payload.targetId') = NEW.suppression_id
          AND json_extract(command.envelope_json, '$.payload.targetEventId') IS NEW.target_event_id
          AND json_extract(command.envelope_json, '$.payload.startEventSequence') IS NEW.start_event_sequence
          AND json_extract(command.envelope_json, '$.payload.endEventSequence') IS NEW.end_event_sequence
          AND json_extract(command.envelope_json, '$.payload.newlyHiddenTurnCount') = NEW.newly_hidden_turn_count
          AND json_extract(command.envelope_json, '$.payload.totalCoveredTurnCount') = NEW.total_covered_turn_count)
        OR (NEW.forgotten_transition_id IS NOT NULL
          AND json_extract(command.envelope_json, '$.payload.operation') = 'item.forget'
          AND json_extract(command.envelope_json, '$.payload.targetId') = NEW.forgotten_transition_id
          AND EXISTS (
            SELECT 1 FROM json_each(command.envelope_json, '$.payload.suppressions') entry
            WHERE json_extract(entry.value, '$.suppressionId') = NEW.suppression_id
              AND json_extract(entry.value, '$.targetEventId') IS NEW.target_event_id
              AND json_extract(entry.value, '$.startEventSequence') IS NEW.start_event_sequence
              AND json_extract(entry.value, '$.endEventSequence') IS NEW.end_event_sequence
              AND json_extract(entry.value, '$.sourceId') = NEW.source_id
              AND json_extract(entry.value, '$.newlyHiddenTurnCount') = NEW.newly_hidden_turn_count
              AND json_extract(entry.value, '$.totalCoveredTurnCount') = NEW.total_covered_turn_count
          ))
      )
      AND (
        (NEW.target_event_id IS NOT NULL AND command.sequence > COALESCE(
          (SELECT event.sequence FROM events event WHERE event.event_id = NEW.target_event_id),
          (SELECT archived.event_sequence FROM archive_segment_events archived
            WHERE archived.event_id = NEW.target_event_id)
        ))
        OR (NEW.target_event_id IS NULL AND command.sequence > NEW.end_event_sequence)
      )
  )
  OR (
    NEW.target_event_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM events event
      WHERE event.event_id = NEW.target_event_id
        AND event.subject_id = NEW.principal_id
        AND event.event_type IN (
          'conversation.user_committed', 'conversation.assistant_delivered'
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM archive_segment_events archived WHERE archived.event_id = NEW.target_event_id
    )
  )
  OR (
    NEW.target_event_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM events event
      WHERE event.sequence BETWEEN NEW.start_event_sequence AND NEW.end_event_sequence
        AND event.subject_id = NEW.principal_id
      UNION ALL
      SELECT 1 FROM archive_segment_events archived
      WHERE archived.event_sequence BETWEEN NEW.start_event_sequence AND NEW.end_event_sequence
    )
  )
  OR (
    NEW.target_event_id IS NOT NULL
    AND (
      NEW.total_covered_turn_count <> 1
      OR NEW.newly_hidden_turn_count <> NOT EXISTS (
        SELECT 1 FROM memory_active_event_suppressions active
        WHERE active.principal_id = NEW.principal_id
          AND (
            active.target_event_id = NEW.target_event_id
            OR COALESCE(
              (SELECT event.sequence FROM events event WHERE event.event_id = NEW.target_event_id),
              (SELECT archived.event_sequence FROM archive_segment_events archived
                WHERE archived.event_id = NEW.target_event_id)
            ) BETWEEN active.start_event_sequence AND active.end_event_sequence
          )
      )
    )
  )
  OR (
    NEW.target_event_id IS NULL
    AND (
      NEW.total_covered_turn_count <> (
        SELECT count(*) FROM (
          SELECT event.sequence, event.event_id
          FROM events event
          WHERE event.subject_id = NEW.principal_id
            AND event.event_type IN (
              'conversation.user_committed', 'conversation.assistant_delivered'
            )
            AND event.sequence BETWEEN NEW.start_event_sequence AND NEW.end_event_sequence
          UNION
          SELECT archived.event_sequence, archived.event_id
          FROM archive_segment_events archived
          WHERE archived.event_sequence BETWEEN NEW.start_event_sequence AND NEW.end_event_sequence
        ) covered
      )
      OR NEW.newly_hidden_turn_count <> (
        SELECT count(*) FROM (
          SELECT event.sequence, event.event_id
          FROM events event
          WHERE event.subject_id = NEW.principal_id
            AND event.event_type IN (
              'conversation.user_committed', 'conversation.assistant_delivered'
            )
            AND event.sequence BETWEEN NEW.start_event_sequence AND NEW.end_event_sequence
          UNION
          SELECT archived.event_sequence, archived.event_id
          FROM archive_segment_events archived
          WHERE archived.event_sequence BETWEEN NEW.start_event_sequence AND NEW.end_event_sequence
        ) covered
        WHERE NOT EXISTS (
          SELECT 1 FROM memory_active_event_suppressions active
          WHERE active.principal_id = NEW.principal_id
            AND (
              active.target_event_id = covered.event_id
              OR covered.sequence BETWEEN active.start_event_sequence AND active.end_event_sequence
            )
        )
      )
    )
  )
  OR (
    NEW.forgotten_transition_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM memory_item_transitions transition_row
      JOIN memory_item_sources source
        ON source.principal_id = transition_row.principal_id
        AND source.item_id = transition_row.item_id
        AND source.source_id = NEW.source_id
      JOIN memory_item_state current_state
        ON current_state.principal_id = transition_row.principal_id
        AND current_state.item_id = transition_row.item_id
        AND current_state.last_transition_id = transition_row.transition_id
        AND current_state.last_transition_number = transition_row.transition_number
      WHERE transition_row.principal_id = NEW.principal_id
        AND transition_row.transition_id = NEW.forgotten_transition_id
        AND transition_row.lifecycle_state = 'forgotten'
        AND transition_row.owner_authorizing_event_id = NEW.owner_authorizing_event_id
        AND (
          NEW.target_event_id = source.event_id
          OR source.event_sequence BETWEEN NEW.start_event_sequence AND NEW.end_event_sequence
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_event_suppression_invalid');
END;

CREATE TRIGGER memory_event_suppression_lifts_insert_guard
BEFORE INSERT ON memory_event_suppression_lifts
WHEN EXISTS (
    SELECT 1 FROM memory_event_suppression_lifts lift
    WHERE lift.lift_id = NEW.lift_id OR lift.suppression_id = NEW.suppression_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM memory_event_suppressions suppression
    WHERE suppression.principal_id = NEW.principal_id
      AND suppression.suppression_id = NEW.suppression_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM memory_valid_owner_commands command
    JOIN memory_event_suppressions suppression
      ON suppression.principal_id = NEW.principal_id
      AND suppression.suppression_id = NEW.suppression_id
    JOIN memory_valid_owner_commands suppression_command
      ON suppression_command.event_id = suppression.owner_authorizing_event_id
    WHERE command.event_id = NEW.owner_authorizing_event_id
      AND command.subject_id = NEW.principal_id
      AND command.sequence > suppression_command.sequence
      AND (
        (NEW.correction_transition_id IS NULL
          AND json_extract(command.envelope_json, '$.payload.operation') = 'history.lift'
          AND json_extract(command.envelope_json, '$.payload.targetId') = NEW.lift_id
          AND json_extract(command.envelope_json, '$.payload.suppressionId') = NEW.suppression_id)
        OR (NEW.correction_transition_id IS NOT NULL
          AND json_extract(command.envelope_json, '$.payload.operation') = 'item.correct'
          AND json_extract(command.envelope_json, '$.payload.targetId') = NEW.correction_transition_id
          AND EXISTS (
            SELECT 1 FROM json_each(command.envelope_json, '$.payload.lifts') entry
            WHERE json_extract(entry.value, '$.liftId') = NEW.lift_id
              AND json_extract(entry.value, '$.suppressionId') = NEW.suppression_id
          ))
      )
  )
  OR NOT EXISTS (
    SELECT 1
    FROM memory_event_suppressions suppression
    LEFT JOIN memory_item_transitions forgotten_transition
      ON forgotten_transition.principal_id = suppression.principal_id
      AND forgotten_transition.transition_id = suppression.forgotten_transition_id
    LEFT JOIN memory_item_transitions correction_transition
      ON correction_transition.principal_id = suppression.principal_id
      AND correction_transition.transition_id = NEW.correction_transition_id
    LEFT JOIN memory_item_state current_state
      ON current_state.principal_id = correction_transition.principal_id
      AND current_state.item_id = correction_transition.item_id
    WHERE suppression.principal_id = NEW.principal_id
      AND suppression.suppression_id = NEW.suppression_id
      AND (
        (suppression.forgotten_transition_id IS NULL
          AND NEW.correction_transition_id IS NULL)
        OR (suppression.forgotten_transition_id IS NOT NULL
          AND NEW.correction_transition_id IS NOT NULL
          AND correction_transition.item_id = forgotten_transition.item_id
          AND correction_transition.actor = 'owner'
          AND correction_transition.owner_authorizing_event_id = NEW.owner_authorizing_event_id
          AND correction_transition.transition_number > forgotten_transition.transition_number
          AND correction_transition.transition_number = current_state.last_transition_number
          AND correction_transition.transition_id = current_state.last_transition_id
          AND correction_transition.lifecycle_state IN ('proposed', 'active'))
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_event_suppression_lift_invalid');
END;

CREATE TRIGGER memory_item_links_insert_guard
BEFORE INSERT ON memory_item_links
WHEN EXISTS (
    SELECT 1 FROM memory_item_links link
    WHERE link.link_id = NEW.link_id
      OR (link.principal_id = NEW.principal_id
        AND link.source_item_id = NEW.source_item_id
        AND link.target_item_id = NEW.target_item_id
        AND link.link_type = NEW.link_type)
  )
  OR NOT EXISTS (
  SELECT 1 FROM memory_item_transitions transition_row
  WHERE transition_row.principal_id = NEW.principal_id
    AND transition_row.item_id = NEW.source_item_id
    AND transition_row.transition_id = NEW.authorizing_transition_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory_item_link_transition_invalid');
END;

CREATE TRIGGER memory_topic_events_insert_guard
BEFORE INSERT ON memory_topic_events
WHEN EXISTS (
    SELECT 1 FROM memory_topic_events event
    WHERE event.topic_event_id = NEW.topic_event_id
  )
  OR NEW.occurred_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 minutes')
  OR (
    NEW.operation <> 'create'
    AND EXISTS (
      SELECT 1 FROM memory_topics topic
      JOIN memory_topic_events previous
        ON previous.principal_id = topic.principal_id
        AND previous.topic_event_id = topic.last_topic_event_id
      WHERE topic.principal_id = NEW.principal_id
        AND topic.topic_id = NEW.topic_id
        AND NEW.occurred_at < previous.occurred_at
    )
  )
  OR (
    NEW.actor = 'owner'
    AND NOT EXISTS (
      SELECT 1 FROM memory_valid_owner_commands command
      WHERE command.event_id = NEW.owner_authorizing_event_id
        AND command.subject_id = NEW.principal_id
        AND json_extract(command.envelope_json, '$.payload.operation') = 'topic.' || NEW.operation
        AND json_extract(command.envelope_json, '$.payload.targetId') = NEW.topic_event_id
        AND json_extract(command.envelope_json, '$.payload.topicId') = NEW.topic_id
        AND json_extract(command.envelope_json, '$.payload.newParentTopicId') IS NEW.new_parent_topic_id
        AND json_extract(command.envelope_json, '$.payload.newDisplayName') IS NEW.new_display_name
        AND json_extract(command.envelope_json, '$.payload.newNormalizedName') IS NEW.new_normalized_name
        AND json_extract(command.envelope_json, '$.payload.mergeTargetTopicId') IS NEW.merge_target_topic_id
    )
  )
  OR (
    NEW.operation = 'create'
    AND (
      EXISTS (
        SELECT 1 FROM memory_topics topic
        WHERE topic.principal_id = NEW.principal_id AND topic.topic_id = NEW.topic_id
      )
      OR (
        NEW.new_parent_topic_id IS NULL
        AND EXISTS (
          SELECT 1 FROM memory_topics root
          WHERE root.principal_id = NEW.principal_id AND root.parent_topic_id IS NULL
        )
      )
      OR (
        NEW.new_parent_topic_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM memory_topics parent
          WHERE parent.principal_id = NEW.principal_id
            AND parent.topic_id = NEW.new_parent_topic_id
            AND parent.status = 'active'
        )
      )
      OR (
        NEW.new_parent_topic_id IS NOT NULL
        AND EXISTS (
          WITH RECURSIVE ancestors(topic_id, parent_topic_id, depth) AS (
            SELECT parent.topic_id, parent.parent_topic_id, 1
            FROM memory_topics parent
            WHERE parent.principal_id = NEW.principal_id
              AND parent.topic_id = NEW.new_parent_topic_id
              AND parent.status = 'active'
            UNION
            SELECT parent.topic_id, parent.parent_topic_id, child.depth + 1
            FROM memory_topics parent
            JOIN ancestors child ON child.parent_topic_id = parent.topic_id
            WHERE parent.principal_id = NEW.principal_id
              AND parent.status = 'active'
              AND child.depth < 64
          )
          SELECT 1 FROM ancestors WHERE depth = 64
        )
      )
      OR json_array_length(NEW.reparented_child_ids_json) <> 0
      OR json_array_length(NEW.moved_placement_ids_json) <> 0
      OR json_array_length(NEW.added_aliases_json) <> 0
    )
  )
  OR (
    NEW.operation <> 'create'
    AND NOT EXISTS (
      SELECT 1 FROM memory_topics topic
      WHERE topic.principal_id = NEW.principal_id
        AND topic.topic_id = NEW.topic_id
        AND topic.status = 'active'
    )
  )
  OR (
    NEW.operation = 'rename'
    AND (
      NOT EXISTS (
        SELECT 1 FROM memory_topics topic
        WHERE topic.principal_id = NEW.principal_id
          AND topic.topic_id = NEW.topic_id
          AND topic.display_name = NEW.previous_display_name
          AND topic.normalized_name = NEW.previous_normalized_name
      )
      OR NEW.previous_display_name = NEW.new_display_name
      OR NEW.previous_normalized_name = NEW.new_normalized_name
      OR json_array_length(NEW.reparented_child_ids_json) <> 0
      OR json_array_length(NEW.moved_placement_ids_json) <> 0
      OR json_array_length(NEW.added_aliases_json) = 0
    )
  )
  OR (
    NEW.operation = 'move'
    AND (
      NOT EXISTS (
        SELECT 1 FROM memory_topics topic
        WHERE topic.principal_id = NEW.principal_id
          AND topic.topic_id = NEW.topic_id
          AND topic.parent_topic_id = NEW.previous_parent_topic_id
          AND topic.parent_topic_id IS NOT NULL
      )
      OR NOT EXISTS (
        SELECT 1 FROM memory_topics parent
        WHERE parent.principal_id = NEW.principal_id
          AND parent.topic_id = NEW.new_parent_topic_id
          AND parent.status = 'active'
      )
      OR NEW.topic_id = NEW.new_parent_topic_id
      OR EXISTS (
        WITH RECURSIVE
        ancestors(topic_id, parent_topic_id, depth) AS (
          SELECT parent.topic_id, parent.parent_topic_id, 1
          FROM memory_topics parent
          WHERE parent.principal_id = NEW.principal_id
            AND parent.topic_id = NEW.new_parent_topic_id
            AND parent.status = 'active'
          UNION
          SELECT parent.topic_id, parent.parent_topic_id, child.depth + 1
          FROM memory_topics parent
          JOIN ancestors child ON child.parent_topic_id = parent.topic_id
          WHERE parent.principal_id = NEW.principal_id
            AND parent.status = 'active'
            AND child.depth < 64
        ),
        subtree(topic_id, depth) AS (
          SELECT NEW.topic_id, 1
          UNION
          SELECT child.topic_id, parent.depth + 1
          FROM memory_topics child
          JOIN subtree parent ON child.parent_topic_id = parent.topic_id
          WHERE child.principal_id = NEW.principal_id
            AND child.status = 'active'
            AND parent.depth < 64
        )
        SELECT 1
        WHERE EXISTS (SELECT 1 FROM ancestors WHERE topic_id = NEW.topic_id)
          OR EXISTS (
            SELECT 1 FROM ancestors WHERE depth = 64 AND parent_topic_id IS NOT NULL
          )
          OR COALESCE((SELECT max(depth) FROM ancestors), 0)
            + COALESCE((SELECT max(depth) FROM subtree), 1) > 64
      )
      OR json_array_length(NEW.reparented_child_ids_json) <> 0
      OR json_array_length(NEW.moved_placement_ids_json) <> 0
    )
  )
  OR (
    NEW.operation = 'merge'
    AND (
      NEW.topic_id = NEW.merge_target_topic_id
      OR EXISTS (
        SELECT 1 FROM memory_topics source
        WHERE source.principal_id = NEW.principal_id
          AND source.topic_id = NEW.topic_id
          AND source.parent_topic_id IS NULL
      )
      OR NOT EXISTS (
        SELECT 1 FROM memory_topics target
        WHERE target.principal_id = NEW.principal_id
          AND target.topic_id = NEW.merge_target_topic_id
          AND target.status = 'active'
      )
      OR NOT EXISTS (
        SELECT 1 FROM memory_topics source
        WHERE source.principal_id = NEW.principal_id
          AND source.topic_id = NEW.topic_id
          AND source.display_name = NEW.previous_display_name
          AND source.normalized_name = NEW.previous_normalized_name
      )
      OR EXISTS (
        WITH RECURSIVE
        ancestors(topic_id, parent_topic_id, depth) AS (
          SELECT target.topic_id, target.parent_topic_id, 1
          FROM memory_topics target
          WHERE target.principal_id = NEW.principal_id
            AND target.topic_id = NEW.merge_target_topic_id
            AND target.status = 'active'
          UNION
          SELECT parent.topic_id, parent.parent_topic_id, child.depth + 1
          FROM memory_topics parent
          JOIN ancestors child ON child.parent_topic_id = parent.topic_id
          WHERE parent.principal_id = NEW.principal_id
            AND parent.status = 'active'
            AND child.depth < 64
        ),
        descendants(topic_id, depth) AS (
          SELECT child.topic_id, 1
          FROM memory_topics child
          WHERE child.principal_id = NEW.principal_id
            AND child.parent_topic_id = NEW.topic_id
            AND child.status = 'active'
          UNION
          SELECT child.topic_id, parent.depth + 1
          FROM memory_topics child
          JOIN descendants parent ON child.parent_topic_id = parent.topic_id
          WHERE child.principal_id = NEW.principal_id
            AND child.status = 'active'
            AND parent.depth < 64
        )
        SELECT 1
        WHERE EXISTS (SELECT 1 FROM ancestors WHERE topic_id = NEW.topic_id)
          OR EXISTS (
            SELECT 1 FROM ancestors WHERE depth = 64 AND parent_topic_id IS NOT NULL
          )
          OR COALESCE((SELECT max(depth) FROM ancestors), 0)
            + COALESCE((SELECT max(depth) FROM descendants), 0) > 64
      )
      OR json_array_length(NEW.reparented_child_ids_json) <> (
        SELECT count(*) FROM memory_topics child
        WHERE child.principal_id = NEW.principal_id
          AND child.parent_topic_id = NEW.topic_id
          AND child.status = 'active'
      )
      OR EXISTS (
        SELECT 1 FROM memory_topics child
        WHERE child.principal_id = NEW.principal_id
          AND child.parent_topic_id = NEW.topic_id
          AND child.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM json_each(NEW.reparented_child_ids_json) entry
            WHERE entry.value = child.topic_id
          )
      )
      OR json_array_length(NEW.moved_placement_ids_json) <> (
        SELECT count(*) FROM memory_item_placement_state placement
        WHERE placement.principal_id = NEW.principal_id
          AND placement.topic_id = NEW.topic_id
          AND placement.status = 'active'
      )
      OR EXISTS (
        SELECT 1 FROM memory_item_placement_state placement
        WHERE placement.principal_id = NEW.principal_id
          AND placement.topic_id = NEW.topic_id
          AND placement.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM json_each(NEW.moved_placement_ids_json) entry
            WHERE entry.value = placement.placement_id
          )
      )
      OR json_array_length(NEW.added_aliases_json) = 0
    )
  )
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.added_aliases_json) entry
    WHERE json_type(entry.value) <> 'object'
      OR json_type(entry.value, '$.aliasId') <> 'text'
      OR json_type(entry.value, '$.topicId') <> 'text'
      OR json_type(entry.value, '$.displayName') <> 'text'
      OR json_type(entry.value, '$.normalizedName') <> 'text'
      OR json_type(entry.value, '$.pathAlias') <> 'text'
      OR json_extract(entry.value, '$.topicId') IS NOT
        COALESCE(NEW.merge_target_topic_id, NEW.topic_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_event_invalid');
END;

CREATE TRIGGER memory_topic_events_apply
AFTER INSERT ON memory_topic_events
BEGIN
  INSERT INTO memory_topics (
    topic_id, principal_id, parent_topic_id, display_name, normalized_name,
    status, redirect_to_topic_id, last_topic_event_id, created_at, updated_at
  ) SELECT NEW.topic_id, NEW.principal_id, NEW.new_parent_topic_id,
      NEW.new_display_name, NEW.new_normalized_name, 'active', NULL,
      NEW.topic_event_id, NEW.occurred_at, NEW.occurred_at
    WHERE NEW.operation = 'create';

  INSERT INTO memory_topic_aliases (
    alias_id, principal_id, topic_id, display_alias, normalized_alias,
    path_alias, created_by_topic_event_id, created_at
  ) SELECT
      json_extract(entry.value, '$.aliasId'), NEW.principal_id,
      json_extract(entry.value, '$.topicId'), json_extract(entry.value, '$.displayName'),
      json_extract(entry.value, '$.normalizedName'), json_extract(entry.value, '$.pathAlias'),
      NEW.topic_event_id, NEW.occurred_at
    FROM json_each(NEW.added_aliases_json) entry;

  UPDATE memory_topics SET
    display_name = NEW.new_display_name,
    normalized_name = NEW.new_normalized_name,
    last_topic_event_id = NEW.topic_event_id,
    updated_at = NEW.occurred_at
  WHERE NEW.operation = 'rename'
    AND principal_id = NEW.principal_id AND topic_id = NEW.topic_id;

  UPDATE memory_topics SET
    parent_topic_id = NEW.new_parent_topic_id,
    last_topic_event_id = NEW.topic_event_id,
    updated_at = NEW.occurred_at
  WHERE NEW.operation = 'move'
    AND principal_id = NEW.principal_id AND topic_id = NEW.topic_id;

  UPDATE memory_topics SET
    parent_topic_id = NEW.merge_target_topic_id,
    last_topic_event_id = NEW.topic_event_id,
    updated_at = NEW.occurred_at
  WHERE NEW.operation = 'merge'
    AND principal_id = NEW.principal_id
    AND EXISTS (
      SELECT 1 FROM json_each(NEW.reparented_child_ids_json) entry
      WHERE entry.value = memory_topics.topic_id
    );

  UPDATE memory_item_placement_state SET
    topic_id = NEW.merge_target_topic_id,
    last_event_kind = 'topic',
    last_event_id = NEW.topic_event_id,
    updated_at = NEW.occurred_at
  WHERE NEW.operation = 'merge'
    AND principal_id = NEW.principal_id
    AND EXISTS (
      SELECT 1 FROM json_each(NEW.moved_placement_ids_json) entry
      WHERE entry.value = memory_item_placement_state.placement_id
    );

  UPDATE memory_topics SET
    status = 'merged',
    redirect_to_topic_id = NEW.merge_target_topic_id,
    last_topic_event_id = NEW.topic_event_id,
    updated_at = NEW.occurred_at
  WHERE NEW.operation = 'merge'
    AND principal_id = NEW.principal_id AND topic_id = NEW.topic_id;
END;

CREATE TRIGGER memory_topics_insert_guard
BEFORE INSERT ON memory_topics
WHEN EXISTS (
    SELECT 1 FROM memory_topics topic
    WHERE topic.topic_id = NEW.topic_id
      OR (NEW.parent_topic_id IS NULL
        AND topic.principal_id = NEW.principal_id
        AND topic.parent_topic_id IS NULL)
      OR (topic.principal_id = NEW.principal_id
        AND topic.parent_topic_id IS NEW.parent_topic_id
        AND topic.normalized_name = NEW.normalized_name
        AND topic.status = 'active')
  )
  OR NOT EXISTS (
  SELECT 1 FROM memory_topic_events event
  WHERE event.principal_id = NEW.principal_id
    AND event.topic_event_id = NEW.last_topic_event_id
    AND event.topic_id = NEW.topic_id
    AND event.operation = 'create'
    AND event.new_parent_topic_id IS NEW.parent_topic_id
    AND event.new_display_name = NEW.display_name
    AND event.new_normalized_name = NEW.normalized_name
    AND event.occurred_at = NEW.created_at
    AND event.occurred_at = NEW.updated_at
)
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_requires_event');
END;

CREATE TRIGGER memory_topics_update_guard
BEFORE UPDATE ON memory_topics
WHEN NEW.principal_id <> OLD.principal_id
  OR NEW.topic_id <> OLD.topic_id
  OR NEW.created_at <> OLD.created_at
  OR NEW.last_topic_event_id = OLD.last_topic_event_id
  OR NOT EXISTS (
    SELECT 1 FROM memory_topic_events event
    WHERE event.principal_id = NEW.principal_id
      AND event.topic_event_id = NEW.last_topic_event_id
      AND event.occurred_at = NEW.updated_at
      AND EXISTS (
        SELECT 1 FROM memory_topic_events previous
        WHERE previous.principal_id = OLD.principal_id
          AND previous.topic_event_id = OLD.last_topic_event_id
          AND (
            event.occurred_at > previous.occurred_at
            OR (event.occurred_at = previous.occurred_at
              AND event.topic_event_id > previous.topic_event_id)
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM memory_topic_events later
        WHERE later.principal_id = event.principal_id
          AND later.topic_id = event.topic_id
          AND (
            later.occurred_at > event.occurred_at
            OR (later.occurred_at = event.occurred_at
              AND later.topic_event_id > event.topic_event_id)
          )
      )
      AND (
        (event.operation = 'rename'
          AND event.topic_id = NEW.topic_id
          AND event.new_display_name = NEW.display_name
          AND event.new_normalized_name = NEW.normalized_name
          AND NEW.parent_topic_id IS OLD.parent_topic_id
          AND NEW.status = OLD.status
          AND NEW.redirect_to_topic_id IS OLD.redirect_to_topic_id)
        OR (event.operation = 'move'
          AND event.topic_id = NEW.topic_id
          AND event.previous_parent_topic_id IS OLD.parent_topic_id
          AND event.new_parent_topic_id IS NEW.parent_topic_id
          AND NEW.display_name = OLD.display_name
          AND NEW.normalized_name = OLD.normalized_name
          AND NEW.status = OLD.status
          AND NEW.redirect_to_topic_id IS OLD.redirect_to_topic_id)
        OR (event.operation = 'merge'
          AND (
            (event.topic_id = NEW.topic_id
              AND NEW.status = 'merged'
              AND NEW.redirect_to_topic_id = event.merge_target_topic_id
              AND NEW.parent_topic_id IS OLD.parent_topic_id)
            OR (NEW.status = OLD.status
              AND NEW.redirect_to_topic_id IS OLD.redirect_to_topic_id
              AND NEW.parent_topic_id = event.merge_target_topic_id
              AND EXISTS (
                SELECT 1 FROM json_each(event.reparented_child_ids_json) entry
                WHERE entry.value = NEW.topic_id
              ))
          )
          AND NEW.display_name = OLD.display_name
          AND NEW.normalized_name = OLD.normalized_name)
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_update_requires_event');
END;

CREATE TRIGGER memory_topics_delete_guard
BEFORE DELETE ON memory_topics
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_delete_forbidden');
END;

CREATE TRIGGER memory_topic_aliases_insert_guard
BEFORE INSERT ON memory_topic_aliases
WHEN EXISTS (
    SELECT 1 FROM memory_topic_aliases alias
    WHERE alias.alias_id = NEW.alias_id
      OR (alias.principal_id = NEW.principal_id
        AND alias.normalized_alias = NEW.normalized_alias
        AND alias.path_alias = NEW.path_alias)
  )
  OR NOT EXISTS (
  SELECT 1 FROM memory_topic_events event
  JOIN json_each(event.added_aliases_json) entry
  WHERE event.principal_id = NEW.principal_id
    AND event.topic_event_id = NEW.created_by_topic_event_id
    AND json_extract(entry.value, '$.aliasId') = NEW.alias_id
    AND json_extract(entry.value, '$.topicId') = NEW.topic_id
    AND json_extract(entry.value, '$.displayName') = NEW.display_alias
    AND json_extract(entry.value, '$.normalizedName') = NEW.normalized_alias
    AND json_extract(entry.value, '$.pathAlias') = NEW.path_alias
    AND event.occurred_at = NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_alias_requires_event');
END;

CREATE TRIGGER memory_item_placement_events_insert_guard
BEFORE INSERT ON memory_item_placement_events
WHEN EXISTS (
    SELECT 1 FROM memory_item_placement_events event
    WHERE event.placement_event_id = NEW.placement_event_id
      OR (event.principal_id = NEW.principal_id
        AND event.placement_id = NEW.placement_id
        AND event.placement_event_number = NEW.placement_event_number)
  )
  OR NOT EXISTS (
    SELECT 1 FROM memory_items item
    WHERE item.principal_id = NEW.principal_id AND item.item_id = NEW.item_id
  )
  OR (
    NEW.new_topic_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM memory_topics topic
      WHERE topic.principal_id = NEW.principal_id
        AND topic.topic_id = NEW.new_topic_id
        AND topic.status = 'active'
    )
  )
  OR NEW.placement_event_number <> COALESCE((
    SELECT state.last_placement_event_number + 1
    FROM memory_item_placement_state state
    WHERE state.principal_id = NEW.principal_id AND state.placement_id = NEW.placement_id
  ), 1)
  OR (
    NEW.operation = 'place'
    AND EXISTS (
      SELECT 1 FROM memory_item_placement_state state
      WHERE state.principal_id = NEW.principal_id AND state.placement_id = NEW.placement_id
    )
  )
  OR (
    NEW.operation IN ('refile', 'remove')
    AND NOT EXISTS (
      SELECT 1 FROM memory_item_placement_state state
      WHERE state.principal_id = NEW.principal_id
        AND state.placement_id = NEW.placement_id
        AND state.item_id = NEW.item_id
        AND state.topic_id = NEW.previous_topic_id
        AND state.relation = NEW.relation
        AND state.status = 'active'
    )
  )
  OR (
    NEW.filing_source = 'owner'
    AND NOT EXISTS (
      SELECT 1 FROM memory_valid_owner_commands command
      WHERE command.event_id = NEW.owner_authorizing_event_id
        AND command.subject_id = NEW.principal_id
        AND json_extract(command.envelope_json, '$.payload.operation') = 'placement.' || NEW.operation
        AND json_extract(command.envelope_json, '$.payload.targetId') = NEW.placement_event_id
        AND json_extract(command.envelope_json, '$.payload.placementId') = NEW.placement_id
        AND json_extract(command.envelope_json, '$.payload.itemId') = NEW.item_id
        AND json_extract(command.envelope_json, '$.payload.previousTopicId') IS NEW.previous_topic_id
        AND json_extract(command.envelope_json, '$.payload.newTopicId') IS NEW.new_topic_id
        AND json_extract(command.envelope_json, '$.payload.relation') = NEW.relation
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_item_placement_event_invalid');
END;

CREATE TRIGGER memory_item_placement_events_apply_state
AFTER INSERT ON memory_item_placement_events
BEGIN
  INSERT INTO memory_item_placement_state (
    principal_id, placement_id, item_id, topic_id, relation, status,
    last_event_kind, last_event_id, last_placement_event_number, updated_at
  ) SELECT NEW.principal_id, NEW.placement_id, NEW.item_id, NEW.new_topic_id,
      NEW.relation, 'active', 'placement', NEW.placement_event_id,
      NEW.placement_event_number, NEW.occurred_at
    WHERE NEW.operation = 'place';

  UPDATE memory_item_placement_state SET
    topic_id = NEW.new_topic_id,
    last_event_kind = 'placement',
    last_event_id = NEW.placement_event_id,
    last_placement_event_number = NEW.placement_event_number,
    updated_at = NEW.occurred_at
  WHERE NEW.operation = 'refile'
    AND principal_id = NEW.principal_id AND placement_id = NEW.placement_id;

  UPDATE memory_item_placement_state SET
    status = 'removed',
    last_event_kind = 'placement',
    last_event_id = NEW.placement_event_id,
    last_placement_event_number = NEW.placement_event_number,
    updated_at = NEW.occurred_at
  WHERE NEW.operation = 'remove'
    AND principal_id = NEW.principal_id AND placement_id = NEW.placement_id;
END;

CREATE TRIGGER memory_item_placement_state_insert_guard
BEFORE INSERT ON memory_item_placement_state
WHEN EXISTS (
    SELECT 1 FROM memory_item_placement_state state
    WHERE state.principal_id = NEW.principal_id
      AND (state.placement_id = NEW.placement_id
        OR (state.item_id = NEW.item_id AND state.relation = 'primary'
          AND state.status = 'active' AND NEW.relation = 'primary' AND NEW.status = 'active'))
  )
  OR NOT EXISTS (
  SELECT 1 FROM memory_item_placement_events event
  WHERE event.principal_id = NEW.principal_id
    AND event.placement_id = NEW.placement_id
    AND event.placement_event_id = NEW.last_event_id
    AND event.placement_event_number = NEW.last_placement_event_number
    AND event.item_id = NEW.item_id
    AND event.operation = 'place'
    AND event.new_topic_id = NEW.topic_id
    AND event.relation = NEW.relation
    AND NEW.status = 'active'
    AND NEW.last_event_kind = 'placement'
    AND event.occurred_at = NEW.updated_at
)
BEGIN
  SELECT RAISE(ABORT, 'memory_item_placement_state_requires_event');
END;

CREATE TRIGGER memory_item_placement_state_update_guard
BEFORE UPDATE ON memory_item_placement_state
WHEN NEW.principal_id <> OLD.principal_id
  OR NEW.placement_id <> OLD.placement_id
  OR NEW.item_id <> OLD.item_id
  OR NEW.relation <> OLD.relation
  OR NOT EXISTS (
    SELECT 1 FROM memory_item_placement_events event
    WHERE NEW.last_event_kind = 'placement'
      AND event.principal_id = NEW.principal_id
      AND event.placement_id = NEW.placement_id
      AND event.placement_event_id = NEW.last_event_id
      AND event.placement_event_number = NEW.last_placement_event_number
      AND event.item_id = NEW.item_id
      AND event.relation = NEW.relation
      AND event.occurred_at = NEW.updated_at
      AND (
        (event.operation = 'refile'
          AND NEW.last_placement_event_number = OLD.last_placement_event_number + 1
          AND event.previous_topic_id = OLD.topic_id
          AND event.new_topic_id = NEW.topic_id
          AND EXISTS (
            SELECT 1 FROM memory_topics topic
            WHERE topic.principal_id = NEW.principal_id
              AND topic.topic_id = NEW.topic_id
              AND topic.status = 'active'
          )
          AND OLD.status = 'active' AND NEW.status = 'active')
        OR (event.operation = 'remove'
          AND NEW.last_placement_event_number = OLD.last_placement_event_number + 1
          AND event.previous_topic_id = OLD.topic_id
          AND NEW.topic_id = OLD.topic_id
          AND OLD.status = 'active' AND NEW.status = 'removed')
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM memory_topic_events event
    WHERE NEW.last_event_kind = 'topic'
      AND event.principal_id = NEW.principal_id
      AND event.topic_event_id = NEW.last_event_id
      AND NEW.last_event_id <> OLD.last_event_id
      AND event.operation = 'merge'
      AND OLD.topic_id = event.topic_id
      AND NEW.topic_id = event.merge_target_topic_id
      AND NEW.item_id = OLD.item_id
      AND NEW.relation = OLD.relation
      AND NEW.status = OLD.status
      AND NEW.last_placement_event_number = OLD.last_placement_event_number
      AND NEW.updated_at = event.occurred_at
      AND EXISTS (
        SELECT 1 FROM json_each(event.moved_placement_ids_json) entry
        WHERE entry.value = NEW.placement_id
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_item_placement_state_requires_event');
END;

CREATE TRIGGER memory_item_placement_state_delete_guard
BEFORE DELETE ON memory_item_placement_state
BEGIN
  SELECT RAISE(ABORT, 'memory_item_placement_state_delete_forbidden');
END;

CREATE TRIGGER memory_episodes_insert_guard
BEFORE INSERT ON memory_episodes
WHEN (NEW.episode_rowid IS NOT NULL AND EXISTS (
    SELECT 1 FROM memory_episodes episode
    WHERE episode.episode_rowid = NEW.episode_rowid
  ))
  OR EXISTS (
  SELECT 1 FROM memory_episodes episode
  WHERE episode.episode_id = NEW.episode_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory_episode_duplicate');
END;

CREATE TRIGGER memory_episode_sources_insert_guard
BEFORE INSERT ON memory_episode_sources
WHEN EXISTS (
    SELECT 1 FROM memory_episode_sources source
    WHERE source.source_id = NEW.source_id
      OR (source.principal_id = NEW.principal_id
        AND source.episode_id = NEW.episode_id
        AND (source.source_position = NEW.source_position OR source.event_id = NEW.event_id))
  )
  OR NOT EXISTS (
    SELECT 1 FROM memory_episodes episode
    WHERE episode.principal_id = NEW.principal_id
      AND episode.episode_id = NEW.episode_id
      AND NEW.event_sequence BETWEEN episode.start_event_sequence AND episode.end_event_sequence
  )
  OR (
    NEW.source_location = 'live'
    AND NOT EXISTS (
      SELECT 1 FROM events event
      WHERE event.event_id = NEW.event_id
        AND event.sequence = NEW.event_sequence
        AND event.subject_id = NEW.principal_id
    )
  )
  OR (
    NEW.source_location = 'archived'
    AND NOT EXISTS (
      SELECT 1 FROM archive_segment_events archived
      WHERE archived.event_id = NEW.event_id
        AND archived.event_sequence = NEW.event_sequence
        AND archived.segment_id = NEW.r2_segment_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_episode_source_receipt_invalid');
END;

CREATE TRIGGER memory_history_chunks_insert_guard
BEFORE INSERT ON memory_history_chunks
WHEN (NEW.chunk_rowid IS NOT NULL AND EXISTS (
    SELECT 1 FROM memory_history_chunks chunk
    WHERE chunk.chunk_rowid = NEW.chunk_rowid
  ))
  OR EXISTS (
    SELECT 1 FROM memory_history_chunks chunk
    WHERE chunk.chunk_id = NEW.chunk_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM memory_history_coverage coverage
    WHERE coverage.principal_id = NEW.principal_id
      AND coverage.start_event_sequence = NEW.start_event_sequence
      AND coverage.end_event_sequence = NEW.end_event_sequence
      AND coverage.indexing_outcome = 'indexed'
      AND coverage.content_hash = NEW.source_receipt_hash
      AND (
        NEW.source_location = 'mixed'
        OR (coverage.source_location = NEW.source_location
          AND coverage.r2_segment_id IS NEW.r2_segment_id)
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_history_chunk_receipt_invalid');
END;

CREATE TRIGGER memory_history_chunks_immutable_update
BEFORE UPDATE ON memory_history_chunks
BEGIN
  SELECT RAISE(ABORT, 'memory_history_chunk_immutable');
END;

CREATE TRIGGER memory_history_coverage_insert_guard
BEFORE INSERT ON memory_history_coverage
WHEN EXISTS (
    SELECT 1 FROM memory_history_coverage coverage
    WHERE coverage.coverage_id = NEW.coverage_id
  )
  OR (
    NEW.source_location = 'live'
    AND (
      NOT EXISTS (
        SELECT 1 FROM events event
        WHERE event.subject_id = NEW.principal_id
          AND event.sequence BETWEEN NEW.start_event_sequence AND NEW.end_event_sequence
      )
      OR NEW.end_event_sequence > COALESCE((SELECT max(event.sequence) FROM events event), 0)
      OR EXISTS (
        SELECT 1 FROM archive_segment_events archived
        WHERE archived.event_sequence BETWEEN NEW.start_event_sequence AND NEW.end_event_sequence
      )
    )
  )
  OR (
    NEW.source_location = 'archived'
    AND NOT EXISTS (
      SELECT 1 FROM archive_segments segment
      JOIN archive_manifests manifest ON manifest.manifest_id = segment.manifest_id
      WHERE segment.segment_id = NEW.r2_segment_id
        AND manifest.start_sequence <= NEW.start_event_sequence
        AND manifest.end_sequence >= NEW.end_event_sequence
        AND manifest.status = 'sealed'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_history_coverage_receipt_invalid');
END;

CREATE TRIGGER memory_vectors_insert_guard
BEFORE INSERT ON memory_vectors
WHEN EXISTS (
  SELECT 1 FROM memory_vectors vector
  WHERE vector.vector_ledger_id = NEW.vector_ledger_id
    OR vector.mutation_id = NEW.mutation_id
    OR (vector.principal_id = NEW.principal_id
      AND vector.item_kind = NEW.item_kind
      AND vector.item_id = NEW.item_id
      AND vector.embedding_model = NEW.embedding_model
      AND vector.content_hash = NEW.content_hash)
)
BEGIN
  SELECT RAISE(ABORT, 'memory_vector_duplicate');
END;

CREATE TRIGGER memory_vectors_update_guard
BEFORE UPDATE ON memory_vectors
WHEN OLD.deleted_at IS NOT NULL
  OR NEW.deleted_at IS NULL
  OR NEW.deleted_at < OLD.upserted_at
  OR NEW.vector_ledger_id <> OLD.vector_ledger_id
  OR NEW.principal_id <> OLD.principal_id
  OR NEW.item_kind <> OLD.item_kind
  OR NEW.item_id <> OLD.item_id
  OR NEW.embedding_model <> OLD.embedding_model
  OR NEW.dimensions <> OLD.dimensions
  OR NEW.content_hash <> OLD.content_hash
  OR NEW.mutation_id <> OLD.mutation_id
  OR NEW.upserted_at <> OLD.upserted_at
BEGIN
  SELECT RAISE(ABORT, 'memory_vector_delete_transition_invalid');
END;

CREATE TRIGGER memory_vectors_delete_guard
BEFORE DELETE ON memory_vectors
BEGIN
  SELECT RAISE(ABORT, 'memory_vector_delete_forbidden');
END;

CREATE TRIGGER memory_model_prices_insert_guard
BEFORE INSERT ON memory_model_prices
WHEN EXISTS (
  SELECT 1 FROM memory_model_prices price
  WHERE price.price_id = NEW.price_id
    OR (price.principal_id = NEW.principal_id
      AND price.model_id = NEW.model_id
      AND price.effective_at = NEW.effective_at)
)
BEGIN
  SELECT RAISE(ABORT, 'memory_model_price_duplicate');
END;

CREATE TRIGGER memory_runs_insert_guard
BEFORE INSERT ON memory_runs
WHEN EXISTS (
    SELECT 1 FROM memory_runs run
    WHERE run.run_id = NEW.run_id
      OR (run.principal_id = NEW.principal_id AND run.run_key = NEW.run_key)
  )
  OR NEW.outcome <> 'running'
  OR NEW.input_event_count <> 0
  OR NEW.created_item_count <> 0
  OR NEW.input_tokens <> 0
  OR NEW.output_tokens <> 0
  OR NEW.cache_read_tokens <> 0
  OR NEW.reserved_cost_micros <> 0
  OR NEW.settled_cost_micros <> 0
  OR NEW.started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')
  OR NEW.started_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 minutes')
  OR (
    NEW.job = 'reprocessing'
    AND NOT EXISTS (
      SELECT 1 FROM memory_reprocess_jobs job
      WHERE job.principal_id = NEW.principal_id
        AND job.job_id = NEW.reprocess_job_id
        AND job.status IN ('pending', 'running')
        AND job.provider_model_id = NEW.provider_model_id
        AND (
          (job.start_event_sequence IS NOT NULL
            AND NEW.start_event_sequence = job.start_event_sequence
            AND NEW.end_event_sequence = job.end_event_sequence)
          OR (job.start_day IS NOT NULL
            AND NEW.start_event_sequence IS NOT NULL
            AND NEW.end_event_sequence IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM events first_event
              WHERE first_event.sequence = NEW.start_event_sequence
                AND first_event.subject_id = NEW.principal_id
                AND substr(first_event.occurred_at, 1, 10)
                  BETWEEN job.start_day AND job.end_day
            )
            AND EXISTS (
              SELECT 1 FROM events last_event
              WHERE last_event.sequence = NEW.end_event_sequence
                AND last_event.subject_id = NEW.principal_id
                AND substr(last_event.occurred_at, 1, 10)
                  BETWEEN job.start_day AND job.end_day
            )
            AND NOT EXISTS (
              SELECT 1 FROM events ranged_event
              WHERE ranged_event.subject_id = NEW.principal_id
                AND ranged_event.sequence
                  BETWEEN NEW.start_event_sequence AND NEW.end_event_sequence
                AND substr(ranged_event.occurred_at, 1, 10)
                  NOT BETWEEN job.start_day AND job.end_day
            ))
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_run_initial_state_invalid');
END;

CREATE TRIGGER memory_runs_update_guard
BEFORE UPDATE ON memory_runs
WHEN OLD.outcome <> 'running'
  OR NEW.outcome = 'running'
  OR NEW.run_id <> OLD.run_id
  OR NEW.principal_id <> OLD.principal_id
  OR NEW.run_key <> OLD.run_key
  OR NEW.job <> OLD.job
  OR NEW.reprocess_job_id IS NOT OLD.reprocess_job_id
  OR NEW.start_event_sequence IS NOT OLD.start_event_sequence
  OR NEW.end_event_sequence IS NOT OLD.end_event_sequence
  OR NEW.provider_model_id IS NOT OLD.provider_model_id
  OR NEW.price_id IS NOT OLD.price_id
  OR NEW.started_at <> OLD.started_at
  OR (
    NEW.job = 'reprocessing'
    AND NOT EXISTS (
      SELECT 1 FROM memory_reprocess_jobs job
      WHERE job.principal_id = NEW.principal_id
        AND job.job_id = NEW.reprocess_job_id
        AND NEW.input_event_count <= job.maximum_event_count
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_run_transition_invalid');
END;

CREATE TRIGGER memory_runs_delete_guard
BEFORE DELETE ON memory_runs
BEGIN
  SELECT RAISE(ABORT, 'memory_run_delete_forbidden');
END;

CREATE TRIGGER memory_reprocess_jobs_insert_guard
BEFORE INSERT ON memory_reprocess_jobs
WHEN EXISTS (
    SELECT 1 FROM memory_reprocess_jobs job
    WHERE job.job_id = NEW.job_id
  )
  OR NEW.status <> 'pending'
  OR NEW.checkpoint_event_sequence IS NOT NULL
  OR (
    NEW.start_event_sequence IS NOT NULL
    AND NEW.end_event_sequence - NEW.start_event_sequence + 1 > NEW.maximum_event_count
  )
  OR (
    NEW.start_day IS NOT NULL
    AND (
      SELECT count(*) FROM events event
      WHERE event.subject_id = NEW.principal_id
        AND substr(event.occurred_at, 1, 10) BETWEEN NEW.start_day AND NEW.end_day
    ) > NEW.maximum_event_count
  )
  OR NOT EXISTS (
    SELECT 1 FROM memory_valid_owner_commands command
    WHERE command.event_id = NEW.owner_authorizing_event_id
      AND command.subject_id = NEW.principal_id
      AND json_extract(command.envelope_json, '$.payload.operation') = 'reprocess.create'
      AND json_extract(command.envelope_json, '$.payload.targetId') = NEW.job_id
      AND json_extract(command.envelope_json, '$.payload.startEventSequence') IS NEW.start_event_sequence
      AND json_extract(command.envelope_json, '$.payload.endEventSequence') IS NEW.end_event_sequence
      AND json_extract(command.envelope_json, '$.payload.startDay') IS NEW.start_day
      AND json_extract(command.envelope_json, '$.payload.endDay') IS NEW.end_day
      AND json_extract(command.envelope_json, '$.payload.maximumEventCount') = NEW.maximum_event_count
      AND json_extract(command.envelope_json, '$.payload.providerModelId') = NEW.provider_model_id
      AND json_extract(command.envelope_json, '$.payload.spendLimitMicros') = NEW.spend_limit_micros
      AND json_extract(command.envelope_json, '$.payload.dryRun') = NEW.dry_run
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_reprocess_job_authorization_invalid');
END;

CREATE TRIGGER memory_reprocess_jobs_update_guard
BEFORE UPDATE ON memory_reprocess_jobs
WHEN NEW.job_id <> OLD.job_id
  OR NEW.principal_id <> OLD.principal_id
  OR NEW.owner_authorizing_event_id <> OLD.owner_authorizing_event_id
  OR NEW.start_event_sequence IS NOT OLD.start_event_sequence
  OR NEW.end_event_sequence IS NOT OLD.end_event_sequence
  OR NEW.start_day IS NOT OLD.start_day
  OR NEW.end_day IS NOT OLD.end_day
  OR NEW.maximum_event_count <> OLD.maximum_event_count
  OR NEW.provider_model_id <> OLD.provider_model_id
  OR NEW.spend_limit_micros <> OLD.spend_limit_micros
  OR NEW.dry_run <> OLD.dry_run
  OR NEW.created_at <> OLD.created_at
  OR (OLD.checkpoint_event_sequence IS NOT NULL
    AND (NEW.checkpoint_event_sequence IS NULL
      OR NEW.checkpoint_event_sequence < OLD.checkpoint_event_sequence))
  OR NOT (
    (OLD.status = 'pending' AND NEW.status IN ('running', 'cancelled'))
    OR (OLD.status = 'running' AND NEW.status IN ('running', 'succeeded', 'failed', 'cancelled'))
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_reprocess_job_transition_invalid');
END;

CREATE TRIGGER memory_reprocess_jobs_delete_guard
BEFORE DELETE ON memory_reprocess_jobs
BEGIN
  SELECT RAISE(ABORT, 'memory_reprocess_job_delete_forbidden');
END;

CREATE TRIGGER memory_cost_ledger_insert_guard
BEFORE INSERT ON memory_cost_ledger
WHEN EXISTS (
    SELECT 1 FROM memory_cost_ledger entry
    WHERE entry.cost_entry_id = NEW.cost_entry_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM memory_runs run
    WHERE run.principal_id = NEW.principal_id
      AND run.run_id = NEW.run_id
      AND run.provider_model_id = NEW.model_id
      AND run.price_id = NEW.price_id
      AND NEW.occurred_at >= run.started_at
      AND (NEW.entry_type <> 'reservation' OR run.outcome = 'running')
      AND (
        (NEW.budget_class = 'normal_monthly'
          AND run.job <> 'reprocessing'
          AND run.reprocess_job_id IS NULL
          AND NEW.reprocess_job_id IS NULL)
        OR (NEW.budget_class = 'reprocessing'
          AND run.job = 'reprocessing'
          AND run.reprocess_job_id = NEW.reprocess_job_id
          AND EXISTS (
            SELECT 1 FROM memory_reprocess_jobs job
            WHERE job.principal_id = NEW.principal_id
              AND job.job_id = NEW.reprocess_job_id
              AND (
                NEW.entry_type <> 'reservation'
                OR (job.status IN ('pending', 'running') AND job.dry_run = 0)
              )
              AND (
                job.start_day IS NOT NULL
                OR (run.start_event_sequence = job.start_event_sequence
                  AND run.end_event_sequence = job.end_event_sequence)
              )
              AND run.provider_model_id = job.provider_model_id
              AND (
                NEW.entry_type <> 'reservation'
                OR NEW.amount_micros
                  + COALESCE((
                    SELECT sum(settlement.amount_micros)
                    FROM memory_cost_ledger settlement
                    WHERE settlement.principal_id = NEW.principal_id
                      AND settlement.reprocess_job_id = NEW.reprocess_job_id
                      AND settlement.entry_type IN ('settlement', 'overrun')
                  ), 0)
                  + COALESCE((
                    SELECT sum(reservation.amount_micros)
                    FROM memory_cost_ledger reservation
                    WHERE reservation.principal_id = NEW.principal_id
                      AND reservation.reprocess_job_id = NEW.reprocess_job_id
                      AND reservation.entry_type = 'reservation'
                      AND NOT EXISTS (
                        SELECT 1 FROM memory_cost_ledger terminal
                        WHERE terminal.principal_id = reservation.principal_id
                          AND terminal.reservation_entry_id = reservation.cost_entry_id
                          AND terminal.entry_type IN ('settlement', 'release')
                      )
                  ), 0) <= job.spend_limit_micros
              )
          ))
      )
  )
  OR (
    NEW.entry_type IN ('settlement', 'release')
    AND (
      NOT EXISTS (
        SELECT 1 FROM memory_cost_ledger reservation
        WHERE reservation.principal_id = NEW.principal_id
          AND reservation.cost_entry_id = NEW.reservation_entry_id
          AND reservation.run_id = NEW.run_id
          AND reservation.entry_type = 'reservation'
          AND reservation.provider = NEW.provider
          AND reservation.model_id = NEW.model_id
          AND reservation.budget_class = NEW.budget_class
          AND reservation.reprocess_job_id IS NEW.reprocess_job_id
          AND reservation.price_id = NEW.price_id
          AND (
            (NEW.entry_type = 'settlement' AND NEW.amount_micros <= reservation.amount_micros)
            OR (NEW.entry_type = 'release' AND NEW.amount_micros = reservation.amount_micros)
          )
      )
      OR EXISTS (
        SELECT 1 FROM memory_cost_ledger terminal
        WHERE terminal.principal_id = NEW.principal_id
          AND terminal.reservation_entry_id = NEW.reservation_entry_id
          AND terminal.entry_type IN ('settlement', 'release')
      )
    )
  )
  OR (
    NEW.entry_type = 'overrun'
    AND (
      NOT EXISTS (
        SELECT 1 FROM memory_cost_ledger reservation
        JOIN memory_cost_ledger settlement
          ON settlement.principal_id = reservation.principal_id
          AND settlement.reservation_entry_id = reservation.cost_entry_id
          AND settlement.entry_type = 'settlement'
          AND settlement.amount_micros = reservation.amount_micros
          AND NEW.occurred_at >= settlement.occurred_at
        WHERE reservation.principal_id = NEW.principal_id
          AND reservation.cost_entry_id = NEW.reservation_entry_id
          AND reservation.run_id = NEW.run_id
          AND reservation.entry_type = 'reservation'
          AND reservation.provider = NEW.provider
          AND reservation.model_id = NEW.model_id
          AND reservation.budget_class = NEW.budget_class
          AND reservation.reprocess_job_id IS NEW.reprocess_job_id
          AND reservation.price_id = NEW.price_id
      )
      OR EXISTS (
        SELECT 1 FROM memory_cost_ledger previous_overrun
        WHERE previous_overrun.principal_id = NEW.principal_id
          AND previous_overrun.reservation_entry_id = NEW.reservation_entry_id
          AND previous_overrun.entry_type = 'overrun'
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_cost_entry_lineage_invalid');
END;

CREATE TRIGGER memory_cursors_insert_guard
BEFORE INSERT ON memory_cursors
WHEN EXISTS (
  SELECT 1 FROM memory_cursors cursor_row
  WHERE cursor_row.principal_id = NEW.principal_id
    AND cursor_row.cursor_name = NEW.cursor_name
)
BEGIN
  SELECT RAISE(ABORT, 'memory_cursor_duplicate');
END;

CREATE TRIGGER memory_cursors_monotonic_update
BEFORE UPDATE ON memory_cursors
WHEN NEW.principal_id <> OLD.principal_id
  OR NEW.cursor_name <> OLD.cursor_name
  OR NEW.current_event_sequence < OLD.current_event_sequence
  OR NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'memory_cursor_transition_invalid');
END;

CREATE TRIGGER memory_cursors_delete_guard
BEFORE DELETE ON memory_cursors
BEGIN
  SELECT RAISE(ABORT, 'memory_cursor_delete_forbidden');
END;

CREATE TRIGGER memory_item_versions_fts_insert
AFTER INSERT ON memory_item_versions
BEGIN
  INSERT INTO memory_item_fts(rowid, text) VALUES (NEW.version_rowid, NEW.text);
END;

CREATE TRIGGER memory_episodes_fts_insert
AFTER INSERT ON memory_episodes
BEGIN
  INSERT INTO memory_episode_fts(rowid, text) VALUES (NEW.episode_rowid, NEW.text);
END;

CREATE TRIGGER memory_history_chunks_fts_insert
AFTER INSERT ON memory_history_chunks
BEGIN
  INSERT INTO memory_history_fts(rowid, text) VALUES (NEW.chunk_rowid, NEW.text);
END;

CREATE TRIGGER memory_history_chunks_fts_delete
AFTER DELETE ON memory_history_chunks
BEGIN
  INSERT INTO memory_history_fts(memory_history_fts, rowid, text)
  VALUES ('delete', OLD.chunk_rowid, OLD.text);
END;
