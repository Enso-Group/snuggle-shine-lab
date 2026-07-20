// Knowledge-base loading + the grounding rules that keep the bot honest.
// Degrades gracefully: no KB table / no items → empty block + strict
// "don't invent" rule, matching pre-Phase-2 behavior but safer.
import { formatKnowledgeBlock, rankKnowledge, type KBItem } from "./kb-rank";
import type { Supa } from "./types";

export type KnowledgeContext = { block: string; count: number };

export async function loadKnowledge(supabase: Supa, query: string): Promise<KnowledgeContext> {
  try {
    const { data, error } = await supabase
      .from("knowledge_base")
      .select("id, kind, title, content, url")
      .eq("active", true)
      .order("updated_at", { ascending: false })
      .limit(300);
    if (error) {
      console.warn("[kb] load failed (continuing without KB):", error.message);
      return { block: "", count: 0 };
    }
    const items = (data ?? []) as KBItem[];
    if (!items.length) return { block: "", count: 0 };
    const picked = rankKnowledge(items, query);
    return { block: formatKnowledgeBlock(picked), count: picked.length };
  } catch (e) {
    console.warn("[kb] unexpected failure (continuing without KB):", e);
    return { block: "", count: 0 };
  }
}

/**
 * Grounding rules appended to the draft prompt. The KB is the only permitted
 * source for business facts; everything else is "I'll check and get back to
 * you", which the intent stage can escalate.
 */
export function buildGroundingRules(kb: KnowledgeContext): string {
  if (kb.count > 0) {
    return `

מאגר הידע העסקי (המקור המאומת היחיד לעובדות עסקיות):
${kb.block}

כללי אמת מחייבים:
- מחירים, מדיניות, מוצרים, קישורים ופרטים עסקיים — אך ורק מתוך מאגר הידע שלמעלה. אסור להמציא או להשלים מהזיכרון.
- אם התשובה העובדתית לא נמצאת במאגר — אמור בכנות שתבדוק ותחזור עם תשובה, אל תנחש.`;
  }
  return `

כללי אמת מחייבים:
- אין כרגע מאגר ידע עסקי זמין. אסור לציין מחירים, מדיניות, מבצעים או קישורים ספציפיים.
- לשאלה עובדתית עסקית — אמור בכנות שתבדוק ותחזור עם תשובה מסודרת.`;
}
