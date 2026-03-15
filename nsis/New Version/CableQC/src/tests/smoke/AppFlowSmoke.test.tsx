import { describe, expect, it, vi, afterEach, beforeAll, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { PreflightReport, SessionStartResponse } from "@/lib/api";
import type { ProductionSnapshot } from "@/lib/types";

const {
  dummyPreflight,
  dummySnapshot,
  dummySession,
  validateLoginMock,
  performPreflightMock,
  startSessionMock,
  fetchProductionSnapshotMock,
  resolveSnapshot,
  resolveQualityResponse,
  resolveLabelSettings,
  resolveLabelResult,
} = vi.hoisted(() => {
  const dummyPreflight: PreflightReport = {
    appDb: { ok: true, message: "App DB reachable" },
    crimpDb: { ok: true, message: "Crimp DB reachable" },
    sharedFolder: { ok: true, message: "Shared folder mounted" },
    microscopeFolder: { ok: true, message: "Microscope share available" },
    api: { ok: true, message: "API responding" },
  };

  const dummySnapshot: ProductionSnapshot = {
    totals: {
      totalOrders: 1,
      activeOrders: 1,
      completedOrders: 0,
      totalWires: 1,
      validatedWires: 1,
      completedWires: 0,
      testsBlocking: 0,
      averageProgress: 32.5,
    },
    orders: [
      {
        id: 101,
        ofId: "OF-123",
        reference: "WIRE-789",
        quantityTotal: 120,
        bundleCount: 12,
        status: "active",
        progressPercent: 32.5,
        machineId: "MC-42",
        wires: [
          {
            id: 501,
            refCoil: "COIL-1",
            refWire: "WIRE-789",
            marquage: "A",
            operatorTestDone: true,
            lengthMm: 340,
            section: 2,
            colorPrimary: "red",
            colorSecondary: null,
            bundleCount: 12,
            status: "in_production",
            previousStatus: "validated",
            producedQuantity: 40,
            targetQuantity: 120,
            progressPercent: 33.3,
            bootTestDone: true,
            bootTestRequired: true,
            bootTestRequiredCount: 1,
            bootTestDoneCount: 1,
            wheelTestDone: false,
            wheelTestRequired: true,
            finalTestDone: false,
            finalTestRequired: true,
            ext1: {
              terminal: "TRM-1",
              joint: "JNT-1",
              stripping: 3,
              kind: "A",
            },
            ext2: null,
          },
        ],
      },
    ],
  };

  const dummySession: SessionStartResponse = {
    operatorId: "OP-9",
    operatorName: "Operator Nine",
    machineId: "MC-42",
    orders: dummySnapshot.orders,
  };

  const validateLoginMock = vi.fn(async ({ userId, userName, role }: { userId: string; userName: string; role: string }) => ({
    userId,
    userName,
    role,
    csvRole: null,
  }));

  const performPreflightMock = vi.fn(async () => dummyPreflight);
  const startSessionMock = vi.fn(async () => dummySession);
  const fetchProductionSnapshotMock = vi.fn(async () => dummySnapshot);

  const resolveSnapshot = async () => dummySnapshot;
  const resolveQualityResponse = async () => ({
    snapshot: await resolveSnapshot(),
    result: {
      stage: "boot" as const,
      result: {
        status: null,
        overallPassed: null,
        verdicts: [],
      },
    },
  });
  const resolveLabelSettings = async () => ({
    enabled: false,
    labelFormat: "default",
    labelPrinterName: null,
    defaultFormat: "default",
    resolvedFormat: "default",
  });
  const resolveLabelResult = async () => ({
    format: "default",
    labelId: "LBL-1",
    path: null,
    printerName: null,
    skipped: false,
    message: null,
  });

  return {
    dummyPreflight,
    dummySnapshot,
    dummySession,
    validateLoginMock,
    performPreflightMock,
    startSessionMock,
    fetchProductionSnapshotMock,
    resolveSnapshot,
    resolveQualityResponse,
    resolveLabelSettings,
    resolveLabelResult,
  };
});

let App: typeof import("@/App").default;

beforeAll(async () => {
  ({ default: App } = await import("@/App"));
});

const globalWithOverrides = globalThis as typeof globalThis & {
  __APP_API_OVERRIDES__?: Record<string, unknown>;
};

beforeEach(() => {
  globalWithOverrides.__APP_API_OVERRIDES__ = {
    validateLogin: validateLoginMock,
    performPreflight: performPreflightMock,
    startSession: startSessionMock,
    fetchProductionSnapshot: fetchProductionSnapshotMock,
    validateWire: vi.fn(resolveSnapshot),
    pauseWire: vi.fn(resolveSnapshot),
    resumeWire: vi.fn(resolveSnapshot),
    stopWire: vi.fn(resolveSnapshot),
    recordWireProgress: vi.fn(resolveSnapshot),
    completeOperatorTest: vi.fn(resolveSnapshot),
    completeQualityTest: vi.fn(resolveQualityResponse),
    fetchCrimpToolSpec: vi.fn(async () => ({
      status: "Ready",
      statusOk: true,
      terminalRef: "TRM-1",
      jointRef: "JNT-1",
      hcMin: 1.2,
      hcMax: 1.8,
      hcNominal: 1.5,
      tractionNominal: 2.1,
    })),
    fetchLabelPrinterSettings: vi.fn(resolveLabelSettings),
    saveLabelPrinterSettings: vi.fn(resolveLabelSettings),
    listLabelPrinters: vi.fn(async () => ["Test Printer"]),
    printBundleLabel: vi.fn(resolveLabelResult),
    logout: vi.fn(async () => undefined),
  };
});

afterEach(() => {
  validateLoginMock.mockClear();
  performPreflightMock.mockClear();
  startSessionMock.mockClear();
  fetchProductionSnapshotMock.mockClear();
  delete globalWithOverrides.__APP_API_OVERRIDES__;
});

async function completeLoginFlow() {
  const user = userEvent.setup();

  const userIdInput = await screen.findByLabelText(/user id/i);
  const nameInput = await screen.findByLabelText(/full name/i);
  await user.type(userIdInput, "operator-123");
  await user.type(nameInput, "Test User");
  await user.click(screen.getByRole("button", { name: /sign in/i }));

  await waitFor(() => expect(validateLoginMock).toHaveBeenCalled());
  expect(await screen.findByText(/system validation/i)).toBeInTheDocument();
}

async function acknowledgePreflight() {
  const user = userEvent.setup();
  const continueButton = await screen.findByRole("button", { name: /continue/i });

  await waitFor(() => expect(continueButton).not.toBeDisabled());
  await user.click(continueButton);
  await waitFor(() => expect(performPreflightMock).toHaveBeenCalled());
  expect(await screen.findByText(/work orders/i)).toBeInTheDocument();
}

async function submitSessionForm() {
  const user = userEvent.setup();

  await user.type(screen.getByLabelText(/operator id/i), "OP-9");
  await user.type(screen.getByLabelText(/machine/i), "MC-42");
  await user.type(screen.getByLabelText(/work order/i), "OF-123");
  await user.type(screen.getByLabelText(/quantity/i), "120");
  await user.type(screen.getByLabelText(/reference/i), "WIRE-789");

  await user.click(screen.getByRole("button", { name: /launch session/i }));
  await waitFor(() => expect(startSessionMock).toHaveBeenCalled());
}

describe("app smoke flow", () => {
  it(
    "builds session with dummy data and reaches dashboard",
    async () => {
      render(<App />);

      await completeLoginFlow();
      await acknowledgePreflight();
      await submitSessionForm();

      expect(await screen.findByText(/production overview/i)).toBeInTheDocument();
      await waitFor(() => expect(fetchProductionSnapshotMock).toHaveBeenCalled());

      const ordersHeading = screen.getByRole("heading", { level: 3, name: /^orders$/i });
      const ordersValue = ordersHeading.parentElement?.parentElement?.querySelector("div.text-2xl");
      expect(ordersValue).toHaveTextContent("1");

      const validatedHeading = screen.getByRole("heading", { level: 3, name: /^validated$/i });
      const validatedValue = validatedHeading.parentElement?.parentElement?.querySelector("div.text-2xl");
      expect(validatedValue).toHaveTextContent("1");
    },
    20000,
  );
});
