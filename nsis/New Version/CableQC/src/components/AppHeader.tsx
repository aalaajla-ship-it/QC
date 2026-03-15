import { NavLink } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { History, LogOut, Maximize2, Printer } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useLogoutDialog } from "@/hooks/useLogoutDialog";
import { LogoutConfirmDialog } from "@/components/LogoutConfirmDialog";
import { usePrinterConfig } from "@/context/PrinterConfigContext";

type AppWindowHandle = typeof import("@tauri-apps/api/window").appWindow;
type InvokeFn = typeof import("@tauri-apps/api/tauri").invoke;

interface AppHeaderProps {
  title?: string;
  connected?: boolean;
}

type HeaderNavAction = {
  to: string;
  icon: LucideIcon;
  label: string;
};

const navActions: HeaderNavAction[] = [
  { to: "/history", icon: History, label: "History Log" },
];

export function AppHeader({ title = "Dashboard", connected = true }: AppHeaderProps) {
  const { open, isProcessing, requestLogout, confirmLogout, setOpen } = useLogoutDialog();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [tauriAvailable, setTauriAvailable] = useState(false);
  const appWindowRef = useRef<AppWindowHandle | null>(null);
  const invokeRef = useRef<InvokeFn | null>(null);
  const { state: printerState, openDialog: openPrinterDialog } = usePrinterConfig();
  const printerReady = printerState.loading ? null : printerState.ready;

  useEffect(() => {
    let mounted = true;

    const bootstrap = async () => {
      if (typeof window === "undefined") {
        return;
      }

      const ipc = (window as Window & { __TAURI_IPC__?: unknown }).__TAURI_IPC__;
      if (typeof ipc !== "function") {
        return;
      }

      try {
        const [{ appWindow }, { invoke }] = await Promise.all([
          import("@tauri-apps/api/window"),
          import("@tauri-apps/api/tauri"),
        ]);

        if (!mounted) {
          return;
        }

        appWindowRef.current = appWindow;
        invokeRef.current = invoke;
        setTauriAvailable(true);

        try {
          const fs = await appWindow.isFullscreen();
          if (mounted) {
            setIsFullscreen(fs);
          }
        } catch {
          if (mounted) {
            setIsFullscreen(false);
          }
        }
      } catch {
        if (!mounted) {
          return;
        }
        appWindowRef.current = null;
        invokeRef.current = null;
        setTauriAvailable(false);
      }
    };

    void bootstrap();

    return () => {
      mounted = false;
    };
  }, []);

  const renderNavAction = (action: HeaderNavAction) => (
    <NavLink
      key={action.to}
      to={action.to}
      title={action.label}
      className={({ isActive }) =>
        cn(
          "group relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl border border-border/60 bg-background/65 text-muted-foreground transition-all duration-300 ease-out sm:h-10 sm:w-10",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          isActive
            ? "border-primary/50 bg-primary text-primary-foreground shadow-lg shadow-primary/25"
            : "hover:border-primary/40 hover:text-primary"
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={cn(
              "pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-r from-primary/18 via-primary/10 to-transparent opacity-0 transition-opacity duration-300",
              "group-hover:opacity-100",
              isActive && "opacity-100"
            )}
          />
          <span
            className={cn(
              "pointer-events-none absolute bottom-1.5 left-1/2 h-0.5 w-6 -translate-x-1/2 rounded-full bg-primary/80 transition-opacity duration-300",
              isActive ? "opacity-100" : "opacity-0 group-hover:opacity-80"
            )}
          />
          <action.icon className="relative z-10 h-4 w-4 transition-transform duration-300 group-hover:scale-110" />
        </>
      )}
    </NavLink>
  );

  return (
    <>
      <header className="sticky top-0 z-40 flex h-16 items-center justify-between gap-4 border-b border-border/50 bg-gradient-to-r from-background/92 via-background/88 to-primary/10 px-4 shadow-[0_25px_60px_-40px_rgba(15,23,42,0.85)] backdrop-blur-xl transition-all duration-500 sm:px-6">
        <div className="flex items-center gap-3 sm:gap-4">
          <div className="flex flex-col leading-tight">
            <span className="text-[11px] uppercase tracking-[0.32em] text-muted-foreground/70">CableQC System</span>
            <h1 className="text-lg font-semibold text-foreground sm:text-xl">{title}</h1>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <Badge
            variant="secondary"
            className={cn(
              "relative flex items-center gap-2 rounded-full border border-border/40 bg-background/65 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.28em] transition-all duration-300 sm:text-xs",
              connected ? "text-success" : "text-destructive"
            )}
          >
            <span
              className={cn(
                "relative flex h-2 w-2 items-center justify-center rounded-full transition-all duration-300 sm:h-2.5 sm:w-2.5",
                connected
                  ? "bg-success shadow-[0_0_18px_rgba(34,197,94,0.55)]"
                  : "bg-destructive shadow-[0_0_18px_rgba(239,68,68,0.55)]"
              )}
            />
            <span>{connected ? "Live" : "Offline"}</span>
          </Badge>

          <button
            type="button"
            title={
              printerState.loading
                ? "Loading printer configuration"
                : printerState.enabled
                ? printerReady
                  ? "Printer configured"
                  : "Printer configuration required"
                : "Printer configuration disabled"
            }
            onClick={() => openPrinterDialog()}
            className={cn(
              "group relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl border border-border/60 bg-background/65 text-muted-foreground transition-all duration-300 ease-out hover:border-primary/35 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:h-10 sm:w-10",
              printerReady === false && "border-warning/60 text-warning",
            )}
          >
            <span className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-br from-primary/12 via-primary/8 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
            {printerReady === false ? (
              <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-warning shadow-[0_0_10px_rgba(251,191,36,0.65)]" />
            ) : null}
            <Printer className="relative z-10 h-4 w-4 transition-transform duration-300 group-hover:scale-110" />
          </button>

          <button
            type="button"
            title="Toggle Fullscreen"
            aria-pressed={isFullscreen}
            onClick={() => {
              const invoke = invokeRef.current;
              const appWindow = appWindowRef.current;
              if (!invoke || !appWindow) {
                return;
              }

              void invoke("toggle_fullscreen").then(async () => {
                try {
                  const fs = await appWindow.isFullscreen();
                  setIsFullscreen(fs);
                } catch {
                  setIsFullscreen((v) => !v);
                }
              });
            }}
            className={cn(
              "group relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl border bg-background/65 text-muted-foreground transition-all duration-300 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:h-10 sm:w-10",
              isFullscreen
                ? "border-primary/50 bg-primary text-primary-foreground shadow-lg shadow-primary/25"
                : "border-border/60 hover:border-primary/35 hover:text-primary",
            )}
            disabled={!tauriAvailable}
          >
            <span className={cn(
              "pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-br from-primary/12 via-primary/8 to-transparent opacity-0 transition-opacity duration-300",
              isFullscreen ? "opacity-100" : "group-hover:opacity-100",
            )} />
            <Maximize2 className="relative z-10 h-4 w-4 transition-transform duration-300 group-hover:scale-110" />
          </button>

          {navActions.map(renderNavAction)}

          <button
            type="button"
            onClick={requestLogout}
            disabled={isProcessing}
            className={cn(
              "group relative flex h-9 items-center gap-2 overflow-hidden rounded-xl border border-destructive/40 bg-destructive/10 px-3 text-xs font-semibold uppercase tracking-[0.2em] text-destructive transition-all duration-300 hover:bg-destructive hover:text-destructive-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:h-10 sm:text-[11px]",
              isProcessing && "cursor-not-allowed opacity-70"
            )}
          >
            <span className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-r from-destructive/18 via-destructive/12 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
            <LogOut className="relative z-10 h-3.5 w-3.5 transition-transform duration-300 group-hover:scale-110" />
            <span className="relative z-10 hidden sm:inline">Logout</span>
          </button>
        </div>
      </header>

      <LogoutConfirmDialog
        open={open}
        onOpenChange={setOpen}
        onConfirm={() => {
          void confirmLogout();
        }}
        isProcessing={isProcessing}
      />
    </>
  );
}
