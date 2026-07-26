// Honesty guard: promises of actions the bot has no machinery for must be
// detected (and rewritten by the pipeline); BACKED promises — research
// check-backs, sending things to the person in THIS chat, images — must
// never be flagged.
import { describe, expect, it } from "vitest";

import { detectsUnbackedActionPromise } from "../research";

describe("detectsUnbackedActionPromise", () => {
  it("flags promises to post/reply in groups", () => {
    expect(detectsUnbackedActionPromise("סגור, אפרסם את זה בקבוצה עוד היום")).toBe(true);
    expect(detectsUnbackedActionPromise("אין בעיה — אשלח הודעה לקבוצת המנהלים")).toBe(true);
    expect(detectsUnbackedActionPromise("מעולה, אגיב על זה בקבוצה")).toBe(true);
    expect(detectsUnbackedActionPromise("אעלה את זה בקבוצה של הקהילה")).toBe(true);
    expect(detectsUnbackedActionPromise("Sure, I'll post it in the group tomorrow")).toBe(true);
    expect(detectsUnbackedActionPromise("I'll reply in that group right away")).toBe(true);
  });

  it("flags promises to message/coordinate with OTHER people", () => {
    expect(detectsUnbackedActionPromise("אשלח לו את הפרטים עכשיו")).toBe(true);
    expect(detectsUnbackedActionPromise("אדבר עם המנהל ואחזור אליך")).toBe(true);
    expect(detectsUnbackedActionPromise("אעדכן אותו ברגע שאדע")).toBe(true);
    expect(detectsUnbackedActionPromise("I'll message him about it")).toBe(true);
    expect(detectsUnbackedActionPromise("I'll tell them you asked")).toBe(true);
  });

  it("never flags BACKED promises (research, images, this-chat sends)", () => {
    // Research check-backs — tracked by the 10-minute promise engine.
    expect(detectsUnbackedActionPromise("אבדוק ואחזור אליך עם תשובה")).toBe(false);
    expect(detectsUnbackedActionPromise("I'll check and get back to you")).toBe(false);
    // Sending to the person in THIS chat is a real ability.
    expect(detectsUnbackedActionPromise("אשלח לך את הקישור עוד רגע")).toBe(false);
    expect(detectsUnbackedActionPromise("אשלח לך את הדוח בהמשך השיחה")).toBe(false);
    // Image captions / plain replies.
    expect(detectsUnbackedActionPromise("הנה התמונה שביקשת 🦁")).toBe(false);
    expect(detectsUnbackedActionPromise('מחיר החבילה הוא 199 ש"ח לחודש')).toBe(false);
    expect(detectsUnbackedActionPromise("")).toBe(false);
  });
});
