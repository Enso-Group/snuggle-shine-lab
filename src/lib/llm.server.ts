// Role-based LLM layer over the Lovable AI Gateway.
//
// Pipeline stages ask for a ROLE ("strong" for reasoning/drafting, "fast" for
// classification/extraction), never a hardcoded model. Resolution order:
//   bot_settings.model_strong/model_fast  →  env LLM_STRONG_MODEL/LLM_FAST_MODEL
//   →  built-in candidate chain (newest first, known-good last).
// If the gateway rejects a model id as unknown, the next candidate is tried and
// the working one is memoized for the life of the isolate.
//
// Retries: transient failures (429/5xx/network) retry with backoff before the
// error propagates. Every call is logged to ai_usage_log with cost estimates.

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 25_000;
const RETRY_DELAYS_MS = [800, 2_500];
// An attempt with less budget than this left can't realistically complete —
// throwing the last error immediately beats starting a doomed request.
const MIN_ATTEMPT_BUDGET_MS = 3_000;

export type LLMRole = "strong" | "fast";

// Newest-first candidates; ids confirmed against the gateway catalog on
// 2026-07-20. The tail of each chain is a known-good fallback so a catalog
// change can degrade quality but never silence the bot.
const MODEL_CANDIDATES: Record<LLMRole, string[]> = {
  strong: [
    "google/gemini-3.1-pro-preview",
    "openai/gpt-5.5",
    "google/gemini-2.5-pro",
    "google/gemini-2.5-flash",
  ],
  fast: ["google/gemini-3-flash-preview", "google/gemini-2.5-flash"],
};

const workingModel = new Map<LLMRole, string>();

export type LLMToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type LLMMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: LLMToolCall[];
};

export type LLMToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type LLMModelOverrides = {
  model_strong?: string | null;
  model_fast?: string | null;
};

export type LLMCallInput = {
  role: LLMRole;
  messages: LLMMessage[];
  /** ai_usage_log source tag, e.g. "agent_intent", "agent_draft" */
  source: string;
  /** Ask for strict JSON output (also enforce it in your prompt). */
  json?: boolean;
  tools?: LLMToolDef[];
  timeoutMs?: number;
  /**
   * Wall-clock budget for the WHOLE call, across every retry and candidate
   * model. Without it, the retry ladder (timeout x attempts x candidates) can
   * run for minutes — longer than the Worker invocation lives, so the caller's
   * error handling never runs. Every attempt's timeout is clamped to the
   * remaining budget (and never started with under 3s left — the last error
   * is thrown instead), so callLLM NEVER outlives budgetMs: before the clamp,
   * an attempt started with seconds left could run a full timeoutMs past the
   * deadline and outlive the runtime's ~60s request wall (live 2026-07-24).
   */
  budgetMs?: number;
  /** Per-tenant overrides loaded from bot_settings. */
  overrides?: LLMModelOverrides;
};

export type LLMCallResult = {
  content: string;
  model: string;
  toolCalls: LLMToolCall[];
  finishReason: string | null;
};

function candidatesFor(role: LLMRole, overrides?: LLMModelOverrides): string[] {
  const configured =
    (role === "strong" ? overrides?.model_strong : overrides?.model_fast) ||
    (role === "strong" ? process.env.LLM_STRONG_MODEL : process.env.LLM_FAST_MODEL);
  const chain = [...MODEL_CANDIDATES[role]];
  const memo = workingModel.get(role);
  if (memo) chain.unshift(memo);
  if (configured) chain.unshift(configured);
  return [...new Set(chain)];
}

/**
 * The resolved candidate chain, for callers that spread ONE call's budget
 * across ticks instead of models (the posting engine rotates its starting
 * model per attempt so a degraded pinned model can't consume every attempt).
 */
export function modelCandidates(role: LLMRole, overrides?: LLMModelOverrides): string[] {
  return candidatesFor(role, overrides);
}

function isUnknownModelError(status: number, bodyText: string): boolean {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  return /model|not found|unknown|unsupported|invalid/i.test(bodyText);
}

function isTransientError(status: number): boolean {
  return status === 429 || status >= 500;
}

// Reads the WHOLE body under the abort timer — clearing the timer at
// headers-arrival would let a slow body stream run unbounded, and the
// posting engine's wall-budget math depends on callLLM never outliving its
// budget by more than one retry sleep.
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ res: Response; bodyText: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const bodyText = await res.text();
    return { res, bodyText };
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Parse a JSON object out of model output that may be wrapped in markdown
 * fences or prose. Throws if no object can be recovered.
 */
export function parseJsonLoose<T = Record<string, unknown>>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* fall through */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim()) as T;
    } catch {
      /* fall through */
    }
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1)) as T;
  }
  throw new Error(`Model did not return parseable JSON: ${trimmed.slice(0, 120)}`);
}

export async function callLLM(input: LLMCallInput): Promise<LLMCallResult> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

  const { logUsage } = await import("./usage-log.server");
  const { estimateCostUSD, providerFromModel } = await import("./ai-pricing.server");

  const models = candidatesFor(input.role, input.overrides);
  const timeoutMs = input.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const deadlineAt = input.budgetMs != null ? Date.now() + input.budgetMs : null;
  let lastError: Error = new Error("no model candidates");

  for (const model of models) {
    // response_format is dropped on retry if this gateway/model rejects it.
    let useResponseFormat = !!input.json;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      // Clamp the attempt to what's left of the budget: an unclamped attempt
      // started near the deadline runs a full timeoutMs PAST it, outliving
      // the caller's whole request so no error handling ever runs.
      let attemptTimeoutMs = timeoutMs;
      if (deadlineAt !== null) {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs < MIN_ATTEMPT_BUDGET_MS) throw lastError;
        attemptTimeoutMs = Math.min(timeoutMs, remainingMs);
      }
      const start = Date.now();
      let res: Response;
      let bodyText: string;
      try {
        ({ res, bodyText } = await fetchWithTimeout(
          GATEWAY_URL,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "Lovable-API-Key": apiKey },
            body: JSON.stringify({
              model,
              messages: input.messages,
              ...(input.tools?.length ? { tools: input.tools, tool_choice: "auto" } : {}),
              ...(useResponseFormat ? { response_format: { type: "json_object" } } : {}),
            }),
          },
          attemptTimeoutMs,
        ));
      } catch (e: unknown) {
        const err = e as Error;
        lastError = err?.name === "AbortError" ? new Error("LLM request timed out") : err;
        logUsage({
          kind: "llm",
          provider: providerFromModel(model),
          model,
          source: input.source,
          status: "error",
          duration_ms: Date.now() - start,
          error_message: String(lastError.message),
          meta: { attempt, role: input.role },
        });
        if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }

      if (!res.ok) {
        logUsage({
          kind: "llm",
          provider: providerFromModel(model),
          model,
          source: input.source,
          status: "error",
          http_status: res.status,
          duration_ms: Date.now() - start,
          error_message: bodyText.slice(0, 500),
          meta: { attempt, role: input.role },
        });
        if (useResponseFormat && res.status === 400 && /response_format/i.test(bodyText)) {
          useResponseFormat = false;
          continue; // same model, without response_format — doesn't consume a retry
        }
        if (isUnknownModelError(res.status, bodyText)) {
          lastError = new Error(`Model ${model} not available: ${bodyText.slice(0, 200)}`);
          break; // next candidate model
        }
        if (res.status === 402)
          throw new Error("Out of AI credits — add credits in Lovable settings.");
        lastError = new Error(`AI error ${res.status}: ${bodyText.slice(0, 200)}`);
        if (isTransientError(res.status) && attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw lastError;
      }

      // Same effective typing res.json() had — the shape is validated by use.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any;
      try {
        data = JSON.parse(bodyText);
      } catch {
        lastError = new Error(`AI returned unparseable JSON body: ${bodyText.slice(0, 120)}`);
        if (attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw lastError;
      }
      const usage = data.usage ?? {};
      const inTok = Number(usage.prompt_tokens ?? 0);
      const outTok = Number(usage.completion_tokens ?? 0);
      logUsage({
        kind: "llm",
        provider: providerFromModel(model),
        model,
        source: input.source,
        status: "success",
        http_status: res.status,
        duration_ms: Date.now() - start,
        prompt_tokens: inTok,
        completion_tokens: outTok,
        total_tokens: Number(usage.total_tokens ?? inTok + outTok),
        cost_usd: estimateCostUSD(model, inTok, outTok),
        meta: { role: input.role, finish_reason: data.choices?.[0]?.finish_reason },
      });

      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error("AI returned no message");
      workingModel.set(input.role, model);
      return {
        content: (msg.content ?? "").trim(),
        model,
        toolCalls: (msg.tool_calls ?? []) as LLMToolCall[],
        finishReason: data.choices?.[0]?.finish_reason ?? null,
      };
    }
  }
  throw lastError;
}
