// Near-duplicate detection for outbound sends — pure, unit-tested. Two
// messages count as near-identical when they share a URL (same article/link
// posted twice) or when their normalized token overlap is high (same content
// reworded, e.g. a reviewed draft vs its pre-review version — the live
// 2026-07-28 double-send was exactly that pair).

const URL_RE = /https?:\/\/[^\s"'<>)]+/g;

export function extractUrls(text: string): string[] {
  return [...String(text ?? "").matchAll(URL_RE)].map((m) =>
    m[0].replace(/[.,;]+$/, "").toLowerCase(),
  );
}

/** Lowercased word tokens, URLs and punctuation stripped. */
export function dupeTokens(text: string): Set<string> {
  const cleaned = String(text ?? "")
    .replace(URL_RE, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return new Set(cleaned.split(" ").filter((t) => t.length > 1));
}

export function tokenJaccard(a: string, b: string): number {
  const ta = dupeTokens(a);
  const tb = dupeTokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Near-identical = shares any URL, or ≥60% token overlap. Short texts (under
 * 6 tokens) only match on URLs — greetings legitimately repeat.
 */
export function isNearDuplicateText(a: string, b: string): boolean {
  const urlsA = extractUrls(a);
  if (urlsA.length) {
    const urlsB = new Set(extractUrls(b));
    if (urlsA.some((u) => urlsB.has(u))) return true;
  }
  if (dupeTokens(a).size < 6 || dupeTokens(b).size < 6) return false;
  return tokenJaccard(a, b) >= 0.6;
}
