import { useMemo, useState } from "react";

import { completeQualityTest, type CompleteQualityTestResponse, type QualityTestType } from "@/lib/api";
import type { WorkOrderSummary, WireSummary } from "@/lib/types";
import { OperatorTestDialog } from "@/components/production/OperatorTestDialog";

interface QualityDialogTask {
  stage: QualityTestType;
  order: WorkOrderSummary;
  wire: WireSummary;
  label: string;
  description: string;
}

interface QualityTestDialogProps {
  open: boolean;
  task: QualityDialogTask | null;
  onOpenChange: (open: boolean) => void;
  onCompleted: (response: CompleteQualityTestResponse, notes: Record<string, string>) => void;
  onError?: (message: string) => void;
  qualityAgentId: string | null;
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

function buildIdentifier(task: QualityDialogTask | null) {
  if (!task) return null;
  return {
    workOrderId: task.order.id,
    refWire: task.wire.refWire,
    marquage: task.wire.marquage,
  };
}

export function QualityTestDialog({
  open,
  task,
  onOpenChange,
  onCompleted,
  onError,
  qualityAgentId,
}: QualityTestDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const identifier = useMemo(
    () => buildIdentifier(task),
    [task?.order.id, task?.wire.id, task?.wire.marquage, task?.wire.refWire],
  );

  const handleComplete = async ({ notes }: { notes: Record<string, string> }) => {
    if (!task || !identifier) {
      return;
    }
    try {
      const trimmedAgentId = qualityAgentId?.trim();
      if (!trimmedAgentId) {
        onError?.("Quality agent authentication is required before performing this test.");
        return;
      }
      setIsSubmitting(true);

      const response = await completeQualityTest({
        wire: identifier,
        test: task.stage,
        notes,
        qualityAgentId: trimmedAgentId,
      });
      onCompleted(response, notes);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unable to complete quality test.";
      onError?.(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!task) {
    return null;
  }

  return (
    <OperatorTestDialog
      open={open}
      wire={task.wire}
      order={task.order}
      isSubmitting={isSubmitting}
      onOpenChange={onOpenChange}
      onComplete={handleComplete}
      pausePending={false}
      variant="quality"
      showPauseControls={false}
      workflowTitle={`${stageLabel(task.stage)} quality workflow`}
      workflowDescription={`Perform the ${stageLabel(task.stage).toLowerCase()} inspection for ${task.wire.refWire}.`}
      confirmLabel={`Complete ${stageLabel(task.stage)} test`}
      qualityAgentId={qualityAgentId}
    />
  );
}
