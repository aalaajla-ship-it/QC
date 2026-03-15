import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, ClipboardList, Plus, Trash2, UserCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppFlow } from "@/context/AppFlowContext";
import { startSession } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";

type OrderDraft = {
  ofId: string;
  quantityTotal: string;
  bundleCount: string;
  reference: string;
};

const blankOrder: OrderDraft = {
  ofId: "",
  quantityTotal: "",
  bundleCount: "",
  reference: "",
};

export default function Orders() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { state, setSession, setOrders } = useAppFlow();
  const { toast } = useToast();

  const [operatorId, setOperatorId] = useState(state.session?.operatorId ?? "");
  const [machineId, setMachineId] = useState(state.session?.machineId ?? "");
  const [orders, setLocalOrders] = useState<OrderDraft[]>(
    state.orders.length
      ? state.orders.map((order) => ({
        ofId: order.ofId,
        quantityTotal: order.quantityTotal ? String(order.quantityTotal) : "",
        bundleCount: order.bundleCount ? String(order.bundleCount) : "",
        reference: order.reference,
      }))
      : [blankOrder],
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (state.orders.length === 0) {
      setLocalOrders([blankOrder]);
      return;
    }
    setLocalOrders(
      state.orders.map((order) => ({
        ofId: order.ofId,
        quantityTotal: order.quantityTotal ? String(order.quantityTotal) : "",
        bundleCount: order.bundleCount ? String(order.bundleCount) : "",
        reference: order.reference,
      })),
    );
  }, [state.orders]);

  const operatorName = state.session?.operatorName;
  const appUserName = state.credentials?.userName;
  const appUserRole = state.credentials?.role;

  const allFieldsPresent = useMemo(
    () =>
      orders.every(
        (order) =>
          order.ofId.trim() &&
          order.reference.trim() &&
          order.quantityTotal.trim() &&
          !Number.isNaN(Number(order.quantityTotal)),
      ),
    [orders],
  );

  const updateOrder = (index: number, field: keyof OrderDraft, value: string) => {
    setLocalOrders((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const addRow = () => setLocalOrders((prev) => [...prev, blankOrder]);

  const removeRow = (index: number) => {
    setLocalOrders((prev) => (prev.length === 1 ? prev : prev.filter((_, idx) => idx !== index)));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const normalizedOperator = operatorId.trim();
    if (!normalizedOperator) {
      toast({
        title: "Operator ID required",
        description: "Scan or enter the operator badge before continuing.",
        variant: "destructive",
      });
      return;
    }
    if (!allFieldsPresent) {
      toast({
        title: "Work order details missing",
        description: "Provide OF, reference, and quantity for each order before continuing.",
        variant: "destructive",
      });
      return;
    }

    const preparedOrders = orders.map((order) => ({
      ofId: order.ofId.trim(),
      quantityTotal: Number(order.quantityTotal),
      bundleCount: order.bundleCount.trim() ? Number(order.bundleCount) : 0,
      reference: order.reference.trim(),
    }));

    const invalidOrder = preparedOrders.find(
      (order) =>
        !Number.isFinite(order.quantityTotal) ||
        order.quantityTotal <= 0 ||
        !Number.isFinite(order.bundleCount) ||
        order.bundleCount < 0,
    );

    if (invalidOrder) {
      toast({
        title: "Invalid quantities",
        description: "Quantity and bundle counts must be positive numbers.",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);
    try {
      const sessionResponse = await startSession({
        operatorId: normalizedOperator,
        machineId: machineId.trim() || undefined,
        orders: preparedOrders,
      });
      setSession(sessionResponse);
      const resumedOrders = sessionResponse.orders.filter((order) => order.status !== "pending");
      const resumedSuffix =
        resumedOrders.length > 0
          ? ` Continuing ${resumedOrders.length} existing order${resumedOrders.length === 1 ? "" : "s"} already in progress.`
          : "";
      toast({
        title: "Operator linked",
        description: `Operator ${sessionResponse.operatorName} is now linked to this station.${resumedSuffix}`,
      });
      await queryClient.invalidateQueries({ queryKey: ["production-snapshot"] });

      const sessionOrders = sessionResponse.orders.map((order) => ({
        ofId: order.ofId,
        reference: order.reference,
        quantityTotal: order.quantityTotal,
        bundleCount: order.bundleCount,
      }));
      setOrders(sessionOrders);
      toast({
        title: "Session configured",
        description: "Redirecting to dashboard…",
      });
      navigate("/dashboard");
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Unable to start operator session.";
      const normalized = message.toLowerCase();
      const title = normalized.includes("only operator")
        ? "Order already in progress"
        : normalized.includes("completed")
          ? "Order already completed"
          : normalized.includes("duplicate work orders")
            ? "Duplicate orders detected"
            : "Unable to start session";
      toast({
        title,
        description: message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col gap-4 bg-gradient-to-br from-background to-muted/20 p-4 sm:p-6">
      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card className="border border-border/40 bg-card/80 backdrop-blur">
          <CardHeader className="border-b border-border/30">
            <CardTitle className="text-lg font-semibold text-foreground">Work Orders</CardTitle>
            <CardDescription className="text-sm text-muted-foreground">
              Configure operator session and work order details to start production
            </CardDescription>
          </CardHeader>

          <CardContent className="pt-6">
            <form className="space-y-6" onSubmit={handleSubmit}>
              <section className="grid gap-3 rounded-lg border border-border/40 bg-background/80 p-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="operatorId" className="text-xs font-medium">Operator ID</Label>
                  <Input
                    id="operatorId"
                    value={operatorId}
                    onChange={(event) => setOperatorId(event.target.value.toUpperCase())}
                    placeholder="Scan badge or enter ID"
                    className="h-9 rounded-lg text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="machineId" className="text-xs font-medium">Machine (optional)</Label>
                  <Input
                    id="machineId"
                    value={machineId}
                    onChange={(event) => setMachineId(event.target.value.toUpperCase())}
                    placeholder="Enter machine ID"
                    className="h-9 rounded-lg text-sm"
                  />
                </div>
                {operatorName && (
                  <p className="col-span-full text-xs text-muted-foreground">
                    Current: <span className="font-medium text-foreground">{operatorName}</span>
                  </p>
                )}
              </section>

              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">Orders</h3>
                  <Button type="button" variant="outline" size="sm" className="gap-1.5 text-xs" onClick={addRow}>
                    <Plus className="h-3.5 w-3.5" />
                    Add
                  </Button>
                </div>

                <div className="space-y-2.5">
                  {orders.map((order, idx) => (
                    <div
                      key={`order-${idx}`}
                      className="grid gap-2 rounded-lg border border-border/40 bg-background/90 p-2.5 sm:grid-cols-[repeat(4,minmax(0,1fr))_auto]"
                    >
                      <div className="space-y-1">
                        <Label htmlFor={`of-${idx}`} className="text-xs font-medium">Work Order</Label>
                        <Input
                          id={`of-${idx}`}
                          value={order.ofId}
                          onChange={(event) => updateOrder(idx, "ofId", event.target.value)}
                          placeholder="OF-203948"
                          className="h-9 rounded-lg text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`qty-${idx}`} className="text-xs font-medium">Quantity</Label>
                        <Input
                          id={`qty-${idx}`}
                          value={order.quantityTotal}
                          onChange={(event) => updateOrder(idx, "quantityTotal", event.target.value)}
                          inputMode="numeric"
                          placeholder="0"
                          className="h-9 rounded-lg text-sm"
                        />
                      </div>
                      {/* <div className="space-y-1">
                        <Label htmlFor={`bundle-${idx}`} className="text-xs font-medium">Bundles</Label>
                        <Input
                          id={`bundle-${idx}`}
                          value={order.bundleCount}
                          onChange={(event) => updateOrder(idx, "bundleCount", event.target.value)}
                          inputMode="numeric"
                          placeholder="0"
                          className="h-9 rounded-lg text-sm"
                        />
                      </div> */}
                      <div className="space-y-1">
                        <Label htmlFor={`ref-${idx}`} className="text-xs font-medium">Reference</Label>
                        <Input
                          id={`ref-${idx}`}
                          value={order.reference}
                          onChange={(event) => updateOrder(idx, "reference", event.target.value)}
                          placeholder="1245-998-A"
                          className="h-9 rounded-lg text-sm"
                        />
                      </div>
                      <div className="flex items-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => removeRow(idx)}
                          disabled={orders.length === 1}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          <span className="sr-only">Remove</span>
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <div className="flex items-center justify-end gap-2 border-t border-border/30 pt-4">
                <Button type="submit" className="h-9 text-sm" disabled={loading}>
                  {loading ? "Saving…" : "Launch Session"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="border border-border/40 bg-card/80 backdrop-blur">
          <CardHeader className="border-b border-border/30">
            <CardTitle className="text-base font-semibold text-foreground">Session Status</CardTitle>
            <p className="text-sm text-muted-foreground">Current user and operator information</p>
          </CardHeader>
          <CardContent className="space-y-3 pt-6">
            <div className="rounded-lg border border-border/40 bg-background/80 p-2.5">
              <p className="text-xs text-muted-foreground">Signed in</p>
              <p className="text-sm font-semibold text-foreground">{appUserName ?? "—"}</p>
              <p className="text-xs capitalize text-muted-foreground">{appUserRole ?? "unknown"}</p>
            </div>

            <div className="rounded-lg border border-border/40 bg-background/80 p-2.5">
              <p className="text-xs text-muted-foreground">Operator</p>
              <p className="text-sm font-semibold text-foreground">
                {operatorName ? operatorName : operatorId ? operatorId : "Pending"}
              </p>
              <p className="text-xs text-muted-foreground">
                Machine: {machineId || "—"}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
