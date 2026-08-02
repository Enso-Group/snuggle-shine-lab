import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getWhatsAppConnectionStatus } from "@/lib/participants.functions";
import { DEMO_MODE, demoConnection } from "@/lib/demo";

// Shared live-connection status. All WhatsApp-dependent pages read this via the
// same query key, so it's fetched once and refetched on an interval. When the
// account is (re)connected, pages pick up the change automatically.
export const WA_CONNECTION_QUERY_KEY = ["wa-connection"] as const;

export type WaConnection = {
  connected: boolean;
  status: string | null;
  userName: string | null;
  isLoading: boolean;
  isError: boolean;
};

export function useWhatsAppConnection(): WaConnection {
  const fn = useServerFn(getWhatsAppConnectionStatus);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: WA_CONNECTION_QUERY_KEY,
    queryFn: () => fn(),
    enabled: !DEMO_MODE,
    staleTime: 10_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });

  // Account isolation, client side: the moment the linked account CHANGES
  // (connect → disconnect, or a different number), every cached dashboard
  // query is dropped — otherwise React Query keeps serving the previous
  // account's rows until each page's own interval fires.
  const accountPhone = (q.data as { accountPhone?: string | null } | undefined)?.accountPhone;
  const lastAccount = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (q.data === undefined) return; // nothing fetched yet — nothing cached to drop
    const current = accountPhone ?? null;
    if (lastAccount.current !== undefined && lastAccount.current !== current) {
      void qc.invalidateQueries({
        predicate: (query) => query.queryKey[0] !== WA_CONNECTION_QUERY_KEY[0],
      });
    }
    lastAccount.current = current;
  }, [accountPhone, q.data, qc]);
  // Demo Mode: pretend a business number is linked, without any server call.
  if (DEMO_MODE) {
    return {
      connected: true,
      status: demoConnection.status,
      userName: demoConnection.userName,
      isLoading: false,
      isError: false,
    };
  }
  return {
    connected: q.data?.connected ?? false,
    status: (q.data?.status as string | null) ?? null,
    userName: (q.data?.userName as string | null) ?? null,
    isLoading: q.isLoading,
    isError: q.isError,
  };
}
