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
    const { getChannelScope } = await import("@/lib/agent/channel.server");
    // No connected WhatsApp → show nothing (never surface a previous session's
    // contacts).
    const scope = await getChannelScope(supabaseAdmin);
    if (scope.mode === "disconnected") return [];

    let q = supabaseAdmin
      .from("people")
      .select(
        "id, wa_id, display_name, language, sentiment, funnel_stage, facts, last_seen_at, first_seen_at",
      )
      .order("last_seen_at", { ascending: false })
      .limit(200);
    // Presentation mode: only demo profiles on screen while demo data is
    // seeded — real contacts must never appear in a recording.
    const { isDemoViewOn } = await import("./demo-seed");
    if (await isDemoViewOn(supabaseAdmin as never)) {
      q = q.like("wa_id", "demo-%");
    } else if (scope.mode === "scoped") {
      // STRICT — a contact stamped for another number (or not yet stamped) is
      // not this account's data.
      q = q.eq("channel_phone", scope.phone);
    }
    const { data, error } = await q;
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
    const { getChannelScope } = await import("@/lib/agent/channel.server");
    // Account isolation: no connection → no person data; connected → only a
    // contact of THIS account may be opened (demo fixtures excepted).
    const scope = await getChannelScope(supabaseAdmin);
    const { data: person, error } = await supabaseAdmin
      .from("people")
      .select(
        "id, wa_id, display_name, language, sentiment, funnel_stage, facts, last_seen_at, first_seen_at, channel_phone",
      )
      .eq("id", data.personId)
      .single();
    if (error) throw new Error(error.message);
    const isDemoPerson = person.wa_id.startsWith("demo-");
    if (!isDemoPerson) {
      if (scope.mode === "disconnected") {
        throw new Error("No WhatsApp account is connected");
      }
      if (scope.mode === "scoped" && person.channel_phone !== scope.phone) {
        throw new Error("This contact belongs to a different WhatsApp account");
      }
    }

    // Their 1:1 conversation. people.wa_id converges on the canonical digits
    // (see agent/wa-id.ts) while conversations/bot_decisions/group_members
    // still hold whatever spelling Whapi used ('@s.whatsapp.net', '@c.us',
    // ':<device>') — match on the phone part so the data is found either way.
    const { normalizeWaId } = await import("@/lib/agent/wa-id");
    const barePhone = person.wa_id.replace(/@.*$/, "");
    const personCanon = normalizeWaId(person.wa_id);
    // Digits usable in a `<digits>@%` pattern — null for '@lid'/'@simulation'
    // identities, which only ever match their exact raw spelling.
    const phoneDigits = personCanon && !personCanon.includes("@") ? personCanon : null;
    let convQuery = supabaseAdmin
      .from("conversations")
      .select("id, whapi_chat_id")
      .eq("is_group", false)
      .or(`whapi_chat_id.eq.${person.wa_id},whapi_chat_id.like.${barePhone}@%`)
      .limit(1);
    if (scope.mode === "scoped" && !isDemoPerson) {
      convQuery = convQuery.eq("channel_phone", scope.phone);
    }
    const { data: convs } = await convQuery;
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
        .or(
          phoneDigits
            ? `chat_id.eq.${person.wa_id},chat_id.like.${phoneDigits}@%`
            : `chat_id.eq.${person.wa_id}`,
        )
        .eq("stage", "intent")
        .order("created_at", { ascending: false })
        .limit(15),
      // group_members.wa_id keeps Whapi's raw spelling — fetch active
      // memberships and compare canonically client-side (a like-pattern would
      // miss ':<device>' variants).
      supabaseAdmin
        .from("group_members")
        .select("group_chat_id, wa_id")
        .is("left_at", null)
        .limit(5000),
    ]);

    const groupIds = (memberRes.data ?? [])
      .filter((m) => normalizeWaId(m.wa_id) === personCanon)
      .map((m) => m.group_chat_id);
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
      person: person as unknown as PersonListItem,
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

    // --- LIVE research: all three tools run in parallel on every question,
    // scoped to the contact. Tavily (web) + Apify (X/Twitter) search the name
    // plus the manager's question; Apollo looks the person up in its B2B
    // graph. Each tool's failure/absence is reported honestly in the tool
    // status line — never silently skipped.
    const name = (p.display_name ?? "").trim();
    // Company hint from stored facts sharpens Apollo/web matches.
    const companyFact = p.facts
      .map((f) =>
        f.text.match(/(?:works? at|company|from|-מ|עובד ב|עובדת ב|חברת)\s+([\w"'&.-]{2,40})/i),
      )
      .find(Boolean);
    const companyHint = companyFact?.[1] ?? null;
    const researchQuery = [name, companyHint, data.question]
      .filter(Boolean)
      .join(" ")
      .slice(0, 300);

    const [tavilyRes, xRes, apolloRes] = await Promise.allSettled([
      (async () => {
        const { isTavilyConfigured, tavilySearch } = await import("@/lib/tavily.server");
        if (!isTavilyConfigured()) throw new Error("TAVILY_API_KEY not configured");
        // Dashboard call — it can afford a patient search (a 10s timeout hit
        // live 2026-07-28 while Tavily was slow; the fn's own wall is ~60s).
        return tavilySearch(researchQuery, { maxResults: 5, timeoutMs: 15_000, budgetMs: 20_000 });
      })(),
      (async () => {
        const { isApifyConfigured, xSearch } = await import("@/lib/apify-x.server");
        if (!isApifyConfigured()) throw new Error("APIFY_API_KEY not configured");
        if (!name) throw new Error("contact has no name to search on X");
        return xSearch(name, { maxItems: 8, timeoutMs: 18_000, budgetMs: 20_000 });
      })(),
      (async () => {
        const { isApolloConfigured, apolloPeopleSearch } = await import("@/lib/apollo.server");
        if (!isApolloConfigured()) throw new Error("not configured");
        if (!name) throw new Error("contact has no name for an Apollo lookup");
        return apolloPeopleSearch({ name, company: companyHint }, { maxResults: 3 });
      })(),
    ]);

    const { buildResearchBlock, buildXBlock } = await import("@/lib/agent/research");
    const { buildApolloBlock, APOLLO_SETUP_HINT, isApolloConfigured } =
      await import("@/lib/apollo.server");
    const tavily = tavilyRes.status === "fulfilled" ? tavilyRes.value : null;
    const x = xRes.status === "fulfilled" ? xRes.value : null;
    const apollo = apolloRes.status === "fulfilled" ? apolloRes.value : null;
    const failMsg = (r: PromiseSettledResult<unknown>) =>
      r.status === "rejected"
        ? String((r.reason as Error)?.message ?? r.reason).slice(0, 120)
        : null;

    const toolStatus = [
      tavily
        ? `Tavily web search: ${tavily.results.length} result(s)`
        : `Tavily web search FAILED: ${failMsg(tavilyRes)}`,
      x
        ? `X/Twitter (Apify): ${x.results.length} post(s)`
        : `X/Twitter (Apify) FAILED: ${failMsg(xRes)}`,
      apollo
        ? `Apollo B2B lookup: ${apollo.people.length} profile match(es)`
        : isApolloConfigured()
          ? `Apollo lookup FAILED: ${failMsg(apolloRes)}`
          : APOLLO_SETUP_HINT,
    ].join("\n");

    const liveBlocks = `${buildResearchBlock(tavily)}${buildXBlock(x)}${buildApolloBlock(apollo)}`;

    const system = `You are the manager's research analyst for one WhatsApp contact. Answer the manager's questions about this person in English, concisely, grounded in (a) the STORED DATA from our own conversations and (b) the LIVE RESEARCH that was just run with real tools (web search, X/Twitter, Apollo). Cite source URLs from the research when you rely on them. Live matches may be a different person with the same name — say so when the identification is uncertain. If neither the stored data nor the research answers the question, say exactly what is missing — never invent.

LIVE TOOL RUN STATUS (report failures honestly if the manager asks about research coverage)
${toolStatus}

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
${timelineBlock || "(no direct 1:1 conversation)"}
${liveBlocks || "\n(LIVE RESEARCH returned no usable results this run — answer from stored data and say research came up empty.)"}`;

    const res = await callLLM({
      role: "strong",
      source: "profile_chat",
      timeoutMs: 18_000,
      budgetMs: 25_000,
      messages: [
        { role: "system", content: system },
        ...data.history.map((h) => ({ role: h.role, content: h.content })),
        { role: "user", content: data.question },
      ],
    });
    const answer = res.content.trim() || "I could not produce an answer from the stored data.";
    // Compact, honest footer: which tools actually ran on this question.
    const footer = [
      `🔎 ${tavily ? `Web ${tavily.results.length}` : "Web ✗"}`,
      x ? `X ${x.results.length}` : "X ✗",
      apollo
        ? `Apollo ${apollo.people.length}`
        : isApolloConfigured()
          ? "Apollo ✗"
          : "Apollo not connected (APOLLO_API_KEY missing)",
    ].join(" · ");
    return { answer: `${answer}\n\n${footer}` };
  });
