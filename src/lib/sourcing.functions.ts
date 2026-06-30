import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAdmin } from "@/integrations/supabase/admin-middleware";
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
// Helper: safe abort signal with timeout
// ---------------------------------------------------------------------------
function makeSignal(ms: number): AbortSignal {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

// ---------------------------------------------------------------------------
// Apollo.io people search — uses reveal_personal_emails + reveal_phone_number
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
        reveal_personal_emails: true,
        reveal_phone_number: true,
        page: 1,
        per_page: 5,
      }),
      signal: makeSignal(15_000),
    });
    if (!res.ok) {
      console.warn("[sourcing] Apollo error", res.status, await res.text().catch(() => ""));
      return {};
    }
    const data = await res.json();
    const p = data.people?.[0];
    if (!p) {
      console.log("[sourcing] Apollo: no results for", name);
      return {};
    }
    console.log("[sourcing] Apollo found:", p.name, p.email, p.linkedin_url);
    return {
      email: p.email || p.personal_emails?.[0] || undefined,
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
// Apify — LinkedIn Profile Search By Name (harvestapi actor, no cookies)
// Docs: https://apify.com/harvestapi/linkedin-profile-search-by-name
// ---------------------------------------------------------------------------
async function apifyLinkedInByName(
  name: string,
  company?: string,
): Promise<Partial<EnrichedCandidate>> {
  const key = process.env.APIFY_API_KEY;
  if (!key) return {};
  try {
    // Use LinkedIn Profile Search By Name actor — much more accurate than Google scrape
    const query = company ? `${name} ${company}` : name;
    const res = await fetch(
      `https://api.apify.com/v2/acts/harvestapi~linkedin-profile-search-by-name/run-sync-get-dataset-items?token=${key}&timeout=60`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          searches: [{ fullName: name, companyName: company ?? undefined }],
          maxResults: 3,
        }),
        signal: makeSignal(65_000),
      },
    );
    if (!res.ok) {
      console.warn("[sourcing] Apify LinkedIn-by-name error", res.status);
      // Fallback: Google scrape
      return apifyGoogleFallback(name, company);
    }
    const results: any[] = await res.json();
    const profile = results?.[0];
    if (!profile) return apifyGoogleFallback(name, company);

    console.log("[sourcing] Apify found:", profile.fullName, profile.linkedinUrl || profile.url);
    return {
      linkedinUrl: profile.linkedinUrl || profile.url || undefined,
      title: profile.headline || profile.title || undefined,
      companyFull: profile.company || profile.currentCompany || undefined,
      enrichedVia: ["apify"],
    };
  } catch (e) {
    console.error("[sourcing] Apify LinkedIn-by-name failed", e);
    return apifyGoogleFallback(name, company);
  }
}

// Fallback: Google → LinkedIn URL via Apify Google scraper
async function apifyGoogleFallback(
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
        body: JSON.stringify({ queries: query, resultsPerPage: 5, maxPagesPerQuery: 1 }),
        signal: makeSignal(35_000),
      },
    );
    if (!res.ok) return {};
    const results: any[] = await res.json();
    const linkedinUrl = results
      .flatMap((r: any) => r.organicResults ?? [])
      .find((r: any) => r.url?.includes("linkedin.com/in/"))?.url;
    if (!linkedinUrl) return {};
    return { linkedinUrl, enrichedVia: ["apify"] };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Server fn: enrich one candidate with Apollo + Apify
// ---------------------------------------------------------------------------
export const enrichCandidate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
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
    console.log("[sourcing] enriching:", data.name, data.company);
    const [apolloResult, apifyResult] = await Promise.allSettled([
      apolloSearch(data.name, data.company),
      apifyLinkedInByName(data.name, data.company),
    ]);

    const apollo = apolloResult.status === "fulfilled" ? apolloResult.value : {};
    const apify = apifyResult.status === "fulfilled" ? apifyResult.value : {};

    // Apollo takes priority; Apify fills in LinkedIn + title if Apollo missed them
    const linkedinUrl = apollo.linkedinUrl || apify.linkedinUrl;
    const title = apollo.title || apify.title;
    const companyFull = apollo.companyFull || apify.companyFull;
    const enrichedVia = [
      ...(apollo.enrichedVia ?? []),
      ...(!apollo.linkedinUrl && apify.linkedinUrl ? (apify.enrichedVia ?? []) : []),
    ];

    return {
      ...data,
      ...apollo,
      linkedinUrl,
      title,
      companyFull,
      enrichedVia: enrichedVia.length ? enrichedVia : undefined,
    };
  });

// ---------------------------------------------------------------------------
// Server fn: scan WhatsApp groups and find candidates via AI
// ---------------------------------------------------------------------------
export const scanGroupsForCandidates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) =>
    z.object({
      description: z.string().min(3).max(2000),
      groupIds: z.array(z.string()).optional(),
    }).parse(d),
  )
  .handler(async ({ data }): Promise<RawCandidate[]> => {
    const { listGroups, listMessagesByChatId } = await import("./whapi.server");
    const { runAI } = await import("./ai-brain.server");

    const allGroups = await listGroups();
    console.log("[sourcing] total groups:", allGroups.length);

    const topGroups = data.groupIds?.length
      ? allGroups.filter((g) => data.groupIds!.includes(g.id))
      : allGroups.slice(0, 25);

    if (!topGroups.length) {
      console.warn("[sourcing] no groups to scan");
      return [];
    }
    console.log("[sourcing] scanning", topGroups.length, "groups");

    // Fetch messages in parallel
    const groupResults = await Promise.allSettled(
      topGroups.map(async (g) => {
        const msgs = await listMessagesByChatId(g.id, 50);
        console.log(`[sourcing] group "${g.name}": ${msgs.length} messages`);
        return { id: g.id, name: g.name, messages: msgs };
      }),
    );

    // Format messages for AI — include BOTH sent and received so we capture all context
    const groupBlocks = groupResults
      .filter(
        (r): r is PromiseFulfilledResult<{ id: string; name: string; messages: any[] }> =>
          r.status === "fulfilled",
      )
      .map(({ value: g }) => {
        const lines = (g.messages ?? [])
          .map((m: any) => {
            // Whapi message format: from_name is the sender's display name
            const body = String(m.text?.body ?? m.body ?? m.caption ?? "").trim().slice(0, 300);
            if (!body) return null;
            const sender = m.from_me
              ? "Me"
              : (m.from_name ?? m.pushname ?? m.notifyName ?? m.author ?? "Unknown");
            return `${sender}: ${body}`;
          })
          .filter(Boolean)
          .join("\n");
        return lines ? `[GROUP: ${g.name} | ID: ${g.id}]\n${lines}` : null;
      })
      .filter(Boolean)
      .join("\n\n---\n\n");

    if (!groupBlocks) {
      console.warn("[sourcing] no message text found in any group");
      return [];
    }

    console.log("[sourcing] sending", groupBlocks.length, "chars to AI");

    // Generous AI prompt — look for ANY professional signal, not just obvious CVs
    const aiPrompt = `You are a talent sourcing AI helping a recruiter find people from WhatsApp group conversations.

Search description: "${data.description}"

INSTRUCTIONS:
- Look for ANY person who shows signs relevant to the search: mentions their job/role, company, skills, projects, or background
- Also look for people others describe ("Dan is a great frontend dev", "Sarah works at Google")
- Even partial signals count — if someone mentions "worked at" or "specializes in" that's enough
- NEVER hallucinate names. Only use names that appear in the messages
- Extract real names (first name or full name) when visible
- If the description is general (e.g. "developers"), include all tech-related mentions
- Return ONLY a valid JSON array, nothing else. Empty array [] if truly nothing relevant.

Each object in the array must have:
{
  "name": "person's name as it appears in messages",
  "matchReason": "1-2 sentences why they might match the search",
  "company": "company name if mentioned, else null",
  "role": "job title/role if mentioned, else null",
  "groupName": "the group name from the GROUP header",
  "groupId": "the group ID from the GROUP header",
  "sourceMessage": "the exact message snippet (max 100 chars) that revealed this person"
}

=== WHATSAPP GROUP CONVERSATIONS ===
${groupBlocks.slice(0, 15000)}`;

    let aiReply = "";
    try {
      aiReply = await runAI({
        systemPrompt:
          "You are a talent-sourcing assistant that extracts candidate signals from WhatsApp conversations. You output ONLY valid JSON arrays — no prose, no markdown fences, just the raw JSON array.",
        history: [],
        userMessage: aiPrompt,
        source: "sourcing",
      });
      console.log("[sourcing] AI reply length:", aiReply.length, "preview:", aiReply.slice(0, 200));
    } catch (e) {
      console.error("[sourcing] AI scan failed:", e);
      return [];
    }

    try {
      // Strip possible markdown fences
      const clean = aiReply.replace(/```json?\s*/gi, "").replace(/```/g, "").trim();
      const jsonMatch = clean.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.warn("[sourcing] AI returned no JSON array. Raw:", aiReply.slice(0, 400));
        return [];
      }
      const parsed: any[] = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];

      const results = parsed
        .filter((c) => c && typeof c.name === "string" && c.name.trim().length > 1)
        .map((c, i) => ({
          id: `candidate-${Date.now()}-${i}`,
          name: String(c.name).trim(),
          matchReason: String(c.matchReason || "Mentioned in group conversation"),
          company: c.company ? String(c.company).trim() : undefined,
          role: c.role ? String(c.role).trim() : undefined,
          groupName: String(c.groupName || ""),
          groupId: String(c.groupId || ""),
          sourceMessage: String(c.sourceMessage || "").trim().slice(0, 120),
        }));
      console.log("[sourcing] found", results.length, "candidates");
      return results;
    } catch (e) {
      console.error("[sourcing] JSON parse failed:", e, aiReply.slice(0, 500));
      return [];
    }
  });

// ---------------------------------------------------------------------------
// Server fn: list all WhatsApp groups (for the group picker UI)
// ---------------------------------------------------------------------------
export const listGroupsForSourcing = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAdmin])
  .handler(async (): Promise<Array<{ id: string; name: string }>> => {
    const { listGroups } = await import("./whapi.server");
    return listGroups();
  });
