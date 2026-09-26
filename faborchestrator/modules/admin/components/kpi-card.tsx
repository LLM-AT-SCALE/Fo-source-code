import { Card, CardContent } from "@/shared/components/ui/card";
import { cn } from "@/shared/lib/utils";
import { TrendingDown, TrendingUp } from "lucide-react";

interface KpiCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ReactNode;
  /**
   * Optional period-over-period delta. `value` is a percentage; positive is
   * treated as an improvement (success color) unless `invert` is set — e.g. a
   * rise in errors should read as bad, so pass `invert`.
   */
  trend?: { value: number; label: string; invert?: boolean };
  className?: string;
}

export function KpiCard({ title, value, subtitle, icon, trend, className }: KpiCardProps) {
  const up = trend ? trend.value >= 0 : false;
  // "good" = the direction we want to color as success.
  const good = trend ? (trend.invert ? !up : up) : false;

  return (
    <Card
      className={cn(
        "admin-kpi h-full rounded-xl shadow-none",
        className
      )}
    >
      <CardContent className="flex h-full flex-col justify-between gap-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-medium text-muted-foreground">
            {title}
          </p>
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
            aria-hidden="true"
          >
            {icon}
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-3xl font-semibold leading-none tracking-tight tabular-nums">{value}</p>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
          {trend && (
            <p
              className={cn(
                "flex items-center gap-1 text-xs font-medium",
                good ? "" : "text-destructive"
              )}
              style={good ? { color: "var(--status-success-foreground)" } : undefined}
            >
              {up ? (
                <TrendingUp className="size-3.5" aria-hidden="true" />
              ) : (
                <TrendingDown className="size-3.5" aria-hidden="true" />
              )}
              <span className="tabular-nums">
                {up ? "+" : ""}
                {trend.value}%
              </span>
              <span className="text-muted-foreground">{trend.label}</span>
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
