import { useMemo, type ReactNode, useRef, useLayoutEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";

import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/use-toast";
import {
  fetchProductionSnapshot,
  finalizeWireProduction,
  type CompleteQualityTestResponse,
  type QualityTestResultPayload,
  type QualityTestType,
} from "@/lib/api";
import type { ProductionSnapshot, WireIdentifier, WireSummary, WorkOrderSummary, WireStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAppFlow } from "@/context/AppFlowContext";
import { QualityTestDialog } from "@/components/quality/QualityTestDialog";
import { QualityActionsDialog } from "@/components/quality/QualityActionsDialog";
import { QualityTestResultsDialog } from "@/components/quality/QualityTestResultsDialog";
import { useQualityAgent } from "@/context/QualityAgentContext";
import { DepartmentCallButtons } from "@/components/DepartmentCallButtons";

type QualityTaskAction = "test" | "validate";

type FilterKey = "wireReference" | "marking" | "color" | "section" | "cosse";

type QualityTask = {
  id: string;
  stage: QualityTestType;
  order: WorkOrderSummary;
  wire: WireSummary;
  label: string;
  description: string;
  action: QualityTaskAction;
};

const FILTER_LABELS: Record<FilterKey, string> = {
  wireReference: "Wire Reference",
  marking: "Marking",
  color: "Color",
  section: "Section",
  cosse: "Cosse",
};

const OPERATOR_TEST_COMPLETE_STATUSES: WireStatus[] = [
  "qc_boot",
  "qc_wheel",
  "qc_final",
  "stopped",
  "completed",
];

function buildIdentifier(order: WorkOrderSummary, wire: WireSummary): WireIdentifier {
  return {
    workOrderId: order.id,
    refWire: wire.refWire,
    marquage: wire.marquage,
  };
}

function makeWireKey(order: WorkOrderSummary, wire: WireSummary): string {
  return `${order.id}::${wire.id}`;
}

function hasCompletedRequiredQuality(wire: WireSummary): boolean {
  const bootComplete =
    !wire.bootTestRequired || wire.bootTestDoneCount >= wire.bootTestRequiredCount;
  const wheelComplete = !wire.wheelTestRequired || wire.wheelTestDone;
  const finalComplete = !wire.finalTestRequired || wire.finalTestDone;
  return bootComplete && wheelComplete && finalComplete;
}

function isReadyForValidation(wire: WireSummary): boolean {
  const quantitySatisfied = wire.targetQuantity <= 0 || wire.producedQuantity >= wire.targetQuantity;
  return hasCompletedRequiredQuality(wire) && quantitySatisfied && wire.status !== "completed";
}

function stageLabel(stage: QualityTestType): string {
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

function formatColor(wire: WireSummary): string {
  const parts = [wire.colorPrimary, wire.colorSecondary].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  if (parts.length === 0) return "Not specified";
  return parts.join(" / ");
}

function formatSection(wire: WireSummary): string {
  if (wire.section === null || wire.section === undefined) return "—";
  return `${wire.section.toFixed(2)} mm²`;
}

function buildQualityQueue(snapshot?: ProductionSnapshot | null): QualityTask[] {
  if (!snapshot) return [];
  const tasks: QualityTask[] = [];

  snapshot.orders.forEach((order) => {
    order.wires.forEach((wire) => {
      const bootPending = wire.bootTestRequired && wire.bootTestDoneCount < wire.bootTestRequiredCount;
      const wheelPending = wire.wheelTestRequired && !wire.wheelTestDone;
      const finalPending = wire.finalTestRequired && !wire.finalTestDone;

      if (bootPending) {
        tasks.push({
          id: `${order.id}-${wire.id}-boot`,
          stage: "boot",
          order,
          wire,
          label: `Boot test (${wire.bootTestDoneCount}/${wire.bootTestRequiredCount})`,
          description: "Verify the initial boot sample before production resumes.",
          action: "test",
        });
      }
      if (wire.wheelTestRequired && !wire.wheelTestDone && !bootPending) {
        tasks.push({
          id: `${order.id}-${wire.id}-wheel`,
          stage: "wheel",
          order,
          wire,
          label: "Wheel test",
          description: "Perform the 50% quality validation.",
          action: "test",
        });
      }
      if (finalPending && !bootPending && !wheelPending) {
        tasks.push({
          id: `${order.id}-${wire.id}-final`,
          stage: "final",
          order,
          wire,
          label: "Final test",
          description: "Complete the closing inspection before delivery.",
          action: "test",
        });
      }

      const awaitingValidation =
        !bootPending && !wheelPending && !finalPending && isReadyForValidation(wire);
      if (awaitingValidation) {
        tasks.push({
          id: `${order.id}-${wire.id}-validate`,
          stage: "final",
          order,
          wire,
          label: "Validate production",
          description: "Confirm the wire is ready to be released.",
          action: "validate",
        });
      }
    });
  });

  return tasks;
}

function summarizeQueue(queue: QualityTask[]) {
  return queue.reduce(
    (acc, task) => {
      if (task.action !== "test") {
        return acc;
      }
      acc.total += 1;
      acc.byStage[task.stage] = (acc.byStage[task.stage] ?? 0) + 1;
      return acc;
    },
    { total: 0, byStage: { boot: 0, wheel: 0, final: 0 } as Record<QualityTestType, number> },
  );
}

export default function Quality() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isOperatorTestComplete } = useAppFlow();
  const { qualityAgentId, ensureAgent, promptAgent } = useQualityAgent();

  const { data, isLoading, isFetching } = useQuery<ProductionSnapshot>({
    queryKey: ["production-snapshot"],
    queryFn: fetchProductionSnapshot,
    refetchInterval: 15000,
  });

  const queue = useMemo(() => buildQualityQueue(data), [data]);
  const summary = useMemo(() => summarizeQueue(queue), [queue]);

  const [filters, setFilters] = useState<Record<FilterKey, string>>({
    wireReference: "All",
    marking: "All",
    color: "All",
    section: "All",
    cosse: "All",
  });

  const filterOptions = useMemo(() => {
    const wireReference = new Set<string>();
    const marking = new Set<string>();
    const color = new Set<string>();
    const section = new Set<string>();
    const cosse = new Set<string>();
    queue.forEach(({ wire }) => {
      wireReference.add(wire.refWire);
      marking.add(wire.marquage);
      color.add(formatColor(wire));
      section.add(wire.section === null || wire.section === undefined ? "Not specified" : wire.section.toFixed(2));
      if (wire.ext1?.terminal) cosse.add(wire.ext1.terminal);
      if (wire.ext2?.terminal) cosse.add(wire.ext2.terminal);
    });
    return {
      wireReference: ["All", ...Array.from(wireReference)],
      marking: ["All", ...Array.from(marking)],
      color: ["All", ...Array.from(color)],
      section: ["All", ...Array.from(section)],
      cosse: ["All", ...Array.from(cosse)],
    } as Record<FilterKey, string[]>;
  }, [queue]);

  const filteredQueue = useMemo(() => {
    return queue.filter(({ wire }) => {
      const colorLabel = formatColor(wire);
      const sectionLabel = wire.section === null || wire.section === undefined ? "Not specified" : wire.section.toFixed(2);
      const cosseMatch = filters.cosse === "All" ||
        wire.ext1?.terminal === filters.cosse ||
        wire.ext2?.terminal === filters.cosse;
      return (
        (filters.wireReference === "All" || wire.refWire === filters.wireReference) &&
        (filters.marking === "All" || wire.marquage === filters.marking) &&
        (filters.color === "All" || colorLabel === filters.color) &&
        (filters.section === "All" || sectionLabel === filters.section) &&
        cosseMatch
      );
    });
  }, [filters, queue]);

  const invalidateSnapshot = (snapshot?: ProductionSnapshot) => {
    if (snapshot) {
      queryClient.setQueryData(["production-snapshot"], snapshot);
    } else {
      queryClient.invalidateQueries({ queryKey: ["production-snapshot"] });
    }
  };

  const validateProductionMutation = useMutation<
    ProductionSnapshot,
    unknown,
    { identifier: WireIdentifier; qualityAgentId: string; context: { order: WorkOrderSummary; wire: WireSummary } }
  >({
    mutationFn: ({ identifier, qualityAgentId }) =>
      finalizeWireProduction({ wire: identifier, qualityAgentId }),
    onSuccess: (snapshot, variables) => {
      invalidateSnapshot(snapshot);
      toast({
        title: "Production validated",
        description: `${variables.context.wire.refWire} marked as completed.`,
      });
      setResultsDialogOpen(false);
      setActionsOpen(false);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      toast({ title: "Validation failed", description: message, variant: "destructive" });
    },
  });

  const [dialogTask, setDialogTask] = useState<QualityTask | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [resultsDialogOpen, setResultsDialogOpen] = useState(false);
  const [lastResult, setLastResult] = useState<QualityTestResultPayload | null>(null);
  const [lastNotes, setLastNotes] = useState<Record<string, string> | null>(null);
  const [lastTestContext, setLastTestContext] = useState<QualityTask | null>(null);

  const latestContext = useMemo(() => {
    if (!lastTestContext || !data) return null;
    const order = data.orders.find((candidate) => candidate.id === lastTestContext.order.id);
    if (!order) return null;
    const wire = order.wires.find((candidate) => candidate.id === lastTestContext.wire.id);
    if (!wire) return null;
    return { order, wire };
  }, [data, lastTestContext?.order.id, lastTestContext?.wire.id]);

  const actionsOrder = latestContext?.order ?? lastTestContext?.order ?? null;
  const actionsWire = latestContext?.wire ?? lastTestContext?.wire ?? null;
  const actionsStage = lastTestContext?.stage ?? null;

  const pendingFinalTask = useMemo(() => {
    if (!actionsOrder || !actionsWire) return null;
    return (
      queue.find(
        (task) =>
          task.action === "test" &&
          task.stage === "final" &&
          task.order.id === actionsOrder.id &&
          task.wire.id === actionsWire.id,
      ) ?? null
    );
  }, [queue, actionsOrder?.id, actionsWire?.id]);

  const nextTaskForWire = useMemo(() => {
    if (!actionsOrder || !actionsWire) return null;
    return (
      queue.find(
        (task) => task.action === "test" && task.order.id === actionsOrder.id && task.wire.id === actionsWire.id,
      ) ?? null
    );
  }, [queue, actionsOrder?.id, actionsWire?.id]);

  const validationTask = useMemo(() => {
    if (!actionsOrder || !actionsWire) return null;
    return (
      queue.find(
        (task) =>
          task.action === "validate" &&
          task.order.id === actionsOrder.id &&
          task.wire.id === actionsWire.id,
      ) ?? null
    );
  }, [queue, actionsOrder?.id, actionsWire?.id]);

  const validationAvailable = Boolean(validationTask);
  const currentActionsKey =
    actionsOrder && actionsWire ? makeWireKey(actionsOrder, actionsWire) : null;
  const activeValidationKey = validateProductionMutation.variables?.context
    ? makeWireKey(
        validateProductionMutation.variables.context.order,
        validateProductionMutation.variables.context.wire,
      )
    : null;
  const validationInProgress =
    validateProductionMutation.isPending &&
    currentActionsKey !== null &&
    currentActionsKey === activeValidationKey;

  const handleDialogCompleted = (
    response: CompleteQualityTestResponse,
    notes: Record<string, string>,
  ) => {
    invalidateSnapshot(response.snapshot);
    if (dialogTask) {
      setLastTestContext(dialogTask);
    }
    setLastResult(response.result);
    setLastNotes(Object.keys(notes).length > 0 ? notes : null);
    setDialogOpen(false);
    setActionsOpen(true);
    setResultsDialogOpen(false);
    toast({
      title: `${stageLabel(response.result.stage)} test completed`,
      description: `${dialogTask?.wire.refWire ?? "Wire"} released back to production.`,
    });
  };

  const handleDialogError = (message: string) => {
    toast({ title: "Quality update failed", description: message, variant: "destructive" });
  };

  const handleDialogOpenChange = (openState: boolean) => {
    setDialogOpen(openState);
    if (!openState) {
      setDialogTask(null);
    }
  };

  const handleLaunchTest = async (task: QualityTask) => {
    if (task.action !== "test") {
      return;
    }
    try {
      await ensureAgent();
    } catch {
      return;
    }
    setLastResult(null);
    setLastNotes(null);
    setLastTestContext(null);
    setResultsDialogOpen(false);
    setActionsOpen(false);
    setDialogTask(task);
    setDialogOpen(true);
  };

  const handleShowResults = () => {
    setActionsOpen(false);
    setResultsDialogOpen(true);
  };

  const handleResultsDialogOpenChange = (openState: boolean) => {
    setResultsDialogOpen(openState);
    if (!openState && lastResult) {
      setActionsOpen(true);
    }
  };

  const handleStartAnother = () => {
    setActionsOpen(false);
    if (nextTaskForWire) {
      void handleLaunchTest(nextTaskForWire);
    }
  };

  const handleStartFinal = () => {
    if (!pendingFinalTask) {
      return;
    }
    setActionsOpen(false);
    void handleLaunchTest(pendingFinalTask);
  };

  const handleValidateProduction = async (order: WorkOrderSummary, wire: WireSummary) => {
    try {
      const agentId = await ensureAgent();
      validateProductionMutation.mutate({
        identifier: buildIdentifier(order, wire),
        qualityAgentId: agentId,
        context: { order, wire },
      });
    } catch {
      // ignore cancellation
    }
  };

  const handleQualityControl = async () => {
    try {
      await promptAgent({ initialValue: qualityAgentId ?? undefined });
      setActionsOpen(false);
      navigate("/history");
    } catch {
      // ignore cancellation
    }
  };

  const handleHistory = () => {
    setActionsOpen(false);
    navigate("/history");
  };

  const handleChangeAgent = async () => {
    try {
      await promptAgent({ initialValue: qualityAgentId ?? undefined });
    } catch {
      // ignore cancellation
    }
  };

  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const [sbw, setSbw] = useState(0);
  useLayoutEffect(() => {
    const el = bodyScrollRef.current;
    if (!el) return;
    const calc = () => setSbw(el.offsetWidth - el.clientWidth);
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    window.addEventListener("resize", calc);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", calc);
    };
  }, []);

  return (
    <div className="flex flex-1 flex-col gap-4 bg-gradient-to-br from-background to-muted/20 p-4 sm:p-6">
      <section className="grid gap-3 md:grid-cols-3 xl:grid-cols-4">
        <SummaryCard
          title="Pending checks"
          value={summary.total.toString()}
          icon={<ShieldCheck className="h-4 w-4 text-primary" />}
          subtitle={isFetching ? "Refreshing status…" : "Live quality queue"}
        />
        <SummaryCard
          title="Boot"
          value={summary.byStage.boot.toString()}
          icon={<AlertTriangle className="h-4 w-4 text-secondary" />}
          subtitle="Awaiting boot validation"
        />
        <SummaryCard
          title="Wheel"
          value={summary.byStage.wheel.toString()}
          icon={<Loader2 className="h-4 w-4 text-warning" />}
          subtitle="Triggered at 50% progress"
        />
        <SummaryCard
          title="Final"
          value={summary.byStage.final.toString()}
          icon={<CheckCircle2 className="h-4 w-4 text-success" />}
          subtitle="Required for closure"
        />
      </section>

      <DepartmentCallButtons />

      <Card className="border border-border/40 bg-card/80 backdrop-blur">
        <CardHeader className="space-y-3 border-b border-border/30 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base font-semibold text-foreground">Quality queue</CardTitle>
            <p className="text-sm text-muted-foreground">Assign and confirm pending quality checks.</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className={cn("h-4 w-4", isFetching ? "animate-spin" : "opacity-60")} />
            <span>{isFetching ? "Synchronising" : "Up to date"}</span>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex h-36 items-center justify-center text-sm text-muted-foreground">
              Loading quality queue…
            </div>
          ) : queue.length === 0 ? (
            <div className="flex h-36 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <ShieldCheck className="h-6 w-6 text-success" />
              All quality tests are complete.
            </div>
          ) : (
            <>
            <div className="flex flex-wrap items-center gap-3 border-b border-border/30 p-4">
              {(Object.keys(filterOptions) as FilterKey[]).map((key) => (
                <div key={key}>
                  <Select
                    value={filters[key]}
                    onValueChange={(value) =>
                      setFilters((prev) => ({
                        ...prev,
                        [key]: value,
                      }))
                    }
                  >
                    <SelectTrigger
                      aria-label={FILTER_LABELS[key]}
                      className="h-12 w-[180px] rounded-lg border-border/40 text-left text-sm"
                    >
                      <div className="flex w-full flex-col items-start leading-tight">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {FILTER_LABELS[key]}
                        </span>
                        <SelectValue placeholder="All" />
                      </div>
                    </SelectTrigger>
                    <SelectContent>
                      {filterOptions[key].map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            <div className="min-h-0 flex flex-col">
              <div style={{ paddingRight: sbw }}>
                <Table className="table-fixed min-w-[720px] border-separate border-spacing-0">
                  <colgroup>
                    <col className="w-[22%]" />
                    <col className="w-[18%]" />
                    <col className="w-[12%]" />
                    <col className="w-[14%]" />
                    <col className="w-[24%]" />
                    <col className="w-[10%]" />
                  </colgroup>
                  <TableHeader className="border-b border-border/30 bg-card/95 backdrop-blur supports-[backdrop-filter]:backdrop-blur">
                    <TableRow className="border-border/40">
                      <TableHead className="text-xs">Wire</TableHead>
                      <TableHead className="text-xs">Order</TableHead>
                      <TableHead className="text-xs">Stage</TableHead>
                      <TableHead className="text-xs">Status</TableHead>
                      <TableHead className="text-xs">Details</TableHead>
                      <TableHead className="w-32 text-right text-xs">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                </Table>
              </div>

              <div
                ref={bodyScrollRef}
                className="min-h-0 max-h-[60vh] w-full overflow-y-auto [scrollbar-gutter:stable]"
              >
                <Table className="table-fixed min-w-[720px] border-separate border-spacing-0">
                  <colgroup>
                    <col className="w-[22%]" />
                    <col className="w-[18%]" />
                    <col className="w-[12%]" />
                    <col className="w-[14%]" />
                    <col className="w-[24%]" />
                    <col className="w-[10%]" />
                  </colgroup>
                  <TableBody>
                    {filteredQueue.map((task) => {
                      const { wire, order } = task;
                      const isValidationTask = task.action === "validate";
                      const taskKey = makeWireKey(order, wire);
                      const isCurrentValidationPending =
                        validateProductionMutation.isPending && activeValidationKey === taskKey;
                      const bootProgress =
                        task.action === "test" && task.stage === "boot"
                          ? Math.round((wire.bootTestDoneCount / wire.bootTestRequiredCount) * 100)
                          : null;
                      const operatorTestRecorded =
                        wire.operatorTestDone ||
                        isOperatorTestComplete(order.ofId, order.reference, wire.refWire, wire.marquage) ||
                        OPERATOR_TEST_COMPLETE_STATUSES.includes(wire.status) ||
                        (wire.status === "in_production" && wire.producedQuantity > 0);
                      const bootLocked = task.stage === "boot" && !operatorTestRecorded;

                      return (
                        <TableRow key={task.id} className="border-border/30">
                          <TableCell className="py-3">
                            <div className="flex flex-col">
                              <span className="text-sm font-medium text-foreground">{wire.refWire}</span>
                              <span className="text-xs text-muted-foreground">{wire.marquage}</span>
                            </div>
                          </TableCell>
                          <TableCell className="py-3 text-xs text-muted-foreground">
                            {order.ofId} · {order.reference}
                          </TableCell>
                          <TableCell className="py-3">
                            <Badge variant="outline" className="border-border/60 text-xs uppercase">
                              {stageLabel(task.stage)}
                            </Badge>
                          </TableCell>
                          <TableCell className="py-3">
                            <StatusBadge status={wire.status} />
                          </TableCell>
                          <TableCell className="py-3 text-xs text-muted-foreground">
                            <div className="flex flex-col gap-1">
                              <span>{task.description}</span>
                              {bootProgress !== null ? (
                                <div className="flex items-center gap-2">
                                  <Progress value={bootProgress} className="h-1.5 w-24" />
                                  <span>
                                    {wire.bootTestDoneCount}/{wire.bootTestRequiredCount}
                                  </span>
                                </div>
                              ) : null}
                              {bootLocked ? (
                                <Badge
                                  variant="outline"
                                  className="w-fit border-warning/40 text-[10px] font-semibold uppercase tracking-wide text-warning"
                                >
                                  Awaiting operator test
                                </Badge>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell className="py-3 text-right">
                            <Button
                              size="sm"
                              onClick={() =>
                                isValidationTask
                                  ? void handleValidateProduction(order, wire)
                                  : void handleLaunchTest(task)
                              }
                              disabled={
                                isValidationTask
                                  ? validateProductionMutation.isPending
                                  : dialogOpen || bootLocked
                              }
                              className="gap-1 text-xs"
                            >
                              {isValidationTask ? (
                                <>
                                  {isCurrentValidationPending ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                  )}
                                  {isCurrentValidationPending ? "Validating..." : "Validate production"}
                                </>
                              ) : (
                                "Start test"
                              )}
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
            </>
          )}
        </CardContent>
      </Card>

      <QualityTestDialog
        open={dialogOpen}
        task={dialogTask}
        onOpenChange={handleDialogOpenChange}
        onCompleted={handleDialogCompleted}
        onError={handleDialogError}
        qualityAgentId={qualityAgentId}
      />
      <QualityActionsDialog
        open={actionsOpen}
        onOpenChange={setActionsOpen}
        order={actionsOrder ?? null}
        wire={actionsWire ?? null}
        stage={actionsStage ?? null}
        qualityAgentId={qualityAgentId}
        onShowResults={lastResult ? handleShowResults : undefined}
        onStartAnother={nextTaskForWire ? handleStartAnother : undefined}
        onStartFinal={pendingFinalTask ? handleStartFinal : undefined}
        onValidateProduction={
          validationAvailable && actionsOrder && actionsWire
            ? () => void handleValidateProduction(actionsOrder, actionsWire)
            : undefined
        }
        canValidateProduction={validationAvailable}
        validateInProgress={validationInProgress}
        onQualityControl={handleQualityControl}
        onHistory={handleHistory}
        onChangeAgent={handleChangeAgent}
        resultsAvailable={Boolean(lastResult)}
      />
      <QualityTestResultsDialog
        open={resultsDialogOpen}
        onOpenChange={handleResultsDialogOpenChange}
        result={lastResult}
        order={actionsOrder ?? null}
        wire={actionsWire ?? null}
        qualityAgentId={qualityAgentId}
        notes={lastNotes ?? undefined}
      />
    </div>
  );
}

function SummaryCard({
  title,
  value,
  icon,
  subtitle,
}: {
  title: string;
  value: string;
  icon: ReactNode;
  subtitle: string;
}) {
  return (
    <Card className="border border-border/40 bg-card/80 backdrop-blur">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold text-foreground">{value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
      </CardContent>
    </Card>
  );
}
