// Persona leak detection — pure, shared by ai-brain and the agent pipeline.
// The WhatsApp persona must never out itself as an AI; prompt rules are not
// 100% reliable when users directly challenge the model, so final replies are
// scanned for leak phrases before anything is sent.

// NOTE: JS \b is ASCII-only and never matches next to Hebrew letters, so the
// Hebrew whole-word checks use explicit not-a-Hebrew-letter boundaries.
export const PERSONA_LEAK_PATTERNS: RegExp[] = [
  /מודל\s*שפה/i,
  /בינה\s*מלאכותית/i,
  /(^|[^א-ת])כמודל($|[^א-ת])/,
  /(^|[^א-ת])ה?בוט(ים)?($|[^א-ת])/,
  /אני\s+לא\s+(?:יצור|בן[\s-]*אדם|אדם)\b/i,
  /לא\s+יצור\s+חי/i,
  /עוזר\s*(?:AI|וירטואלי|דיגיטלי)/i,
  /(^|[^א-ת])כעוזר($|[^א-ת])/,
  /אומנתי|הוכשרתי|אומן\s+על\s+ידי/i,
  /אין\s+לי\s+גישה/i,
  /language\s*model/i,
  /\bas\s+an?\s+ai\b/i,
  /\bi'?m\s+an?\s+ai\b/i,
  /\bchat\s*bot\b/i,
  /trained\s+by/i,
  /\b(openai|anthropic|claude)\b/i,
];

export function leaksPersona(text: string): boolean {
  return PERSONA_LEAK_PATTERNS.some((re) => re.test(text));
}

export function stripLeakSentences(text: string): string {
  return text
    .split(/(?<=[.!?…\n])\s+/)
    .filter((s) => s.trim() && !leaksPersona(s))
    .join(" ")
    .trim();
}

/** Neutral in-character fallback when nothing usable remains after stripping. */
export const PERSONA_FALLBACK_LINE = "לא בטוח שהבנתי, מה בדיוק אתה צריך?";
