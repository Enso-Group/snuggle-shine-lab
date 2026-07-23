// Pure helpers for scoping data to the connected WhatsApp account ("channel").
// No I/O — unit-tested directly. The channel is identified by the digits-only
// phone of the linked account (checkHealth().userId).

/** Digits-only phone from any WA id ("9725...@s.whatsapp.net" / "9725...:5@..." → "9725..."). */
export function normalizeChannelPhone(id: string | null | undefined): string {
  if (!id) return "";
  return String(id).split("@")[0].split(":")[0].replace(/\D/g, "");
}

/**
 * PostgREST `.or()` filter string that scopes a table to one channel while a
 * backfill is still in progress: rows already tagged with this phone, plus
 * not-yet-tagged rows (channel_phone IS NULL). Once the backfill stamps every
 * row, the NULL branch matches nothing and this behaves like an equality
 * filter. `phone` is digits-only (normalizeChannelPhone), so it is safe to
 * interpolate into the filter expression.
 */
export function channelOrFilter(phone: string): string {
  return `channel_phone.is.null,channel_phone.eq.${phone}`;
}
