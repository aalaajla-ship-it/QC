import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";

import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppFlowProvider, useAppFlow, stageToPath, compareStage } from "@/context/AppFlowContext";
import { QualityAgentProvider } from "@/context/QualityAgentContext";
import { PrinterConfigProvider } from "@/context/PrinterConfigContext";

const Login = lazy(() => import("./pages/Login"));
const Startup = lazy(() => import("./pages/Startup"));
const Orders = lazy(() => import("./pages/Orders"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Settings = lazy(() => import("./pages/Settings"));
const NotFound = lazy(() => import("./pages/NotFound"));
const Operator = lazy(() => import("./pages/Operator"));
const Quality = lazy(() => import("./pages/Quality"));
const Maintenance = lazy(() => import("./pages/Maintenance"));
const Production = lazy(() => import("./pages/Production"));
const HistoryPage = lazy(() => import("./pages/History"));
const LazyAppSidebar = lazy(() =>
  import("@/components/AppSidebar").then((module) => ({ default: module.AppSidebar })),
);
const LazyAppHeader = lazy(() =>
  import("@/components/AppHeader").then((module) => ({ default: module.AppHeader })),
);

function renderProtectedPage(title: string, element: ReactElement) {
  return (
    <ProtectedPage title={title}>
      <Suspense fallback={null}>{element}</Suspense>
    </ProtectedPage>
  );
}

const queryClient = new QueryClient();

function AppLayout({ children, title }: { children: ReactNode; title: string }) {
  const { connectionOk } = useAppFlow();

  return (
    <SidebarProvider>
      <PrinterConfigProvider>
        <div className="flex min-h-screen w-full overflow-hidden">
          <Suspense fallback={<div className="w-16 flex-shrink-0 bg-background sm:w-20 lg:w-72" />}>
            <LazyAppSidebar />
          </Suspense>
          <SidebarInset className="flex flex-1 flex-col overflow-hidden">
            <Suspense fallback={<div className="h-16 border-b border-border/40 bg-background" />}>
              <LazyAppHeader title={title} connected={connectionOk} />
            </Suspense>
            <main className="flex flex-1 flex-col overflow-hidden bg-background">
              <div className="page-transition-enter flex flex-1 flex-col overflow-hidden">
                {children}
              </div>
            </main>
          </SidebarInset>
        </div>
      </PrinterConfigProvider>
    </SidebarProvider>
  );
}

function LoginRoute() {
  const { stage } = useAppFlow();
  if (stage !== "login") {
    return <Navigate to={stageToPath(stage)} replace />;
  }
  return <Login />;
}

function StartupRoute() {
  const { stage } = useAppFlow();
  if (stage === "login") {
    return <Navigate to="/login" replace />;
  }
  if (stage !== "validation") {
    return <Navigate to={stageToPath(stage)} replace />;
  }
  return <Startup />;
}

function OrdersRoute() {
  const { stage } = useAppFlow();
  if (stage === "login") {
    return <Navigate to="/login" replace />;
  }
  if (stage === "validation") {
    return <Navigate to="/startup" replace />;
  }
  return <Orders />;
}

function ProtectedPage({ title, children }: { title: string; children: ReactNode }) {
  const { stage } = useAppFlow();
  if (compareStage(stage, "app") < 0) {
    return <Navigate to={stageToPath(stage)} replace />;
  }
  return <AppLayout title={title}>{children}</AppLayout>;
}

function AppRoutes() {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route
          path="/login"
          element={(
            <Suspense fallback={null}>
              <LoginRoute />
            </Suspense>
          )}
        />
        <Route
          path="/startup"
          element={(
            <Suspense fallback={null}>
              <StartupRoute />
            </Suspense>
          )}
        />
        <Route
          path="/orders"
          element={(
            <Suspense fallback={null}>
              <OrdersRoute />
            </Suspense>
          )}
        />
        <Route
          path="/dashboard"
          element={renderProtectedPage("Dashboard", <Dashboard />)}
        />
        <Route
          path="/production"
          element={renderProtectedPage("Production", <Production />)}
        />
        <Route path="/wires" element={<Navigate to="/production" replace />} />
        <Route
          path="/operator"
          element={renderProtectedPage("Operator", <Operator />)}
        />
        <Route
          path="/quality"
          element={renderProtectedPage("Quality", <Quality />)}
        />
        <Route
          path="/maintenance"
          element={renderProtectedPage("Maintenance", <Maintenance />)}
        />
        <Route
          path="/settings"
          element={renderProtectedPage("Settings", <Settings />)}
        />
        <Route
          path="/history"
          element={renderProtectedPage("History", <HistoryPage />)}
        />
        <Route
          path="/machine"
          element={renderProtectedPage("Machine Setup", <Dashboard />)}
        />
        <Route
          path="/admin"
          element={renderProtectedPage("Admin", <Dashboard />)}
        />
        <Route
          path="*"
          element={(
            <Suspense fallback={null}>
              <NotFound />
            </Suspense>
          )}
        />
      </Routes>
    </Suspense>
  );
}

function AppScaffold() {
  const { stage } = useAppFlow();
  const location = useLocation();
  const [windowReady, setWindowReady] = useState(false);
  const [loginViewReady, setLoginViewReady] = useState(false);
  const bootCompleted = useRef(false);

  const hideInitialSplash = useCallback(() => {
    if (bootCompleted.current) {
      return;
    }
    bootCompleted.current = true;
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("app:hide-splash"));
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handle = () => setLoginViewReady(true);
    window.addEventListener("app:login-ready", handle);
    return () => {
      window.removeEventListener("app:login-ready", handle);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function prepareWindow() {
      if (typeof window === "undefined") {
        setWindowReady(true);
        return;
      }

      const ipcBridge = (window as Window & { __TAURI_IPC__?: unknown }).__TAURI_IPC__;
      const hasTauri = typeof ipcBridge === "function";

      if (!hasTauri) {
        setWindowReady(true);
        return;
      }

      try {
        const { appWindow } = await import("@tauri-apps/api/window");
        if (cancelled) return;

        await appWindow.show().catch(() => undefined);

        if (cancelled) return;
        try {
          const isFullscreen = await appWindow.isFullscreen();
          if (!isFullscreen) {
            await appWindow.setFullscreen(true);
          }
        } catch {
          await appWindow.setFullscreen(true).catch(() => undefined);
        }

        if (cancelled) return;
        await appWindow.setFocus().catch(() => undefined);
      } catch {
        // Ignore window preparation issues; fall back to default behavior.
      } finally {
        if (!cancelled) {
          setWindowReady(true);
        }
      }
    }

    void prepareWindow();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!windowReady || bootCompleted.current) {
      return;
    }

    if (stage !== "login") {
      hideInitialSplash();
      return;
    }

    if (!["/login", "/"].includes(location.pathname)) {
      return;
    }

    if (!loginViewReady) {
      return;
    }

    let cancelled = false;
    const fallback = window.setTimeout(() => {
      if (!cancelled) {
        hideInitialSplash();
      }
    }, 4500);

    const finalize = async () => {
      try {
        if (document.readyState === "loading") {
          await new Promise<void>((resolve) => {
            const handler = () => {
              window.removeEventListener("DOMContentLoaded", handler);
              resolve();
            };
            window.addEventListener("DOMContentLoaded", handler, { once: true });
          });
        }

        if ("fonts" in document) {
          await (document.fonts as FontFaceSet).ready;
        }

        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            window.setTimeout(resolve, 180);
          });
        });
      } catch {
        // Ignore readiness waiting errors.
      }

      if (!cancelled) {
        window.clearTimeout(fallback);
        hideInitialSplash();
      }
    };

    void finalize();

    return () => {
      cancelled = true;
      window.clearTimeout(fallback);
    };
  }, [windowReady, stage, location.pathname, loginViewReady, hideInitialSplash]);

  return <AppRoutes />;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AppFlowProvider>
          <QualityAgentProvider>
            <AppScaffold />
          </QualityAgentProvider>
        </AppFlowProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
