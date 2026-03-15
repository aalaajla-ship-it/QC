import { useEffect, useState } from "react";
import { Shield, AlertCircle } from "lucide-react";

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
import { cn } from "@/lib/utils";
import type { WireSummary, WorkOrderSummary } from "@/lib/types";
import { verifyUserId } from "@/lib/api";

interface StopWireIdDialogProps {
    open: boolean;
    wire: WireSummary | null;
    order: WorkOrderSummary | null;
    onOpenChange: (open: boolean) => void;
    onVerified: () => void;
}

export function StopWireIdDialog({
    open,
    wire,
    order,
    onOpenChange,
    onVerified,
}: StopWireIdDialogProps) {
    const [userId, setUserId] = useState("");
    const [isVerifying, setIsVerifying] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (open) {
            setUserId("");
            setError(null);
        }
    }, [open]);

    const handleVerify = async () => {
        if (!userId.trim()) {
            setError("Please enter your user ID");
            return;
        }

        setIsVerifying(true);
        setError(null);

        try {
            const result = await verifyUserId(userId.trim());

            if (result.valid) {
                // Verification successful
                onVerified();
            } else {
                setError(result.message || "User ID not found in the operator list");
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
        } finally {
            setIsVerifying(false);
        }
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !isVerifying) {
            handleVerify();
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader className="space-y-2">
                    <DialogTitle className="flex items-center gap-2 text-lg">
                        <Shield className="h-5 w-5 text-destructive" />
                        Stop Wire - ID Verification Required
                    </DialogTitle>
                    <DialogDescription>
                        Enter your user ID to authorize stopping production for this wire.
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
                            <span className="text-muted-foreground">Marking</span>
                            <span className="font-medium text-foreground">{wire?.marquage ?? "—"}</span>
                        </div>
                    </section>

                    <section className="space-y-2">
                        <Label htmlFor="userId">User ID</Label>
                        <Input
                            id="userId"
                            autoFocus
                            value={userId}
                            onChange={(event) => setUserId(event.target.value)}
                            onKeyPress={handleKeyPress}
                            placeholder="Enter your user ID…"
                            className={cn(
                                "uppercase tracking-wide",
                                error && "border-destructive/60"
                            )}
                            disabled={isVerifying}
                        />
                        {error && (
                            <div className="flex items-center gap-2 text-xs text-destructive">
                                <AlertCircle className="h-3 w-3" />
                                <span>{error}</span>
                            </div>
                        )}
                    </section>

                    <div className="rounded-md bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
                        <span className="font-medium text-foreground">Important</span>
                        <p className="mt-1">
                            Only authorized operators can stop production. Your ID will be verified against the operator list.
                        </p>
                    </div>
                </div>

                <DialogFooter className="mt-4">
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isVerifying}>
                        Cancel
                    </Button>
                    <Button
                        onClick={handleVerify}
                        disabled={!userId.trim() || isVerifying}
                        variant="destructive"
                    >
                        {isVerifying ? "Verifying…" : "Verify ID"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
