// Knowledge-base retrieval — pure lexical ranking, no I/O.
//
// The KB is a curated set of dozens-to-hundreds of short business facts, not a
// document corpus: exact ranked injection beats approximate semantic search at
// this scale and has zero external dependencies. If the whole active KB fits
// the character budget it is injected verbatim — retrieval can then never miss.

export type KBItem = {
  id: string;
  kind: string;
  title: string;
  content: string;
  url?: string | null;
};

/** Unicode-aware tokenizer: keeps Hebrew/Arabic/Cyrillic/Latin words and numbers. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter(Boolean);
}

function scoreItem(queryTokens: Set<string>, item: KBItem): number {
  let score = 0;
  for (const t of tokenize(item.title)) if (queryTokens.has(t)) score += 3;
  for (const t of tokenize(item.content)) if (queryTokens.has(t)) score += 1;
  return score;
}

export type RankOptions = { maxItems?: number; charBudget?: number };

/**
 * Pick the KB items to inject for a query. Returns all active items when they
 * fit the budget; otherwise the best-scoring items (stable order for ties).
 */
export function rankKnowledge(items: KBItem[], query: string, opts: RankOptions = {}): KBItem[] {
  const maxItems = opts.maxItems ?? 8;
  const charBudget = opts.charBudget ?? 4_000;

  const sizeOf = (i: KBItem) => i.title.length + i.content.length + (i.url?.length ?? 0);
  const totalSize = items.reduce((s, i) => s + sizeOf(i), 0);
  if (totalSize <= charBudget) return [...items];

  const queryTokens = new Set(tokenize(query));
  const scored = items
    .map((item, idx) => ({ item, idx, score: scoreItem(queryTokens, item) }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx);

  const picked: KBItem[] = [];
  let used = 0;
  for (const { item, score } of scored) {
    if (picked.length >= maxItems) break;
    // Once past the budget, only strong matches earn a slot.
    if (used + sizeOf(item) > charBudget && score < 3) continue;
    picked.push(item);
    used += sizeOf(item);
    if (used >= charBudget) break;
  }
  return picked;
}

const KIND_LABELS: Record<string, string> = {
  fact: "עובדה",
  product: "מוצר",
  price: "מחיר",
  policy: "מדיניות",
  faq: "שאלה נפוצה",
  link: "קישור",
  doc: "מסמך",
};

/** Format picked items as the prompt block the drafting stages consume. */
export function formatKnowledgeBlock(items: KBItem[]): string {
  if (!items.length) return "";
  const lines = items.map((i) => {
    const label = KIND_LABELS[i.kind] ?? i.kind;
    const url = i.url ? ` | קישור: ${i.url}` : "";
    return `• [${label}] ${i.title}: ${i.content}${url}`;
  });
  return lines.join("\n");
}
