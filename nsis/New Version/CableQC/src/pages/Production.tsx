import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CircleStop,
  LineChart,
  Loader2,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  ShieldCheck,
  Scan,
  UserRound,
} from "lucide-react";

import { LabelVerificationDialog } from "@/components/production/LabelVerificationDialog";
import { OperatorActionsDialog } from "@/components/production/OperatorActionsDialog";
import { OperatorTestDialog } from "@/components/production/OperatorTestDialog";
import { WireValidationDialog } from "@/components/production/WireValidationDialog";
import { CosseValidationDialog } from "@/components/production/CosseValidationDialog";
import { StopWireIdDialog } from "@/components/production/StopWireIdDialog";
import { UnlockWireIdDialog } from "@/components/production/UnlockWireIdDialog";
import { UnlockOptionsDialog } from "@/components/production/UnlockOptionsDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/use-toast";
import { useAppFlow } from "@/context/AppFlowContext";
import {
  completeOperatorTest,
  fetchProductionSnapshot,
  pauseWire,
  printBundleLabel,
  recordWireProgress,
  resumeWire,
  stopWire,
  validateWire,
  verifyBundleLabel,
  unlockWire,
} from "@/lib/api";
import type { BundleLabelRequest, BundleLabelResult } from "@/lib/api";
import type { ProductionSnapshot, WireIdentifier, WireStatus, WireSummary, WorkOrderSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { usePrinterConfig } from "@/context/PrinterConfigContext";

type FilterKey = "wireReference" | "marking" | "color" | "section" | "cosse";

const FILTER_LABELS: Record<FilterKey, string> = {
  wireReference: "Wire Reference",
  marking: "Marking",
  color: "Color",
  section: "Section",
  cosse: "Cosse",
};

const ACTIVE_WORK_STATUSES: WireStatus[] = [
  "validated",
  "in_production",
  "qc_boot",
  "qc_wheel",
  "qc_final",
  "paused",
];

const OPERATOR_TEST_COMPLETE_STATUSES: WireStatus[] = [
  "qc_boot",
  "qc_wheel",
  "qc_final",
  "stopped",
  "completed",
];
function makeWireIdentifier(order: WorkOrderSummary, wire: WireSummary): WireIdentifier {
  return {
    workOrderId: order.id,
    refWire: wire.refWire,
    marquage: wire.marquage,
  };
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

function formatStrip(value?: number | null): string {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(1)} mm`;
}

interface WireRuntimeState {
  requiresWheel: boolean;
  requiresFinal: boolean;
  requiresBoot: boolean;
  isPaused: boolean;
  isStopped: boolean;
  isCompleted: boolean;
  isNotValidated: boolean;
  canOpenTest: boolean;
  validationLocked: boolean;
  lockedByActive: boolean;
  lockedByScan: boolean;
  isLocked: boolean;
  qcPending: boolean;
}

interface LabelVerificationState {
  order: WorkOrderSummary;
  wire: WireSummary;
  quantity: number;
  request: BundleLabelRequest;
  labelId: string | null;
  expectedBarcode: string | null;
  verifying: boolean;
  error: string | null;
}

function buildWireRuntimeState(
  wire: WireSummary,
  anyValidated: boolean,
  activeWireId: number | null,
  scanningWireId: number | null,
): WireRuntimeState {
  const isWheelStage = wire.status === "qc_wheel" || wire.status === "qc_final";
  const requiresWheel =
    wire.wheelTestRequired && !wire.wheelTestDone && isWheelStage;
  const requiresFinal =
    wire.finalTestRequired && !wire.finalTestDone && wire.status === "qc_final";
  const requiresBoot = wire.status === "qc_boot" && wire.bootTestDoneCount < wire.bootTestRequiredCount;
  const qcPending = requiresBoot || requiresWheel || requiresFinal;
  const isPaused = wire.status === "paused";
  const isStopped = wire.status === "stopped";
  const isCompleted = wire.status === "completed";
  const isNotValidated = wire.status === "not_validated";
  const canOpenTest = ["validated", "in_production"].includes(wire.status) && !qcPending;
  const lockedByActive = activeWireId !== null && activeWireId !== wire.id;
  const lockedByScan = scanningWireId !== null && scanningWireId !== wire.id;
  const validationLocked =
    lockedByActive || lockedByScan || (anyValidated && !ACTIVE_WORK_STATUSES.includes(wire.status));

  return {
    requiresWheel,
    requiresFinal,
    requiresBoot,
    isPaused,
    isStopped,
    isCompleted,
    isNotValidated,
    canOpenTest,
    validationLocked,
    lockedByActive,
    lockedByScan,
    isLocked: lockedByActive || lockedByScan,
    qcPending,
  };
}

function StatCard({
  icon: Icon,
  label,
  value,
  progress,
  variant = "default",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  progress?: number;
  variant?: "primary" | "success" | "warning" | "secondary" | "default";
}) {
  const iconStyles = {
    primary: "text-primary",
    success: "text-success",
    warning: "text-destructive",
    secondary: "text-secondary",
    default: "text-muted-foreground",
  } as const;

  return (
    <Card className="border-border/40 bg-card/80 backdrop-blur">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </CardTitle>
        <Icon className={cn("h-4 w-4", iconStyles[variant])} />
      </CardHeader>
      <CardContent>
        <div className="text-xl font-bold text-foreground">{value}</div>
        {progress !== undefined ? <Progress value={progress} className="mt-2 h-1.5" /> : null}
      </CardContent>
    </Card>
  );
}

export default function Production() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const headerCellClass =
    "sticky top-0 z-30 bg-card/95 backdrop-blur supports-[backdrop-filter]:backdrop-blur";
  const {
    state: flowState,
    markOperatorTestComplete,
    isOperatorTestComplete,
    getOperatorTestNotes,
    saveOperatorTestDraft,
    getOperatorTestDraft,

    clearOperatorTestDraft,
    clearOperatorTest,
  } = useAppFlow();

  const { data, isLoading, isFetching, refetch } = useQuery<ProductionSnapshot>({
    queryKey: ["production-snapshot"],
    queryFn: fetchProductionSnapshot,
    refetchInterval: 15000,
  });

  const orders = data?.orders ?? [];

  useEffect(() => {
    orders.forEach((order) => {
      order.wires.forEach((wire) => {
        const backendComplete =
          wire.operatorTestDone ||
          OPERATOR_TEST_COMPLETE_STATUSES.includes(wire.status) ||
          (wire.status === "in_production" && wire.producedQuantity > 0);
        if (
          backendComplete &&
          !isOperatorTestComplete(order.ofId, order.reference, wire.refWire, wire.marquage)
        ) {
          markOperatorTestComplete(order.ofId, order.reference, wire.refWire, wire.marquage);
        }
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders]);
  const refs = useMemo(() => Array.from(new Set(orders.map((o) => o.reference))), [orders]);
  const [selectedRef, setSelectedRef] = useState<string>("");
  useEffect(() => {
    if (!selectedRef && refs.length > 0) {
      setSelectedRef(refs[0]);
    }
  }, [refs, selectedRef]);

  const batchesByRef = useMemo(() => {
    const map = new Map<string, string[]>();
    orders.forEach((order) => {
      const batches = map.get(order.reference) ?? [];
      if (!batches.includes(order.ofId)) batches.push(order.ofId);
      map.set(order.reference, batches);
    });
    return map;
  }, [orders]);

  const batchOptions = batchesByRef.get(selectedRef) ?? [];
  const [selectedBatch, setSelectedBatch] = useState<string>("");
  useEffect(() => {
    if (!selectedBatch && batchOptions.length > 0) {
      setSelectedBatch(batchOptions[0]);
    }
  }, [batchOptions, selectedBatch]);

  const [filters, setFilters] = useState<Record<FilterKey, string>>({
    wireReference: "All",
    marking: "All",
    color: "All",
    section: "All",
    cosse: "All",
  });

  useEffect(() => {
    setFilters({
      wireReference: "All",
      marking: "All",
      color: "All",
      section: "All",
      cosse: "All",
    });
  }, [selectedBatch, selectedRef]);

  const [selectedWireId, setSelectedWireId] = useState<number | null>(null);
  const [stopContext, setStopContext] = useState<{ order: WorkOrderSummary; wire: WireSummary } | null>(null);
  const [stopIdContext, setStopIdContext] = useState<{ order: WorkOrderSummary; wire: WireSummary } | null>(null);
  const [unlockContext, setUnlockContext] = useState<{ order: WorkOrderSummary; wire: WireSummary; userId?: string } | null>(null);
  const [unlockIdContext, setUnlockIdContext] = useState<{ order: WorkOrderSummary; wire: WireSummary } | null>(null);
  const [validationContext, setValidationContext] = useState<{ order: WorkOrderSummary; wire: WireSummary } | null>(null);
  const [cosseValidationContext, setCosseValidationContext] = useState<{ order: WorkOrderSummary; wire: WireSummary } | null>(null);
  const [testContext, setTestContext] = useState<{ order: WorkOrderSummary; wire: WireSummary } | null>(null);
  const activeDraft = useMemo(() => {
    if (!testContext) return null;
    return (
      getOperatorTestDraft(
        testContext.order.ofId,
        testContext.order.reference,
        testContext.wire.refWire,
        testContext.wire.marquage,
      ) ?? null
    );
  }, [
    getOperatorTestDraft,
    testContext?.order.ofId,
    testContext?.order.reference,
    testContext?.wire.refWire,
    testContext?.wire.marquage,
  ]);
  const [actionsContext, setActionsContext] = useState<{
    order: WorkOrderSummary;
    wire: WireSummary;
    notes: Record<string, string>;
  } | null>(null);

  const [labelVerification, setLabelVerification] = useState<LabelVerificationState | null>(null);

  const { state: labelSettings, openDialog: openPrinterDialog } = usePrinterConfig();
  const pendingBundleRef = useRef<{
    quantity: number;
    order: WorkOrderSummary;
    wire: WireSummary;
  } | null>(null);

  const [operatorSubmitting, setOperatorSubmitting] = useState(false);
  const [activeWireId, setActiveWireId] = useState<number | null>(null);
  const [scanningWireId, setScanningWireId] = useState<number | null>(null);

  const scopedRows = useMemo(() => {
    const rows: Array<{ order: WorkOrderSummary; wire: WireSummary }> = [];
    orders.forEach((order) => {
      if (order.reference !== selectedRef) return;
      if (selectedBatch && order.ofId !== selectedBatch) return;
      order.wires.forEach((wire) => rows.push({ order, wire }));
    });
    return rows;
  }, [orders, selectedBatch, selectedRef]);

  const filterOptions = useMemo(() => {
    const wireReference = new Set<string>();
    const marking = new Set<string>();
    const color = new Set<string>();
    const section = new Set<string>();
    const cosse = new Set<string>();
    scopedRows.forEach(({ wire }) => {
      wireReference.add(wire.refWire);
      marking.add(wire.marquage);
      color.add(formatColor(wire));
      section.add(wire.section === null || wire.section === undefined ? "Not specified" : wire.section.toFixed(2));
      // Add terminal values from both Term. A and Term. B
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
  }, [scopedRows]);

  const filteredRows = useMemo(() => {
    return scopedRows.filter(({ wire }) => {
      const colorLabel = formatColor(wire);
      const sectionLabel = wire.section === null || wire.section === undefined ? "Not specified" : wire.section.toFixed(2);
      // Check if the wire matches the cosse filter (terminal from ext1 or ext2)
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
  }, [filters, scopedRows]);

  const anyValidated = useMemo(() => {
    return orders.some((order) => order.wires.some((wire) => ACTIVE_WORK_STATUSES.includes(wire.status)));
  }, [orders]);

  useEffect(() => {
    if (selectedWireId !== null) {
      const stillPresent = orders.some((order) => order.wires.some((wire) => wire.id === selectedWireId));
      if (!stillPresent) {
        setSelectedWireId(null);
      }
      return;
    }
    const firstValidated = orders
      .flatMap((order) => order.wires)
      .find((wire) => wire.status === "qc_boot" || wire.status === "validated");
    if (firstValidated) {
      setSelectedWireId(firstValidated.id);
    }
  }, [orders, selectedWireId]);

  useEffect(() => {
    if (scanningWireId === null) return;
    const exists = orders.some((order) => order.wires.some((wire) => wire.id === scanningWireId));
    if (!exists) {
      setScanningWireId(null);
    }
  }, [orders, scanningWireId]);

  useEffect(() => {
    if (activeWireId !== null) {
      const activeWire = orders
        .flatMap((order) => order.wires)
        .find((wire) => wire.id === activeWireId);
      if (!activeWire || !ACTIVE_WORK_STATUSES.includes(activeWire.status)) {
        setActiveWireId(null);
      }
      return;
    }
    if (scanningWireId !== null) return;
    const fallbackActive = orders
      .flatMap((order) => order.wires)
      .find((wire) => ACTIVE_WORK_STATUSES.includes(wire.status));
    if (fallbackActive) {
      setActiveWireId(fallbackActive.id);
    }
  }, [orders, activeWireId, scanningWireId]);

  const totals = useMemo(() => {
    const produced = filteredRows.reduce((acc, { wire }) => acc + wire.producedQuantity, 0);
    const required = filteredRows.reduce((acc, { wire }) => acc + wire.targetQuantity, 0);
    const blocked = filteredRows.filter(({ wire }) =>
      wire.status === "qc_boot" || wire.status === "qc_wheel" || wire.status === "qc_final",
    ).length;
    const completed = filteredRows.filter(({ wire }) => wire.status === "completed").length;
    const percent = required > 0 ? Math.round((produced / required) * 100) : 0;
    return { produced, required, blocked, completed, percent };
  }, [filteredRows]);

  const operatorName = flowState.session?.operatorName?.trim() ?? "";
  const activeOperator = operatorName || "—";

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

  const resolveWireContext = (
    snapshot: ProductionSnapshot,
    identifier: WireIdentifier,
  ): { order: WorkOrderSummary; wire: WireSummary } | null => {
    const orderMatch = snapshot.orders.find((candidate) => candidate.id === identifier.workOrderId);
    if (!orderMatch) return null;
    const wireMatch = orderMatch.wires.find(
      (candidate) => candidate.refWire === identifier.refWire && candidate.marquage === identifier.marquage,
    );
    if (!wireMatch) return null;
    return { order: orderMatch, wire: wireMatch };
  };

  const validateWireMutation = useMutation<ProductionSnapshot, unknown, WireIdentifier>({
    mutationFn: validateWire,
    onSuccess: (snapshot) => {
      const validatedId = scanningWireId;
      invalidateSnapshot(snapshot);
      setValidationContext(null);
      setScanningWireId(null);
      if (validatedId !== null) {
        setActiveWireId(validatedId);
      }
      toast({ title: "Wire validated", description: "The wire is ready for operator tests." });
    },
    onError: (error) => {
      handleError(error);
      setScanningWireId(null);
    },
  });

  const operatorTestMutation = useMutation({
    mutationFn: completeOperatorTest,
    onSuccess: (snapshot) => {
      invalidateSnapshot(snapshot);
      toast({
        title: "Operator tests completed",
        description: "Wire handed off to quality control.",
      });
    },
    onError: handleError,
  });

  const recordProgressMutation = useMutation<
    ProductionSnapshot,
    unknown,
    { wire: WireIdentifier; producedIncrement: number }
  >({
    mutationFn: recordWireProgress,
    onSuccess: (snapshot, variables) => {
      invalidateSnapshot(snapshot);
      toast({
        title: "Production updated",
        description: `${variables.producedIncrement} wires recorded for the bundle.`,
      });
      setActionsContext((prev) => {
        if (!prev || !variables?.wire) return prev;
        const resolved = resolveWireContext(snapshot, variables.wire);
        if (resolved) {
          return { ...prev, order: resolved.order, wire: resolved.wire };
        }
        return prev;
      });
    },
    onError: handleError,
  });

  const { mutate: mutateRecordProgress } = recordProgressMutation;

  const printAndVerifyBundle = useCallback(
    (bundle: { order: WorkOrderSummary; wire: WireSummary; quantity: number }) => {
      const { order, wire, quantity } = bundle;
      const identifier = makeWireIdentifier(order, wire);
      const request: BundleLabelRequest = {
        productRef: order.reference,
        ofId: order.ofId,
        refWire: wire.refWire,
        refCoil: wire.refCoil,
        marquage: wire.marquage,
        quantity,
        lengthMm: wire.lengthMm,
        machineName: order.machineId ?? null,
      };
      const marquageValue = wire.marquage.trim();
      const refWireValue = wire.refWire.trim();
      const expectedBarcodeValue = marquageValue.length > 0 ? marquageValue : refWireValue;
      void (async () => {
        try {
          const result: BundleLabelResult = await printBundleLabel(request);
          if (result.message) {
            toast({
              title: result.skipped ? "Label printing skipped" : "Label printing",
              description: result.message,
            });
          }
          if (result.skipped) {
            mutateRecordProgress({ wire: identifier, producedIncrement: quantity });
            return;
          }
          setLabelVerification({
            order,
            wire,
            quantity,
            request,
            labelId: result.labelId ?? null,
            expectedBarcode: expectedBarcodeValue.length > 0 ? expectedBarcodeValue : null,
            verifying: false,
            error: null,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unable to complete label printing.";
          toast({
            title: "Label printing failed",
            description: message,
            variant: "destructive",
          });
        } finally {
          pendingBundleRef.current = null;
        }
      })();
    },
    [mutateRecordProgress, toast],
  );

  const pauseMutation = useMutation<ProductionSnapshot, unknown, WireIdentifier>({
    mutationFn: pauseWire,
    onSuccess: (snapshot) => {
      invalidateSnapshot(snapshot);
      toast({ title: "Wire paused", description: "Production was paused for the selected wire." });
    },
    onError: handleError,
  });

  const resumeMutation = useMutation<ProductionSnapshot, unknown, WireIdentifier>({
    mutationFn: resumeWire,
    onSuccess: (snapshot) => {
      invalidateSnapshot(snapshot);
      toast({ title: "Wire resumed", description: "Production was resumed for the selected wire." });
    },
    onError: handleError,
  });

  const stopMutation = useMutation<ProductionSnapshot, unknown, WireIdentifier>({
    mutationFn: stopWire,
    onSuccess: (snapshot) => {
      const stoppedId = stopContext?.wire.id ?? null;
      invalidateSnapshot(snapshot);
      setStopContext(null);
      if (stoppedId !== null) {
        setActiveWireId((prev) => (prev === stoppedId ? null : prev));
      }
      setScanningWireId((prev) => (prev === stoppedId ? null : prev));
      toast({ title: "Wire stopped", description: "The wire has been marked as stopped." });
    },
    onError: handleError,
  });

  const unlockMutation = useMutation<
    ProductionSnapshot,
    unknown,
    { wire: WireIdentifier; userId: string; action: "restart" | "continue" }
  >({
    mutationFn: unlockWire,
    onSuccess: (snapshot, variables) => {
      invalidateSnapshot(snapshot);

      // If restarting, clear the local operator test state to force the test to reappear
      if (variables.action === "restart" && unlockContext) {
        clearOperatorTest(
          unlockContext.order.ofId,
          unlockContext.order.reference,
          unlockContext.wire.refWire,
          unlockContext.wire.marquage
        );
      }

      setUnlockContext(null);
      setUnlockIdContext(null);
      toast({ title: "Wire unlocked", description: "The wire has been successfully unlocked." });
    },
    onError: handleError,
  });

  const handleRecordBundle = useCallback(
    (quantity: number) => {
      if (!actionsContext) return;
      if (labelSettings.loading) {
        toast({
          title: "Printer settings",
          description: "Printer configuration is still loading. Please retry in a moment.",
        });
        return;
      }
      const bundle = {
        quantity,
        order: actionsContext.order,
        wire: actionsContext.wire,
      };
      if (labelSettings.enabled && !labelSettings.ready) {
        pendingBundleRef.current = bundle;
        openPrinterDialog({
          onSaved: () => {
            const bundle = pendingBundleRef.current;
            if (!bundle) {
              return;
            }
            printAndVerifyBundle(bundle);
          },
        });
        toast({
          title: "Printer configuration required",
          description: "Configure label printing before finishing bundles.",
        });
        return;
      }
      if (labelSettings.enabled) {
        pendingBundleRef.current = bundle;
        printAndVerifyBundle(bundle);
        return;
      }
      pendingBundleRef.current = null;
      const identifier = makeWireIdentifier(bundle.order, bundle.wire);
      mutateRecordProgress({ wire: identifier, producedIncrement: quantity });
    },
    [actionsContext, labelSettings, mutateRecordProgress, openPrinterDialog, printAndVerifyBundle, toast],
  );

  const handleLabelVerificationSubmit = useCallback(
    async ({ barcode, bac }: { barcode: string; bac: string }) => {
      if (!labelVerification) return;
      const current = labelVerification;
      setLabelVerification((prev) => (prev ? { ...prev, verifying: true, error: null } : prev));
      try {
        const identifier = makeWireIdentifier(current.order, current.wire);
        await verifyBundleLabel({
          wire: identifier,
          labelId: current.labelId ?? barcode,
          barcode,
          bacId: bac,
          quantity: current.quantity,
        });
        toast({
          title: "Label verified",
          description: `Bundle stored in ${bac}.`,
        });
        setLabelVerification(null);
        mutateRecordProgress({ wire: identifier, producedIncrement: current.quantity });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLabelVerification((prev) => (prev ? { ...prev, verifying: false, error: message } : prev));
      }
    },
    [labelVerification, mutateRecordProgress, toast],
  );

  const handleLabelVerificationReprint = useCallback(async () => {
    if (!labelVerification) return;
    setLabelVerification((prev) => (prev ? { ...prev, verifying: true, error: null } : prev));
    try {
      const result: BundleLabelResult = await printBundleLabel(labelVerification.request);
      if (result.message) {
        toast({
          title: result.skipped ? "Label printing skipped" : "Label printing",
          description: result.message,
        });
      }
      if (result.skipped) {
        setLabelVerification((prev) =>
          prev
            ? {
              ...prev,
              verifying: false,
              error:
                result.message ??
                "Label printing was skipped. Configure the printer settings to continue.",
            }
            : prev,
        );
        return;
      }
      setLabelVerification((prev) =>
        prev
          ? {
            ...prev,
            verifying: false,
            labelId: result.labelId ?? prev.labelId,
            error: null,
          }
          : prev,
      );
      if (!result.message) {
        toast({
          title: "Label reprinted",
          description: result.labelId
            ? `Label ${result.labelId} sent to the printer.`
            : "Label reprint sent to the printer.",
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to complete label printing.";
      setLabelVerification((prev) => (prev ? { ...prev, verifying: false, error: message } : prev));
      toast({
        title: "Label printing failed",
        description: message,
        variant: "destructive",
      });
    }
  }, [labelVerification, toast]);

  const handleLabelVerificationCancel = useCallback(() => {
    setLabelVerification((prev) => (prev && prev.verifying ? prev : null));
  }, []);

  const handleChangeCoil = useCallback(() => {
    if (!actionsContext) return;
    setActionsContext(null);
    setScanningWireId(actionsContext.wire.id);
    setSelectedWireId(actionsContext.wire.id);
    setValidationContext({ order: actionsContext.order, wire: actionsContext.wire });
  }, [actionsContext]);

  const changeCoilDisabled =
    validateWireMutation.isPending ||
    recordProgressMutation.isPending ||
    operatorSubmitting;

  const handleOperatorTestComplete = async (
    identifier: WireIdentifier,
    context: { order: WorkOrderSummary; wire: WireSummary },
    notes: Record<string, string>,
  ) => {
    try {
      setOperatorSubmitting(true);
      const snapshot = await operatorTestMutation.mutateAsync({ wire: identifier, notes });
      setTestContext(null);
      const resolved = resolveWireContext(snapshot, identifier);
      const targetOrder = resolved?.order ?? context.order;
      const targetWire = resolved?.wire ?? context.wire;
      const storedNotes = notes ?? {};
      clearOperatorTestDraft(
        targetOrder.ofId,
        targetOrder.reference,
        targetWire.refWire,
        targetWire.marquage,
      );
      markOperatorTestComplete(
        targetOrder.ofId,
        targetOrder.reference,
        targetWire.refWire,
        targetWire.marquage,
        storedNotes,
      );
      setActionsContext({
        order: targetOrder,
        wire: targetWire,
        notes: storedNotes,
      });
    } catch (error) {
      handleError(error);
    } finally {
      setOperatorSubmitting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4 overflow-hidden bg-gradient-to-br from-background to-muted/20 p-4 sm:p-6">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={LineChart}
          label="Progress"
          value={`${totals.produced} / ${totals.required}`}
          progress={totals.percent}
          variant="primary"
        />
        <StatCard icon={ShieldCheck} label="Completed" value={totals.completed.toString()} variant="success" />
        <StatCard icon={AlertTriangle} label="Blocked" value={totals.blocked.toString()} variant="warning" />
        <StatCard icon={UserRound} label="Operator" value={activeOperator} variant="secondary" />
      </section>

      <Card className="flex min-h-0 flex-1 flex-col border-border/40 bg-card/80 backdrop-blur">
        <CardHeader className="space-y-3 border-b border-border/30 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base font-semibold text-foreground">
              Wire Production Table
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Aligns with the desktop production workflow: validate coils, record batches, and release bundles after operator checkpoints.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Product Reference:
              </span>
              <Select value={selectedRef} onValueChange={setSelectedRef}>
                <SelectTrigger aria-label="Product Reference" className="h-9 w-[180px] rounded-lg border-border/40 text-sm">
                  <SelectValue placeholder="Reference" />
                </SelectTrigger>
                <SelectContent>
                  {refs.map((ref) => (
                    <SelectItem key={ref} value={ref}>
                      {ref}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Batch (OF):
              </span>
              <Select value={selectedBatch} onValueChange={setSelectedBatch}>
                <SelectTrigger
                  aria-label="Batch (OF)"
                  className="h-9 w-[180px] rounded-lg border-border/40 text-sm"
                  disabled={batchOptions.length === 0}
                >
                  <SelectValue placeholder="Batch" />
                </SelectTrigger>
                <SelectContent>
                  {batchOptions.map((batch) => (
                    <SelectItem key={batch} value={batch}>
                      {batch}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-9 gap-1.5"
              onClick={() => {
                refetch();
                toast({ title: "Snapshot refreshed" });
              }}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
              <span className="hidden sm:inline text-sm">Refresh</span>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col overflow-hidden p-0">
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
            <Badge variant="outline" className="ml-auto rounded-full border-border/60 text-xs text-muted-foreground">
              {filteredRows.length} wires
            </Badge>
          </div>

          <div className="hidden h-full lg:block">
            <ScrollArea className="h-full max-h-[60vh] w-full">
              <div className="w-full overflow-x-auto">
                <Table className="min-w-[1480px]">
                  <TableHeader className="bg-transparent">
                    <TableRow className="border-border/30">
                      <TableHead className={cn(headerCellClass, "w-[60px] text-center text-xs uppercase")}>
                        <ShieldCheck className="mx-auto h-4 w-4 text-muted-foreground" aria-hidden />
                        <span className="sr-only">Validate</span>
                      </TableHead>
                      <TableHead className={cn(headerCellClass, "text-xs uppercase")}>Wire Reference</TableHead>
                      <TableHead className={cn(headerCellClass, "text-xs uppercase")}>REF</TableHead>
                      <TableHead className={cn(headerCellClass, "text-xs uppercase")}>Batch</TableHead>
                      <TableHead className={cn(headerCellClass, "text-xs uppercase")}>Wire Color</TableHead>
                      <TableHead className={cn(headerCellClass, "text-xs uppercase")}>Wire Section</TableHead>
                      <TableHead className={cn(headerCellClass, "text-xs uppercase")}>Marking</TableHead>
                      <TableHead className={cn(headerCellClass, "text-xs uppercase")}>Length (mm ±5)</TableHead>
                      <TableHead className={cn(headerCellClass, "text-xs uppercase")}>Term. A Strip (±0.5)</TableHead>
                      <TableHead className={cn(headerCellClass, "text-xs uppercase")}>Term. A Terminal</TableHead>
                      <TableHead className={cn(headerCellClass, "text-xs uppercase")}>Term. A Joint</TableHead>
                      <TableHead className={cn(headerCellClass, "text-xs uppercase")}>Term. B Strip (±0.5)</TableHead>
                      <TableHead className={cn(headerCellClass, "text-xs uppercase")}>Term. B Terminal</TableHead>
                      <TableHead className={cn(headerCellClass, "text-xs uppercase")}>Term. B Joint</TableHead>
                      <TableHead className={cn(headerCellClass, "text-xs uppercase")}>Status</TableHead>
                      <TableHead className={cn(headerCellClass, "w-[220px] text-xs uppercase")}>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading ? (
                      <TableRow>
                        <TableCell colSpan={16} className="h-24 text-center">
                          <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
                        </TableCell>
                      </TableRow>
                    ) : filteredRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={16} className="h-24 text-center text-sm text-muted-foreground">
                          No wires found for the selected scope.
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredRows.map(({ order, wire }) => {
                        const runtime = buildWireRuntimeState(wire, anyValidated, activeWireId, scanningWireId);
                        const {
                          isPaused,
                          isStopped,
                          isCompleted,
                          isNotValidated,
                          canOpenTest,
                          validationLocked,
                          isLocked,
                          qcPending,
                        } = runtime;
                        const colorLabel = formatColor(wire);
                        const sectionLabel = formatSection(wire);
                        const isSelected = selectedWireId === wire.id;
                        const identifier = makeWireIdentifier(order, wire);
                        const operatorTestRecorded =
                          wire.operatorTestDone ||
                          isOperatorTestComplete(order.ofId, order.reference, wire.refWire, wire.marquage) ||
                          OPERATOR_TEST_COMPLETE_STATUSES.includes(wire.status) ||
                          (wire.status === "in_production" && wire.producedQuantity > 0);
                        return (
                          <TableRow
                            key={wire.id}
                            className={cn(
                              "border-border/30 transition-colors hover:bg-muted/20",
                              isSelected && "bg-primary/5",
                              (wire.status === "validated" || wire.status === "qc_boot") && "ring-1 ring-primary/40",
                              isPaused && "bg-muted/30",
                              isStopped && "opacity-60",
                              isLocked && "cursor-not-allowed opacity-50 pointer-events-none"
                            )}
                            aria-disabled={isLocked}
                          >
                            <TableCell className="py-3 text-center">
                              <Button
                                size="icon"
                                variant="ghost"
                                className={cn(
                                  "h-8 w-8 rounded-full border border-transparent",
                                  isSelected && "border-primary/50 bg-primary/10",
                                )}
                                onClick={() => {
                                  setScanningWireId(wire.id);
                                  setValidationContext({ order, wire });
                                  setSelectedWireId(wire.id);
                                }}
                                disabled={
                                  validateWireMutation.isPending ||
                                  !isNotValidated ||
                                  validationLocked ||
                                  isLocked ||
                                  isCompleted ||
                                  isStopped
                                }
                                aria-label={`Scan ${wire.refWire}`}
                              >
                                <Scan className="h-4 w-4" />
                              </Button>
                            </TableCell>
                            <TableCell className="py-3">
                              <div className="flex flex-col">
                                <span className="text-sm font-medium text-foreground">{wire.refWire}</span>
                              </div>
                            </TableCell>
                            <TableCell className="py-3">
                              <span className="text-xs text-muted-foreground">{order.reference}</span>
                            </TableCell>
                            <TableCell className="py-3">
                              <span className="text-xs text-muted-foreground">{order.ofId}</span>
                            </TableCell>
                            <TableCell className="py-3">
                              <span className="text-xs text-muted-foreground">{colorLabel}</span>
                            </TableCell>
                            <TableCell className="py-3">
                              <span className="text-xs text-muted-foreground">{sectionLabel}</span>
                            </TableCell>
                            <TableCell className="py-3">
                              <span className="text-xs text-muted-foreground">{wire.marquage}</span>
                            </TableCell>
                            <TableCell className="py-3">
                              <div className="flex flex-col gap-1">
                                <span className="text-xs text-muted-foreground">{wire.lengthMm} mm</span>
                              </div>
                            </TableCell>
                            <TableCell className="py-3">
                              <span className="text-xs text-muted-foreground">{formatStrip(wire.ext1?.stripping)}</span>
                            </TableCell>
                            <TableCell className="py-3">
                              <span className="text-xs text-muted-foreground">{wire.ext1?.terminal ?? "—"}</span>
                            </TableCell>
                            <TableCell className="py-3">
                              <span className="text-xs text-muted-foreground">{wire.ext1?.joint ?? "—"}</span>
                            </TableCell>
                            <TableCell className="py-3">
                              <span className="text-xs text-muted-foreground">{formatStrip(wire.ext2?.stripping)}</span>
                            </TableCell>
                            <TableCell className="py-3">
                              <span className="text-xs text-muted-foreground">{wire.ext2?.terminal ?? "—"}</span>
                            </TableCell>
                            <TableCell className="py-3">
                              <span className="text-xs text-muted-foreground">{wire.ext2?.joint ?? "—"}</span>
                            </TableCell>
                            <TableCell className="py-3">
                              <StatusBadge status={wire.status} />
                            </TableCell>
                            <TableCell className="py-3">
                              <div className="flex flex-wrap items-center gap-2">
                                <Button
                                  size="icon"
                                  variant="secondary"
                                  className="h-8 w-8"
                                  onClick={() => {
                                    setSelectedWireId(wire.id);
                                    if (operatorTestRecorded) {
                                      const storedNotes = getOperatorTestNotes(
                                        order.ofId,
                                        order.reference,
                                        wire.refWire,
                                        wire.marquage,
                                      );
                                      setActionsContext({
                                        order,
                                        wire,
                                        notes: storedNotes ?? {},
                                      });
                                    } else {
                                      setTestContext({ order, wire });
                                    }
                                  }}
                                  disabled={
                                    operatorSubmitting ||
                                    operatorTestMutation.isPending ||
                                    isLocked ||
                                    isStopped ||
                                    isCompleted ||
                                    (!operatorTestRecorded && !canOpenTest)
                                  }
                                >
                                  <PlayCircle className="h-4 w-4" />
                                  <span className="sr-only">
                                    {operatorTestRecorded ? "Operator Actions" : "Operator Test"}
                                  </span>
                                </Button>
                                {isPaused ? (
                                  <Button
                                    size="icon"
                                    variant="outline"
                                    className="h-8 w-8"
                                    onClick={() => resumeMutation.mutate(identifier)}
                                    disabled={
                                      resumeMutation.isPending ||
                                      pauseMutation.isPending ||
                                      stopMutation.isPending ||
                                      isLocked
                                    }
                                  >
                                    <PlayCircle className="h-4 w-4" />
                                    <span className="sr-only">Resume</span>
                                  </Button>
                                ) : (
                                  <Button
                                    size="icon"
                                    variant="outline"
                                    className="h-8 w-8"
                                    onClick={() => pauseMutation.mutate(identifier)}
                                    disabled={
                                      pauseMutation.isPending ||
                                      resumeMutation.isPending ||
                                      stopMutation.isPending ||
                                      isNotValidated ||
                                      isLocked ||
                                      isCompleted ||
                                      isStopped
                                    }
                                  >
                                    <PauseCircle className="h-4 w-4" />
                                    <span className="sr-only">Pause</span>
                                  </Button>
                                )}
                                <Button
                                  size="icon"
                                  variant="destructive"
                                  className="h-8 w-8"
                                  onClick={() => setStopIdContext({ order, wire })}
                                  disabled={stopMutation.isPending || isLocked || isCompleted || isStopped}
                                >
                                  <CircleStop className="h-4 w-4" />
                                  <span className="sr-only">Stop</span>
                                </Button>
                                {isStopped && (
                                  <Button
                                    size="icon"
                                    variant="outline"
                                    className="h-8 w-8 text-orange-500 hover:text-orange-600 border-orange-200 hover:bg-orange-50"
                                    onClick={() => setUnlockIdContext({ order, wire })}
                                    disabled={unlockMutation.isPending}
                                  >
                                    <ShieldCheck className="h-4 w-4" />
                                    <span className="sr-only">Unlock Wire</span>
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </ScrollArea>
          </div>

          <ScrollArea className="max-h-[70vh] border-t border-border/20 lg:hidden">
            <div className="grid gap-3 p-4">
              {isLoading ? (
                <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading wires…
                </div>
              ) : filteredRows.length === 0 ? (
                <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                  No wires found for the selected scope.
                </div>
              ) : filteredRows.map(({ order, wire }) => {
                const runtime = buildWireRuntimeState(wire, anyValidated, activeWireId, scanningWireId);
                const {
                  isPaused,
                  isStopped,
                  isCompleted,
                  isNotValidated,
                  canOpenTest,
                  validationLocked,
                  requiresBoot,
                  requiresWheel,
                  requiresFinal,
                  isLocked,
                  qcPending,
                } = runtime;
                const identifier = makeWireIdentifier(order, wire);
                const operatorTestRecorded =
                  wire.operatorTestDone ||
                  isOperatorTestComplete(order.ofId, order.reference, wire.refWire, wire.marquage) ||
                  OPERATOR_TEST_COMPLETE_STATUSES.includes(wire.status) ||
                  (wire.status === "in_production" && wire.producedQuantity > 0);
                const colorLabel = formatColor(wire);
                const sectionLabel = formatSection(wire);
                return (
                  <div
                    key={`card-${wire.id}`}
                    className={cn(
                      "rounded-xl border border-border/50 bg-card/75 p-4 shadow-sm backdrop-blur",
                      isPaused && "border-secondary/40",
                      isStopped && "opacity-60",
                      isLocked && "pointer-events-none opacity-50"
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-foreground">{wire.refWire}</span>
                          <Badge variant="outline" className="border-border/60 text-[0.65rem] uppercase">
                            {wire.marquage}
                          </Badge>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          Order {order.ofId} · {order.reference}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1 rounded-lg px-2 py-1 text-xs"
                        onClick={() => {
                          setScanningWireId(wire.id);
                          setValidationContext({ order, wire });
                          setSelectedWireId(wire.id);
                        }}
                        disabled={
                          validateWireMutation.isPending ||
                          !isNotValidated ||
                          validationLocked ||
                          isLocked ||
                          isCompleted ||
                          isStopped
                        }
                      >
                        <Scan className="h-4 w-4" /> Scan
                      </Button>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <StatusBadge status={wire.status} />
                      {isPaused ? (
                        <Badge variant="secondary" className="text-[0.65rem] uppercase">
                          Paused
                        </Badge>
                      ) : null}
                    </div>

                    <div className="mt-3 grid gap-2 text-xs text-muted-foreground">
                      <div className="flex items-center justify-between">
                        <span className="uppercase tracking-wide">Production</span>
                        <span className="font-medium text-foreground">
                          {wire.producedQuantity}/{wire.targetQuantity} ({wire.progressPercent.toFixed(0)}%)
                        </span>
                      </div>
                      <Progress value={wire.progressPercent} className="h-2" />
                      <div className="grid grid-cols-2 gap-2 text-[0.65rem]">
                        <span>Length {wire.lengthMm} mm</span>
                        <span>{colorLabel}</span>
                        <span>Section {sectionLabel}</span>
                      </div>
                      {(requiresBoot || requiresWheel || requiresFinal) && !isCompleted ? (
                        <div className="rounded-lg bg-muted/30 p-2 text-[0.65rem] text-muted-foreground">
                          {requiresBoot && <p>Boot test required before production can continue.</p>}
                          {requiresWheel && (
                            <p>Wheel test pending - production may continue, but completion waits for the result.</p>
                          )}
                          {requiresFinal && (
                            <p>Final test pending - wire will close once the final check passes.</p>
                          )}
                        </div>
                      ) : null}
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="icon"
                        variant="secondary"
                        className="h-10 w-10"
                        onClick={() => {
                          setSelectedWireId(wire.id);
                          if (operatorTestRecorded) {
                            const storedNotes = getOperatorTestNotes(
                              order.ofId,
                              order.reference,
                              wire.refWire,
                              wire.marquage,
                            );
                            setActionsContext({
                              order,
                              wire,
                              notes: storedNotes ?? {},
                            });
                          } else {
                            setTestContext({ order, wire });
                          }
                        }}
                        disabled={
                          operatorSubmitting ||
                          operatorTestMutation.isPending ||
                          isLocked ||
                          isStopped ||
                          isCompleted ||
                          (!operatorTestRecorded && !canOpenTest)
                        }
                      >
                        <PlayCircle className="h-5 w-5" />
                        <span className="sr-only">
                          {operatorTestRecorded ? "Operator Actions" : "Operator Test"}
                        </span>
                      </Button>
                      {operatorTestRecorded ? (
                        <Badge
                          variant="outline"
                          className="h-8 rounded-full border-success/40 px-3 text-[0.6rem] font-semibold uppercase tracking-wide text-success"
                        >
                          Operator test done
                        </Badge>
                      ) : null}
                      <Button
                        size="icon"
                        variant="outline"
                        className="h-10 w-10"
                        onClick={() => {
                          if (isPaused) {
                            resumeMutation.mutate(identifier);
                          } else {
                            pauseMutation.mutate(identifier);
                          }
                        }}
                        disabled={
                          pauseMutation.isPending ||
                          resumeMutation.isPending ||
                          stopMutation.isPending ||
                          isNotValidated ||
                          isLocked ||
                          isCompleted ||
                          isStopped
                        }
                      >
                        {isPaused ? <PlayCircle className="h-5 w-5" /> : <PauseCircle className="h-5 w-5" />}
                        <span className="sr-only">{isPaused ? "Resume" : "Pause"}</span>
                      </Button>
                      <Button
                        size="icon"
                        variant="destructive"
                        className="h-10 w-10"
                        onClick={() => setStopContext({ order, wire })}
                        disabled={stopMutation.isPending || isLocked || isCompleted || isStopped}
                      >
                        <CircleStop className="h-5 w-5" />
                        <span className="sr-only">Stop</span>
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <WireValidationDialog
        open={Boolean(validationContext)}
        wire={validationContext?.wire ?? null}
        order={validationContext?.order ?? null}
        isSubmitting={validateWireMutation.isPending}
        onOpenChange={(open) => {
          if (!open) {
            setValidationContext(null);
            setScanningWireId(null);
          }
        }}
        onConfirm={(_coilId) => {
          if (!validationContext) return;
          // After bobine validation, move to cosse validation
          setCosseValidationContext(validationContext);
          setValidationContext(null);
        }}
      />

      <CosseValidationDialog
        open={Boolean(cosseValidationContext)}
        wire={cosseValidationContext?.wire ?? null}
        order={cosseValidationContext?.order ?? null}
        isSubmitting={validateWireMutation.isPending}
        onOpenChange={(open) => {
          if (!open) {
            setCosseValidationContext(null);
            setScanningWireId(null);
          }
        }}
        onConfirm={() => {
          if (!cosseValidationContext) return;
          setScanningWireId(cosseValidationContext.wire.id);
          const identifier = makeWireIdentifier(cosseValidationContext.order, cosseValidationContext.wire);
          setCosseValidationContext(null);
          validateWireMutation.mutate(identifier);
        }}
      />

      <OperatorTestDialog
        open={Boolean(testContext)}
        wire={testContext?.wire ?? null}
        order={testContext?.order ?? null}
        isSubmitting={operatorSubmitting || operatorTestMutation.isPending}
        onOpenChange={(open) => {
          if (!open) setTestContext(null);
        }}
        onComplete={({ notes }) => {
          if (!testContext) return;
          const identifier = makeWireIdentifier(testContext.order, testContext.wire);
          handleOperatorTestComplete(identifier, testContext, notes);
        }}
        onPause={(identifier) => pauseMutation.mutate(identifier)}
        onResume={(identifier) => resumeMutation.mutate(identifier)}
        pausePending={pauseMutation.isPending || resumeMutation.isPending || stopMutation.isPending}
        initialNotes={activeDraft?.notes ?? null}
        initialActiveStep={activeDraft?.activeStep ?? null}
        onSaveDraft={({ notes, activeStep }) => {
          if (!testContext) return;
          saveOperatorTestDraft(
            testContext.order.ofId,
            testContext.order.reference,
            testContext.wire.refWire,
            testContext.wire.marquage,
            { notes, activeStep },
          );
        }}
      />

      <OperatorActionsDialog
        open={Boolean(actionsContext)}
        wire={actionsContext?.wire ?? null}
        order={actionsContext?.order ?? null}
        notes={actionsContext?.notes ?? null}
        isRecording={recordProgressMutation.isPending}
        printingEnabled={labelSettings.enabled}
        printingFormat={labelSettings.resolvedFormat}
        printerReady={labelSettings.ready}
        printingLoading={labelSettings.loading}
        onConfigurePrinter={() => openPrinterDialog()}
        onChangeCoil={handleChangeCoil}
        changeCoilDisabled={changeCoilDisabled}
        onOpenChange={(open) => {
          if (!open && !recordProgressMutation.isPending) {
            setActionsContext(null);
          }
        }}
        onRecordBundle={handleRecordBundle}
      />

      <LabelVerificationDialog
        open={Boolean(labelVerification)}
        order={labelVerification?.order ?? null}
        wire={labelVerification?.wire ?? null}
        labelId={labelVerification?.labelId ?? null}
        expectedBarcode={labelVerification?.expectedBarcode ?? null}
        quantity={labelVerification?.quantity ?? 0}
        verifying={labelVerification?.verifying ?? false}
        error={labelVerification?.error ?? null}
        onVerify={handleLabelVerificationSubmit}
        onReprint={handleLabelVerificationReprint}
        onCancel={handleLabelVerificationCancel}
      />

      <StopWireIdDialog
        open={Boolean(stopIdContext)}
        wire={stopIdContext?.wire ?? null}
        order={stopIdContext?.order ?? null}
        onOpenChange={(open) => !open && setStopIdContext(null)}
        onVerified={() => {
          setStopContext(stopIdContext);
          setStopIdContext(null);
        }}
      />

      <UnlockWireIdDialog
        open={Boolean(unlockIdContext)}
        wire={unlockIdContext?.wire ?? null}
        order={unlockIdContext?.order ?? null}
        onOpenChange={(open) => !open && setUnlockIdContext(null)}
        onVerified={(userId) => {
          if (unlockIdContext) {
            setUnlockContext({ ...unlockIdContext, userId });
            setUnlockIdContext(null);
          }
        }}
      />

      <UnlockOptionsDialog
        open={Boolean(unlockContext)}
        wire={unlockContext?.wire ?? null}
        order={unlockContext?.order ?? null}
        isSubmitting={unlockMutation.isPending}
        onOpenChange={(open) => !open && setUnlockContext(null)}
        onConfirm={(action) => {
          if (!unlockContext || !unlockContext.userId) return;
          const identifier = makeWireIdentifier(unlockContext.order, unlockContext.wire);
          unlockMutation.mutate({
            wire: identifier,
            userId: unlockContext.userId,
            action,
          });
        }}
      />

      <AlertDialog open={Boolean(stopContext)} onOpenChange={(open) => {
        if (!open && !stopMutation.isPending) {
          setStopContext(null);
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop wire?</AlertDialogTitle>
            <AlertDialogDescription>
              {stopContext ? `Stopping ${stopContext.wire.refWire} will mark the wire as stopped and block further production.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={stopMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={stopMutation.isPending}
              onClick={() => {
                if (!stopContext) return;
                const identifier = makeWireIdentifier(stopContext.order, stopContext.wire);
                stopMutation.mutate(identifier);
              }}
            >
              Stop Wire
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div >
  );
}
