// Canonical person identity for the people table. Whapi reports the same
// human under many spellings — bare digits, '@s.whatsapp.net', '@c.us', a
// ':<device>' suffix — and keying rows on the raw string created duplicate
// profiles. Everything that stores or looks up a person must go through
// normalizeWaId so one human maps to exactly one key.
//
// Key shapes:
//  * phone-backed ids  → digits only ("972501234567")
//  * '@lid' ids        → kept raw (WhatsApp LinkedDevice ids are numeric but
//                        NOT phone numbers; stripping the suffix would collide
//                        them with real phones)
//  * '@simulation' ids → kept raw (simulator identities, never real contacts)
//  * groups / sentinels / junk → null (never person profiles)

export function normalizeWaId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const id = String(raw);
  // 'bot'/'manual' are our own sender sentinels, not contacts.
  if (id === "bot" || id === "manual") return null;
  if (id.endsWith("@g.us")) return null;
  if (id.endsWith("@lid") || id.endsWith("@simulation")) return id;
  const digits = id.split("@")[0].split(":")[0].replace(/\D/g, "");
  // Too short to be a phone number → garbage id, not a person.
  if (digits.length < 5) return null;
  return digits;
}
