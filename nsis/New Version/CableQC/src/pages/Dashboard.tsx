import { useMemo, useRef, useLayoutEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

import { fetchProductionSnapshot } from "@/lib/api";
import type { ProductionSnapshot, WorkOrderSummary, WireSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DepartmentCallButtons } from "@/components/DepartmentCallButtons";

function useViewportMaxHeight<T extends HTMLElement>(pad = 16) {
  const ref = useRef<T | null>(null);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const compute = () => {
      // Prefer visualViewport for mobile browser UI; fall back to window.innerHeight
      const vh = (window.visualViewport?.height ?? window.innerHeight) || 0;
      const rect = el.getBoundingClientRect();
      const available = Math.max(0, vh - rect.top - pad);
      // Add a sensible floor so the card never collapses to nothing
      setMaxHeight(Math.max(240, available));
    };

    compute();

    const supportsResizeObserver = typeof ResizeObserver === "function";
    let ro: ResizeObserver | null = null;
    if (supportsResizeObserver) {
      ro = new ResizeObserver(() => compute());
      ro.observe(document.documentElement);
      ro.observe(el);
    }

    window.addEventListener("resize", compute);
    window.addEventListener("orientationchange", compute);
    // Some mobile UIs adjust on scroll; this keeps it snappy but not noisy
    window.addEventListener("scroll", compute, { passive: true });

    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", compute);
      window.removeEventListener("orientationchange", compute);
      window.removeEventListener("scroll", compute);
    };
  }, [pad]);

  return { ref, maxHeight };
}

function SummaryCard({
  title,
  value,
  icon,
  alert,
}: {
  title: string;
  value: string;
  icon?: React.ReactNode;
  alert?: boolean;
}) {
  return (
    <Card className={cn("bg-card/80 backdrop-blur border border-border/40", alert && "border-destructive/40")}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold text-foreground">{value}</div>
      </CardContent>
    </Card>
  );
}

function TestBadges({ wire }: { wire: WireSummary }) {
  const steps: Array<{ label: string; done: boolean; required: boolean }> = [
    { label: "Boot", done: wire.bootTestDone, required: wire.bootTestRequired },
    { label: "Wheel", done: wire.wheelTestDone, required: wire.wheelTestRequired },
    { label: "Final", done: wire.finalTestDone, required: wire.finalTestRequired },
  ];

  return (
    <div className="flex flex-wrap gap-1.5 text-xs">
      {steps.map((step) => (
        <Badge
          key={step.label}
          variant="secondary"
          className={cn(
            "border-border/60",
            step.done && "bg-success/15 text-success border-success/30",
            !step.done && step.required && "bg-destructive/15 text-destructive border-destructive/30",
            !step.done && !step.required && "bg-muted/40 text-muted-foreground border-transparent",
          )}
        >
          {step.label}
        </Badge>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const { data, isLoading, isFetching } = useQuery<ProductionSnapshot>({
    queryKey: ["production-snapshot"],
    queryFn: fetchProductionSnapshot,
    refetchInterval: 15000,
  });

  const totals = data?.totals;
  const wires = useMemo(() => {
    if (!data) return [] as Array<{ order: WorkOrderSummary; wire: WireSummary }>;
    return data.orders.flatMap((order) => order.wires.map((wire) => ({ order, wire })));
  }, [data]);

  const headerCellClass = "text-xs";
  const averageProgress = totals ? totals.averageProgress.toFixed(1) + "%" : "0%";

  // Create a viewport-aware height cap for the card without assuming parent height.
  const { ref: cardShellRef, maxHeight } = useViewportMaxHeight<HTMLDivElement>(16);

  return (
    <div className="flex flex-col gap-4 bg-gradient-to-br from-background to-muted/20 p-4 sm:p-6">
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          title="Orders"
          value={totals ? totals.totalOrders.toString() : isLoading ? "--" : "0"}
          icon={<CheckCircle2 className="h-4 w-4 text-primary" />}
        />
        <SummaryCard
          title="Active"
          value={totals ? totals.activeOrders.toString() : isLoading ? "--" : "0"}
          icon={<Loader2 className={cn("h-4 w-4", isFetching ? "animate-spin text-secondary" : "text-secondary")} />}
        />
        <SummaryCard
          title="Validated"
          value={totals ? totals.validatedWires.toString() : isLoading ? "--" : "0"}
          icon={<CheckCircle2 className="h-4 w-4 text-success" />}
        />
        <SummaryCard
          title="Blocked"
          value={totals ? totals.testsBlocking.toString() : isLoading ? "--" : "0"}
          icon={<AlertTriangle className="h-4 w-4 text-destructive" />}
          alert={Boolean(totals?.testsBlocking)}
        />
      </section>

      <DepartmentCallButtons />

      {/* Wrapper that we measure; it caps height to the viewport automatically */}
      <div
        ref={cardShellRef}
        // Use maxHeight from the hook; fall back gracefully if undefined
        style={maxHeight ? { maxHeight } : undefined}
        className="overflow-hidden"
      >
        <Card className="flex h-full flex-col overflow-hidden border border-border/40 bg-card/80 backdrop-blur">
          <CardHeader className="flex flex-row items-center justify-between border-b border-border/30">
            <div>
              <CardTitle className="text-base font-semibold text-foreground">Production Overview</CardTitle>
              <p className="text-sm text-muted-foreground">Real-time status of all active wires and work orders</p>
            </div>
            <div className="flex items-center gap-2">
              <Progress value={totals?.averageProgress ?? 0} className="h-1.5 w-32" />
              <span className="text-xs font-medium text-muted-foreground">{averageProgress}</span>
            </div>
          </CardHeader>

          {/* Inside card: header is auto-height; below fills remaining CARD height */}
          <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
            {/* Desktop: fixed header table + scrollable body within the card */}
            <div className="hidden min-h-0 flex-1 lg:flex lg:flex-col">
              {/* Fixed header table (outside scroll area) */}
              <Table className="table-fixed min-w-[700px] border-separate border-spacing-0">
                <colgroup>
                  <col className="w-[20%]" />
                  <col className="w-[18%]" />
                  <col className="w-[14%]" />
                  <col className="w-[30%]" />
                  <col className="w-[18%]" />
                </colgroup>
                <TableHeader className="border-b border-border/30 bg-card/95 backdrop-blur supports-[backdrop-filter]:backdrop-blur">
                  <TableRow className="border-border/30">
                    <TableHead className={cn(headerCellClass)}>Wire</TableHead>
                    <TableHead className={cn(headerCellClass)}>Order</TableHead>
                    <TableHead className={cn(headerCellClass)}>Status</TableHead>
                    <TableHead className={cn(headerCellClass, "min-w-[120px]")}>Progress</TableHead>
                    <TableHead className={cn(headerCellClass)}>Tests</TableHead>
                  </TableRow>
                </TableHeader>
              </Table>

              {/* Rows scroll in the remaining CARD height */}
              <div className="min-h-0 flex-1 overflow-y-auto pr-2">
                <Table className="table-fixed min-w-[700px] border-separate border-spacing-0">
                  <colgroup>
                    <col className="w-[20%]" />
                    <col className="w-[18%]" />
                    <col className="w-[14%]" />
                    <col className="w-[30%]" />
                    <col className="w-[18%]" />
                  </colgroup>
                  <TableBody>
                    {isLoading ? (
                      <TableRow>
                        <TableCell colSpan={5} className="h-20 text-center text-sm text-muted-foreground">
                          Loading...
                        </TableCell>
                      </TableRow>
                    ) : wires.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="h-20 text-center text-sm text-muted-foreground">
                          No wires declared
                        </TableCell>
                      </TableRow>
                    ) : (
                      wires.map(({ order, wire }) => (
                        <TableRow key={wire.id} className="border-border/30">
                          <TableCell className="py-3">
                            <div className="flex flex-col">
                              <span className="text-sm font-medium text-foreground">{wire.refWire}</span>
                              <span className="text-xs text-muted-foreground">{wire.marquage}</span>
                            </div>
                          </TableCell>
                          <TableCell className="py-3">
                            <div className="flex flex-col">
                              <span className="text-xs font-medium text-foreground">{order.ofId}</span>
                              <span className="text-xs text-muted-foreground">{order.reference}</span>
                            </div>
                          </TableCell>
                          <TableCell className="py-3">
                            <StatusBadge status={wire.status} />
                          </TableCell>
                          <TableCell className="py-3">
                            <div className="flex flex-col gap-1.5">
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-muted-foreground">
                                  {wire.producedQuantity}/{wire.targetQuantity}
                                </span>
                                <span className="font-medium text-foreground">
                                  {wire.progressPercent.toFixed(0)}%
                                </span>
                              </div>
                              <Progress value={wire.progressPercent} className="h-1.5" />
                            </div>
                          </TableCell>
                          <TableCell className="py-3">
                            <TestBadges wire={wire} />
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>

            {/* Mobile: list fills remaining CARD height and scrolls */}
            <div className="lg:hidden min-h-0 flex-1 overflow-y-auto border-t border-border/20">
              <div className="grid gap-3 p-4">
                {isLoading ? (
                  <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading snapshot…
                  </div>
                ) : wires.length === 0 ? (
                  <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                    No wires declared
                  </div>
                ) : (
                  wires.map(({ order, wire }) => (
                    <div
                      key={`dashboard-card-${wire.id}`}
                      className="rounded-xl border border-border/50 bg-card/75 p-4 shadow-sm backdrop-blur"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex flex-col gap-1">
                          <span className="text-sm font-semibold text-foreground">{wire.refWire}</span>
                          <span className="text-xs text-muted-foreground">
                            {order.ofId} · {order.reference}
                          </span>
                        </div>
                        <StatusBadge status={wire.status} />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        <TestBadges wire={wire} />
                      </div>
                      <div className="mt-3 grid gap-2 text-xs text-muted-foreground">
                        <div className="flex items-center justify-between">
                          <span className="uppercase tracking-wide">Progress</span>
                          <span className="font-medium text-foreground">
                            {wire.producedQuantity}/{wire.targetQuantity} ({wire.progressPercent.toFixed(0)}%)
                          </span>
                        </div>
                        <Progress value={wire.progressPercent} className="h-2" />
                        <div className="flex items-center justify-between text-[0.65rem]">
                          <span>Marking</span>
                          <span className="text-foreground">{wire.marquage}</span>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
