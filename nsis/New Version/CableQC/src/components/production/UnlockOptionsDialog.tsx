import { useState } from "react";
import { PlayCircle, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import type { WireSummary, WorkOrderSummary } from "@/lib/types";

interface UnlockOptionsDialogProps {
    open: boolean;
    wire: WireSummary | null;
    order: WorkOrderSummary | null;
    onOpenChange: (open: boolean) => void;
    onConfirm: (action: "restart" | "continue") => void;
    isSubmitting: boolean;
}

export function UnlockOptionsDialog({
    open,
    wire,
    order,
    onOpenChange,
    onConfirm,
    isSubmitting,
}: UnlockOptionsDialogProps) {
    const [action, setAction] = useState<"restart" | "continue">("continue");

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Unlock Production</DialogTitle>
                    <DialogDescription>
                        Choose how you want to proceed with wire <strong>{wire?.refWire}</strong>.
                    </DialogDescription>
                </DialogHeader>

                <div className="grid gap-4 py-4">
                    <RadioGroup
                        value={action}
                        onValueChange={(val) => setAction(val as "restart" | "continue")}
                        className="grid gap-4"
                    >
                        <div>
                            <RadioGroupItem
                                value="continue"
                                id="continue"
                                className="peer sr-only"
                            />
                            <Label
                                htmlFor="continue"
                                className={cn(
                                    "flex cursor-pointer items-start gap-4 rounded-lg border border-border p-4 hover:bg-muted/50 peer-data-[state=checked]:border-primary peer-data-[state=checked]:bg-primary/5",

                                )}
                            >
                                <div className="mt-1">
                                    <PlayCircle className="h-5 w-5 text-primary" />
                                </div>
                                <div className="space-y-1">
                                    <div className="font-semibold leading-none tracking-tight">
                                        Continue Production
                                    </div>
                                    <div className="text-sm text-muted-foreground">
                                        Resume production from where it was stopped. The produced quantity will be preserved.
                                    </div>
                                </div>
                            </Label>
                        </div>

                        <div>
                            <RadioGroupItem
                                value="restart"
                                id="restart"
                                className="peer sr-only"
                            />
                            <Label
                                htmlFor="restart"
                                className={cn(
                                    "flex cursor-pointer items-start gap-4 rounded-lg border border-border p-4 hover:bg-muted/50 peer-data-[state=checked]:border-primary peer-data-[state=checked]:bg-primary/5",
                                )}
                            >
                                <div className="mt-1">
                                    <RotateCcw className="h-5 w-5 text-orange-500" />
                                </div>
                                <div className="space-y-1">
                                    <div className="font-semibold leading-none tracking-tight">
                                        Restart Production
                                    </div>
                                    <div className="text-sm text-muted-foreground">
                                        Reset produced quantity to 0 and restart validation/testing process.
                                    </div>
                                </div>
                            </Label>
                        </div>
                    </RadioGroup>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                        Cancel
                    </Button>
                    <Button onClick={() => onConfirm(action)} disabled={isSubmitting}>
                        {action === "restart" ? "Confirm Restart" : "Confirm Continue"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
