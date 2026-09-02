-- Full-text index over fact text. The foundation design makes full-text
-- search mandatory; semantic search is additive and arrives with the pinned
-- embedding stack.
--
-- `fact_id` is UNINDEXED: it is carried so results can join back to the fact
-- row, not matched against. Diacritics are folded so "cafe" finds "café",
-- which matters because the archive normalizes to NFC rather than stripping
-- accents.
CREATE VIRTUAL TABLE fact_search USING fts5(
    fact_id UNINDEXED,
    text,
    tokenize = 'unicode61 remove_diacritics 2'
);

-- Populated by trigger rather than by application code so that no write path
-- can add a fact that is invisible to search. Facts are never deleted and
-- their text is immutable, so insert is the only event needing a sync.
CREATE TRIGGER fact_search_insert AFTER INSERT ON fact
BEGIN
    INSERT INTO fact_search (fact_id, text) VALUES (new.fact_id, new.text);
END;
