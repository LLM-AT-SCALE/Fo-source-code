"use client";

import { Check } from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "@/shared/lib/utils";

export type WizardStep = {
  key: string;
  label: string;
  /** Optional icon shown inside the node (falls back to the step number). */
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  /** One-line "what to do here", shown under the rail for the active step. */
  hint?: string;
};

type Props = {
  steps: WizardStep[];
  /** 0-based index of the current step. */
  current: number;
  /** Highest step index the user may jump back to (<= current). */
  maxReachable: number;
  onStepClick?: (index: number) => void;
  /** When true, all navigation is frozen (e.g. after a committed load). */
  locked?: boolean;
};

export function StepProgress({ steps, current, maxReachable, onStepClick, locked = false }: Props) {
  const active = steps[current];
  return (
    <div className="flex flex-col gap-2.5">
      <ol
        className="flex w-full items-center"
        aria-label={`Step ${current + 1} of ${steps.length}: ${active?.label ?? ""}`}
      >
        {steps.map((step, i) => {
          const done = i < current;
          const isActive = i === current;
          const reachable = i <= maxReachable && !locked;
          const clickable = reachable && !!onStepClick && !isActive;
          const Icon = step.icon;
          return (
            <li
              key={step.key}
              className={cn("flex items-center", i < steps.length - 1 && "flex-1")}
            >
              <button
                type="button"
                disabled={!clickable}
                onClick={() => clickable && onStepClick?.(i)}
                aria-current={isActive ? "step" : undefined}
                title={step.label}
                className={cn(
                  "group flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm outline-none transition-colors",
                  "focus-visible:ring-2 focus-visible:ring-ring/50",
                  clickable && "hover:bg-muted",
                  !clickable && "cursor-default",
                )}
              >
                <span
                  className={cn(
                    "relative inline-flex size-9 shrink-0 items-center justify-center rounded-full border-2 transition-all",
                    done && "border-primary bg-primary text-primary-foreground",
                    isActive &&
                      "border-primary bg-primary/10 text-primary ring-4 ring-primary/15",
                    !done && !isActive && "border-border bg-background text-muted-foreground",
                  )}
                >
                  {done ? (
                    <Check className="size-5" aria-hidden />
                  ) : Icon ? (
                    <Icon className="size-5" aria-hidden />
                  ) : (
                    <span className="text-sm font-semibold">{i + 1}</span>
                  )}
                </span>
                <span className="flex min-w-0 flex-col items-start leading-tight">
                  <span
                    className={cn(
                      "text-[10px] font-medium tracking-wide uppercase",
                      isActive ? "text-primary" : "text-muted-foreground/70",
                    )}
                  >
                    Step {i + 1}
                  </span>
                  <span
                    className={cn(
                      "truncate text-sm font-medium",
                      isActive && "text-foreground",
                      done && "text-foreground",
                      !isActive && !done && "text-muted-foreground",
                    )}
                  >
                    {step.label}
                  </span>
                </span>
              </button>
              {i < steps.length - 1 && (
                <span
                  className={cn(
                    "mx-1 h-0.5 flex-1 rounded-full transition-colors sm:mx-2",
                    done ? "bg-primary" : "bg-border",
                  )}
                  aria-hidden
                />
              )}
            </li>
          );
        })}
      </ol>
      {active?.hint && (
        <p className="text-xs text-muted-foreground">{active.hint}</p>
      )}
    </div>
  );
}
