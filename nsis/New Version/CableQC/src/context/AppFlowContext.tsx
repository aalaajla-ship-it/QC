import { createContext, useContext, useMemo, useReducer } from "react";

import type { PreflightReport, LoginResponse, SessionStartResponse } from "@/lib/api";

export type FlowStage = "login" | "validation" | "orders" | "app";

export interface OrderEntry {
  ofId: string;
  quantityTotal: number;
  bundleCount: number;
  reference: string;
}

type OperatorTestKey = string;

interface OperatorTestRecord {
  completedAt: string;
  notes: Record<string, string>;
}

export interface OperatorTestDraft {
  updatedAt: string;
  notes: Record<string, string>;
  activeStep: number;
}

function normalizeKeySegment(value: string): string {
  return value.trim().toLowerCase();
}

function makeOperatorTestKey(
  ofId: string,
  reference: string,
  wireRef: string,
  marquage: string,
): OperatorTestKey {
  return [ofId, reference, wireRef, marquage].map(normalizeKeySegment).join("::");
}

function parseOperatorTestKey(key: OperatorTestKey) {
  const parts = key.split("::");
  if (parts.length !== 4) return null;
  const [ofId, reference, wireRef, marquage] = parts;
  return { ofId, reference, wireRef, marquage };
}

function normalizeNotes(notes?: Record<string, string> | null): Record<string, string> {
  if (!notes) return {};
  const entries = Object.entries(notes)
    .map(([key, value]) => [key?.trim(), (value ?? "").toString().trim()] as const)
    .filter(([key]) => Boolean(key && key.length > 0));
  return Object.fromEntries(entries);
}

interface AppFlowState {
  credentials?: LoginResponse;
  preflight?: PreflightReport;
  preflightAcknowledged: boolean;
  session?: SessionStartResponse;
  orders: OrderEntry[];
  completedOperatorTests: Record<OperatorTestKey, OperatorTestRecord>;
  operatorTestDrafts: Record<OperatorTestKey, OperatorTestDraft>;
}

interface AppFlowContextValue {
  state: AppFlowState;
  stage: FlowStage;
  connectionOk: boolean;
  setCredentials: (payload: LoginResponse | undefined) => void;
  setPreflight: (payload: PreflightReport | undefined) => void;
  acknowledgePreflight: () => void;
  setSession: (payload: SessionStartResponse | undefined) => void;
  setOrders: (orders: OrderEntry[]) => void;
  isOperatorTestComplete: (ofId: string, reference: string, wireRef: string, marquage: string) => boolean;
  markOperatorTestComplete: (
    ofId: string,
    reference: string,
    wireRef: string,
    marquage: string,
    notes?: Record<string, string> | null,
  ) => void;
  getOperatorTestNotes: (
    ofId: string,
    reference: string,
    wireRef: string,
    marquage: string,
  ) => Record<string, string> | null;
  saveOperatorTestDraft: (
    ofId: string,
    reference: string,
    wireRef: string,
    marquage: string,
    payload: { notes: Record<string, string>; activeStep: number },
  ) => void;
  getOperatorTestDraft: (
    ofId: string,
    reference: string,
    wireRef: string,
    marquage: string,
  ) => OperatorTestDraft | null;
  clearOperatorTestDraft: (ofId: string, reference: string, wireRef: string, marquage: string) => void;
  clearOperatorTest: (ofId: string, reference: string, wireRef: string, marquage: string) => void;
  reset: () => void;
}

const AppFlowContext = createContext<AppFlowContextValue | undefined>(undefined);

type Action =
  | { type: "SET_CREDENTIALS"; payload?: LoginResponse }
  | { type: "SET_PREFLIGHT"; payload?: PreflightReport }
  | { type: "ACK_PREFLIGHT" }
  | { type: "SET_SESSION"; payload?: SessionStartResponse }
  | { type: "SET_ORDERS"; payload: OrderEntry[] }
  | { type: "MARK_OPERATOR_TEST"; key: OperatorTestKey; record: OperatorTestRecord }
  | { type: "SAVE_OPERATOR_DRAFT"; key: OperatorTestKey; draft: OperatorTestDraft }
  | { type: "CLEAR_OPERATOR_DRAFT"; key: OperatorTestKey }
  | { type: "CLEAR_OPERATOR_TEST"; key: OperatorTestKey }
  | { type: "RESET" };

const initialState: AppFlowState = {
  credentials: undefined,
  preflight: undefined,
  preflightAcknowledged: false,
  session: undefined,
  orders: [],
  completedOperatorTests: {},
  operatorTestDrafts: {},
};

function reducer(state: AppFlowState, action: Action): AppFlowState {
  switch (action.type) {
    case "SET_CREDENTIALS":
      return {
        credentials: action.payload,
        preflight: undefined,
        preflightAcknowledged: false,
        session: undefined,
        orders: [],
        completedOperatorTests: {},
        operatorTestDrafts: {},
      };
    case "SET_PREFLIGHT":
      return {
        ...state,
        preflight: action.payload,
        preflightAcknowledged: false,
        session: action.payload ? state.session : undefined,
        orders: action.payload ? state.orders : [],
        completedOperatorTests: action.payload ? state.completedOperatorTests : {},
        operatorTestDrafts: action.payload ? state.operatorTestDrafts : {},
      };
    case "ACK_PREFLIGHT":
      return {
        ...state,
        preflightAcknowledged: true,
      };
    case "SET_SESSION": {
      if (!action.payload) {
        return {
          ...state,
          session: undefined,
          orders: [],
          completedOperatorTests: {},
          operatorTestDrafts: {},
        };
      }

      const operatorChanged = state.session?.operatorId
        ? state.session.operatorId.trim().toLowerCase() !==
        action.payload.operatorId.trim().toLowerCase()
        : false;

      return {
        ...state,
        session: action.payload,
        completedOperatorTests: operatorChanged ? {} : state.completedOperatorTests,
        operatorTestDrafts: operatorChanged ? {} : state.operatorTestDrafts,
      };
    }
    case "SET_ORDERS": {
      const allowedOrders = action.payload.map((order) => ({
        ofId: normalizeKeySegment(order.ofId),
        reference: normalizeKeySegment(order.reference),
      }));
      return {
        ...state,
        orders: action.payload,
        completedOperatorTests: Object.fromEntries(
          Object.entries(state.completedOperatorTests).filter(([key]) => {
            const parsed = parseOperatorTestKey(key);
            if (!parsed) return false;
            return allowedOrders.some(
              (order) => order.ofId === parsed.ofId && order.reference === parsed.reference,
            );
          }),
        ),
        operatorTestDrafts: Object.fromEntries(
          Object.entries(state.operatorTestDrafts).filter(([key]) => {
            const parsed = parseOperatorTestKey(key);
            if (!parsed) return false;
            return allowedOrders.some(
              (order) => order.ofId === parsed.ofId && order.reference === parsed.reference,
            );
          }),
        ),
      };
    }
    case "MARK_OPERATOR_TEST": {
      const { [action.key]: _removedDraft, ...remainingDrafts } = state.operatorTestDrafts;
      return {
        ...state,
        completedOperatorTests: {
          ...state.completedOperatorTests,
          [action.key]: action.record,
        },
        operatorTestDrafts: remainingDrafts,
      };
    }
    case "SAVE_OPERATOR_DRAFT":
      return {
        ...state,
        operatorTestDrafts: {
          ...state.operatorTestDrafts,
          [action.key]: action.draft,
        },
      };
    case "CLEAR_OPERATOR_DRAFT": {
      const { [action.key]: _removed, ...rest } = state.operatorTestDrafts;
      return {
        ...state,
        operatorTestDrafts: rest,
      };
    }
    case "CLEAR_OPERATOR_TEST": {
      const { [action.key]: _removed, ...rest } = state.completedOperatorTests;
      return {
        ...state,
        completedOperatorTests: rest,
      };
    }
    case "RESET":
      return initialState;
    default:
      return state;
  }
}

const stageOrder: Record<FlowStage, number> = {
  login: 0,
  validation: 1,
  orders: 2,
  app: 3,
};

function resolveStage(state: AppFlowState): FlowStage {
  if (!state.credentials) return "login";
  if (!state.preflight || !state.preflightAcknowledged) return "validation";
  if (!state.session) return "orders";
  if (state.orders.length === 0) return "orders";
  return "app";
}

export function AppFlowProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const stage = useMemo(() => resolveStage(state), [state]);

  const connectionOk =
    !!state.preflight &&
    state.preflight.appDb.ok &&
    state.preflight.crimpDb.ok &&
    state.preflight.api.ok;

  const value = useMemo<AppFlowContextValue>(
    () => ({
      state,
      stage,
      connectionOk,
      setCredentials: (payload) => dispatch({ type: "SET_CREDENTIALS", payload }),
      setPreflight: (payload) => dispatch({ type: "SET_PREFLIGHT", payload }),
      acknowledgePreflight: () => dispatch({ type: "ACK_PREFLIGHT" }),
      setSession: (payload) => dispatch({ type: "SET_SESSION", payload }),
      setOrders: (orders) => dispatch({ type: "SET_ORDERS", payload: orders }),
      isOperatorTestComplete: (ofId, reference, wireRef, marquage) => {
        const key = makeOperatorTestKey(ofId, reference, wireRef, marquage);
        return Boolean(state.completedOperatorTests[key]);
      },
      markOperatorTestComplete: (ofId, reference, wireRef, marquage, notes) => {
        const key = makeOperatorTestKey(ofId, reference, wireRef, marquage);
        dispatch({
          type: "MARK_OPERATOR_TEST",
          key,
          record: {
            completedAt: new Date().toISOString(),
            notes: normalizeNotes(notes),
          },
        });
      },
      getOperatorTestNotes: (ofId, reference, wireRef, marquage) => {
        const key = makeOperatorTestKey(ofId, reference, wireRef, marquage);
        const record = state.completedOperatorTests[key];
        if (!record) return null;
        const noteKeys = Object.keys(record.notes);
        if (noteKeys.length === 0) return null;
        return record.notes;
      },
      saveOperatorTestDraft: (ofId, reference, wireRef, marquage, payload) => {
        const key = makeOperatorTestKey(ofId, reference, wireRef, marquage);
        const normalizedNotes = normalizeNotes(payload.notes);
        const activeStep = Number.isFinite(payload.activeStep)
          ? Math.max(0, Math.floor(payload.activeStep))
          : 0;
        if (Object.keys(normalizedNotes).length === 0 && activeStep === 0) {
          if (state.operatorTestDrafts[key]) {
            dispatch({ type: "CLEAR_OPERATOR_DRAFT", key });
          }
          return;
        }
        dispatch({
          type: "SAVE_OPERATOR_DRAFT",
          key,
          draft: {
            updatedAt: new Date().toISOString(),
            notes: normalizedNotes,
            activeStep,
          },
        });
      },
      getOperatorTestDraft: (ofId, reference, wireRef, marquage) => {
        const key = makeOperatorTestKey(ofId, reference, wireRef, marquage);
        return state.operatorTestDrafts[key] ?? null;
      },
      clearOperatorTestDraft: (ofId, reference, wireRef, marquage) => {
        const key = makeOperatorTestKey(ofId, reference, wireRef, marquage);
        if (state.operatorTestDrafts[key]) {
          dispatch({ type: "CLEAR_OPERATOR_DRAFT", key });
        }
      },
      clearOperatorTest: (ofId, reference, wireRef, marquage) => {
        const key = makeOperatorTestKey(ofId, reference, wireRef, marquage);
        dispatch({ type: "CLEAR_OPERATOR_TEST", key });
      },
      reset: () => dispatch({ type: "RESET" }),
    }),
    [connectionOk, stage, state],
  );

  return <AppFlowContext.Provider value={value}>{children}</AppFlowContext.Provider>;
}

export function useAppFlow() {
  const ctx = useContext(AppFlowContext);
  if (!ctx) {
    throw new Error("useAppFlow must be used within an AppFlowProvider");
  }
  return ctx;
}

export function compareStage(current: FlowStage, target: FlowStage) {
  return stageOrder[current] - stageOrder[target];
}

export function stageToPath(stage: FlowStage): string {
  switch (stage) {
    case "login":
      return "/login";
    case "validation":
      return "/startup";
    case "orders":
      return "/orders";
    case "app":
    default:
      return "/dashboard";
  }
}
