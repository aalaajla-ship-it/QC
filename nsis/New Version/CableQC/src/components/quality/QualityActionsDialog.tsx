import {
  ShieldCheck,
  PlayCircle,
  ClipboardCheck,
  History as HistoryIcon,
  ScrollText,
  UserCheck,
  CheckCircle2,
  Loader2,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { QualityTestType } from "@/lib/api";
import type { WorkOrderSummary, WireSummary } from "@/lib/types";

interface QualityActionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: WorkOrderSummary | null;
  wire: WireSummary | null;
  stage: QualityTestType | null;
  qualityAgentId: string | null;
  onShowResults?: () => void;
  onStartAnother?: () => void;
  onStartFinal?: () => void;
  onValidateProduction?: () => void;
  canValidateProduction?: boolean;
  validateInProgress?: boolean;
  onQualityControl?: () => void;
  onHistory?: () => void;
  onChangeAgent?: () => void;
  resultsAvailable?: boolean;
}

function stageLabel(stage: QualityTestType | null): string {
  switch (stage) {
    case "boot":
      return "Boot";
    case "wheel":
      return "Wheel";
    case "final":
      return "Final";
    default:
      return "Quality";
  }
}

export function QualityActionsDialog({
  open,
  onOpenChange,
  order,
  wire,
  stage,
  qualityAgentId,
  onShowResults,
  onStartAnother,
  onStartFinal,
  onValidateProduction,
  canValidateProduction = false,
  validateInProgress = false,
  onQualityControl,
  onHistory,
  onChangeAgent,
  resultsAvailable = false,
}: QualityActionsDialogProps) {
  const stageText = stageLabel(stage);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Quality actions</DialogTitle>
          <DialogDescription>
            Next steps for {wire ? `${wire.refWire} · ${wire.marquage}` : "the selected wire"} after the {stageText.toLowerCase()} test.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border border-border/50 bg-muted/20 p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-1">
                <p className="font-semibold text-foreground">
                  {order ? `${order.ofId} · ${order.reference}` : "Work order context"}
                </p>
                <p className="text-xs text-muted-foreground">Stage completed: {stageText}</p>
                {qualityAgentId ? (
                  <p className="text-xs text-muted-foreground">Signed in as QA {qualityAgentId}</p>
                ) : (
                  <p className="text-xs text-destructive">Quality agent not authenticated.</p>
                )}
              </div>
              {qualityAgentId ? (
                <Badge variant="secondary" className="text-xs uppercase tracking-wider">
                  QA Active
                </Badge>
              ) : null}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => onChangeAgent?.()}
                disabled={!onChangeAgent}
              >
                <UserCheck className="h-4 w-4" />
                Change quality agent
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => onShowResults?.()}
                disabled={!resultsAvailable}
              >
                <ScrollText className="h-4 w-4" />
                Show test results
              </Button>
            </div>
          </div>

          <div className="space-y-3">
            <Button
              type="button"
              className="w-full gap-2"
              onClick={() => onStartAnother?.()}
              disabled={!onStartAnother}
            >
              <PlayCircle className="h-4 w-4" />
              Quality start test
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="w-full gap-2"
              onClick={() => onStartFinal?.()}
              disabled={!onStartFinal}
            >
              <ClipboardCheck className="h-4 w-4" />
              Final test
            </Button>
            <Button
              type="button"
              className="w-full gap-2"
              onClick={() => onValidateProduction?.()}
              disabled={!onValidateProduction || !canValidateProduction || validateInProgress}
            >
              {validateInProgress ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              Validate production
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="w-full gap-2"
              onClick={() => onQualityControl?.()}
              disabled={!onQualityControl}
            >
              <ShieldCheck className="h-4 w-4" />
              Quality control login
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full gap-2"
              onClick={() => onHistory?.()}
              disabled={!onHistory}
            >
              <HistoryIcon className="h-4 w-4" />
              Open history
            </Button>
          </div>
        </div>

        <DialogFooter className="mt-2 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
