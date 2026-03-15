import { useEffect, useMemo, useState } from "react";
import { Scan, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { fetchCrimpToolSpec, type CrimpToolSpec } from "@/lib/api";
import type { WireSummary, WorkOrderSummary } from "@/lib/types";

interface CosseValidationDialogProps {
    open: boolean;
    wire: WireSummary | null;
    order: WorkOrderSummary | null;
    isSubmitting: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => Promise<void> | void;
}

function describeColor(wire: WireSummary | null): string {
    if (!wire) return "—";
    const parts = [wire.colorPrimary, wire.colorSecondary].filter(
        (part): part is string => Boolean(part && part.trim()),
    );
    if (parts.length === 0) return "Not specified";
    return parts.join(" / ");
}

function shouldValidateTerminal(terminal: string | null | undefined): boolean {
    if (!terminal) return false;
    const trimmed = terminal.trim();
    // Skip if starts with "__" or doesn't start with "TER"
    if (trimmed.startsWith("__")) return false;
    if (!trimmed.toUpperCase().startsWith("TER")) return false;
    return true;
}

type ValidationStep = "left" | "right" | "complete";

export function CosseValidationDialog({
    open,
    wire,
    order,
    isSubmitting,
    onOpenChange,
    onConfirm,
}: CosseValidationDialogProps) {
    const [cosseInput, setCosseInput] = useState("");
    const [override, setOverride] = useState(false);
    const [currentStep, setCurrentStep] = useState<ValidationStep>("left");
    const [crimpSpec, setCrimpSpec] = useState<CrimpToolSpec | null>(null);

    const validationSteps = useMemo(() => {
        const steps: Array<{ step: ValidationStep; terminal: string; label: string }> = [];

        if (shouldValidateTerminal(wire?.ext1?.terminal)) {
            steps.push({
                step: "left",
                terminal: wire!.ext1!.terminal!,
                label: "Left Terminal (Term. A)",
            });
        }

        if (shouldValidateTerminal(wire?.ext2?.terminal)) {
            steps.push({
                step: "right",
                terminal: wire!.ext2!.terminal!,
                label: "Right Terminal (Term. B)",
            });
        }

        return steps;
    }, [wire?.ext1?.terminal, wire?.ext2?.terminal]);

    const currentStepInfo = useMemo(() => {
        return validationSteps.find((s) => s.step === currentStep);
    }, [validationSteps, currentStep]);

    const currentStepIndex = useMemo(() => {
        return validationSteps.findIndex((s) => s.step === currentStep);
    }, [validationSteps, currentStep]);

    useEffect(() => {
        if (open) {
            setCosseInput("");
            setOverride(false);
            // Set initial step to the first valid terminal
            if (validationSteps.length > 0) {
                setCurrentStep(validationSteps[0].step);
            } else {
                setCurrentStep("complete");
            }
        }
    }, [open, wire?.id, validationSteps]);

    useEffect(() => {
        if (currentStepInfo?.terminal) {
            console.log("Fetching crimp spec for terminal:", currentStepInfo.terminal, "joint:", currentStep === "left" ? wire?.ext1?.joint : wire?.ext2?.joint);
            // Make the API call non-blocking to prevent UI freeze
            setTimeout(() => {
                fetchCrimpToolSpec({
                    terminal: currentStepInfo.terminal,
                    joint: currentStep === "left" ? wire?.ext1?.joint : wire?.ext2?.joint,
                })
                    .then((data) => {
                        console.log("Crimp spec data received:", data);
                        setCrimpSpec(data);
                    })
                    .catch((error) => {
                        console.error("Failed to fetch crimp spec:", error);
                        setCrimpSpec(null);
                    });
            }, 0);
        } else {
            console.log("No terminal to fetch crimp spec for");
            setCrimpSpec(null);
        }
    }, [currentStepInfo?.terminal, currentStep, wire?.ext1?.joint, wire?.ext2?.joint]);

    // Auto-complete if no terminals need validation
    useEffect(() => {
        if (open && validationSteps.length === 0) {
            // No terminals to validate, proceed automatically
            onConfirm();
            onOpenChange(false);
        }
    }, [open, validationSteps, onConfirm, onOpenChange]);

    const targetSection = useMemo(() => {
        if (!wire?.section) return "—";
        return `${wire.section.toFixed(2)} mm²`;
    }, [wire?.section]);

    const targetLength = useMemo(() => {
        if (!wire) return "—";
        return `${wire.lengthMm} mm ±5`;
    }, [wire]);

    const cosseMatch = useMemo(() => {
        if (!currentStepInfo) return false;
        // Compare only the first 8 characters to handle barcodes with dates
        const inputFirst8 = cosseInput.trim().toLowerCase().substring(0, 8);
        const terminalFirst8 = currentStepInfo.terminal.trim().toLowerCase().substring(0, 8);
        return inputFirst8 === terminalFirst8 && inputFirst8.length === 8;
    }, [cosseInput, currentStepInfo]);

    const extType = wire?.ext1?.kind ?? wire?.ext2?.kind ?? null;

    const disableConfirm = !override && !cosseMatch;

    const handleConfirm = () => {
        if (!currentStepInfo) return;

        // Move to next step or complete
        const nextIndex = currentStepIndex + 1;
        if (nextIndex < validationSteps.length) {
            // Move to next terminal
            setCurrentStep(validationSteps[nextIndex].step);
            setCosseInput("");
            setOverride(false);
        } else {
            // All steps validated, complete
            onConfirm();
        }
    };

    if (!open || validationSteps.length === 0) {
        return null;
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader className="space-y-2">
                    <DialogTitle className="flex items-center gap-2 text-lg">
                        <Scan className="h-5 w-5 text-primary" />
                        Validate Cosse (Terminal) For Production
                    </DialogTitle>
                    <DialogDescription>
                        {currentStepInfo
                            ? `Validate ${currentStepInfo.label} - Step ${currentStepIndex + 1} of ${validationSteps.length}`
                            : "Terminal validation"}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    <section className="grid gap-3 rounded-lg border border-border/50 bg-muted/20 p-4 text-sm">
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">Order</span>
                            <div className="flex items-center gap-2">
                                <Badge variant="outline" className="border-border/60">
                                    {order?.ofId ?? "—"}
                                </Badge>
                                <Badge variant="outline" className="border-border/60">
                                    {order?.reference ?? "—"}
                                </Badge>
                            </div>
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">Wire Reference</span>
                            <span className="font-medium text-foreground">{wire?.refWire ?? "—"}</span>
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">Current Step</span>
                            <Badge variant="default" className="font-mono">
                                {currentStepInfo?.label}
                            </Badge>
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">Section</span>
                            <span className="font-medium text-foreground">{targetSection}</span>
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">Color</span>
                            <span className="font-medium text-foreground">{describeColor(wire)}</span>
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">Length</span>
                            <span className="font-medium text-foreground">{targetLength}</span>
                        </div>
                        {extType ? (
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">Process</span>
                                <span className="font-medium capitalize text-foreground">{extType}</span>
                            </div>
                        ) : null}
                    </section>

                    {/* Progress indicator */}
                    <div className="flex items-center gap-2">
                        {validationSteps.map((step, idx) => (
                            <div key={step.step} className="flex items-center gap-2 flex-1">
                                <div
                                    className={cn(
                                        "flex-1 h-2 rounded-full transition-colors",
                                        idx < currentStepIndex
                                            ? "bg-success"
                                            : idx === currentStepIndex
                                                ? "bg-primary"
                                                : "bg-muted"
                                    )}
                                />
                                {idx < validationSteps.length - 1 && (
                                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                )}
                            </div>
                        ))}
                    </div>

                    <section className="space-y-2">
                        <Label htmlFor="cosseInput">
                            Scan or enter {currentStepInfo?.label.toLowerCase()} identifier
                        </Label>
                        <Input
                            id="cosseInput"
                            autoFocus
                            value={cosseInput}
                            onChange={(event) => setCosseInput(event.target.value)}
                            placeholder={`Scan ${currentStepInfo?.label.toLowerCase()} barcode…`}
                            className={cn(
                                "uppercase tracking-wide",
                                cosseInput && !cosseMatch && !override && "border-destructive/60 text-destructive",
                            )}
                        />
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span>
                                Expected: <span className="font-medium uppercase text-foreground">
                                    {currentStepInfo?.terminal || "—"}
                                </span>
                            </span>
                            {cosseInput ? (
                                <span
                                    className={cn(
                                        "font-semibold uppercase",
                                        cosseMatch ? "text-success" : override ? "text-warning" : "text-destructive",
                                    )}
                                >
                                    {cosseMatch ? "Match confirmed" : override ? "Manual override" : "Mismatch"}
                                </span>
                            ) : null}
                        </div>
                    </section>

                    <section className="grid gap-3 rounded-lg border border-border/50 bg-muted/20 p-4 text-sm">
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">STATUT</span>
                            <span
                                className={cn(
                                    "font-medium",
                                    crimpSpec?.status === "VALIDE" ? "text-green-600" : "text-red-600"
                                )}
                            >
                                {crimpSpec?.status || "—"}
                            </span>
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">APPLICATEUR</span>
                            <span className="font-medium text-foreground">
                                {crimpSpec?.terminalRef || "—"}
                            </span>
                        </div>
                    </section>

                    {!cosseMatch ? (
                        <button
                            type="button"
                            className="inline-flex w-full items-center justify-center rounded-md border border-border/60 bg-muted/10 px-3 py-2 text-xs font-medium text-muted-foreground transition hover:bg-muted/20"
                            onClick={() => setOverride((prev) => !prev)}
                        >
                            {override ? "Disable override (require terminal scan)" : "Override terminal check (authorized only)"}
                        </button>
                    ) : null}

                    <Separator />

                    <div className="grid gap-2 rounded-md bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
                        <span className="font-medium text-foreground">Terminal Validation Progress</span>
                        <span>
                            Validating {currentStepIndex + 1} of {validationSteps.length} terminals.
                            {validationSteps.length > 1 && currentStepIndex < validationSteps.length - 1
                                ? " Click continue to proceed to the next terminal."
                                : " Click validate to complete."}
                        </span>
                    </div>
                </div>

                <DialogFooter className="mt-4">
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                        Cancel
                    </Button>
                    <Button
                        onClick={handleConfirm}
                        disabled={disableConfirm || isSubmitting}
                    >
                        {isSubmitting
                            ? "Validating…"
                            : currentStepIndex < validationSteps.length - 1
                                ? "Continue to Next Terminal"
                                : "Validate Wire"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
