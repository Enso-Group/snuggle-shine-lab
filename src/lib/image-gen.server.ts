// AI image generation through the Lovable AI gateway — the SAME gateway and
// auto-provisioned LOVABLE_API_KEY the text models use; no extra key setup.
// The gateway exposes image models over the chat-completions endpoint with
// modalities:["image","text"]; the generated image comes back as a base64
// data URL on the assistant message. Video generation is NOT supported by the
// gateway (checked 2026-07-26) — this module is images only, by design.
//
// Model chain: OpenAI image models first (Itamar standardized on GPT), one
// gemini model as the emergency fallback. Unknown-model errors advance the
// chain, the working model is memoized per isolate, and every call is logged
// to ai_usage_log.
import type { MediaAttachment } from "./media";

const GATEWAY_CHAT_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const GATEWAY_IMAGES_URL = "https://ai.gateway.lovable.dev/v1/images/generations";
// Image models render slowly (10-40s is normal) — one generous attempt per
// candidate, capped so a dashboard server-fn stays inside the ~60s wall.
const REQUEST_TIMEOUT_MS = 45_000;
const BUDGET_MS = 50_000;

// Endpoint per family (confirmed by Lovable's assistant 2026-07-26):
// gemini image models take messages+modalities on chat/completions; the
// openai/gpt-image-* models exist ONLY on /v1/images/generations with the
// OpenAI shape (prompt/quality).
// ORDER IS A PRODUCT DECISION (Itamar 2026-07-28, reaffirming "only GPT"):
// OpenAI image models lead — gpt-5.5 itself is text-only, so gpt-image-2 /
// gpt-image-1-mini are the GPT-family image models. Gemini stays ONLY as the
// last-resort emergency fallback, because the DM contract ("a real image or
// a retry, never silence") outranks model preference when OpenAI is down.
const IMAGE_MODEL_CANDIDATES: Array<{ model: string; endpoint: "chat" | "images" }> = [
  { model: "openai/gpt-image-2", endpoint: "images" },
  { model: "openai/gpt-image-1-mini", endpoint: "images" },
  { model: "google/gemini-3.1-flash-image", endpoint: "chat" },
];

let workingImageModel: string | null = null;

export type GeneratedImage = {
  attachment: MediaAttachment;
  model: string;
  prompt: string;
};

function isUnknownModelError(status: number, bodyText: string): boolean {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  return /model|not found|unknown|unsupported|invalid/i.test(bodyText);
}

/**
 * Pull the generated image data URL out of a gateway response. Providers
 * differ in where they put it — checked in order:
 *  1. message.images[0].image_url.url  (Lovable's documented shape)
 *  2. message.content as an array with image_url parts
 *  3. top-level data[0].b64_json       (images-API style passthrough)
 * Exported for unit tests.
 */
export function extractImageDataUrl(raw: unknown): string | null {
  const d = raw as {
    choices?: Array<{
      message?: {
        images?: Array<{ image_url?: { url?: unknown }; url?: unknown }>;
        content?: unknown;
      };
    }>;
    data?: Array<{ b64_json?: unknown; url?: unknown }>;
  } | null;
  const msg = d?.choices?.[0]?.message;
  const fromImages = msg?.images?.[0];
  const direct = fromImages?.image_url?.url ?? fromImages?.url;
  if (typeof direct === "string" && direct.startsWith("data:image")) return direct;
  if (Array.isArray(msg?.content)) {
    for (const part of msg.content as Array<{ image_url?: { url?: unknown }; url?: unknown }>) {
      const u = part?.image_url?.url ?? part?.url;
      if (typeof u === "string" && u.startsWith("data:image")) return u;
    }
  }
  const b64 = d?.data?.[0]?.b64_json;
  if (typeof b64 === "string" && b64.length > 100) return `data:image/png;base64,${b64}`;
  return null;
}

/** data:image/png;base64,AAAA → { mime, base64 } */
export function splitDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const m = dataUrl.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!m) return null;
  return { mime: m[1], base64: m[2] };
}

/**
 * Generate one image and store it in the private media bucket. Returns the
 * ready-to-attach MediaAttachment (signed preview URL + storage_path) that
 * the existing approval/post send paths already know how to deliver.
 */
export async function generateImage(
  prompt: string,
  opts: {
    source?: string;
    timeoutMs?: number;
    budgetMs?: number;
    /**
     * openai/gpt-image-* rendering quality (images endpoint only). "medium"
     * default; the DM pipeline passes "low" — measured 2026-07-28: both GPT
     * image models exceed 20s at medium, which does not fit the DM reply's
     * slice of the ~60s request wall. Low renders in a fraction of the time.
     */
    quality?: "low" | "medium" | "high";
  } = {},
): Promise<GeneratedImage> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");
  const { logUsage } = await import("./usage-log.server");
  const source = opts.source ?? "image_gen";

  const deadlineAt = Date.now() + (opts.budgetMs ?? BUDGET_MS);
  const chain = workingImageModel
    ? [
        ...IMAGE_MODEL_CANDIDATES.filter((c) => c.model === workingImageModel),
        ...IMAGE_MODEL_CANDIDATES.filter((c) => c.model !== workingImageModel),
      ]
    : IMAGE_MODEL_CANDIDATES;
  let lastError: Error = new Error("no image model candidates");

  for (const { model, endpoint } of chain) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs < 5_000) break;
    const start = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(),
      Math.min(opts.timeoutMs ?? REQUEST_TIMEOUT_MS, remainingMs),
    );
    try {
      const res = await fetch(endpoint === "images" ? GATEWAY_IMAGES_URL : GATEWAY_CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Lovable-API-Key": apiKey },
        body: JSON.stringify(
          endpoint === "images"
            ? { model, prompt, quality: opts.quality ?? "medium" }
            : {
                model,
                messages: [{ role: "user", content: prompt }],
                modalities: ["image", "text"],
              },
        ),
        signal: ctrl.signal,
      });
      const bodyText = await res.text();
      clearTimeout(timer);

      if (!res.ok) {
        lastError = new Error(
          `Image gen error ${res.status} (${model}): ${bodyText.slice(0, 200)}`,
        );
        logUsage({
          kind: "llm",
          provider: model.split("/")[0],
          model,
          source,
          status: "error",
          http_status: res.status,
          duration_ms: Date.now() - start,
          error_message: bodyText.slice(0, 300),
        });
        if (isUnknownModelError(res.status, bodyText)) continue; // next candidate
        if (res.status === 402)
          throw new Error("Out of AI credits — add credits in Lovable settings.");
        continue; // transient — a different model is this call's only retry
      }

      let data: unknown;
      try {
        data = JSON.parse(bodyText);
      } catch {
        lastError = new Error(`Image gen returned an unparseable body (${model})`);
        continue;
      }
      const dataUrl = extractImageDataUrl(data);
      if (!dataUrl) {
        lastError = new Error(`Image gen returned no image (${model}): ${bodyText.slice(0, 150)}`);
        logUsage({
          kind: "llm",
          provider: model.split("/")[0],
          model,
          source,
          status: "error",
          duration_ms: Date.now() - start,
          error_message: lastError.message.slice(0, 300),
        });
        continue;
      }
      const split = splitDataUrl(dataUrl);
      if (!split) {
        lastError = new Error(`Image gen returned an unusable data URL (${model})`);
        continue;
      }

      logUsage({
        kind: "llm",
        provider: model.split("/")[0],
        model,
        source,
        status: "success",
        http_status: res.status,
        duration_ms: Date.now() - start,
        meta: { prompt_chars: prompt.length, bytes: Math.round(split.base64.length * 0.75) },
      });
      workingImageModel = model;

      const { uploadMediaToStorage } = await import("./media.server");
      const ext = split.mime.includes("jpeg") || split.mime.includes("jpg") ? "jpg" : "png";
      const attachment = await uploadMediaToStorage({
        filename: `ai-image.${ext}`,
        mime: split.mime,
        dataBase64: split.base64,
      });
      return { attachment, model, prompt };
    } catch (e: unknown) {
      clearTimeout(timer);
      const err = e as Error;
      if (err?.name === "AbortError") {
        lastError = new Error(`Image generation timed out (${model})`);
        logUsage({
          kind: "llm",
          provider: model.split("/")[0],
          model,
          source,
          status: "error",
          duration_ms: Date.now() - start,
          error_message: lastError.message,
        });
        continue; // try the next candidate with whatever budget remains
      }
      if (String(err?.message ?? "").startsWith("Out of AI credits")) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Have the (GPT-5.5) text model turn a manager's plain-language ask + the
 * post text into ONE strong English image prompt. Deterministic guardrails:
 * no text/letters inside the image (models garble Hebrew and it reads as
 * spam), WhatsApp-friendly composition.
 */
export async function writeImagePrompt(args: {
  postText: string;
  instruction?: string | null;
  overrides?: { model_strong?: string | null; model_fast?: string | null };
}): Promise<string> {
  const { callLLM } = await import("./llm.server");
  try {
    const res = await callLLM({
      role: "strong",
      source: "image_prompt",
      overrides: args.overrides,
      timeoutMs: 12_000,
      budgetMs: 15_000,
      messages: [
        {
          role: "system",
          content: `Write ONE image-generation prompt in English (3-5 sentences) for a social-media visual that accompanies the WhatsApp post below. Describe subject, composition, style, lighting and mood. STRICT rules: absolutely no text, letters, numbers or logos inside the image; no real people's faces; clean modern look that reads well as a small phone preview. Return ONLY the prompt text.`,
        },
        {
          role: "user",
          content: `The post:\n"""${args.postText.slice(0, 900)}"""${
            args.instruction ? `\n\nThe manager asked for: ${args.instruction.slice(0, 300)}` : ""
          }`,
        },
      ],
    });
    const prompt = res.content.trim();
    if (prompt.length >= 20) return prompt.slice(0, 1500);
  } catch {
    /* fall through to the deterministic prompt */
  }
  // Never let prompt-writing block generation — a plain fallback prompt.
  return `A clean, modern illustration for a WhatsApp community post about: ${args.postText.slice(0, 300)}. ${args.instruction ?? ""} No text or letters in the image, friendly professional style, soft colors, mobile-friendly composition.`.slice(
    0,
    1500,
  );
}
