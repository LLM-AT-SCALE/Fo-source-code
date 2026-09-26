"use client";

import {
  AlertTriangle, BarChart3, Clock, Factory, Filter, Gauge, LayoutGrid, List, PieChart, Search, Sparkles, Table, TrendingUp, Wrench,
} from "lucide-react";
import type { ChipIcon as ChipIconKey } from "@/modules/admin/lib/dashboards/prompt-chips";

/** lucide icon per chip icon key — matches what Fab AI renders above the composer. */
const CHIP_ICON_COMPONENTS: Record<ChipIconKey, React.ElementType> = {
  factory: Factory,
  clock: Clock,
  trend: TrendingUp,
  wrench: Wrench,
  funnel: Filter,
  grid: LayoutGrid,
  bars: BarChart3,
  gauge: Gauge,
  table: Table,
  alert: AlertTriangle,
  list: List,
  search: Search,
  chart: PieChart,
  spark: Sparkles,
};

export const CHIP_ICON_LABELS: Record<ChipIconKey, string> = {
  factory: "Factory",
  clock: "Clock",
  trend: "Trend",
  wrench: "Wrench",
  funnel: "Funnel",
  grid: "Grid",
  bars: "Bars",
  gauge: "Gauge",
  table: "Table",
  alert: "Alert",
  list: "List",
  search: "Search",
  chart: "Chart",
  spark: "Spark",
};

export function ChipIcon({ icon, className = "h-3.5 w-3.5" }: { icon: string; className?: string }) {
  const Cmp = (CHIP_ICON_COMPONENTS as Record<string, React.ElementType>)[icon] ?? PieChart;
  return <Cmp className={className} aria-hidden="true" />;
}
