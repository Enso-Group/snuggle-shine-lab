import { createFileRoute, redirect } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";

export const Route = createFileRoute("/_authenticated/instructions")({
  head: () => ({ meta: [{ title: "Instructions — WhatsApp Bot" }] }),
  beforeLoad: ({ context }) => {
    if (!(context as any).isAdmin) throw redirect({ to: "/" });
  },
  component: InstructionsPage,
});

function InstructionsPage() {
  const webhookUrl = typeof window !== "undefined" ? `${window.location.origin}/api/public/whapi-webhook` : "";

  return (
    <div className="p-8 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold">Instructions</h1>
        <p className="text-muted-foreground mt-1">Setup and Whapi connection instructions</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>How to get started?</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>1. Go to <a href="https://whapi.cloud" target="_blank" className="text-primary underline">whapi.cloud</a> and start a free trial (5 days)</p>
          <p>2. Scan the QR code with your new number</p>
          <p>3. Copy the API Token and enter it on the <strong>Settings</strong> page</p>
          <p>4. Set the Webhook URL in Whapi (you'll find it in Settings)</p>
          <p>5. The bot will start replying automatically 🚀</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Whapi connection</CardTitle>
          <CardDescription>The token is stored securely on the server (it can't be viewed from the browser)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertDescription className="space-y-2">
              <p><strong>Setup steps:</strong></p>
              <ol className="list-decimal pl-5 space-y-1">
                <li>Go to <a href="https://whapi.cloud" target="_blank" className="text-primary underline">whapi.cloud</a> and create a new Channel</li>
                <li>Scan the QR code with your new number</li>
                <li>Copy the API Token and add it as a secret named <code className="bg-muted px-1 rounded">WHAPI_TOKEN</code> using the "Add secret" button below</li>
                <li>In Whapi → Settings → Webhook, enter this URL:</li>
              </ol>
              <div className="mt-2 p-2 bg-muted rounded text-xs font-mono break-all" dir="ltr">{webhookUrl}</div>
              <p className="text-xs">Select events: <code>messages</code></p>
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Full history from WhatsApp</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>To see all the messages from the phone (and not only those saved in the database), enable full history and then reconnect WhatsApp.</p>
          <p>When full history is active, it starts pulling old messages only after WhatsApp is reconnected. The group updates automatically every 10 seconds.</p>
          <p className="text-muted-foreground">The actions (enabling full history / reconnecting) are performed on the <strong>Participants</strong> page.</p>
        </CardContent>
      </Card>
    </div>
  );
}
