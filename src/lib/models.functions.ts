// Model transparency — the LIVE answer to "which models does the system use,
// where?". Everything here is resolved from the running configuration
// (bot_settings overrides + the code's candidate chains), never typed by
// hand, so the dashboard can't drift from what the bot actually calls.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAdmin } from "@/integrations/supabase/admin-middleware";

export type ModelStage = {
  /** Dashboard grouping, e.g. "WhatsApp replies". */
  area: string;
  /** Human name of the stage, e.g. "Reply drafting". */
  stage: string;
  /**
   * The model chain this stage calls, in order — first is the primary,
   * the rest are automatic fallbacks.
   */
  models: string[];
  note?: string;
};

export type ModelInventory = {
  configured: { model_strong: string | null; model_fast: string | null };
  chains: { strong: string[]; fast: string[] };
  image_chain: Array<{ model: string; endpoint: string }>;
  stages: ModelStage[];
  research_tools: Array<{ name: string; configured: boolean; detail: string }>;
};

export const getModelInventory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAdmin])
  .handler(async (): Promise<ModelInventory> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { modelCandidates } = await import("@/lib/llm.server");
    const { IMAGE_MODEL_CANDIDATES } = await import("@/lib/image-gen.server");

    const { data: settings } = await supabaseAdmin
      .from("bot_settings")
      .select("model_strong, model_fast")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const overrides = {
      model_strong: settings?.model_strong ?? null,
      model_fast: settings?.model_fast ?? null,
    };
    const strong = modelCandidates("strong", overrides);
    const fast = modelCandidates("fast", overrides);
    const strongTail = strong.at(-1) ?? "";
    const imageChain = IMAGE_MODEL_CANDIDATES.map((c) => ({
      model: c.model,
      endpoint: c.endpoint,
    }));
    const imageModels = imageChain.map((c) => c.model);

    // Stage labels are code facts (each maps to a real callLLM site); the
    // MODEL lists are resolved live above.
    const stages: ModelStage[] = [
      { area: "WhatsApp replies", stage: "Intent analysis", models: fast },
      { area: "WhatsApp replies", stage: "Reply drafting", models: strong },
      { area: "WhatsApp replies", stage: "Burst consolidation", models: strong },
      { area: "WhatsApp replies", stage: "Fallback / honesty lines", models: fast },
      { area: "WhatsApp replies", stage: "Memory extraction (contact facts)", models: fast },
      {
        area: "WhatsApp replies",
        stage: "DM image generation",
        models: imageModels,
        note: 'quality "low" for speed — the reply must fit the platform time limit',
      },
      { area: "Groups", stage: "Reply gate (owned-question check)", models: fast },
      { area: "Groups", stage: "Post drafting & self-review", models: strong },
      { area: "Groups", stage: "Moderation checks", models: fast },
      { area: "Groups", stage: "Welcome messages (join events)", models: fast },
      { area: "Groups", stage: "Insights / topics read", models: fast },
      { area: "Groups", stage: "Post image generation", models: imageModels },
      { area: "Research", stage: "Promised-answer drafting", models: strong },
      {
        area: "Research",
        stage: "Cheap retry after a failed attempt",
        models: strongTail ? [strongTail] : [],
        note: "jumps to the chain tail — the reliable fast fallback",
      },
      { area: "Research", stage: "Pre-reply research drafting", models: strong },
      { area: "Dashboard", stage: 'Profile "Ask the AI about this contact"', models: strong },
      { area: "Dashboard", stage: "Command Center steering chat", models: strong },
      { area: "Dashboard", stage: "Image prompt writing", models: strong },
      { area: "Dashboard", stage: "Analytics & strategy memos", models: strong },
      { area: "WhatsApp admin chat", stage: "Management copilot (tool loop)", models: strong },
      { area: "Follow-ups", stage: "Follow-up drafting", models: strong },
    ];

    const { isTavilyConfigured } = await import("@/lib/tavily.server");
    const { isApifyConfigured } = await import("@/lib/apify-x.server");
    const { isApolloConfigured, APOLLO_SETUP_HINT } = await import("@/lib/apollo.server");
    const research_tools = [
      {
        name: "Tavily (web search + images)",
        configured: isTavilyConfigured(),
        detail: isTavilyConfigured() ? "connected" : "TAVILY_API_KEY missing",
      },
      {
        name: "Apify (X/Twitter search + media)",
        configured: isApifyConfigured(),
        detail: isApifyConfigured() ? "connected" : "APIFY_API_KEY missing",
      },
      {
        name: "Apollo (B2B people lookup)",
        configured: isApolloConfigured(),
        detail: isApolloConfigured() ? "connected" : APOLLO_SETUP_HINT,
      },
    ];

    return {
      configured: overrides,
      chains: { strong, fast },
      image_chain: imageChain,
      stages,
      research_tools,
    };
  });
