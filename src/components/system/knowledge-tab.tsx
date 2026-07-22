// Behind the Scenes → Knowledge Base: the only source the bot may quote
// business facts from. Ported from the former /knowledge page.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { BookOpen, Pencil, Plus, Trash2, X } from "lucide-react";
import { EmptyState } from "@/components/page-header";
import {
  deleteKnowledgeItem,
  listKnowledge,
  saveKnowledgeItem,
  setKnowledgeActive,
  type KnowledgeItem,
} from "@/lib/kb.functions";

const KIND_OPTIONS = [
  { value: "fact", label: "Fact" },
  { value: "product", label: "Product" },
  { value: "price", label: "Price" },
  { value: "policy", label: "Policy" },
  { value: "faq", label: "FAQ" },
  { value: "link", label: "Link" },
  { value: "doc", label: "Document" },
] as const;

const kindLabel = (kind: string) => KIND_OPTIONS.find((k) => k.value === kind)?.label ?? kind;

type FormState = {
  id?: string;
  kind: string;
  title: string;
  content: string;
  url: string;
};

const emptyForm: FormState = { kind: "fact", title: "", content: "", url: "" };

export function KnowledgeTab() {
  const qc = useQueryClient();
  const listFn = useServerFn(listKnowledge);
  const saveFn = useServerFn(saveKnowledgeItem);
  const toggleFn = useServerFn(setKnowledgeActive);
  const deleteFn = useServerFn(deleteKnowledgeItem);

  const [form, setForm] = useState<FormState>(emptyForm);

  const { data: items = [] } = useQuery({
    queryKey: ["knowledge-base"],
    queryFn: () => listFn(),
    refetchInterval: 30000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["knowledge-base"] });

  const save = useMutation({
    mutationFn: (f: FormState) =>
      saveFn({
        data: {
          id: f.id,
          kind: f.kind as KnowledgeItem["kind"] & FormState["kind"],
          title: f.title,
          content: f.content,
          url: f.url || "",
        },
      }),
    onSuccess: () => {
      invalidate();
      setForm(emptyForm);
      toast.success("Knowledge saved — the bot uses it immediately");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = useMutation({
    mutationFn: (args: { id: string; active: boolean }) => toggleFn({ data: args }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => {
      invalidate();
      toast.success("Item deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const busy = save.isPending || toggle.isPending || remove.isPending;
  const editing = !!form.id;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim() || !form.content.trim()) return;
    save.mutate(form);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          The only source the bot may quote business facts from — prices, policies, products, links.
          Anything not here, it says it will check.
        </p>
        <Badge variant="secondary" className="gap-1.5 font-normal">
          <BookOpen className="size-3" />
          {items.filter((i) => i.active).length} active / {items.length}
        </Badge>
      </div>

      <Card>
        <CardContent className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              {editing ? (
                <Pencil className="size-4 text-primary" />
              ) : (
                <Plus className="size-4 text-primary" />
              )}
              <h3 className="text-sm font-semibold">{editing ? "Edit item" : "Add knowledge"}</h3>
            </div>
            {editing && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={() => setForm(emptyForm)}
              >
                <X className="size-3.5" /> Cancel edit
              </Button>
            )}
          </div>
          <form onSubmit={submit} className="space-y-2">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select value={form.kind} onValueChange={(kind) => setForm((f) => ({ ...f, kind }))}>
                <SelectTrigger className="sm:w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KIND_OPTIONS.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                placeholder="Title — e.g. Premium plan price"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                dir="auto"
                className="sm:flex-1"
              />
            </div>
            <Textarea
              placeholder="The content itself — what the bot is allowed to tell customers. Write it in the language your customers use."
              value={form.content}
              onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
              dir="auto"
              rows={3}
            />
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                placeholder="https:// related link (optional)"
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                dir="ltr"
                className="sm:flex-1"
              />
              <Button
                type="submit"
                disabled={busy || !form.title.trim() || !form.content.trim()}
                className="gap-2"
              >
                <Plus className="size-4" />
                {editing ? "Save changes" : "Add to knowledge base"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {items.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={BookOpen}
              title="The knowledge base is empty"
              description="Until you add items, the bot will not state any specific prices, policies or links — it will offer to check and get back."
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="divide-y p-0">
            {items.map((item) => (
              <div
                key={item.id}
                className={`flex items-start gap-3 p-4 ${item.active ? "" : "opacity-50"}`}
              >
                <Badge variant="outline" className="mt-0.5 shrink-0 text-xs">
                  {kindLabel(item.kind)}
                </Badge>
                <div className="min-w-0 flex-1" dir="auto">
                  <p className="text-sm font-medium">{item.title}</p>
                  <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">
                    {item.content}
                  </p>
                  {item.url && (
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 block truncate text-xs text-primary underline-offset-2 hover:underline"
                      dir="ltr"
                    >
                      {item.url}
                    </a>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Switch
                    checked={item.active}
                    onCheckedChange={(active) => toggle.mutate({ id: item.id, active })}
                    disabled={busy}
                    title={item.active ? "Active — the bot uses this" : "Inactive"}
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    title="Edit"
                    onClick={() =>
                      setForm({
                        id: item.id,
                        kind: item.kind,
                        title: item.title,
                        content: item.content,
                        url: item.url ?? "",
                      })
                    }
                    disabled={busy}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8 text-destructive"
                    title="Delete"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete "${item.title}"? The bot stops using it immediately.`,
                        )
                      )
                        remove.mutate(item.id);
                    }}
                    disabled={busy}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
