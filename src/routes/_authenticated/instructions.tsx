import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";

export const Route = createFileRoute("/_authenticated/instructions")({
  head: () => ({ meta: [{ title: "הוראות — בוט WhatsApp" }] }),
  component: InstructionsPage,
});

function InstructionsPage() {
  const webhookUrl = typeof window !== "undefined" ? `${window.location.origin}/api/public/whapi-webhook` : "";

  return (
    <div className="p-8 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold">הוראות</h1>
        <p className="text-muted-foreground mt-1">הוראות התקנה וחיבור ל-Whapi</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>חיבור ל-Whapi</CardTitle>
          <CardDescription>הטוקן נשמר בצורה מאובטחת בשרת (לא ניתן לראות אותו דרך הדפדפן)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertDescription className="space-y-2">
              <p><strong>שלבים להגדרה:</strong></p>
              <ol className="list-decimal pr-5 space-y-1">
                <li>היכנסי ל-<a href="https://whapi.cloud" target="_blank" className="text-primary underline">whapi.cloud</a> וצרי Channel חדש</li>
                <li>סרקי QR עם המספר החדש שלך</li>
                <li>העתיקי את ה-API Token והוסיפי אותו כסוד בשם <code className="bg-muted px-1 rounded">WHAPI_TOKEN</code> דרך כפתור "הוסף סוד" למטה</li>
                <li>ב-Whapi → Settings → Webhook הזיני את הכתובת הזו:</li>
              </ol>
              <div className="mt-2 p-2 bg-muted rounded text-xs font-mono break-all" dir="ltr">{webhookUrl}</div>
              <p className="text-xs">בחרי events: <code>messages</code></p>
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}
