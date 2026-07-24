-- Collapse duplicate person profiles and make duplicates impossible.
--
-- people.wa_id is UNIQUE on the RAW string, but Whapi reports the same human
-- under several spellings — bare digits ('9725...'), '@s.whatsapp.net',
-- '@c.us', sometimes with a ':<device>' suffix — so the table accumulated one
-- profile per spelling. The app now normalizes every id to a canonical key
-- (src/lib/agent/wa-id.ts) and a sweeper pass merges duplicates at runtime;
-- this migration is the durable half: it converges the stored data the same
-- way and adds a unique index on the canonical expression, which makes
-- duplicates impossible regardless of app bugs.
--
-- The canonical key, mirrored from normalizeWaId:
--   * '@lid' / '@simulation' ids stay raw (numeric but NOT phone numbers —
--     stripping the suffix would collide them with real phones),
--   * everything else: local part before '@', drop ':<device>', digits only.
-- Rows that cannot be people at all — group ids ('%@g.us') and ids with fewer
-- than 5 digits ('bot'/'manual' sentinels, junk) — are deleted outright.
--
-- Safe to re-run, and safe whether or not the runtime dedupe already ran:
-- every step finds nothing left to do on a converged table.

-- 0) The merge below reads people.channel_phone via %ROWTYPE. That column
--    comes from 20260723160000_channel_scope.sql, which may not be applied
--    yet — create it here too (same definition, both idempotent) so this
--    migration works regardless of apply order.
ALTER TABLE public.people ADD COLUMN IF NOT EXISTS channel_phone TEXT;

-- 1) Drop rows that are not person identities.
DO $junk$
DECLARE
  removed INT;
BEGIN
  WITH gone AS (
    DELETE FROM public.people
    WHERE wa_id LIKE '%@g.us'
       OR (wa_id NOT LIKE '%@lid'
           AND wa_id NOT LIKE '%@simulation'
           AND length(regexp_replace(split_part(split_part(wa_id, '@', 1), ':', 1), '\D', '', 'g')) < 5)
    RETURNING 1
  )
  SELECT count(*) INTO removed FROM gone;
  RAISE NOTICE 'people dedupe: removed % non-person row(s)', removed;
END
$junk$;

-- 2) Merge duplicate groups into the earliest row (its id may already be
--    referenced elsewhere, and first_seen_at semantics favor the oldest
--    profile). Memory is folded, not discarded: facts union (deduped on
--    normalized text, oldest first, newest 40 kept — mirrors mergeFacts),
--    tags union, min/max seen timestamps, first non-null scalar in
--    created_at order, funnel_stage prefers any non-'unknown'.
DO $dedupe$
DECLARE
  grp RECORD;
  survivor public.people%ROWTYPE;
  loser public.people%ROWTYPE;
  all_facts JSONB;
  merged_facts JSONB;
  merged_tags TEXT[];
  variant_wa_ids TEXT[];
  merged_groups INT := 0;
BEGIN
  FOR grp IN
    SELECT t.canon, array_agg(t.id ORDER BY t.created_at, t.id) AS ids
    FROM (
      SELECT id, created_at,
             CASE WHEN wa_id LIKE '%@lid' OR wa_id LIKE '%@simulation' THEN wa_id
                  ELSE regexp_replace(split_part(split_part(wa_id, '@', 1), ':', 1), '\D', '', 'g')
             END AS canon
      FROM public.people
    ) t
    GROUP BY t.canon
    HAVING count(*) > 1
  LOOP
    SELECT * INTO survivor FROM public.people WHERE id = grp.ids[1];

    all_facts := CASE WHEN jsonb_typeof(survivor.facts) = 'array' THEN survivor.facts ELSE '[]'::jsonb END;
    merged_tags := COALESCE(survivor.tags, '{}');
    variant_wa_ids := ARRAY[survivor.wa_id];

    FOR loser IN
      SELECT * FROM public.people WHERE id = ANY (grp.ids[2:]) ORDER BY created_at, id
    LOOP
      all_facts := all_facts
        || CASE WHEN jsonb_typeof(loser.facts) = 'array' THEN loser.facts ELSE '[]'::jsonb END;
      merged_tags := merged_tags
        || (SELECT COALESCE(array_agg(DISTINCT t), '{}') FROM unnest(loser.tags) t WHERE NOT t = ANY (merged_tags));
      variant_wa_ids := variant_wa_ids || loser.wa_id;

      survivor.display_name  := COALESCE(survivor.display_name, loser.display_name);
      survivor.language      := COALESCE(survivor.language, loser.language);
      survivor.sentiment     := COALESCE(survivor.sentiment, loser.sentiment);
      survivor.channel_phone := COALESCE(survivor.channel_phone, loser.channel_phone);
      IF (survivor.funnel_stage IS NULL OR survivor.funnel_stage = 'unknown')
         AND loser.funnel_stage IS NOT NULL AND loser.funnel_stage <> 'unknown' THEN
        survivor.funnel_stage := loser.funnel_stage;
      END IF;
      survivor.first_seen_at := LEAST(survivor.first_seen_at, loser.first_seen_at);
      survivor.last_seen_at  := GREATEST(survivor.last_seen_at, loser.last_seen_at);
    END LOOP;

    -- Dedupe facts on whitespace-insensitive lowercased text (first spelling
    -- wins), keep the newest 40 by 'at', stored oldest-first.
    SELECT COALESCE(jsonb_agg(capped.fact ORDER BY capped.at_key), '[]'::jsonb)
      INTO merged_facts
    FROM (
      SELECT deduped.fact, deduped.at_key
      FROM (
        -- Same normalization as the app's mergeFacts: collapse whitespace
        -- runs, trim, lowercase.
        SELECT DISTINCT ON (lower(trim(regexp_replace(numbered.fact->>'text', '\s+', ' ', 'g'))))
               numbered.fact, COALESCE(numbered.fact->>'at', '') AS at_key
        FROM (
          SELECT elem.value AS fact, elem.ordinality AS ord
          FROM jsonb_array_elements(all_facts) WITH ORDINALITY AS elem
        ) numbered
        ORDER BY lower(trim(regexp_replace(numbered.fact->>'text', '\s+', ' ', 'g'))), numbered.ord
      ) deduped
      ORDER BY deduped.at_key DESC
      LIMIT 40
    ) capped;

    -- follow_ups reference people by loose wa_id string (no FK) — point every
    -- old spelling at the canonical key before the loser rows disappear.
    UPDATE public.follow_ups
    SET person_wa_id = grp.canon
    WHERE person_wa_id = ANY (variant_wa_ids);

    -- Losers first: the raw-string UNIQUE constraint would reject renaming
    -- the survivor while a loser still holds the canonical spelling.
    DELETE FROM public.people WHERE id = ANY (grp.ids[2:]);

    UPDATE public.people
    SET wa_id         = grp.canon,
        display_name  = survivor.display_name,
        language      = survivor.language,
        sentiment     = survivor.sentiment,
        channel_phone = survivor.channel_phone,
        funnel_stage  = COALESCE(survivor.funnel_stage, 'unknown'),
        facts         = merged_facts,
        tags          = merged_tags,
        first_seen_at = survivor.first_seen_at,
        last_seen_at  = survivor.last_seen_at,
        updated_at    = now()
    WHERE id = survivor.id;

    merged_groups := merged_groups + 1;
  END LOOP;
  RAISE NOTICE 'people dedupe: merged % duplicate group(s)', merged_groups;
END
$dedupe$;

-- 3) Rename the remaining rows to their canonical spelling. No duplicates
--    exist per canonical key after step 2, so this cannot violate the
--    raw-string unique constraint.
DO $rename$
DECLARE
  renamed INT;
BEGIN
  WITH changed AS (
    UPDATE public.people
    SET wa_id = CASE WHEN wa_id LIKE '%@lid' OR wa_id LIKE '%@simulation' THEN wa_id
                     ELSE regexp_replace(split_part(split_part(wa_id, '@', 1), ':', 1), '\D', '', 'g')
                END,
        updated_at = now()
    WHERE wa_id <> CASE WHEN wa_id LIKE '%@lid' OR wa_id LIKE '%@simulation' THEN wa_id
                        ELSE regexp_replace(split_part(split_part(wa_id, '@', 1), ':', 1), '\D', '', 'g')
                   END
    RETURNING 1
  )
  SELECT count(*) INTO renamed FROM changed;
  RAISE NOTICE 'people dedupe: renamed % profile(s) to canonical ids', renamed;
END
$rename$;

-- 4) The actual guarantee: one row per canonical identity, whatever raw
--    spelling a future code path might try to insert.
CREATE UNIQUE INDEX IF NOT EXISTS people_wa_id_canonical_key
  ON public.people ((
    CASE WHEN wa_id LIKE '%@lid' OR wa_id LIKE '%@simulation' THEN wa_id
         ELSE regexp_replace(split_part(split_part(wa_id, '@', 1), ':', 1), '\D', '', 'g')
    END
  ));
