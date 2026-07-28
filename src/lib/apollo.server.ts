// Apollo.io people search — the bot's third research source, next to Tavily
// (web) and Apify (X/Twitter). Used by the profile "Ask the AI" chat and the
// research engine to enrich a CONTACT: role, company, LinkedIn, work email.
//
// Discipline mirrors tavily.server.ts / apify-x.server.ts: one bounded
// attempt, the whole call never outlives budgetMs, and every call is logged
// to ai_usage_log. Resilience lives in the CALLER: an Apollo failure never
// fails a research attempt — the other sources still answer.
//
// Configure with the APOLLO_API_KEY secret (Lovable Settings → Secrets;
// .env.local locally). Endpoint per Apollo's docs (verified 2026-07-28):
// POST https://api.apollo.io/api/v1/mixed_people/api_search with the key in
// the `x-api-key` header. The old guessed path (/v1/mixed_people_search)
// does not exist — it 404'd in production. NOTES from the docs: this search
// endpoint needs a MASTER API key, consumes no credits, and never returns
// emails/phone numbers (those need the separate enrichment endpoints).

export const APOLLO_SEARCH_URL = "https://api.apollo.io/api/v1/mixed_people/api_search";
const REQUEST_TIMEOUT_MS = 12_000;

export type ApolloPerson = {
  name: string;
  title: string | null;
  company: string | null;
  linkedin_url: string | null;
  email: string | null;
  location: string | null;
};

export type ApolloSearchOutcome = { people: ApolloPerson[] };

export function isApolloConfigured(): boolean {
  return !!process.env.APOLLO_API_KEY;
}

/**
 * One-line, human-readable answer to "what's missing to connect Apollo" —
 * shown to the manager when a research surface reports its tool status.
 */
export const APOLLO_SETUP_HINT =
  "Apollo is not connected: set the APOLLO_API_KEY secret (Lovable → Settings → Secrets; create a MASTER API key at app.apollo.io → Settings → Integrations → API — the people-search endpoint rejects non-master keys). The endpoint (api.apollo.io/api/v1/mixed_people/api_search) is already wired in.";

/** Raw Apollo person — only the fields we read. */
type RawApolloPerson = {
  name?: unknown;
  title?: unknown;
  email?: unknown;
  personal_emails?: unknown;
  linkedin_url?: unknown;
  city?: unknown;
  country?: unknown;
  organization?: { name?: unknown } | null;
};

/** Pure mapper — exported for unit tests. */
export function parseApolloPeople(raw: unknown): ApolloPerson[] {
  const people = (raw as { people?: unknown })?.people;
  if (!Array.isArray(people)) return [];
  return (people as RawApolloPerson[])
    .map((p) => ({
      name: String(p.name ?? "").trim(),
      title: p.title ? String(p.title).slice(0, 200) : null,
      company: p.organization?.name ? String(p.organization.name).slice(0, 200) : null,
      linkedin_url: p.linkedin_url ? String(p.linkedin_url) : null,
      email:
        typeof p.email === "string" && p.email.includes("@")
          ? p.email
          : Array.isArray(p.personal_emails) && typeof p.personal_emails[0] === "string"
            ? p.personal_emails[0]
            : null,
      location: [p.city, p.country].filter((x) => typeof x === "string" && x).join(", ") || null,
    }))
    .filter((p) => p.name);
}

export async function apolloPeopleSearch(
  args: { name: string; company?: string | null; keywords?: string | null },
  opts: { maxResults?: number; timeoutMs?: number } = {},
): Promise<ApolloSearchOutcome> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) throw new Error("APOLLO_API_KEY not configured");

  const { logUsage } = await import("./usage-log.server");
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(APOLLO_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        q_keywords: [args.name, args.company, args.keywords]
          .filter(Boolean)
          .join(" ")
          .slice(0, 200),
        person_names: [args.name.slice(0, 100)],
        ...(args.company ? { organization_names: [args.company.slice(0, 100)] } : {}),
        page: 1,
        per_page: Math.min(Math.max(opts.maxResults ?? 3, 1), 10),
      }),
      signal: ctrl.signal,
    });
    const bodyText = await res.text();
    clearTimeout(timer);

    if (!res.ok) {
      const err = new Error(`Apollo search error ${res.status}: ${bodyText.slice(0, 200)}`);
      logUsage({
        kind: "tool",
        tool_name: "apollo_people_search",
        source: "agent_research",
        status: "error",
        http_status: res.status,
        duration_ms: Date.now() - start,
        error_message: String(err.message).slice(0, 300),
        meta: { name_chars: args.name.length },
      });
      throw err;
    }

    let data: unknown;
    try {
      data = JSON.parse(bodyText);
    } catch {
      const err = new Error(
        `Apollo returned an unparseable body (HTTP 200): ${bodyText.slice(0, 120)}`,
      );
      logUsage({
        kind: "tool",
        tool_name: "apollo_people_search",
        source: "agent_research",
        status: "error",
        http_status: 200,
        duration_ms: Date.now() - start,
        error_message: String(err.message).slice(0, 300),
        meta: { name_chars: args.name.length },
      });
      throw err;
    }

    const people = parseApolloPeople(data);
    logUsage({
      kind: "tool",
      tool_name: "apollo_people_search",
      source: "agent_research",
      status: "success",
      http_status: res.status,
      duration_ms: Date.now() - start,
      meta: { name_chars: args.name.length, result_count: people.length },
    });
    return { people };
  } catch (e: unknown) {
    clearTimeout(timer);
    const err = e as Error;
    if (err?.name === "AbortError") {
      const timeoutErr = new Error("Apollo search timed out");
      logUsage({
        kind: "tool",
        tool_name: "apollo_people_search",
        source: "agent_research",
        status: "error",
        duration_ms: Date.now() - start,
        error_message: timeoutErr.message,
        meta: { name_chars: args.name.length },
      });
      throw timeoutErr;
    }
    throw err;
  }
}

/** Compact prompt block for Apollo results — "" when there is nothing to show. */
export function buildApolloBlock(outcome: ApolloSearchOutcome | null): string {
  if (!outcome?.people.length) return "";
  const rows = outcome.people
    .slice(0, 3)
    .map(
      (p) =>
        `- ${p.name}${p.title ? ` · ${p.title}` : ""}${p.company ? ` @ ${p.company}` : ""}${p.location ? ` · ${p.location}` : ""}${p.linkedin_url ? `\n  ${p.linkedin_url}` : ""}${p.email ? `\n  ${p.email}` : ""}`,
    )
    .join("\n");
  return `

APOLLO B2B PROFILE MATCHES (live lookup — verify the match is the same person before relying on it):
${rows}`;
}
