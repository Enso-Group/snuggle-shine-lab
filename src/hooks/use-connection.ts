import { useQuery } from "@tanstack/react-query";
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
  const q = useQuery({
    queryKey: WA_CONNECTION_QUERY_KEY,
    queryFn: () => fn(),
    enabled: !DEMO_MODE,
    staleTime: 10_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
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
