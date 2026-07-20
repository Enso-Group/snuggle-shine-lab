// Rough USD pricing per 1M tokens (input/output). Used to estimate cost; not exact billing.
type Price = { in: number; out: number };

const PRICES: Record<string, Price> = {
  "google/gemini-2.5-flash": { in: 0.075, out: 0.3 },
  "google/gemini-2.5-flash-lite": { in: 0.04, out: 0.15 },
  "google/gemini-2.5-pro": { in: 1.25, out: 5.0 },
  "google/gemini-3-flash-preview": { in: 0.1, out: 0.4 },
  "google/gemini-3.5-flash": { in: 0.15, out: 0.6 },
  "google/gemini-3.1-pro": { in: 2.0, out: 8.0 },
  "google/gemini-3.1-pro-preview": { in: 2.0, out: 8.0 },
  "google/gemini-3.1-lite": { in: 0.08, out: 0.3 },
  "openai/gpt-5.5": { in: 1.75, out: 12.0 },
  "openai/gpt-5.5-pro": { in: 18.0, out: 130.0 },
  "openai/gpt-5-nano": { in: 0.05, out: 0.4 },
  "openai/gpt-5-mini": { in: 0.25, out: 2.0 },
  "openai/gpt-5": { in: 2.5, out: 10.0 },
};

export function estimateCostUSD(model: string, inTok: number, outTok: number): number {
  const p = PRICES[model];
  if (!p) return 0;
  return +(((inTok || 0) * p.in + (outTok || 0) * p.out) / 1_000_000).toFixed(6);
}

export function providerFromModel(model: string): string {
  return model.split("/")[0] ?? "unknown";
}
