import { render, screen, within, waitFor } from '@testing-library/react';
import { act } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import Production from './Production';
import { renderWithProviders } from '@/tests/utils';
import * as api from '@/lib/api';
import type { ProductionSnapshot, WireSummary } from '@/lib/types';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeWire(overrides: Partial<WireSummary> = {}): WireSummary {
  return {
    id: 1,
    refCoil: 'C1',
    refWire: 'W-100',
    marquage: 'MK-1',
    operatorTestDone: false,
    lengthMm: 500,
    section: 1.5,
    colorPrimary: 'Red',
    colorSecondary: null,
    bundleCount: 1,
    status: 'not_validated',
    previousStatus: null,
    producedQuantity: 0,
    targetQuantity: 100,
    progressPercent: 0,
    bootTestDone: false,
    bootTestRequired: true,
    bootTestRequiredCount: 1,
    bootTestDoneCount: 0,
    wheelTestDone: false,
    wheelTestRequired: false,
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

function snapshotForFilters(): ProductionSnapshot {
  return {
    totals: {
      totalOrders: 1,
      activeOrders: 1,
      completedOrders: 0,
      totalWires: 2,
      validatedWires: 0,
      completedWires: 0,
      testsBlocking: 0,
      averageProgress: 0,
    },
    orders: [
      {
        id: 1,
        ofId: 'OF-100',
        reference: 'REF-1',
        quantityTotal: 100,
        bundleCount: 1,
        status: 'in_production',
        progressPercent: 0,
        machineId: null,
        wires: [makeWire({ id: 1, refWire: 'A12-RED', marquage: 'M1' }), makeWire({ id: 2, refWire: 'B14-BLK', marquage: 'M2', colorPrimary: 'Black' })],
      },
    ],
  };
}

describe('Production page', () => {
  test('renders table with wires and quality badges', async () => {
    vi.spyOn(api, 'fetchProductionSnapshot').mockResolvedValue(snapshotForFilters());
    const { ui } = renderWithProviders(<Production />);
    render(ui);

    expect(await screen.findByText('Wire Production Table')).toBeInTheDocument();
    expect((await screen.findAllByText('A12-RED')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('B14-BLK')).length).toBeGreaterThan(0);
  });

  test('wheel reminder keeps production controls available while pending (mirrors wires workflow)', async () => {
    const blocked: ProductionSnapshot = {
      totals: { totalOrders: 1, activeOrders: 1, completedOrders: 0, totalWires: 1, validatedWires: 0, completedWires: 0, testsBlocking: 1, averageProgress: 0 },
      orders: [
        {
          id: 1,
          ofId: 'OF-200',
          reference: 'REF-2',
          quantityTotal: 600,
          bundleCount: 2,
          status: 'in_production',
          progressPercent: 0,
          machineId: null,
          wires: [
            makeWire({
              id: 77,
              refCoil: 'C2',
              refWire: 'D03-GRN',
              marquage: '03-G',
              lengthMm: 300,
              status: 'validated',
              producedQuantity: 0,
              targetQuantity: 600,
              progressPercent: 0,
              bootTestDone: false,
              bootTestRequired: true,
              bootTestRequiredCount: 1,
              bootTestDoneCount: 0,
              wheelTestDone: false,
              wheelTestRequired: false,
            }),
          ],
        },
      ],
    };
    const after: ProductionSnapshot = {
      totals: { totalOrders: 1, activeOrders: 1, completedOrders: 0, totalWires: 1, validatedWires: 0, completedWires: 0, testsBlocking: 1, averageProgress: 0 },
      orders: [
        {
          id: 1,
          ofId: 'OF-200',
          reference: 'REF-2',
          quantityTotal: 600,
          bundleCount: 2,
          status: 'qc_boot',
          progressPercent: 50,
          machineId: null,
          wires: [
            makeWire({
              id: 77,
              refCoil: 'C2',
              refWire: 'D03-GRN',
              marquage: '03-G',
              lengthMm: 300,
              status: 'qc_boot',
              operatorTestDone: true,
              producedQuantity: 0,
              targetQuantity: 600,
              progressPercent: 0,
              bootTestDone: false,
              bootTestRequired: true,
              bootTestRequiredCount: 1,
              bootTestDoneCount: 0,
              wheelTestDone: false,
              wheelTestRequired: false,
            }),
          ],
        },
      ],
    };

    const fetchMock = vi.spyOn(api, 'fetchProductionSnapshot');
    fetchMock.mockResolvedValue(blocked);
    vi.spyOn(api, 'completeOperatorTest').mockResolvedValue(after);

    const { ui, queryClient } = renderWithProviders(<Production />);
    render(ui);

    const table = await screen.findByRole('table');
    const row = (await within(table).findByText('D03-GRN')).closest('tr') as HTMLElement;

    const operatorButton = within(row).getByRole('button', { name: /operator test/i });
    expect(operatorButton).toBeEnabled();
    expect(within(row).getByRole('button', { name: /stop/i })).toBeEnabled();

    await act(async () => {
      queryClient.setQueryData(['production-snapshot'], after);
    });

    await waitFor(() => {
      const actionsButton = within(row).getByRole('button', { name: /operator actions/i });
      expect(actionsButton).toBeEnabled();
    });
    expect(within(row).getByRole('button', { name: /pause/i })).toBeEnabled();
    expect(within(row).getByRole('button', { name: /stop/i })).toBeEnabled();
  });

  test('validated wires needing downstream quality tests keep operator test available', async () => {
    const snapshot: ProductionSnapshot = {
      totals: {
        totalOrders: 1,
        activeOrders: 1,
        completedOrders: 0,
        totalWires: 1,
        validatedWires: 1,
        completedWires: 0,
        testsBlocking: 1,
        averageProgress: 0,
      },
      orders: [
        {
          id: 42,
          ofId: 'OF-300',
          reference: 'REF-3',
          quantityTotal: 200,
          bundleCount: 1,
          status: 'in_production',
          progressPercent: 0,
          machineId: null,
          wires: [
            makeWire({
              id: 88,
              refCoil: 'C3',
              refWire: 'VX-200',
              marquage: 'VX-200',
              status: 'validated',
              wheelTestDone: false,
              wheelTestRequired: false,
              finalTestDone: false,
              finalTestRequired: true,
            }),
          ],
        },
      ],
    };

    vi.spyOn(api, 'fetchProductionSnapshot').mockResolvedValue(snapshot);

    const { ui } = renderWithProviders(<Production />);
    render(ui);

    const table = await screen.findByRole('table');
    const labels = await within(table).findAllByText('VX-200');
    const row = labels[0].closest('tr') as HTMLElement;

    const operatorButton = within(row).getByRole('button', { name: /operator test/i });
    expect(operatorButton).toBeEnabled();
  });
});


