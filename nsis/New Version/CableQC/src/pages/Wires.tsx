import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, ShieldCheck, Zap } from "lucide-react";

import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import { completeQualityTest, fetchProductionSnapshot, recordWireProgress, validateWire } from "@/lib/api";
import type { ProductionSnapshot, WireIdentifier, WireStatus, WireSummary, WorkOrderSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useQualityAgent } from "@/context/QualityAgentContext";

const ACTIVE_PRODUCTION_STATUSES: WireStatus[] = ["validated", "in_production", "qc_wheel"];
const HALTED_STATUSES: WireStatus[] = ["paused", "stopped", "completed"];

function buildIdentifier(order: WorkOrderSummary, wire: WireSummary): WireIdentifier {
  return {
    workOrderId: order.id,
    refWire: wire.refWire,
    marquage: wire.marquage,
  };
}

function makeInputKey(order: WorkOrderSummary, wire: WireSummary): string {
  return `${order.id}::${wire.refWire}::${wire.marquage}`;
}

function stageLabel(stage: "boot" | "wheel" | "final"): string {
  switch (stage) {
    case "boot":
      return "Boot";
    case "wheel":
      return "Wheel";
    case "final":
      return "Final";
    default:
      return stage;
  }
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

export default function Wires() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { ensureAgent } = useQualityAgent();
  const { data, isLoading, isFetching } = useQuery<ProductionSnapshot>({
    queryKey: ["production-snapshot"],
    queryFn: fetchProductionSnapshot,
    refetchInterval: 15000,
  });
  const [productionInputs, setProductionInputs] = useState<Record<string, string>>({});

  const wiresByOrder = useMemo(() => {
    if (!data) return [] as Array<{ order: WorkOrderSummary; wires: WireSummary[] }>;
    return data.orders.map((order) => ({ order, wires: order.wires }));
  }, [data]);

  const invalidateSnapshot = (snapshot?: ProductionSnapshot) => {
    if (snapshot) {
      queryClient.setQueryData(["production-snapshot"], snapshot);
    } else {
      queryClient.invalidateQueries({ queryKey: ["production-snapshot"] });
    }
  };

  const handleError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    toast({ title: "Operation failed", description: message, variant: "destructive" });
  };

  const validateWireMutation = useMutation({
    mutationFn: validateWire,
    onSuccess: (snapshot) => {
      invalidateSnapshot(snapshot);
      toast({ title: "Wire validated", description: "The wire is ready for operator tests." });
    },
    onError: handleError,
  });

  const progressMutation = useMutation({
    mutationFn: recordWireProgress,
    onSuccess: (snapshot, variables) => {
      invalidateSnapshot(snapshot);
      if (variables?.wire) {
        const key = `${variables.wire.workOrderId}::${variables.wire.refWire}::${variables.wire.marquage}`;
        setProductionInputs((prev) => {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
      toast({ title: "Production updated", description: "Progress recorded for the selected wire." });
    },
    onError: handleError,
  });

  const qualityMutation = useMutation({
    mutationFn: completeQualityTest,
    onSuccess: (response, variables) => {
      invalidateSnapshot(response.snapshot);
      const stage = stageLabel(response.result.stage);
      toast({
        title: "Quality test completed",
        description: `${stage} test marked as complete.`,
      });
    },
    onError: handleError,
  });

  const handleValidate = (order: WorkOrderSummary, wire: WireSummary) => {
    validateWireMutation.mutate(buildIdentifier(order, wire));
  };

  const handleProgressSubmit = (order: WorkOrderSummary, wire: WireSummary) => {
    const key = makeInputKey(order, wire);
    const value = Number(productionInputs[key]);
    if (!Number.isFinite(value) || value <= 0) {
      toast({
        title: "Invalid quantity",
        description: "Enter a positive number to record production.",
        variant: "destructive",
      });
      return;
    }
    progressMutation.mutate({
      wire: buildIdentifier(order, wire),
      producedIncrement: Math.floor(value),
    });
  };

  const handleQualityComplete = async (
    order: WorkOrderSummary,
    wire: WireSummary,
    test: "boot" | "wheel" | "final",
  ) => {
    try {
      const agentId = await ensureAgent();
      qualityMutation.mutate({
        wire: buildIdentifier(order, wire),
        test,
        notes: {},
        qualityAgentId: agentId,
      });
    } catch {
      // Authentication was cancelled; do not proceed with the test.
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-6 overflow-hidden bg-gradient-to-br from-background via-background to-secondary/10 p-4 sm:p-6">
      <Card className="border border-border/60 bg-card/80 backdrop-blur">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-lg font-semibold text-foreground sm:text-xl">Wire Production Control</CardTitle>
            <p className="text-sm text-muted-foreground">
              Validate active wires, log production batches, and complete quality checkpoints throughout the production run
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className={cn("h-4 w-4", isFetching ? "animate-spin" : "opacity-60")} />
            <span>{isFetching ? "Refreshing" : "Last updated"}</span>
          </div>
        </CardHeader>
      </Card>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {isLoading ? (
          <Card className="border border-border/60 bg-card/80 backdrop-blur">
            <CardContent className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              Loading session wires...
            </CardContent>
          </Card>
        ) : wiresByOrder.length === 0 ? (
          <Card className="border border-border/60 bg-card/80 backdrop-blur">
            <CardContent className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              No wires declared yet. Configure work orders to begin production.
            </CardContent>
          </Card>
        ) : (
          <ScrollArea className="max-h-[70vh] pr-1">
            <div className="flex flex-col gap-4 pr-2">
              {wiresByOrder.map(({ order, wires }) => (
                <Card key={order.id} className="flex flex-col border border-border/60 bg-card/85 backdrop-blur">
                  <CardHeader className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="border-border/60 text-xs">
                          {order.ofId}
                        </Badge>
                        <span className="text-sm font-semibold text-foreground">{order.reference}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Quantity: {order.quantityTotal} · Bundles: {order.bundleCount}
                        {order.machineId ? " · Machine: " + order.machineId : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{order.status === "completed" ? "Order completed" : "Order progress"}</span>
                      <div className="flex min-w-[140px] items-center gap-2">
                        <Progress value={order.progressPercent} className="h-2 flex-1" />
                        <span className="font-medium text-foreground">{order.progressPercent.toFixed(0)}%</span>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-1 flex-col overflow-hidden p-0">
                    <ScrollArea className="max-h-[50vh] w-full">
                      <Table className="min-w-[900px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Wire</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="min-w-[160px]">Production</TableHead>
                      <TableHead>Quality</TableHead>
                      <TableHead className="w-[220px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                <TableBody>
                  {wires.map((wire) => {
                    const inputKey = makeInputKey(order, wire);
                    const progressValue = productionInputs[inputKey] ?? "";
                    const requiresWheel = wire.status === "qc_wheel" || (!wire.wheelTestDone && wire.wheelTestRequired);
                    const requiresFinal = wire.status === "qc_final" || (!wire.finalTestDone && wire.finalTestRequired);
                    const requiresBoot =
                      wire.status === "qc_boot" ||
                      (wire.bootTestRequired && wire.bootTestDoneCount < wire.bootTestRequiredCount);
                    const isActiveForProduction = ACTIVE_PRODUCTION_STATUSES.includes(wire.status);
                    const isHalted = HALTED_STATUSES.includes(wire.status);
                    const isNotValidated = wire.status === "not_validated";
                    const canProduce =
                      isActiveForProduction && !isHalted && !requiresBoot && !requiresFinal;

                    return (
                      <TableRow key={wire.id}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="text-sm font-medium text-foreground">{wire.refWire}</span>
                            <span className="text-xs text-muted-foreground">{wire.marquage}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={wire.status} />
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                              <span>
                                {wire.producedQuantity}/{wire.targetQuantity}
                              </span>
                              <span className="text-foreground font-medium">{wire.progressPercent.toFixed(0)}%</span>
                            </div>
                            <Progress value={wire.progressPercent} />
                          </div>
                        </TableCell>
                        <TableCell>
                          <TestBadges wire={wire} />
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1"
                              onClick={() => handleValidate(order, wire)}
                              disabled={
                                validateWireMutation.isPending ||
                                !isNotValidated
                              }
                            >
                              <ShieldCheck className="h-4 w-4" />
                              Validate
                            </Button>
                            <form
                              className="flex items-center gap-2"
                              onSubmit={(event) => {
                                event.preventDefault();
                                handleProgressSubmit(order, wire);
                              }}
                            >
                              <Input
                                type="number"
                                min={1}
                                className="h-8 w-20"
                                value={progressValue}
                                disabled={progressMutation.isPending || !canProduce}
                                onChange={(event) =>
                                  setProductionInputs((prev) => ({ ...prev, [inputKey]: event.target.value }))
                                }
                              />
                              <Button
                                type="submit"
                                size="sm"
                                variant="secondary"
                                className="gap-1"
                                disabled={progressMutation.isPending || !canProduce}
                              >
                                <Zap className="h-4 w-4" />
                                Add
                              </Button>
                            </form>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="gap-1"
                              onClick={() => handleQualityComplete(order, wire, "boot")}
                              disabled={
                                qualityMutation.isPending ||
                                !wire.bootTestRequired ||
                                wire.bootTestDoneCount >= wire.bootTestRequiredCount
                              }
                            >
                              <CheckCircle2 className="h-4 w-4" />
                              Boot
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="gap-1"
                              onClick={() => handleQualityComplete(order, wire, "wheel")}
                              disabled={
                                qualityMutation.isPending ||
                                wire.wheelTestDone ||
                                !wire.wheelTestRequired
                              }
                            >
                              <CheckCircle2 className="h-4 w-4" />
                              Wheel
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="gap-1"
                              onClick={() => handleQualityComplete(order, wire, "final")}
                              disabled={
                                qualityMutation.isPending ||
                                wire.finalTestDone ||
                                !wire.finalTestRequired
                              }
                            >
                              <CheckCircle2 className="h-4 w-4" />
                              Final
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
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
