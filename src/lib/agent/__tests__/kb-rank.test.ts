import { describe, expect, it } from "vitest";
import { formatKnowledgeBlock, rankKnowledge, tokenize, type KBItem } from "../kb-rank";

const item = (id: string, title: string, content: string, kind = "fact"): KBItem => ({
  id,
  kind,
  title,
  content,
  url: null,
});

describe("tokenize", () => {
  it("keeps Hebrew, Latin and numbers, drops punctuation and single chars", () => {
    expect(tokenize("כמה עולה חבילת פרימיום?")).toEqual(["כמה", "עולה", "חבילת", "פרימיום"]);
    expect(tokenize("Price is 250 NIS!")).toEqual(["price", "is", "250", "nis"]);
  });
});

describe("rankKnowledge", () => {
  it("returns everything when the whole KB fits the budget", () => {
    const items = [item("1", "מחיר", "250 שח"), item("2", "משלוח", "עד 3 ימי עסקים")];
    expect(rankKnowledge(items, "שאלה כלשהי")).toHaveLength(2);
  });

  it("prefers items matching the query when over budget", () => {
    const filler = Array.from({ length: 30 }, (_, i) =>
      item(`f${i}`, `נושא אחר ${i}`, "תוכן כללי ארוך מאוד ".repeat(20)),
    );
    const target = item("t", "מחיר חבילת פרימיום", "החבילה עולה 250 שח לחודש");
    const picked = rankKnowledge([...filler, target], "כמה עולה פרימיום", {
      maxItems: 5,
      charBudget: 2000,
    });
    expect(picked.map((p) => p.id)).toContain("t");
    expect(picked.length).toBeLessThanOrEqual(5);
  });

  it("weights title matches above content matches", () => {
    const a = item("a", "משלוחים", "מידע כללי על החברה");
    const b = item("b", "אודות", "יש לנו משלוחים לכל הארץ בתוספת תשלום קטנה");
    const picked = rankKnowledge([b, a], "משלוחים", { maxItems: 1, charBudget: 10 });
    expect(picked[0].id).toBe("a");
  });
});

describe("formatKnowledgeBlock", () => {
  it("labels kinds in Hebrew and appends urls", () => {
    const block = formatKnowledgeBlock([
      { id: "1", kind: "price", title: "פרימיום", content: "250 שח", url: "https://x.co/p" },
    ]);
    expect(block).toContain("[מחיר] פרימיום: 250 שח");
    expect(block).toContain("https://x.co/p");
  });

  it("returns empty string for no items", () => {
    expect(formatKnowledgeBlock([])).toBe("");
  });
});
