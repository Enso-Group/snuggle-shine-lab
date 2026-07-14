import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";

export const Route = createFileRoute("/auth")({
  validateSearch: (s: Record<string, unknown>) => ({ next: typeof s.next === "string" ? s.next : "/" }),
  head: () => ({ meta: [{ title: "Sign in — WhatsApp Bot" }] }),
  component: AuthPage,
});

function AuthPage() {
  const nav = useNavigate();
  const { next } = useSearch({ from: "/auth" });
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) nav({ to: next || "/" });
    });
  }, []);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("Signed in successfully");
    nav({ to: next || "/" });
  }

  async function signUp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin + "/auth" },
    });
    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("Signed up! You may need to confirm your email. The first user automatically becomes the admin.");
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">WhatsApp Bot 🤖</CardTitle>
          <CardDescription>Manage your bot</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="signin">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="signin">Sign in</TabsTrigger>
              <TabsTrigger value="signup">Sign up</TabsTrigger>
            </TabsList>
            <TabsContent value="signin">
              <form onSubmit={signIn} className="space-y-4 mt-4">
                <div>
                  <Label htmlFor="e1">Email</Label>
                  <Input id="e1" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </div>
                <div>
                  <Label htmlFor="p1">Password</Label>
                  <Input id="p1" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "Signing in..." : "Sign in"}
                </Button>
              </form>
            </TabsContent>
            <TabsContent value="signup">
              <form onSubmit={signUp} className="space-y-4 mt-4">
                <div>
                  <Label htmlFor="e2">Email</Label>
                  <Input id="e2" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </div>
                <div>
                  <Label htmlFor="p2">Password (at least 6 characters)</Label>
                  <Input id="p2" type="password" minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} required />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "Signing up..." : "Sign up"}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
