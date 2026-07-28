// Near-duplicate detection — the deterministic net under the send-idempotency
// marker. Same URL = duplicate; heavy token overlap = duplicate; short
// greetings and genuinely different content are not.
import { describe, expect, it } from "vitest";
import { extractUrls, isNearDuplicateText, tokenJaccard } from "../dedupe";

describe("extractUrls", () => {
  it("finds URLs, strips trailing punctuation, lowercases", () => {
    expect(extractUrls("קראו כאן: https://Example.com/Post.html, שווה!")).toEqual([
      "https://example.com/post.html",
    ]);
    expect(extractUrls("בלי קישור")).toEqual([]);
  });
});

describe("isNearDuplicateText", () => {
  const url = "https://blog.glidaiproperties.com/blog/bluewaters.html";

  it("same URL → duplicate, even with completely different wording", () => {
    expect(
      isNearDuplicateText(`ניסוח ראשון על המאמר ${url}`, `something else entirely ${url}`),
    ).toBe(true);
  });

  it("reworded version of the same post → duplicate (the 2026-07-28 case)", () => {
    const reviewed =
      "השקעה ב-Bluewaters Island בדובאי מציעה תשואות שכירות מרשימות של כ-7% בשנה, עם ביקוש גבוה מתיירים ומשקיעים. האזור נהנה ממיקום מרכזי ומחירים יציבים.";
    const unreviewed =
      "השקעה ב-Bluewaters Island בדובאי מציעה תשואות שכירות של כ-7% בשנה, ביקוש גבוה מתיירים ומשקיעים, מיקום מרכזי ומחירים יציבים לאורך זמן.";
    expect(isNearDuplicateText(reviewed, unreviewed)).toBe(true);
    expect(tokenJaccard(reviewed, unreviewed)).toBeGreaterThan(0.6);
  });

  it("different content about a different topic → not a duplicate", () => {
    expect(
      isNearDuplicateText(
        "פוסט על תוכניות תשלום גמישות בדובאי ואיך בוחרים מסלול מימון נכון למשקיע",
        "מדריך על ויזת משקיע בדובאי וקבלת תושבות דרך רכישת נדל״ן בשווי מיליון דירהם",
      ),
    ).toBe(false);
  });

  it("short greetings never match on tokens", () => {
    expect(isNearDuplicateText("בוקר טוב לכולם!", "בוקר טוב לכולם :)")).toBe(false);
  });
});
