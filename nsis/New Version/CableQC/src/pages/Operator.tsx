import { Construction } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Operator() {
  return (
    <div className="flex h-full flex-1 items-center justify-center bg-gradient-to-br from-background to-muted/30 p-6">
      <Card className="max-w-md border border-dashed border-border/50 bg-card/80 text-center shadow-sm backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center justify-center gap-2 text-lg font-semibold text-foreground">
            <Construction className="h-5 w-5 text-warning" />
            Operator Portal
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>This operator workspace is currently in development.</p>
          <p>Live production queues, readiness checks, and activity timelines will return soon.</p>
        </CardContent>
      </Card>
    </div>
  );
}

/* Previous implementation retained for future reference.

import { useMemo } from "react";
import { CalendarCheck, ClipboardList, Gauge, Pause, PlayCircle, ShieldAlert, Timer, Wrench } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { fetchProductionSnapshot } from "@/lib/api";
import type { ProductionSnapshot, WorkOrderSummary, WireSummary } from "@/lib/types";

type QueueStatus = "setup" | "running" | "awaiting_qc" | "paused";
const STATUS_STYLES: Record<QueueStatus, { label: string; className: string; icon: React.ComponentType<{ className?: string }> }> = {
  setup: { label: "Setting up", className: "border-primary/30 bg-primary/10 text-primary", icon: Gauge },
  running: { label: "Running", className: "border-success/30 bg-success/10 text-success", icon: PlayCircle },
  awaiting_qc: { label: "Awaiting QC", className: "border-warning/30 bg-warning/10 text-warning", icon: ShieldAlert },
  paused: { label: "Paused", className: "border-border/70 bg-muted/50 text-muted-foreground", icon: Pause },
};

export default function Operator() {
  const headerCellClass =
    "sticky top-0 z-30 bg-card/95 backdrop-blur supports-[backdrop-filter]:backdrop-blur";
  const { data } = useQuery<ProductionSnapshot>({
    queryKey: ["production-snapshot"],
    queryFn: fetchProductionSnapshot,
    refetchInterval: 15000,
  });

  const queue = useMemo(() => {
    const rows: Array<{ wire: WireSummary; order: WorkOrderSummary; status: QueueStatus }> = [];
    (data?.orders ?? []).forEach((order) => {
      order.wires.forEach((wire) => {
        let status: QueueStatus = "setup";
        if (["qc_boot", "qc_wheel", "qc_final"].includes(wire.status)) {
          status = "awaiting_qc";
        } else if (wire.status === "in_production" || wire.status === "validated") {
          status = "running";
        } else if (wire.status === "paused" || wire.status === "stopped") {
          status = "paused";
        }
        rows.push({ wire, order, status });
      });
    });
    return rows;
  }, [data]);

  const totals = useMemo(() => {
    const produced = queue.reduce((sum, row) => sum + row.wire.producedQuantity, 0);
    const required = queue.reduce((sum, row) => sum + row.wire.targetQuantity, 0);
    const efficiency = required > 0 ? Math.round((produced / required) * 100) : 0;
    const waitingQc = queue.filter((row) => row.status === "awaiting_qc").length;
    return { produced, required, efficiency, waitingQc };
  }, [queue]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4 overflow-hidden bg-gradient-to-br from-background to-muted/20 p-4 sm:p-6">
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          title="Bundles"
          value={`${totals.produced} / ${totals.required}`}
          icon={<ClipboardList className="h-4 w-4 text-primary" />}
        />
        <SummaryCard
          title="Efficiency"
          value={`${totals.efficiency}%`}
          icon={<Gauge className="h-4 w-4 text-secondary" />}
        />
        <SummaryCard
          title="Awaiting QC"
          value={totals.waitingQc}
          icon={<ShieldAlert className="h-4 w-4 text-warning" />}
        />
        <SummaryCard
          title="Maintenance"
          value="14:30"
          icon={<Wrench className="h-4 w-4 text-success" />}
        />
      </section>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
        <section className="grid min-h-0 gap-4 overflow-hidden xl:grid-cols-[2fr_1fr]">
          <Card className="flex min-h-0 flex-col border border-border/40 bg-card/80 backdrop-blur">
            <CardHeader className="flex flex-row items-center justify-between border-b border-border/30">
              <div>
                <CardTitle className="text-base font-semibold text-foreground">Production Queue</CardTitle>
                <p className="text-sm text-muted-foreground">Active wires awaiting production or quality approval</p>
              </div>
              <Badge variant="outline" className="rounded-full border-border/40 text-xs text-muted-foreground">
                Shift A • Station 3
              </Badge>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col overflow-hidden p-0">
              <ScrollArea className="h-full max-h-[60vh] w-full">
                <Table className="min-w-[720px]">
                  <TableHeader className="bg-transparent">
                    <TableRow className="border-border/30">
                      <TableHead className={cn(headerCellClass, "text-xs")}>Wire</TableHead>
                      <TableHead className={cn(headerCellClass, "text-xs")}>Order</TableHead>
                      <TableHead className={cn(headerCellClass, "text-xs")}>Status</TableHead>
                      <TableHead className={cn(headerCellClass, "text-xs")}>Progress</TableHead>
                      <TableHead className={cn(headerCellClass, "text-xs text-right")}>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {queue.map(({ wire, order, status }) => {
                      const progress =
                        wire.targetQuantity > 0 ? Math.round((wire.producedQuantity / wire.targetQuantity) * 100) : 0;
                      const statusConfig = STATUS_STYLES[status];
                      const StatusIcon = statusConfig.icon;
                      return (
                        <TableRow key={`${order.id}-${wire.id}`} className="border-border/30">
                          <TableCell className="py-3">
                            <div className="flex flex-col">
                              <span className="text-sm font-medium text-foreground">{wire.refWire}</span>
                              <span className="text-xs text-muted-foreground">{wire.marquage}</span>
                            </div>
                          </TableCell>
                          <TableCell className="py-3">
                            <div className="flex flex-col">
                              <span className="text-sm font-medium text-foreground">{order.reference}</span>
                              <span className="text-xs text-muted-foreground">{order.ofId}</span>
                            </div>
                          </TableCell>
                          <TableCell className="py-3">
                            <Badge variant="outline" className={cn("gap-1 rounded-full border px-2 py-0.5 text-xs", statusConfig.className)}>
                              <StatusIcon className="h-3 w-3" />
                              {statusConfig.label}
                            </Badge>
                          </TableCell>
                          <TableCell className="min-w-[140px] py-3">
                            <div className="flex flex-col gap-1.5">
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-muted-foreground">{wire.producedQuantity}</span>
                                <span className="text-muted-foreground">{wire.targetQuantity}</span>
                              </div>
                              <Progress value={progress} className="h-1.5" />
                            </div>
                          </TableCell>
                          <TableCell className="py-3 text-right">
                            <div className="flex justify-end gap-1.5">
                              <Button size="sm" className="h-8 gap-1.5 text-xs">
                                <PlayCircle className="h-3.5 w-3.5" />
                                Continue
                              </Button>
                              <Button variant="outline" size="icon" className="h-8 w-8">
                                <Pause className="h-3.5 w-3.5" />
                                <span className="sr-only">Pause</span>
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </ScrollArea>
            </CardContent>
          </Card>

        <Card className="border border-border/40 bg-card/80 backdrop-blur">
          <CardHeader className="border-b border-border/30">
            <CardTitle className="text-base font-semibold text-foreground">Shift Readiness</CardTitle>
            <p className="text-sm text-muted-foreground">Pre-shift checklist status</p>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 pt-6">
            <div className="space-y-2.5">
              {(data ? [
                { id: 1, label: "Safety briefing", completed: true },
                { id: 2, label: "Press calibration", completed: true },
                { id: 3, label: `${queue.length} wires loaded`, completed: queue.length > 0 },
                { id: 4, label: `${totals.waitingQc} QC pending`, completed: totals.waitingQc === 0 },
              ] : []).map((item) => (
                <label key={item.id} className="flex items-start gap-2.5 text-xs">
                  <Checkbox checked={item.completed} className="mt-0.5" />
                  <span className={cn("leading-tight text-muted-foreground", item.completed && "text-foreground line-through")}>
                    {item.label}
                  </span>
                </label>
              ))}
            </div>
            <Button variant="outline" size="sm" className="gap-2 text-xs">
              <CalendarCheck className="h-3.5 w-3.5" />
              Schedule overtime
            </Button>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card className="border border-border/40 bg-card/80 backdrop-blur">
          <CardHeader className="border-b border-border/30">
            <CardTitle className="text-base font-semibold text-foreground">Activity Timeline</CardTitle>
            <p className="text-sm text-muted-foreground">Recent events and notifications</p>
          </CardHeader>
          <CardContent className="space-y-3 pt-6">
            {(data ? [
              { id: 1, time: "Now", title: "Snapshot updated", emphasis: "success" as const },
              { id: 2, time: "—", title: `${totals.waitingQc} QC pending`, emphasis: totals.waitingQc ? "warning" as const : "normal" as const },
            ] : []).map((event) => (
              <div key={event.id} className="flex items-start gap-3">
                <div className="min-w-[48px] rounded-lg border border-border/40 bg-background/70 px-2 py-1 text-xs font-medium text-muted-foreground">
                  {event.time}
                </div>
                <div className="flex-1 rounded-lg border border-border/40 bg-background/60 p-2.5">
                  <p className={cn("text-xs font-medium", event.emphasis === "warning" && "text-warning", event.emphasis === "success" && "text-success", event.emphasis === "normal" && "text-foreground")}>
                    {event.title}
                  </p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="border border-border/40 bg-card/80 backdrop-blur">
          <CardHeader className="border-b border-border/30">
            <CardTitle className="text-base font-semibold text-foreground">Scheduled Events</CardTitle>
            <p className="text-sm text-muted-foreground">Break windows and recurring tasks</p>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5 pt-6">
            <TimerRow label="Break window" value="09:30 - 09:45" />
            <TimerRow label="Quality sweep" value="Every 45 min" />
          </CardContent>
        </Card>
      </section>
      </div>
    </div>
  );
}

function SummaryCard({
  title,
  value,
  icon,
}: {
  title: string;
  value: string | number;
  icon: React.ReactNode;
}) {
  return (
    <Card className="border border-border/40 bg-card/80 backdrop-blur">
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

function TimerRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border/40 bg-background/60 px-2.5 py-2">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <Timer className="h-3.5 w-3.5 text-primary" />
        {label}
      </span>
      <span className="text-xs font-medium text-foreground">{value}</span>
    </div>
  );
}

*/
