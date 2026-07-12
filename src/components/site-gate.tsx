import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// Simple front-door password. NOTE: this is a light client-side deterrent, not
// real security — the value ships in the browser bundle. Real access control is
// still handled by Supabase Auth on the pages behind it.
const SITE_PASSWORD = "whatsbot123";
const STORAGE_KEY = "site_unlocked";

export function SiteGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<"checking" | "locked" | "unlocked">("checking");
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    setStatus(window.localStorage.getItem(STORAGE_KEY) === "1" ? "unlocked" : "locked");
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (value === SITE_PASSWORD) {
      window.localStorage.setItem(STORAGE_KEY, "1");
      setStatus("unlocked");
    } else {
      setError(true);
    }
  }

  if (status === "checking") return null;
  if (status === "unlocked") return <>{children}</>;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">🔒 Protected</CardTitle>
          <CardDescription>Enter the password to continue</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <Label htmlFor="site-pw">Password</Label>
              <Input
                id="site-pw"
                type="password"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(false);
                }}
                autoFocus
              />
              {error && <p className="text-xs text-destructive mt-1">Incorrect password</p>}
            </div>
            <Button type="submit" className="w-full">Enter</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
