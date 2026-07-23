// Person profiles for the dashboard: the bot's full per-person analysis
// (facts, intent/sentiment history, conversation timeline) plus an embedded
// "ask about this person" chat grounded strictly in stored data.
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

export type PersonIntentEntry = {
  intent: string;
  sentiment: string;
  urgency: string;
  at: string;
};

export type TimelineMessage = {
  direction: string;
  sender_name: string | null;
  body: string;
  created_at: string;
};

export type PersonDetail = {
  person: PersonListItem;
  timeline: TimelineMessage[];
  intents: PersonIntentEntry[];
  groups: string[];
};

export const getPersonDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) => z.object({ personId: z.string().uuid() }).parse(d))
  .handler(async ({ data }): Promise<PersonDetail> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: person, error } = await supabaseAdmin
      .from("people")
      .select(
        "id, wa_id, display_name, language, sentiment, funnel_stage, facts, last_seen_at, first_seen_at",
      )
      .eq("id", data.personId)
      .single();
    if (error) throw new Error(error.message);

    // Their 1:1 conversation. Whapi sometimes reports the same contact as a
    // bare phone number and sometimes with an @s.whatsapp.net/@c.us suffix —
    // match on the phone part so the timeline is found either way.
    const barePhone = person.wa_id.replace(/@.*$/, "");
    const { data: convs } = await supabaseAdmin
      .from("conversations")
      .select("id, whapi_chat_id")
      .eq("is_group", false)
      .or(`whapi_chat_id.eq.${person.wa_id},whapi_chat_id.like.${barePhone}@%`)
      .limit(1);
    const conv = convs?.[0] ?? null;

    const [timelineRes, intentsRes, memberRes] = await Promise.all([
      conv
        ? supabaseAdmin
            .from("messages")
            .select("direction, sender_name, body, created_at")
            .eq("conversation_id", conv.id)
            .order("created_at", { ascending: false })
            .limit(60)
        : Promise.resolve({ data: [] as TimelineMessage[] }),
      supabaseAdmin
        .from("bot_decisions")
        .select("data, created_at")
        .eq("chat_id", person.wa_id)
        .eq("stage", "intent")
        .order("created_at", { ascending: false })
        .limit(15),
      supabaseAdmin
        .from("group_members")
        .select("group_chat_id")
        .eq("wa_id", person.wa_id)
        .is("left_at", null),
    ]);

    const groupIds = (memberRes.data ?? []).map((m) => m.group_chat_id);
    let groups: string[] = [];
    if (groupIds.length) {
      const { data: convs } = await supabaseAdmin
        .from("conversations")
        .select("whapi_chat_id, name")
        .in("whapi_chat_id", groupIds);
      groups = (convs ?? []).map((c) => c.name ?? c.whapi_chat_id);
    }

    const intents: PersonIntentEntry[] = (intentsRes.data ?? []).map((d) => {
      const raw = (d.data ?? {}) as Record<string, unknown>;
      return {
        intent: String(raw.intent ?? ""),
        sentiment: String(raw.sentiment ?? ""),
        urgency: String(raw.urgency ?? ""),
        at: d.created_at,
      };
    });

    return {
      person: person as PersonListItem,
      timeline: ((timelineRes.data ?? []) as TimelineMessage[]).filter((m) => m.body).reverse(),
      intents,
      groups,
    };
  });

const askSchema = z.object({
  personId: z.string().uuid(),
  question: z.string().min(1).max(1000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) }))
    .max(20)
    .default([]),
});

export const askAboutPerson = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) => askSchema.parse(d))
  .handler(async ({ data }): Promise<{ answer: string }> => {
    const detail = await getPersonDetail({ data: { personId: data.personId } });
    const { callLLM } = await import("@/lib/llm.server");

    const p = detail.person;
    const factsBlock = p.facts.length
      ? p.facts.map((f) => `- ${f.text} (${f.at.slice(0, 10)})`).join("\n")
      : "(no stored facts yet)";
    const intentsBlock = detail.intents.length
      ? detail.intents
          .map((i) => `- ${i.at.slice(0, 16)} · intent: ${i.intent} · sentiment: ${i.sentiment}`)
          .join("\n")
      : "(no analyzed messages yet)";
    const timelineBlock = detail.timeline
      .slice(-40)
      .map(
        (m) =>
          `${m.created_at.slice(0, 16)} ${m.direction === "outbound" ? "US" : "THEM"}: ${m.body.slice(0, 250)}`,
      )
      .join("\n");

    const system = `You are the manager's analyst for one WhatsApp contact. Answer the manager's questions about this person in English, concisely (2-6 sentences), grounded STRICTLY in the stored data below. Quote the contact's own words (any language) when useful. If the data is insufficient to answer, say exactly what is missing — never invent.

CONTACT PROFILE
Name: ${p.display_name ?? "unknown"} | WA id: ${p.wa_id}
Funnel stage: ${p.funnel_stage} | Language: ${p.language ?? "unknown"} | Last sentiment: ${p.sentiment ?? "unknown"}
First seen: ${p.first_seen_at.slice(0, 10)} | Last seen: ${p.last_seen_at.slice(0, 16)}
Member of groups: ${detail.groups.join(", ") || "(none tracked)"}

STORED FACTS
${factsBlock}

INTENT / SENTIMENT HISTORY (newest first)
${intentsBlock}

CONVERSATION TIMELINE (oldest first)
${timelineBlock || "(no direct 1:1 conversation)"}`;

    const res = await callLLM({
      role: "strong",
      source: "profile_chat",
      messages: [
        { role: "system", content: system },
        ...data.history.map((h) => ({ role: h.role, content: h.content })),
        { role: "user", content: data.question },
      ],
    });
    return { answer: res.content.trim() || "I could not produce an answer from the stored data." };
  });
