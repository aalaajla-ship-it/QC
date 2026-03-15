import { invoke } from "@tauri-apps/api/tauri";
import type { ProductionSnapshot, WorkOrderSummary, WireIdentifier } from "@/lib/types";

type ApiOverrides = Partial<{
  validateLogin: (payload: { userId: string; userName: string; role: string }) => Promise<LoginResponse>;
  performPreflight: () => Promise<PreflightReport>;
  startSession: (payload: { operatorId: string; machineId?: string; orders: WorkOrderInput[] }) => Promise<SessionStartResponse>;
  logout: () => Promise<void>;
  fetchProductionSnapshot: () => Promise<ProductionSnapshot>;
  validateWire: (payload: WireIdentifier) => Promise<ProductionSnapshot>;
  pauseWire: (payload: WireIdentifier) => Promise<ProductionSnapshot>;
  resumeWire: (payload: WireIdentifier) => Promise<ProductionSnapshot>;
  stopWire: (payload: WireIdentifier) => Promise<ProductionSnapshot>;
  recordWireProgress: (payload: { wire: WireIdentifier; producedIncrement: number }) => Promise<ProductionSnapshot>;
  finalizeWireProduction: (payload: { wire: WireIdentifier; qualityAgentId: string }) => Promise<ProductionSnapshot>;
  completeOperatorTest: (payload: { wire: WireIdentifier; notes: Record<string, string> }) => Promise<ProductionSnapshot>;
  fetchOperatorTestResults: (wire: WireIdentifier) => Promise<TestResult | null>;
  completeQualityTest: (payload: {
    wire: WireIdentifier;
    test: QualityTestType;
    notes: Record<string, string>;
    qualityAgentId: string;
  }) => Promise<CompleteQualityTestResponse>;
  fetchCrimpToolSpec: (payload: { terminal: string; joint?: string | null }) => Promise<CrimpToolSpec | null>;
  fetchLabelPrinterSettings: () => Promise<LabelPrinterSettingsResponse>;
  saveLabelPrinterSettings: (payload: SaveLabelPrinterSettingsPayload) => Promise<LabelPrinterSettingsResponse>;
  listLabelPrinters: () => Promise<string[]>;
  printBundleLabel: (payload: BundleLabelRequest) => Promise<BundleLabelResult>;
  verifyBundleLabel: (payload: {
    wire: WireIdentifier;
    labelId: string;
    barcode: string;
    bacId: string;
    quantity: number;
  }) => Promise<void>;
  saveMicroscopePhoto: (payload: SaveMicroscopePhotoRequest) => Promise<string>;
  fetchHistoryLogs: (payload?: HistoryQuery) => Promise<HistoryLogPage>;
  triggerDepartmentCall: (payload: { department: string }) => Promise<void>;
  verifyUserId: (userId: string) => Promise<VerifyUserResponse>;
  unlockWire: (payload: {
    wire: WireIdentifier;
    userId: string;
    action: "restart" | "continue";
  }) => Promise<ProductionSnapshot>;
  saveCameraPhoto: (payload: SaveCameraPhotoRequest) => Promise<string>;
  getMicroscopePhoto: (path: string) => Promise<string>;
}>;

type GlobalWithOverrides = typeof globalThis & { __APP_API_OVERRIDES__?: ApiOverrides };

function getApiOverride<K extends keyof ApiOverrides>(key: K): ApiOverrides[K] | undefined {
  const overrides = (globalThis as GlobalWithOverrides).__APP_API_OVERRIDES__;
  return overrides?.[key];
}

export interface CheckStatus {
  ok: boolean;
  message: string;
}

export interface PreflightReport {
  appDb: CheckStatus;
  crimpDb: CheckStatus;
  sharedFolder: CheckStatus;
  microscopeFolder: CheckStatus;
  api: CheckStatus;
}

export interface CrimpToolSpec {
  status: string | null;
  statusOk: boolean;
  terminalRef: string | null;
  jointRef: string | null;
  hcMin: number | null;
  hcMax: number | null;
  hcNominal: number | null;
  tractionNominal: number | null;
}

export interface TestMeasurementVerdict {
  key: string;
  value: number | null;
  nominal: number | null;
  lowerBound: number | null;
  upperBound: number | null;
  unit: string | null;
  passed: boolean | null;
}

export interface TestResult {
  status: string | null;
  overallPassed: boolean | null;
  verdicts: TestMeasurementVerdict[];
}

export interface LoginResponse {
  userId: string;
  userName: string;
  role: string;
  csvRole?: string | null;
}

export interface SessionStartResponse {
  operatorId: string;
  operatorName: string;
  machineId?: string | null;
  orders: WorkOrderSummary[];
}

export interface WorkOrderInput {
  ofId: string;
  reference: string;
  quantityTotal: number;
  bundleCount?: number;
}

export type QualityTestType = "boot" | "wheel" | "final";

export async function validateLogin(payload: {
  userId: string;
  userName: string;
  role: string;
}): Promise<LoginResponse> {
  const override = getApiOverride("validateLogin");
  if (override) {
    return override(payload);
  }
  return invoke<LoginResponse>("validate_login", { payload });
}

export async function performPreflight(): Promise<PreflightReport> {
  const override = getApiOverride("performPreflight");
  if (override) {
    return override();
  }
  return invoke<PreflightReport>("perform_preflight");
}

export async function startSession(payload: {
  operatorId: string;
  machineId?: string;
  orders: WorkOrderInput[];
}): Promise<SessionStartResponse> {
  const override = getApiOverride("startSession");
  if (override) {
    return override(payload);
  }
  return invoke<SessionStartResponse>("start_session", { payload });
}

export async function logout(): Promise<void> {
  const override = getApiOverride("logout");
  if (override) {
    return override();
  }
  await invoke("logout");
}

export async function fetchProductionSnapshot(): Promise<ProductionSnapshot> {
  const override = getApiOverride("fetchProductionSnapshot");
  if (override) {
    return override();
  }
  return invoke<ProductionSnapshot>("get_dashboard_snapshot");
}

export async function validateWire(payload: WireIdentifier): Promise<ProductionSnapshot> {
  const override = getApiOverride("validateWire");
  if (override) {
    return override(payload);
  }
  return invoke<ProductionSnapshot>("validate_wire", { payload });
}

export async function pauseWire(payload: WireIdentifier): Promise<ProductionSnapshot> {
  const override = getApiOverride("pauseWire");
  if (override) {
    return override(payload);
  }
  return invoke<ProductionSnapshot>("pause_wire", { payload });
}

export async function resumeWire(payload: WireIdentifier): Promise<ProductionSnapshot> {
  const override = getApiOverride("resumeWire");
  if (override) {
    return override(payload);
  }
  return invoke<ProductionSnapshot>("resume_wire", { payload });
}


export interface VerifyUserResponse {
  valid: boolean;
  userName?: string;
  isAdmin: boolean;
  message: string;
}

export async function verifyUserId(userId: string): Promise<VerifyUserResponse> {
  const override = getApiOverride("verifyUserId");
  if (override) {
    return override(userId);
  }
  return invoke<VerifyUserResponse>("verify_user_id", { userId });
}

export async function unlockWire(payload: {
  wire: WireIdentifier;
  userId: string;
  action: "restart" | "continue";
}): Promise<ProductionSnapshot> {
  const override = getApiOverride("unlockWire");
  if (override) {
    return override(payload);
  }
  return invoke<ProductionSnapshot>("unlock_wire", { payload });
}

export async function stopWire(payload: WireIdentifier): Promise<ProductionSnapshot> {
  const override = getApiOverride("stopWire");
  if (override) {
    return override(payload);
  }
  return invoke<ProductionSnapshot>("stop_wire", { payload });
}

export async function recordWireProgress(payload: {
  wire: WireIdentifier;
  producedIncrement: number;
}): Promise<ProductionSnapshot> {
  const override = getApiOverride("recordWireProgress");
  if (override) {
    return override(payload);
  }
  return invoke<ProductionSnapshot>("record_wire_progress", { payload });
}

export async function finalizeWireProduction(payload: {
  wire: WireIdentifier;
  qualityAgentId: string;
}): Promise<ProductionSnapshot> {
  const override = getApiOverride("finalizeWireProduction");
  if (override) {
    return override(payload);
  }
  return invoke<ProductionSnapshot>("finalize_wire_production", { payload });
}

export async function completeOperatorTest(payload: {
  wire: WireIdentifier;
  notes: Record<string, string>;
}): Promise<ProductionSnapshot> {
  const override = getApiOverride("completeOperatorTest");
  if (override) {
    return override(payload);
  }
  return invoke<ProductionSnapshot>("complete_operator_test", { payload });
}

export async function fetchOperatorTestResults(
  wire: WireIdentifier,
): Promise<TestResult | null> {
  const override = getApiOverride("fetchOperatorTestResults");
  if (override) {
    return override(wire);
  }
  return invoke<TestResult | null>("get_operator_test_results", { payload: { wire } });
}

export async function completeQualityTest(payload: {
  wire: WireIdentifier;
  test: QualityTestType;
  notes: Record<string, string>;
  qualityAgentId: string;
}): Promise<CompleteQualityTestResponse> {
  const override = getApiOverride("completeQualityTest");
  if (override) {
    return override(payload);
  }
  return invoke<CompleteQualityTestResponse>("complete_quality_test", { payload });
}

export async function fetchCrimpToolSpec(payload: {
  terminal: string;
  joint?: string | null;
}): Promise<CrimpToolSpec | null> {
  const override = getApiOverride("fetchCrimpToolSpec");
  if (override) {
    return override(payload);
  }
  return invoke<CrimpToolSpec | null>("fetch_crimp_tool_spec", { payload });
}

export interface LabelPrinterTsplSettings {
  widthMm: number;
  heightMm: number;
  gapMm: number;
  speed: number;
  density: number;
  direction: number;
}

export interface LabelPrinterSettingsResponse {
  enabled: boolean;
  labelFormat: string | null;
  labelPrinterName: string | null;
  defaultFormat: string | null;
  resolvedFormat: string | null;
  tsplSettings: LabelPrinterTsplSettings;
}

export interface SaveLabelPrinterSettingsPayload {
  labelFormat: string;
  labelPrinterName?: string | null;
  tsplSettings?: LabelPrinterTsplSettings;
}

export interface BundleLabelRequest {
  productRef: string;
  ofId: string;
  refWire: string;
  refCoil: string;
  marquage?: string | null;
  quantity: number;
  lengthMm?: number | null;
  machineName?: string | null;
}

export interface BundleLabelResult {
  format: string;
  labelId: string;
  path?: string | null;
  printerName?: string | null;
  skipped: boolean;
  message?: string | null;
}

export interface SaveMicroscopePhotoRequest {
  imageData: string;
  orientation: "front" | "back" | string;
  side?: string | null;
  ofId: string;
  reference: string;
  refWire: string;
  marquage: string;
  machineId?: string | null;
  operatorId?: string | null;
  qualityAgentId?: string | null;
}

export interface SaveCameraPhotoRequest {
  imageData: string;
  ofId: string;
  reference: string;
  refWire: string;
  marquage: string;
  side: string;
  orientation: string;
  machineId?: string | null;
  operatorId?: string | null;
  qualityAgentId?: string | null;
}

export type QualityTestResultPayload = {
  stage: QualityTestType;
  result: TestResult;
}

export interface CompleteQualityTestResponse {
  snapshot: ProductionSnapshot;
  result: QualityTestResultPayload;
}

export type HistoryFilterMode = "all" | "tests" | "events";

export interface HistoryLogEntry {
  id: number;
  timestamp: string | null;
  status: string;
  note: string | null;
  refOf: string | null;
  refProduct: string | null;
  refWire: string | null;
  refCoil: string | null;
  quantity: number | null;
  engineName: string | null;
  userNumber: string | null;
  appUserId: string | null;
  appUserName: string | null;
  opQualityNumber: string | null;
  opMaintenanceNumber: string | null;
  refTool1: string | null;
  refTool2: string | null;
  labelId: string | null;
  bacId: string | null;
  controlLength: number | null;
  controlStrippingLeft: number | null;
  controlStrippingRight: number | null;
  controlCrimpingHeightLeft: number | null;
  controlCrimpingHeightRight: number | null;
  controlTractionForceLeft: number | null;
  controlTractionForceRight: number | null;
  pathImage: string | null;
  pathImageLeft: string | null;
  pathImageRight: string | null;
}

export interface HistoryLogPage {
  entries: HistoryLogEntry[];
  nextCursor: number | null;
  hasMore: boolean;
}

export interface HistoryQuery {
  refOf?: string;
  refProduct?: string;
  refWire?: string;
  filter?: HistoryFilterMode;
  cursor?: number | null;
  limit?: number;
}

export async function fetchLabelPrinterSettings(): Promise<LabelPrinterSettingsResponse> {
  const override = getApiOverride("fetchLabelPrinterSettings");
  if (override) {
    return override();
  }
  return invoke<LabelPrinterSettingsResponse>("get_label_printer_settings");
}

export async function saveLabelPrinterSettings(
  payload: SaveLabelPrinterSettingsPayload,
): Promise<LabelPrinterSettingsResponse> {
  const override = getApiOverride("saveLabelPrinterSettings");
  if (override) {
    return override(payload);
  }
  return invoke<LabelPrinterSettingsResponse>("save_label_printer_settings", { payload });
}

export async function listLabelPrinters(): Promise<string[]> {
  const override = getApiOverride("listLabelPrinters");
  if (override) {
    return override();
  }
  return invoke<string[]>("list_label_printers");
}

export async function printBundleLabel(payload: BundleLabelRequest): Promise<BundleLabelResult> {
  const override = getApiOverride("printBundleLabel");
  if (override) {
    return override(payload);
  }
  return invoke<BundleLabelResult>("print_bundle_label", { payload });
}

export async function saveMicroscopePhoto(payload: SaveMicroscopePhotoRequest): Promise<string> {
  const override = getApiOverride("saveMicroscopePhoto");
  if (override) {
    return override(payload);
  }
  return invoke<string>("save_microscope_photo", { payload });
}

export async function saveCameraPhoto(payload: SaveCameraPhotoRequest): Promise<string> {
  const override = getApiOverride("saveCameraPhoto");
  if (override) {
    return override(payload);
  }
  return invoke<string>("save_camera_photo", { payload });
}

export async function getMicroscopePhoto(path: string): Promise<string> {
  const override = getApiOverride("getMicroscopePhoto");
  if (override) {
    return override(path);
  }
  return invoke<string>("get_microscope_photo", { path });
}

export type DepartmentCallKind =
  | "maintenance"
  | "quality"
  | "production"
  | "non_conformity";

export async function triggerDepartmentCall(department: DepartmentCallKind): Promise<void> {
  const override = getApiOverride("triggerDepartmentCall");
  if (override) {
    await override({ department });
    return;
  }
  await invoke("trigger_department_call", { payload: { department } });
}

export async function verifyBundleLabel(payload: {
  wire: WireIdentifier;
  labelId: string;
  barcode: string;
  bacId: string;
  quantity: number;
}): Promise<void> {
  const override = getApiOverride("verifyBundleLabel");
  if (override) {
    return override(payload);
  }
  await invoke("verify_bundle_label", { payload });
}

export async function fetchHistoryLogs(payload: HistoryQuery = {}): Promise<HistoryLogPage> {
  const override = getApiOverride("fetchHistoryLogs");
  if (override) {
    return override(payload);
  }
  const request: Record<string, unknown> = {};
  if (payload.refOf?.trim()) {
    request.refOf = payload.refOf.trim();
  }
  if (payload.refProduct?.trim()) {
    request.refProduct = payload.refProduct.trim();
  }
  if (payload.refWire?.trim()) {
    request.refWire = payload.refWire.trim();
  }
  if (payload.filter) {
    request.filter = payload.filter;
  }
  if (payload.cursor != null) {
    request.cursor = payload.cursor;
  }
  if (typeof payload.limit === "number") {
    request.limit = payload.limit;
  }
  return invoke<HistoryLogPage>("list_history_logs", { payload: request });
}
