import { createFileRoute, redirect } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, PageContent } from "@/components/page-header";
import { BookOpen, Rocket, Plug, History } from "lucide-react";

export const Route = createFileRoute("/_authenticated/instructions")({
  head: () => ({ meta: [{ title: "Instructions — WhatsApp Bot" }] }),
  beforeLoad: ({ context }) => {
    if (!(context as any).isAdmin) throw redirect({ to: "/" });
  },
  component: InstructionsPage,
});

function NumberedList({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="space-y-3">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3 text-sm leading-relaxed">
          <span className="flex size-6 shrink-0 select-none items-center justify-center rounded-full bg-muted text-xs font-semibold">
            {i + 1}
          </span>
          <span className="min-w-0 pt-0.5">{item}</span>
        </li>
      ))}
    </ol>
  );
}

function InstructionsPage() {
  const webhookUrl = typeof window !== "undefined" ? `${window.location.origin}/api/public/whapi-webhook` : "";

  return (
    <div className="min-h-full">
      <PageHeader icon={BookOpen} title="Instructions" description="Setup and Whapi connection instructions" />

      <PageContent maxWidthClass="max-w-3xl">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Rocket className="size-4 text-primary" />
              How to get started?
            </CardTitle>
          </CardHeader>
          <CardContent>
            <NumberedList
              items={[
                <>
                  Go to{" "}
                  <a href="https://whapi.cloud" target="_blank" className="text-primary underline underline-offset-2">
                    whapi.cloud
                  </a>{" "}
                  and start a free trial (5 days)
                </>,
                <>Scan the QR code with your new number</>,
                <>
                  Copy the API Token and enter it on the <strong>Settings</strong> page
                </>,
                <>Set the Webhook URL in Whapi (you'll find it in Settings)</>,
                <>The bot will start replying automatically 🚀</>,
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Plug className="size-4 text-primary" />
              Whapi connection
            </CardTitle>
            <CardDescription>The token is stored securely on the server (it can't be viewed from the browser)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <NumberedList
              items={[
                <>
                  Go to{" "}
                  <a href="https://whapi.cloud" target="_blank" className="text-primary underline underline-offset-2">
                    whapi.cloud
                  </a>{" "}
                  and create a new Channel
                </>,
                <>Scan the QR code with your new number</>,
                <>
                  Copy the API Token and add it as a secret named{" "}
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">WHAPI_TOKEN</code> using the "Add secret" button
                  below
                </>,
                <>In Whapi → Settings → Webhook, enter this URL:</>,
              ]}
            />
            <div className="rounded-lg border bg-muted/40 p-3 font-mono text-xs break-all" dir="ltr">
              {webhookUrl}
            </div>
            <p className="text-xs text-muted-foreground">
              Select events: <code className="rounded bg-muted px-1.5 py-0.5">messages</code>
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <History className="size-4 text-primary" />
              Full history from WhatsApp
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-relaxed">
            <p>To see all the messages from the phone (and not only those saved in the database), enable full history and then reconnect WhatsApp.</p>
            <p>When full history is active, it starts pulling old messages only after WhatsApp is reconnected. The group updates automatically every 10 seconds.</p>
            <p className="text-muted-foreground">
              The actions (enabling full history / reconnecting) are performed on the <strong>Participants</strong> page.
            </p>
          </CardContent>
        </Card>
      </PageContent>
    </div>
  );
}
