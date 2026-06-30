import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type RawCandidate = {
  id: string;
  name: string;
  role?: string;
  company?: string;
  matchReason: string;
  groupName: string;
  groupId: string;
  sourceMessage: string;
};

export type EnrichedCandidate = RawCandidate & {
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  title?: string;
  companyFull?: string;
  enrichedVia?: string[];
};

// ---------------------------------------------------------------------------
// Apollo.io people search
// ---------------------------------------------------------------------------
async function apolloSearch(
  name: string,
  company?: string,
): Promise<Partial<EnrichedCandidate>> {
  const key = process.env.APOLLO_API_KEY;
  if (!key) return {};
  try {
    const res = await fetch("https://api.apollo.io/v1/mixed_people_search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        q_keywords: [name, company].filter(Boolean).join(" "),
        person_names: [name],
        ...(company ? { organization_names: [company] } : {}),
        page: 1,
        per_page: 3,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn("[sourcing] Apollo error", res.status, await res.text().catch(() => ""));
      return {};
    }
    const data = await res.json();
    const p = data.people?.[0];
    if (!p) return {};
    return {
      email: p.email || undefined,
      phone: p.phone_numbers?.[0]?.sanitized_number || undefined,
      linkedinUrl: p.linkedin_url || undefined,
      title: p.title || undefined,
      companyFull: p.organization?.name || undefined,
      enrichedVia: ["apollo"],
    };
  } catch (e) {
    console.error("[sourcing] Apollo fetch failed", e);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Apify — Google search → LinkedIn URL
// ---------------------------------------------------------------------------
async function apifyLinkedIn(
  name: string,
  company?: string,
): Promise<Partial<EnrichedCandidate>> {
  const key = process.env.APIFY_API_KEY;
  if (!key) return {};
  try {
    const query = `site:linkedin.com/in "${name}"${company ? ` "${company}"` : ""}`;
    const res = await fetch(
      `https://api.apify.com/v2/acts/apify~google-search-scraper/run-sync-get-dataset-items?token=${key}&timeout=30`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queries: query,
          resultsPerPage: 3,
          maxPagesPerQuery: 1,
        }),
        signal: AbortSignal.timeout(35_000),
      },
    );
    if (!res.ok) {
      console.warn("[sourcing] Apify error", res.status);
      return {};
    }
    const results: any[] = await res.json();
    const linkedinUrl = results
      .flatMap((r: any) => r.organicResults ?? [])
      .find((r: any) => r.url?.includes("linkedin.com/in/"))?.url;
    if (!linkedinUrl) return {};
    return { linkedinUrl, enrichedVia: ["apify"] };
  } catch (e) {
    console.error("[sourcing] Apify fetch failed", e);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Server fn: enrich one candidate with Apollo + Apify
// ---------------------------------------------------------------------------
export const enrichCandidate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string(),
        name: z.string(),
        company: z.string().optional(),
        role: z.string().optional(),
        matchReason: z.string(),
        groupName: z.string(),
        groupId: z.string(),
        sourceMessage: z.string(),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<EnrichedCandidate> => {
    const [apolloResult, apifyResult] = await Promise.allSettled([
      apolloSearch(data.name, data.company),
      apifyLinkedIn(data.name, data.company),
    ]);

    const apollo =
      apolloResult.status === "fulfilled" ? apolloResult.value : {};
    const apify =
      apifyResult.status === "fulfilled" ? apifyResult.value : {};

    const linkedinUrl = apollo.linkedinUrl || apify.linkedinUrl;
    const enrichedVia = [
      ...(apollo.enrichedVia ?? []),
      ...(!apollo.linkedinUrl && apify.linkedinUrl ? (apify.enrichedVia ?? []) : []),
    ];

    return {
      ...data,
      ...apollo,
      linkedinUrl,
      enrichedVia: enrichedVia.length ? enrichedVia : undefined,
    };
  });

// ---------------------------------------------------------------------------
// Server fn: scan all WhatsApp groups and find candidates via AI
// ---------------------------------------------------------------------------
export const scanGroupsForCandidates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      description: z.string().min(5).max(2000),
      groupIds: z.array(z.string()).optional(), // if provided, scan only these groups
    }).parse(d),
  )
  .handler(async ({ data }): Promise<RawCandidate[]> => {
    const { listGroups, listMessagesByChatId } = await import("./whapi.server");
    const { runAI } = await import("./ai-brain.server");

    // Fetch all groups, filter to selected if provided
    const allGroups = await listGroups();
    const topGroups = data.groupIds?.length
      ? allGroups.filter((g) => data.groupIds!.includes(g.id))
      : allGroups.slice(0, 25);
    if (!topGroups.length) {
      console.warn("[sourcing] no groups found");
      return [];
    }

    // Fetch recent messages from each group in parallel
    const groupResults = await Promise.allSettled(
      topGroups.map(async (g) => {
        const msgs = await listMessagesByChatId(g.id, 40);
        return { id: g.id, name: g.name, messages: msgs };
      }),
    );

    // Build the text block for the AI
    const groupBlocks = groupResults
      .filter(
        (r): r is PromiseFulfilledResult<{ id: string; name: string; messages: any[] }> =>
          r.status === "fulfilled",
      )
      .map(({ value: g }) => {
        const lines = (g.messages ?? [])
          .filter((m: any) => !m.from_me)
          .slice(0, 20)
          .map((m: any) => {
            const body = String(m.text?.body || m.body || "").trim().slice(0, 200);
            const sender = m.from_name || m.pushname || m.author || "Unknown";
            return body ? `${sender}: ${body}` : null;
          })
          .filter(Boolean)
          .join("\n");
        return lines
          ? `[GROUP: ${g.name} | ID: ${g.id}]\n${lines}`
          : null;
      })
      .filter(Boolean)
      .join("\n\n---\n\n");

    if (!groupBlocks) return [];

    const aiPrompt = `You are a talent sourcing AI. Analyze these WhatsApp group conversations and find people who match this search:

"${data.description}"

For each matching person output a JSON array. Each object must have:
- name: person's name (from messages)
- matchReason: 1-2 sentences on why they match
- company: their company if mentioned (or null)
- role: their job title if mentioned (or null)
- groupName: the GROUP name they came from
- groupId: the GROUP ID they came from
- sourceMessage: the exact short quote that reveals them as a candidate

Be selective — only confident matches. Return ONLY a valid JSON array (no markdown, no text outside the JSON).

=== GROUPS ===
${groupBlocks.slice(0, 14000)}`;

    let aiReply = "";
    try {
      aiReply = await runAI({
        systemPrompt:
          "You are a talent-sourcing assistant. You read WhatsApp conversations and identify people matching job descriptions. Always respond with valid JSON only — a JSON array, nothing else.",
        history: [],
        userMessage: aiPrompt,
        source: "sourcing",
      });
    } catch (e) {
      console.error("[sourcing] AI scan failed:", e);
      return [];
    }

    // Extract and parse JSON
    try {
      const jsonMatch = aiReply.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.warn("[sourcing] AI returned no JSON array:", aiReply.slice(0, 300));
        return [];
      }
      const parsed: any[] = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((c) => c && typeof c.name === "string" && c.name.trim())
        .map((c, i) => ({
          id: `candidate-${Date.now()}-${i}`,
          name: String(c.name).trim(),
          matchReason: String(c.matchReason || "Potentially relevant based on group activity"),
          company: c.company ? String(c.company).trim() : undefined,
          role: c.role ? String(c.role).trim() : undefined,
          groupName: String(c.groupName || ""),
          groupId: String(c.groupId || ""),
          sourceMessage: String(c.sourceMessage || "").trim(),
        }));
    } catch (e) {
      console.error("[sourcing] JSON parse failed:", e, aiReply.slice(0, 500));
      return [];
    }
  });

// ---------------------------------------------------------------------------
// Server fn: list all WhatsApp groups (for the group picker UI)
// ---------------------------------------------------------------------------
export const listGroupsForSourcing = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<Array<{ id: string; name: string }>> => {
    const { listGroups } = await import("./whapi.server");
    return listGroups();
  });
