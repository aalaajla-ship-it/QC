import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

import History from './History';
import { renderWithProviders } from '@/tests/utils';
import * as api from '@/lib/api';
import type { HistoryLogEntry, HistoryLogPage, HistoryQuery } from '@/lib/api';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeEntry(overrides: Partial<HistoryLogEntry> = {}): HistoryLogEntry {
  return {
    id: 1,
    timestamp: '2024-04-15T10:00:00Z',
    status: 'CONTROL_OP',
    note: 'Operator test completed',
    refOf: 'OF-100',
    refProduct: 'REF-1',
    refWire: 'WIRE-1',
    refCoil: 'COIL-9',
    quantity: null,
    engineName: 'host-1',
    userNumber: 'OP-1',
    appUserId: 'USR-1',
    appUserName: 'Alice',
    opQualityNumber: null,
    opMaintenanceNumber: null,
    refTool1: 'T-1',
    refTool2: null,
    labelId: null,
    bacId: null,
    controlLength: 120,
    controlStrippingLeft: 5,
    controlStrippingRight: 5,
    controlCrimpingHeightLeft: 1.5,
    controlCrimpingHeightRight: 1.6,
    controlTractionForceLeft: 35,
    controlTractionForceRight: 36,
    pathImage: null,
    pathImageLeft: null,
    pathImageRight: null,
    ...overrides,
  };
}

describe('History page', () => {
  test('loads history entries, supports pagination, and applies filters', async () => {
    const firstPage: HistoryLogPage = {
      entries: [makeEntry()],
      nextCursor: 200,
      hasMore: true,
    };
    const secondPage: HistoryLogPage = {
      entries: [
        makeEntry({
          id: 2,
          status: 'CALL_QUALITY',
          note: 'Quality requested for wire',
          timestamp: '2024-04-15T10:05:00Z',
          controlLength: null,
          controlStrippingLeft: null,
          controlStrippingRight: null,
          controlCrimpingHeightLeft: null,
          controlCrimpingHeightRight: null,
          controlTractionForceLeft: null,
          controlTractionForceRight: null,
        }),
      ],
      nextCursor: null,
      hasMore: false,
    };

    const fetchMock = vi
      .spyOn(api, 'fetchHistoryLogs')
      .mockImplementation(async (payload: HistoryQuery = {}) => {
        if (payload.cursor != null) {
          return secondPage;
        }
        return firstPage;
      });

    const { ui } = renderWithProviders(<History />);
    render(ui);

    expect(await screen.findByRole('heading', { name: /Operator test/i })).toBeInTheDocument();
    expect(screen.getByText(/1\.50 mm/)).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toMatchObject({
      filter: 'all',
      refOf: undefined,
      refProduct: undefined,
      refWire: undefined,
      cursor: undefined,
      limit: 25,
    });

    const loadMore = await screen.findByRole('button', { name: /load more/i });
    await userEvent.click(loadMore);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toMatchObject({ cursor: 200 });
    expect(await screen.findByRole('heading', { name: /Quality requested/i })).toBeInTheDocument();

    const testsButton = screen.getByRole('button', { name: /tests/i });
    await userEvent.click(testsButton);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const lastCall = fetchMock.mock.calls.at(-1)?.[0];
    expect(lastCall?.filter).toBe('tests');
  });
});
