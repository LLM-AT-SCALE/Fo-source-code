"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/shared/components/ui/button";
import { Checkbox } from "@/shared/components/ui/checkbox";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { Textarea } from "@/shared/components/ui/textarea";
import { toast } from "sonner";
import { Loader2, Plus, X } from "lucide-react";
import {
  appendChipIds,
  CHIP_ICONS,
  DEFAULT_CHIP_ICON,
  defaultChipIds,
  type ChipIcon as ChipIconKey,
  type ClientChip,
} from "@/modules/admin/lib/dashboards/prompt-chips";
import { ChipIcon, CHIP_ICON_LABELS } from "@/modules/admin/components/chip-icon";

const selectCls =
  "flex h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring";

/**
 * "Prompt chips" for a role: the shared library as ONE flat checklist (library
 * order, every chip selectable for every role), the selected chips previewed as
 * the pill strip Fab AI users see, and an inline "New chip" form.
 *
 * The only automatic behaviour: ticking Dashboard Scheduling while this is
 * mounted appends the library's default chips to the current selection.
 * Nothing is pre-selected on a new role and unticking removes nothing; the
 * admin adds and removes chips manually at any time.
 */
export function RoleChipsSection({
  selectedIds,
  onChange,
  token,
  hasDashboards,
}: {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  token: string | null;
  hasDashboards: boolean;
}) {
  const [chips, setChips] = useState<ClientChip[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [label, setLabel] = useState("");
  const [blurb, setBlurb] = useState("");
  const [prompt, setPrompt] = useState("");
  const [icon, setIcon] = useState<ChipIconKey>(DEFAULT_CHIP_ICON);
  const [adding, setAdding] = useState(false);

  // Latest props for the effect below without re-running it on every change.
  const selectedRef = useRef(selectedIds);
  selectedRef.current = selectedIds;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Permission state the last time the rule ran (mount value until the library loads).
  const prevDashboardsRef = useRef(hasDashboards);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch("/api/admin/prompt-chips", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { chips?: ClientChip[] } | null) => {
        if (!cancelled) setChips((j?.chips ?? []).filter((c) => c.isActive));
      })
      .catch(() => {
        if (!cancelled) setChips([]);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Ticking Dashboard Scheduling appends the default chips; unticking does nothing.
  useEffect(() => {
    if (!chips) return;
    if (prevDashboardsRef.current !== hasDashboards) {
      if (hasDashboards) {
        const next = appendChipIds(selectedRef.current, defaultChipIds(chips, ["dashboards"]));
        if (next.length !== selectedRef.current.length) onChangeRef.current(next);
      }
      prevDashboardsRef.current = hasDashboards;
    }
  }, [chips, hasDashboards]);

  const toggle = (id: string) => onChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);

  const addChip = async () => {
    if (!label.trim() || !prompt.trim()) return;
    setAdding(true);
    try {
      const res = await fetch("/api/admin/prompt-chips", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim(), blurb: blurb.trim(), prompt: prompt.trim(), icon }),
      });
      const data = (await res.json().catch(() => ({}))) as ClientChip & { error?: string };
      if (!res.ok) {
        toast.error(data.error || "Could not create the chip");
        return;
      }
      setChips((prev) => [...(prev ?? []), data]);
      onChange([...selectedIds, data.id]);
      setLabel("");
      setBlurb("");
      setPrompt("");
      setIcon(DEFAULT_CHIP_ICON);
      setShowNew(false);
      toast.success(`Chip "${data.label}" added`);
    } catch {
      toast.error("Could not create the chip");
    } finally {
      setAdding(false);
    }
  };

  const byId = new Map((chips ?? []).map((c) => [c.id, c]));
  const selected = selectedIds.map((id) => byId.get(id)).filter((c): c is ClientChip => !!c);

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
      <div>
        <p className="text-sm font-medium">Prompt chips</p>
        <p className="text-xs text-muted-foreground">Shortcut prompts shown above the chat composer for users in this role.</p>
      </div>

      {/* Preview strip — what users see */}
      <div className="flex flex-wrap gap-1.5">
        {selected.length === 0 ? (
          <span className="text-xs text-muted-foreground">No chips selected.</span>
        ) : (
          selected.map((c) => (
            <span key={c.id} title={c.prompt} className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs font-medium">
              <ChipIcon icon={c.icon} className="h-3.5 w-3.5 text-primary" />
              {c.label}
              <button type="button" onClick={() => toggle(c.id)} aria-label={`Remove ${c.label}`} className="text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          ))
        )}
      </div>

      {/* Library checklist — one flat list in library order */}
      {chips === null ? (
        <div className="h-8 animate-pulse rounded-md bg-muted" />
      ) : chips.length === 0 ? (
        <p className="text-xs text-muted-foreground">The chip library is empty. Add one below.</p>
      ) : (
        <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border bg-background p-2">
          {chips.map((c) => (
            <label key={c.id} title={c.prompt} className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted/50">
              <Checkbox className="mt-0.5" checked={selectedIds.includes(c.id)} onCheckedChange={() => toggle(c.id)} />
              <ChipIcon icon={c.icon} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="min-w-0">
                <span className="font-medium">{c.label}</span>
                {c.isDefault && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">default</span>}
                {c.blurb && <span className="block truncate text-xs text-muted-foreground">{c.blurb}</span>}
              </span>
            </label>
          ))}
        </div>
      )}

      {/* New chip */}
      {showNew ? (
        <div className="space-y-2 rounded-md border bg-background p-3">
          <p className="text-xs font-medium">New chip</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
            <div className="space-y-1">
              <Label htmlFor="chip-label" className="text-xs">Label</Label>
              <Input id="chip-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="e.g. Scrap Pareto" className="h-9" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="chip-icon" className="text-xs">Icon</Label>
              <div className="flex items-center gap-2">
                <ChipIcon icon={icon} className="h-4 w-4 text-primary" />
                <select id="chip-icon" className={selectCls} value={icon} onChange={(e) => setIcon(e.target.value as ChipIconKey)}>
                  {CHIP_ICONS.map((k) => (
                    <option key={k} value={k}>{CHIP_ICON_LABELS[k]}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="chip-blurb" className="text-xs">Blurb (optional)</Label>
            <Input id="chip-blurb" value={blurb} onChange={(e) => setBlurb(e.target.value)} maxLength={160} placeholder="One line shown under the label" className="h-9" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="chip-prompt" className="text-xs">Prompt</Label>
            <Textarea id="chip-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={2000} placeholder="The message sent to chat when the user clicks the chip…" className="min-h-20 text-sm" />
            <p className="text-[11px] text-muted-foreground">{prompt.length}/2000</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setShowNew(false)} disabled={adding}>Cancel</Button>
            <Button type="button" size="sm" onClick={addChip} disabled={adding || !label.trim() || !prompt.trim()}>
              {adding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="mr-2 h-4 w-4" aria-hidden="true" />}
              Add chip
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => setShowNew(true)}>
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" /> New chip
        </Button>
      )}
    </div>
  );
}
