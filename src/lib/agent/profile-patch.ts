// Validation for group-profile patches applied by the Command Center chat.
// Pure and strict: the model may only touch whitelisted fields, with the same
// bounds the dashboard form enforces. Unknown or malformed fields are dropped
// and reported so the chat can tell the user exactly what was applied.

export type ProfilePatch = Partial<{
  enabled: boolean;
  instructions: string;
  purpose: string;
  audience: string;
  tone: string;
  language: string;
  content_pillars: string[];
  posting_schedule: Array<{ day: number | null; time: string; pillar?: string; prompt?: string }>;
  rules: string[];
  forbidden_topics: string[];
  moderation: {
    enabled?: boolean;
    delete_violations?: boolean;
    warn_limit?: number;
    remove_limit?: number;
  };
  welcome: { enabled?: boolean; hint?: string };
  reply_when_mentioned: boolean;
  reply_to_questions: boolean;
  allow_reactive_posts: boolean;
  escalation_rules: string;
  kpis: string;
}>;

export type PatchResult = {
  patch: ProfilePatch;
  applied: string[];
  rejected: string[];
};

const TIME_RE = /^\d{1,2}:\d{2}$/;

function asStringArray(v: unknown, maxItems: number, maxLen: number): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.map((x) => String(x).trim()).filter((s) => s.length > 0 && s.length <= maxLen);
  return out.slice(0, maxItems);
}

function asBoundedString(v: unknown, maxLen: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 && s.length <= maxLen ? s : null;
}

/** Sanitize a raw model-proposed patch into a safe ProfilePatch. */
export function sanitizeProfilePatch(raw: unknown): PatchResult {
  const applied: string[] = [];
  const rejected: string[] = [];
  const patch: ProfilePatch = {};
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  for (const [key, value] of Object.entries(obj)) {
    switch (key) {
      case "enabled":
      case "reply_when_mentioned":
      case "reply_to_questions":
      case "allow_reactive_posts": {
        if (typeof value === "boolean") {
          patch[key] = value;
          applied.push(key);
        } else rejected.push(key);
        break;
      }
      case "instructions":
      case "escalation_rules": {
        const s = asBoundedString(value, 8000);
        if (s) {
          patch[key] = s;
          applied.push(key);
        } else rejected.push(key);
        break;
      }
      case "purpose":
      case "audience":
      case "kpis": {
        const s = asBoundedString(value, 1000);
        if (s) {
          patch[key] = s;
          applied.push(key);
        } else rejected.push(key);
        break;
      }
      case "tone": {
        const s = asBoundedString(value, 500);
        if (s) {
          patch.tone = s;
          applied.push(key);
        } else rejected.push(key);
        break;
      }
      case "language": {
        const s = asBoundedString(value, 8);
        if (s && /^[a-z]{2,3}(-[A-Za-z]{2})?$/.test(s)) {
          patch.language = s;
          applied.push(key);
        } else rejected.push(key);
        break;
      }
      case "content_pillars": {
        const arr = asStringArray(value, 20, 120);
        if (arr) {
          patch.content_pillars = arr;
          applied.push(key);
        } else rejected.push(key);
        break;
      }
      case "rules": {
        const arr = asStringArray(value, 30, 300);
        if (arr) {
          patch.rules = arr;
          applied.push(key);
        } else rejected.push(key);
        break;
      }
      case "forbidden_topics": {
        const arr = asStringArray(value, 30, 120);
        if (arr) {
          patch.forbidden_topics = arr;
          applied.push(key);
        } else rejected.push(key);
        break;
      }
      case "posting_schedule": {
        if (!Array.isArray(value)) {
          rejected.push(key);
          break;
        }
        const slots = value
          .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
          .map((s) => ({
            day:
              s.day === null || s.day === undefined
                ? null
                : Number.isInteger(Number(s.day)) && Number(s.day) >= 0 && Number(s.day) <= 6
                  ? Number(s.day)
                  : NaN,
            time: String(s.time ?? ""),
            pillar: typeof s.pillar === "string" ? s.pillar.slice(0, 120) : undefined,
            prompt: typeof s.prompt === "string" ? s.prompt.slice(0, 1000) : undefined,
          }))
          .filter((s) => {
            if (Number.isNaN(s.day) || !TIME_RE.test(s.time)) return false;
            const [hh, mm] = s.time.split(":").map(Number);
            return hh <= 23 && mm <= 59;
          })
          .slice(0, 30);
        patch.posting_schedule = slots;
        applied.push(key);
        break;
      }
      case "moderation": {
        const m = (value && typeof value === "object" ? value : null) as Record<
          string,
          unknown
        > | null;
        if (!m) {
          rejected.push(key);
          break;
        }
        const mod: NonNullable<ProfilePatch["moderation"]> = {};
        if (typeof m.enabled === "boolean") mod.enabled = m.enabled;
        if (typeof m.delete_violations === "boolean") mod.delete_violations = m.delete_violations;
        if (
          Number.isInteger(Number(m.warn_limit)) &&
          Number(m.warn_limit) >= 1 &&
          Number(m.warn_limit) <= 10
        )
          mod.warn_limit = Number(m.warn_limit);
        if (
          Number.isInteger(Number(m.remove_limit)) &&
          Number(m.remove_limit) >= 1 &&
          Number(m.remove_limit) <= 20
        )
          mod.remove_limit = Number(m.remove_limit);
        if (Object.keys(mod).length) {
          patch.moderation = mod;
          applied.push(key);
        } else rejected.push(key);
        break;
      }
      case "welcome": {
        const w = (value && typeof value === "object" ? value : null) as Record<
          string,
          unknown
        > | null;
        if (!w) {
          rejected.push(key);
          break;
        }
        const welcome: NonNullable<ProfilePatch["welcome"]> = {};
        if (typeof w.enabled === "boolean") welcome.enabled = w.enabled;
        if (typeof w.hint === "string" && w.hint.trim()) welcome.hint = w.hint.trim().slice(0, 500);
        if (Object.keys(welcome).length) {
          patch.welcome = welcome;
          applied.push(key);
        } else rejected.push(key);
        break;
      }
      default:
        rejected.push(key);
    }
  }
  return { patch, applied, rejected };
}
