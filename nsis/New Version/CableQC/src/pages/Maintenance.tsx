import { Construction } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Maintenance() {
  return (
    <div className="flex h-full flex-1 items-center justify-center bg-gradient-to-br from-background to-muted/30 p-6">
      <Card className="max-w-md border border-dashed border-border/50 bg-card/80 text-center shadow-sm backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center justify-center gap-2 text-lg font-semibold text-foreground">
            <Construction className="h-5 w-5 text-warning" />
            Maintenance
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>This area is currently in development.</p>
          <p>Planned features include maintenance tickets, preventive tasks, and stock monitoring.</p>
        </CardContent>
      </Card>
    </div>
  );
}

/* Previous implementation retained for future reference.

import { AlertTriangle, BatteryCharging, ClipboardCheck, Factory, LifeBuoy, Settings, Wrench } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type TicketPriority = "critical" | "high" | "medium";

type MaintenanceTicket = {
  id: number;
  title: string;
  asset: string;
  reportedBy: string;
  openedAt: string;
  status: "in_progress" | "waiting_parts" | "scheduled";
  priority: TicketPriority;
};

type PreventiveTask = {
  id: number;
  asset: string;
  description: string;
  window: string;
  owner: string;
};

type StockItem = {
  id: number;
  part: string;
  reference: string;
  quantity: number;
  minimum: number;
};

const ACTIVE_TICKETS: MaintenanceTicket[] = [
  { id: 1, title: "Press A micro-switch fault", asset: "Crimp Press A", reportedBy: "Operator Station 3", openedAt: "07:10", status: "in_progress", priority: "critical" },
  { id: 2, title: "Wheel torque tool drifting", asset: "QC Wheel Bench", reportedBy: "Quality Team", openedAt: "07:48", status: "waiting_parts", priority: "high" },
  { id: 3, title: "Lighting fixture flicker", asset: "Assembly Cell 2", reportedBy: "Shift Supervisor", openedAt: "06:55", status: "scheduled", priority: "medium" },
];

const PREVENTIVE_TASKS: PreventiveTask[] = [
  { id: 1, asset: "Crimp Press B", description: "Lubrication cycle & calibration check", window: "Today • 14:30", owner: "Maintenance Lead" },
  { id: 2, asset: "Cutting Station", description: "Blade inspection and replacement", window: "Tomorrow • 06:30", owner: "Night Shift" },
  { id: 3, asset: "Vision Camera", description: "Lens clean + focus verification", window: "Friday • 11:00", owner: "Quality Support" },
];

const STOCK_LEVELS: StockItem[] = [
  { id: 1, part: "AMP Terminal 180908", reference: "AMP-180908", quantity: 620, minimum: 500 },
  { id: 2, part: "Crimp blade set 0.75 mm²", reference: "CBL-075", quantity: 8, minimum: 10 },
  { id: 3, part: "Wheel torque adaptor", reference: "WTA-220", quantity: 3, minimum: 3 },
];

const PRIORITY_BADGES: Record<TicketPriority, { label: string; className: string }> = {
  critical: { label: "Critical", className: "border-destructive/40 bg-destructive/10 text-destructive" },
  high: { label: "High", className: "border-warning/40 bg-warning/10 text-warning" },
  medium: { label: "Medium", className: "border-primary/30 bg-primary/10 text-primary" },
};

const STATUS_LABELS: Record<MaintenanceTicket["status"], { label: string; className: string }> = {
  in_progress: { label: "In progress", className: "border-success/30 bg-success/10 text-success" },
  waiting_parts: { label: "Waiting parts", className: "border-warning/30 bg-warning/10 text-warning" },
  scheduled: { label: "Scheduled", className: "border-border/70 bg-muted/40 text-muted-foreground" },
};

export default function Maintenance() {
  return (
    <div className="flex flex-1 flex-col gap-4 bg-gradient-to-br from-background to-muted/20 p-4 sm:p-6">
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          title="Open"
          value="3"
          icon={<Wrench className="h-4 w-4 text-primary" />}
        />
        <SummaryCard
          title="Response Time"
          value="11 min"
          icon={<LifeBuoy className="h-4 w-4 text-secondary" />}
        />
        <SummaryCard
          title="Completed"
          value="5"
          icon={<ClipboardCheck className="h-4 w-4 text-success" />}
        />
        <SummaryCard
          title="Next Service"
          value="14:30"
          icon={<Factory className="h-4 w-4 text-warning" />}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <Card className="border border-border/40 bg-card/80 backdrop-blur">
          <CardHeader className="flex flex-row items-center justify-between border-b border-border/30">
            <CardTitle className="text-base font-semibold text-foreground">Tickets</CardTitle>
            <Button variant="outline" size="sm" className="gap-1.5 text-xs">
              <Settings className="h-3.5 w-3.5" />
              Assign
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow className="border-border/30">
                  <TableHead className="text-xs">Ticket</TableHead>
                  <TableHead className="text-xs">Asset</TableHead>
                  <TableHead className="text-xs">Opened</TableHead>
                  <TableHead className="text-xs">Status</TableHead>
                  <TableHead className="text-xs">Priority</TableHead>
                  <TableHead className="text-right text-xs">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ACTIVE_TICKETS.map((ticket) => {
                  const priority = PRIORITY_BADGES[ticket.priority];
                  const status = STATUS_LABELS[ticket.status];
                  return (
                    <TableRow key={ticket.id} className="border-border/30">
                      <TableCell className="py-3">
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-foreground">{ticket.title}</span>
                          <span className="text-xs text-muted-foreground">{ticket.reportedBy}</span>
                        </div>
                      </TableCell>
                      <TableCell className="py-3 text-xs text-muted-foreground">{ticket.asset}</TableCell>
                      <TableCell className="py-3 text-xs text-muted-foreground">{ticket.openedAt}</TableCell>
                      <TableCell className="py-3">
                        <Badge variant="outline" className={cn("rounded-full border px-2 py-0.5 text-xs", status.className)}>
                          {status.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-3">
                        <Badge variant="outline" className={cn("rounded-full border px-2 py-0.5 text-xs", priority.className)}>
                          <AlertTriangle className="mr-1 h-2.5 w-2.5" />
                          {priority.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-3 text-right">
                        <Button size="sm" variant="outline" className="h-8 text-xs">
                          Dispatch
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="border border-border/40 bg-card/80 backdrop-blur">
          <CardHeader className="border-b border-border/30">
            <CardTitle className="text-base font-semibold text-foreground">Preventive</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5 pt-6">
            {PREVENTIVE_TASKS.map((task) => (
              <div key={task.id} className="rounded-lg border border-border/40 bg-background/60 p-2.5 text-xs">
                <p className="font-medium text-foreground">{task.asset}</p>
                <p className="text-xs text-muted-foreground">{task.description}</p>
                <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{task.owner}</span>
                  <span>{task.window}</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      <Card className="border border-border/40 bg-card/80 backdrop-blur">
        <CardHeader className="flex flex-row items-center justify-between border-b border-border/30">
          <CardTitle className="text-base font-semibold text-foreground">Stock</CardTitle>
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-primary">
            <BatteryCharging className="h-3.5 w-3.5" />
            Reorder
          </Button>
        </CardHeader>
        <CardContent className="grid gap-2.5 p-4 md:grid-cols-2 lg:grid-cols-3">
          {STOCK_LEVELS.map((item) => {
            const belowMinimum = item.quantity <= item.minimum;
            return (
              <div key={item.id} className={cn("rounded-lg border border-border/40 bg-background/60 p-2.5 text-xs", belowMinimum && "border-destructive/40 bg-destructive/5")}>
                <p className="font-medium text-foreground">{item.part}</p>
                <p className="text-xs text-muted-foreground">{item.reference}</p>
                <div className="mt-2 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">On hand: <span className="font-medium text-foreground">{item.quantity}</span></span>
                  <span className="text-muted-foreground">Min: {item.minimum}</span>
                </div>
                {belowMinimum ? (
                  <Badge variant="outline" className="mt-2 w-fit rounded-full border border-destructive/40 bg-destructive/10 text-xs text-destructive">
                    Low stock
                  </Badge>
                ) : null}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({
  title,
  value,
  icon,
}: {
  title: string;
  value: string;
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

*/
