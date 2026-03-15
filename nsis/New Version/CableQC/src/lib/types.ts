export interface WireTerminalSpec {
  terminal?: string | null;
  joint?: string | null;
  stripping?: number | null;
  kind?: string | null;
}

export type WireStatus =
  | "not_validated"
  | "validated"
  | "qc_boot"
  | "in_production"
  | "qc_wheel"
  | "qc_final"
  | "paused"
  | "stopped"
  | "completed";

export interface WireIdentifier {
  workOrderId: number;
  refWire: string;
  marquage: string;
}

export interface WireSummary {
  id: number;
  refCoil: string;
  refWire: string;
  marquage: string;
  operatorTestDone: boolean;
  lengthMm: number;
  section?: number | null;
  colorPrimary?: string | null;
  colorSecondary?: string | null;
  bundleCount: number;
  status: WireStatus;
  previousStatus: WireStatus | null;
  producedQuantity: number;
  targetQuantity: number;
  progressPercent: number;
  bootTestDone: boolean;
  bootTestRequired: boolean;
  bootTestRequiredCount: number;
  bootTestDoneCount: number;
  wheelTestDone: boolean;
  wheelTestRequired: boolean;
  finalTestDone: boolean;
  finalTestRequired: boolean;
  ext1?: WireTerminalSpec | null;
  ext2?: WireTerminalSpec | null;
}

export interface WorkOrderSummary {
  id: number;
  ofId: string;
  reference: string;
  quantityTotal: number;
  bundleCount: number;
  status: string;
  progressPercent: number;
  machineId?: string | null;
  wires: WireSummary[];
}

export interface ProductionTotals {
  totalOrders: number;
  activeOrders: number;
  completedOrders: number;
  totalWires: number;
  validatedWires: number;
  completedWires: number;
  testsBlocking: number;
  averageProgress: number;
}

export interface ProductionSnapshot {
  totals: ProductionTotals;
  orders: WorkOrderSummary[];
}
