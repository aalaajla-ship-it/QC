import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import Wires from './Wires';
import { renderWithProviders } from '@/tests/utils';
import * as api from '@/lib/api';
import type { ProductionSnapshot, WireSummary } from '@/lib/types';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeWire(overrides: Partial<WireSummary> = {}): WireSummary {
  return {
    id: 77,
    refCoil: 'C2',
   refWire: 'D03-GRN',
   marquage: '03-G',
    operatorTestDone: false,
   lengthMm: 300,
    section: 2,
    colorPrimary: 'Green',
    colorSecondary: null,
    bundleCount: 2,
    status: 'qc_wheel',
    previousStatus: null,
    producedQuantity: 300,
    targetQuantity: 600,
    progressPercent: 50,
    bootTestDone: true,
    bootTestRequired: true,
    bootTestRequiredCount: 1,
    bootTestDoneCount: 1,
    wheelTestDone: false,
    wheelTestRequired: true,
    finalTestDone: false,
    finalTestRequired: false,
    ext1: {
      terminal: 'T-A',
      joint: 'J-A',
      stripping: 5,
      kind: 'sertissage_simple',
    },
    ext2: {
      terminal: 'T-B',
      joint: 'J-B',
      stripping: 5,
      kind: 'sertissage_simple',
    },
    ...overrides,
  };
}

function snapshotBlockedWheel(): ProductionSnapshot {
  return {
    totals: { totalOrders: 1, activeOrders: 1, completedOrders: 0, totalWires: 1, validatedWires: 0, completedWires: 0, testsBlocking: 1, averageProgress: 50 },
    orders: [
      {
        id: 1,
        ofId: 'OF-200',
        reference: 'REF-2',
        quantityTotal: 600,
        bundleCount: 2,
        status: 'in_production',
        progressPercent: 50,
        machineId: null,
        wires: [
          makeWire(),
        ],
      },
    ],
  };
}

function snapshotAfterWheel(): ProductionSnapshot {
  return {
    totals: { totalOrders: 1, activeOrders: 1, completedOrders: 0, totalWires: 1, validatedWires: 0, completedWires: 0, testsBlocking: 0, averageProgress: 50 },
    orders: [
      {
        id: 1,
        ofId: 'OF-200',
        reference: 'REF-2',
        quantityTotal: 600,
        bundleCount: 2,
        status: 'in_production',
        progressPercent: 50,
        machineId: null,
        wires: [
          makeWire({
            status: 'in_production',
            wheelTestDone: true,
            wheelTestRequired: false,
          }),
        ],
      },
    ],
  };
}

describe('Wires workflow (quality gating)', () => {
  test('wheel reminder keeps production controls available while test pending', async () => {
    vi.spyOn(api, 'fetchProductionSnapshot').mockResolvedValue(snapshotBlockedWheel());
    const qualityMock = vi.spyOn(api, 'completeQualityTest').mockResolvedValue({
      snapshot: snapshotAfterWheel(),
      result: {
        stage: 'wheel',
        result: {
          status: 'OK',
          overallPassed: true,
          verdicts: [],
        },
      },
    });

    const { ui } = renderWithProviders(<Wires />);
    render(ui);

    const table = await screen.findByRole('table');
    const row = within(table).getByText('D03-GRN').closest('tr') as HTMLElement;

    const input = within(row).getByRole('spinbutton');
    const addBtn = within(row).getByRole('button', { name: /add/i });
    expect(input).toBeEnabled();
    expect(addBtn).toBeEnabled();

    // Complete wheel test
    await userEvent.click(within(row).getByRole('button', { name: /wheel/i }));
    const call = qualityMock.mock.calls[0][0];
    expect(call).toEqual({
      wire: { workOrderId: 1, refWire: 'D03-GRN', marquage: '03-G' },
      test: 'wheel',
      notes: {},
      qualityAgentId: 'QA-TEST',
    });

    // Wheel button should be disabled once test completes
    await waitFor(() => expect(within(row).getByRole('button', { name: /wheel/i })).toBeDisabled());
  });
});


