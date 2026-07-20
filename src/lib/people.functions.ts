// Read side of the bot's persistent person memory, for the dashboard.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAdmin } from "@/integrations/supabase/admin-middleware";
import { z } from "zod";

export type PersonListItem = {
  id: string;
  wa_id: string;
  display_name: string | null;
  language: string | null;
  sentiment: string | null;
  funnel_stage: string;
  facts: Array<{ text: string; at: string }>;
  last_seen_at: string;
  first_seen_at: string;
};

export const listPeople = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAdmin])
  .handler(async (): Promise<PersonListItem[]> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("people")
      .select(
        "id, wa_id, display_name, language, sentiment, funnel_stage, facts, last_seen_at, first_seen_at",
      )
      .order("last_seen_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return (data ?? []) as PersonListItem[];
  });

export const deletePersonFact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) =>
    z.object({ personId: z.string().uuid(), factText: z.string().min(1) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: person, error } = await supabaseAdmin
      .from("people")
      .select("facts")
      .eq("id", data.personId)
      .single();
    if (error) throw new Error(error.message);
    const facts = (Array.isArray(person.facts) ? person.facts : []) as Array<{
      text: string;
      at: string;
    }>;
    const next = facts.filter((f) => f.text !== data.factText);
    const { error: upErr } = await supabaseAdmin
      .from("people")
      .update({ facts: next, updated_at: new Date().toISOString() })
      .eq("id", data.personId);
    if (upErr) throw new Error(upErr.message);
    return { ok: true, removed: facts.length - next.length };
  });
