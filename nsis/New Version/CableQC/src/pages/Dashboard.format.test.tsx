import { render, screen, within } from "@testing-library/react";
import { afterEach } from "vitest";
import Dashboard from "./Dashboard";
import { renderWithProviders } from "@/tests/utils";
import * as api from "@/lib/api";
import type { ProductionSnapshot, WireSummary } from "@/lib/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeWire(overrides: Partial<WireSummary> = {}): WireSummary {
  return {
    id: 1,
    refCoil: "C",
    refWire: "A12",
    marquage: "MK",
    operatorTestDone: false,
    lengthMm: 100,
    section: 1.0,
    colorPrimary: "Red",
    colorSecondary: null,
    bundleCount: 1,
    status: "validated",
    previousStatus: null,
    producedQuantity: 25,
    targetQuantity: 100,
    progressPercent: 25,
    bootTestDone: true,
    bootTestRequired: true,
    bootTestRequiredCount: 1,
    bootTestDoneCount: 1,
    wheelTestDone: false,
    wheelTestRequired: false,
    finalTestDone: false,
    finalTestRequired: false,
    ext1: {
      terminal: "T-A",
      joint: "J-A",
      stripping: 5,
      kind: "sertissage_simple",
    },
    ext2: {
      terminal: "T-B",
      joint: "J-B",
      stripping: 5,
      kind: "sertissage_simple",
    },
    ...overrides,
  };
}

function snapshotForDashboard(): ProductionSnapshot {
  return {
    totals: {
      totalOrders: 1,
      activeOrders: 1,
      completedOrders: 0,
      totalWires: 1,
      validatedWires: 1,
      completedWires: 0,
      testsBlocking: 0,
      averageProgress: 25,
    },
    orders: [
      {
        id: 1,
        ofId: "OF-100",
        reference: "PRD-1",
        quantityTotal: 100,
        bundleCount: 1,
        status: "in_production",
        progressPercent: 25,
        machineId: "M1",
        wires: [
          makeWire(),
        ],
      },
    ],
  };
}

describe("Dashboard production table format", () => {
  test("renders columns: Wire, Order, Status, Progress, Quality Tests", async () => {
    vi.spyOn(api, "fetchProductionSnapshot").mockResolvedValue(snapshotForDashboard());
    const { ui } = renderWithProviders(<Dashboard />);
    render(ui);
    const tables = await screen.findAllByRole("table");
    const headerTable = tables.find((candidate) =>
      within(candidate).queryAllByRole("columnheader").length > 0,
    );
    expect(headerTable).toBeDefined();

    const headers = within(headerTable!).getAllByRole("columnheader").map((th) => th.textContent?.trim());
    expect(headers).toEqual(["Wire", "Order", "Status", "Progress", "Tests"]);

    const wireCell = await screen.findByRole("cell", { name: /A12/ });
    expect(wireCell.closest("tr")).not.toBeNull();
  });
});


