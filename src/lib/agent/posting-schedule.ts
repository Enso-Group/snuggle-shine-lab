// Pure scheduling math for the autonomous posting engine. No I/O.
import type { PostingSlot } from "./groups.server";

export type DueSlot = {
  slot: PostingSlot;
  /** Unique per slot occurrence — enforced by a partial unique index. */
  slotKey: string;
};

const GRACE_MINUTES = 10;

/** Israel-time parts for a given instant. */
export function israelNowParts(now: Date): { dow: number; minutes: number; dateKey: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dow: dayMap[get("weekday")] ?? 0,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

function slotMinutes(time: string): number | null {
  const m = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

/**
 * Slots that are due right now (slot time within the last GRACE_MINUTES,
 * matching day). slotKey embeds the date so each occurrence fires once —
 * the DB unique index makes duplicates impossible even across isolates.
 */
export function computeDueSlots(schedule: PostingSlot[], now: Date): DueSlot[] {
  const { dow, minutes, dateKey } = israelNowParts(now);
  const due: DueSlot[] = [];
  for (const slot of schedule) {
    if (slot.day !== null && slot.day !== undefined && Number(slot.day) !== dow) continue;
    const sm = slotMinutes(slot.time);
    if (sm === null) continue;
    if (minutes - sm >= 0 && minutes - sm <= GRACE_MINUTES) {
      due.push({ slot, slotKey: `${slot.day ?? "daily"}-${slot.time}-${dateKey}` });
    }
  }
  return due;
}

/** Quick heuristic: is this group message plausibly a question for the room? */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (t.length < 8) return false;
  if (t.includes("?") || t.includes("؟")) return true;
  // NOTE: \b is ASCII-only in JS and never matches next to Hebrew letters.
  return /^(מי|מה|מתי|איפה|איך|כמה|למה|האם|אפשר|יש למישהו|מישהו יודע|מישהו מכיר)(?=\s|$)/.test(t);
}
