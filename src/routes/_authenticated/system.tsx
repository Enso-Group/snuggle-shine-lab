import { createFileRoute } from "@tanstack/react-router";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { BookOpen, Bot, FlaskConical, Gauge, UserCog, Wifi, Wrench } from "lucide-react";
import { PageHeader, PageContent } from "@/components/page-header";
import { PersonalityTab } from "@/components/system/personality-tab";
import { SimulatorTab } from "@/components/system/simulator-tab";
import { KnowledgeTab } from "@/components/system/knowledge-tab";
import { ConnectionTab } from "@/components/system/connection-tab";
import { AccessTab } from "@/components/system/access-tab";
import { UsageTab } from "@/components/system/usage-tab";

export const Route = createFileRoute("/_authenticated/system")({
  head: () => ({ meta: [{ title: "Behind the Scenes — WhatsApp Bot" }] }),
  component: SystemPage,
});

function SystemPage() {
  return (
    <div className="min-h-full">
      <PageHeader
        icon={Wrench}
        title="Behind the Scenes"
        description="Everything that configures the agent — personality, models, knowledge, connection, access and costs — in one place."
        maxWidthClass="max-w-4xl"
      />
      <PageContent maxWidthClass="max-w-4xl">
        <Tabs defaultValue="personality">
          <TabsList className="mb-4 flex h-auto flex-wrap justify-start">
            <TabsTrigger value="personality" className="gap-1.5 text-xs">
              <Bot className="size-3.5" /> Personality & Models
            </TabsTrigger>
            <TabsTrigger value="knowledge" className="gap-1.5 text-xs">
              <BookOpen className="size-3.5" /> Knowledge Base
            </TabsTrigger>
            <TabsTrigger value="simulator" className="gap-1.5 text-xs">
              <FlaskConical className="size-3.5" /> Simulator
            </TabsTrigger>
            <TabsTrigger value="connection" className="gap-1.5 text-xs">
              <Wifi className="size-3.5" /> WhatsApp Connection
            </TabsTrigger>
            <TabsTrigger value="access" className="gap-1.5 text-xs">
              <UserCog className="size-3.5" /> Users & Access
            </TabsTrigger>
            <TabsTrigger value="usage" className="gap-1.5 text-xs">
              <Gauge className="size-3.5" /> Usage & Costs
            </TabsTrigger>
          </TabsList>
          <TabsContent value="personality">
            <PersonalityTab />
          </TabsContent>
          <TabsContent value="knowledge">
            <KnowledgeTab />
          </TabsContent>
          <TabsContent value="simulator">
            <SimulatorTab />
          </TabsContent>
          <TabsContent value="connection">
            <ConnectionTab />
          </TabsContent>
          <TabsContent value="access">
            <AccessTab />
          </TabsContent>
          <TabsContent value="usage">
            <UsageTab />
          </TabsContent>
        </Tabs>
      </PageContent>
    </div>
  );
}
