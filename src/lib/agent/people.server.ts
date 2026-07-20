// Persistent per-person memory. One row per WhatsApp sender (1:1 chats and
// group members alike), carrying durable facts the bot has learned. All
// loaders degrade gracefully — a missing table or transient error must never
// stop a reply.
import type { Json } from "@/integrations/supabase/types";
import type { Supa } from "./types";

export type PersonFact = { text: string; at: string };

export type PersonRow = {
  id: string;
  wa_id: string;
  display_name: string | null;
  language: string | null;
  sentiment: string | null;
  funnel_stage: string;
  facts: PersonFact[];
  tags: string[];
  last_seen_at: string;
};

const FACTS_CAP = 40;

function normalizeFactText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Merge newly learned facts into the existing list: dedupe, newest last, capped. */
export function mergeFacts(
  existing: PersonFact[],
  incoming: string[],
  now: Date = new Date(),
  cap: number = FACTS_CAP,
): PersonFact[] {
  const seen = new Set(existing.map((f) => normalizeFactText(f.text)));
  const merged = [...existing];
  for (const raw of incoming) {
    const text = raw.replace(/\s+/g, " ").trim();
    if (text.length < 3 || text.length > 300) continue;
    const key = normalizeFactText(text);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ text, at: now.toISOString() });
  }
  // Oldest facts fall off first once over the cap.
  return merged.slice(-cap);
}

function rowToPerson(data: Record<string, unknown>): PersonRow {
  return {
    id: String(data.id),
    wa_id: String(data.wa_id),
    display_name: (data.display_name as string) ?? null,
    language: (data.language as string) ?? null,
    sentiment: (data.sentiment as string) ?? null,
    funnel_stage: String(data.funnel_stage ?? "unknown"),
    facts: Array.isArray(data.facts) ? (data.facts as PersonFact[]) : [],
    tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
    last_seen_at: String(data.last_seen_at ?? new Date().toISOString()),
  };
}

export async function loadOrCreatePerson(
  supabase: Supa,
  waId: string,
  displayName?: string,
): Promise<PersonRow | null> {
  if (!waId || waId === "bot") return null;
  try {
    const { data, error } = await supabase
      .from("people")
      .select(
        "id, wa_id, display_name, language, sentiment, funnel_stage, facts, tags, last_seen_at",
      )
      .eq("wa_id", waId)
      .maybeSingle();
    if (error) {
      console.warn("[people] load failed (continuing without memory):", error.message);
      return null;
    }
    if (data) {
      // Keep freshness + name current; never block the reply on it.
      void supabase
        .from("people")
        .update({
          last_seen_at: new Date().toISOString(),
          ...(displayName && !data.display_name ? { display_name: displayName } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("id", data.id)
        .then(({ error: e }) => {
          if (e) console.warn("[people] touch failed:", e.message);
        });
      return rowToPerson(data);
    }
    const { data: ins, error: insErr } = await supabase
      .from("people")
      .insert({ wa_id: waId, display_name: displayName || null })
      .select(
        "id, wa_id, display_name, language, sentiment, funnel_stage, facts, tags, last_seen_at",
      )
      .single();
    if (insErr) {
      // Unique-violation race with a parallel isolate: read the winner's row.
      if (insErr.code === "23505") {
        const { data: again } = await supabase
          .from("people")
          .select(
            "id, wa_id, display_name, language, sentiment, funnel_stage, facts, tags, last_seen_at",
          )
          .eq("wa_id", waId)
          .maybeSingle();
        return again ? rowToPerson(again) : null;
      }
      console.warn("[people] create failed (continuing without memory):", insErr.message);
      return null;
    }
    return ins ? rowToPerson(ins) : null;
  } catch (e) {
    console.warn("[people] unexpected failure (continuing without memory):", e);
    return null;
  }
}

/** Internal-memory block injected into the drafting prompts. */
export function personPromptBlock(person: PersonRow | null | undefined): string {
  if (!person) return "";
  const facts = person.facts.slice(-15);
  const lines = [
    `

מה שאנחנו יודעים על איש הקשר (זיכרון פנימי — השתמש בו בטבעיות, אל תצטט אותו ואל תגיד "רשום אצלי"):`,
    `- שם: ${person.display_name ?? "לא ידוע"} | שלב: ${person.funnel_stage} | שפה מועדפת: ${person.language ?? "לא ידוע"}${person.sentiment ? ` | מצב רוח אחרון: ${person.sentiment}` : ""}`,
  ];
  if (facts.length) {
    lines.push(...facts.map((f) => `- ${f.text}`));
  }
  return lines.join("\n");
}

export type PersonUpdate = {
  facts?: string[];
  language?: string | null;
  sentiment?: string | null;
  funnel_stage?: string | null;
};

const FUNNEL_STAGES = new Set(["unknown", "lead", "customer", "community", "vip", "churned"]);

export async function applyPersonUpdate(
  supabase: Supa,
  person: PersonRow,
  update: PersonUpdate,
): Promise<void> {
  try {
    const patch: {
      updated_at: string;
      facts?: Json;
      language?: string;
      sentiment?: string;
      funnel_stage?: string;
    } = { updated_at: new Date().toISOString() };
    if (update.facts?.length) {
      patch.facts = mergeFacts(person.facts, update.facts) as unknown as Json;
    }
    if (update.language) patch.language = update.language;
    if (update.sentiment) patch.sentiment = update.sentiment;
    if (update.funnel_stage && FUNNEL_STAGES.has(update.funnel_stage)) {
      patch.funnel_stage = update.funnel_stage;
    }
    const { error } = await supabase.from("people").update(patch).eq("id", person.id);
    if (error) console.warn("[people] update failed:", error.message);
  } catch (e) {
    console.warn("[people] update failed:", e);
  }
}
