ALTER TABLE public.people ADD COLUMN IF NOT EXISTS channel_phone TEXT;

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

    SELECT COALESCE(jsonb_agg(capped.fact ORDER BY capped.at_key), '[]'::jsonb)
      INTO merged_facts
    FROM (
      SELECT deduped.fact, deduped.at_key
      FROM (
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

    UPDATE public.follow_ups
    SET person_wa_id = grp.canon
    WHERE person_wa_id = ANY (variant_wa_ids);

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

CREATE UNIQUE INDEX IF NOT EXISTS people_wa_id_canonical_key
  ON public.people ((
    CASE WHEN wa_id LIKE '%@lid' OR wa_id LIKE '%@simulation' THEN wa_id
         ELSE regexp_replace(split_part(split_part(wa_id, '@', 1), ':', 1), '\D', '', 'g')
    END
  ));