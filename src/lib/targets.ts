// Shared merge for the "send to" pickers (Send + Schedule pages).
// Combines WhatsApp groups, recent chats, and the full contact book into one
// deduplicated, searchable list.
//
// Why this exists: recent chats often carry a bare phone number as the name,
// while the contact book has the real display name. A person can also appear in
// both. We key people by phone digits so each person shows once, keep the chat
// id (the known-sendable form) when we have it, and prefer a human-readable
// name over a numeric one.

export type WhapiTarget = { id: string; name: string; isGroup: boolean };

type RawItem = { id: string; name?: string | null };
type RawChat = RawItem & { type?: string };

export type WhapiTargetsData = {
  groups?: RawItem[];
  chats?: RawChat[];
  contacts?: RawItem[];
};

const phoneKey = (id: string) => id.replace(/@.*$/, "").replace(/\D/g, "");
const looksLikeName = (name: string) =>
  !!name && !/^[\d\s+()\-]+$/.test(name.trim());

export function mergeTargets(data: WhapiTargetsData): WhapiTarget[] {
  const groups: WhapiTarget[] = (data.groups ?? [])
    .filter((g) => g.id)
    .map((g) => ({ id: g.id, name: (g.name || g.id) as string, isGroup: true }));

  const persons = new Map<string, WhapiTarget>();
  const consider = (rawId: string, rawName: string | null | undefined, isChat: boolean) => {
    if (!rawId || rawId.endsWith("@g.us")) return;
    const key = phoneKey(rawId);
    if (!key) return;
    const name = (rawName ?? "").trim();
    const cur = persons.get(key);
    if (!cur) {
      persons.set(key, { id: rawId, name: name || key, isGroup: false });
      return;
    }
    const next: WhapiTarget = { ...cur };
    if (isChat) next.id = rawId; // chat ids are the known-sendable form
    if (!looksLikeName(cur.name) && looksLikeName(name)) next.name = name;
    persons.set(key, next);
  };

  // Chats first so we retain their sendable id, then contacts to fill in real names.
  (data.chats ?? [])
    .filter((c) => c.id && !c.id.endsWith("@g.us"))
    .forEach((c) => consider(c.id, c.name, true));
  (data.contacts ?? []).forEach((c) => consider(c.id, c.name, false));

  return [...groups, ...persons.values()];
}
