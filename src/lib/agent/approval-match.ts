// Pure matching between a group-post approval row and a queued planned post —
// used by the sweeper reconciliation that heals posts whose approval was
// decided without the planned_posts row being updated.

export type ApprovalForMatch = {
  planned_post_id?: string | null;
  target_chat_id: string;
  body: string;
  created_at: string;
};

export type QueuedPostForMatch = {
  id: string;
  group_chat_id: string;
  body: string | null;
  created_at: string;
};

/**
 * True when the approval controls this queued post. The explicit
 * planned_post_id link is authoritative when present; legacy rows fall back
 * to same group + body containment (approval body is the post text; the
 * planned body may append the poll rendered as text). An approval created
 * before the post can never be its approval — the engine always creates the
 * post row first.
 */
export function approvalMatchesPost(a: ApprovalForMatch, p: QueuedPostForMatch): boolean {
  if (a.planned_post_id) return a.planned_post_id === p.id;
  return (
    a.target_chat_id === p.group_chat_id &&
    a.created_at >= p.created_at &&
    (p.body ?? "").includes(a.body)
  );
}
