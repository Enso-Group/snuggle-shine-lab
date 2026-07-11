import { Link } from "@tanstack/react-router";
import { PlugZap } from "lucide-react";
import { Button } from "@/components/ui/button";

// Honest empty state for pages that need a live WhatsApp connection.
// Shown instead of stale/cached data when no account is connected.
export function NotConnected({
  title = "אין חשבון WhatsApp מחובר",
  description = "חבר חשבון WhatsApp כדי לראות נתונים.",
  showConnectButton = true,
  compact = false,
}: {
  title?: string;
  description?: string;
  showConnectButton?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={`flex flex-col items-center justify-center text-center px-6 ${compact ? "py-10" : "py-20"}`}>
      <div className="rounded-full bg-muted p-4 mb-4">
        <PlugZap className="size-8 text-muted-foreground" />
      </div>
      <h2 className="text-lg font-semibold mb-1">{title}</h2>
      <p className="text-muted-foreground max-w-sm mb-5">{description}</p>
      {showConnectButton && (
        <Button asChild>
          <Link to="/participants">חבר WhatsApp</Link>
        </Button>
      )}
    </div>
  );
}
