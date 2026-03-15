import { useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { Cable, ClipboardList, Factory, LayoutDashboard, LogOut, ShieldCheck, Users, Wrench } from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { useLogoutDialog } from "@/hooks/useLogoutDialog";
import { LogoutConfirmDialog } from "@/components/LogoutConfirmDialog";
import { useAppFlow } from "@/context/AppFlowContext";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type SidebarItem = {
  title: string;
  url: string;
  icon: LucideIcon;
};

const mainItems: SidebarItem[] = [
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
  { title: "Operator", url: "/operator", icon: Users },
  { title: "Quality", url: "/quality", icon: ShieldCheck },
  { title: "Maintenance", url: "/maintenance", icon: Wrench },
];

const operationsItems: SidebarItem[] = [
  { title: "Production", url: "/production", icon: Factory },
  { title: "Work Orders", url: "/orders", icon: ClipboardList },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const isExpanded = state === "expanded";
  const { open, isProcessing, requestLogout, confirmLogout, setOpen } = useLogoutDialog();
  const navigate = useNavigate();
  const location = useLocation();
  const { stage, state: flowState } = useAppFlow();
  const [confirmOrdersOpen, setConfirmOrdersOpen] = useState(false);
  const shouldConfirmOrders = stage === "app" && flowState.orders.length > 0;

  const renderNavItem = (item: SidebarItem, index: number) => (
    <SidebarMenuItem key={item.title}>
      <SidebarMenuButton asChild tooltip={!isExpanded ? item.title : undefined}>
        <NavLink
          to={item.url}
          className={({ isActive }) =>
            cn(
              "group relative flex w-full items-center overflow-hidden rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-300 ease-in-out",
              isExpanded ? "gap-3 justify-start" : "justify-center",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:ring-offset-2",
              isActive 
                ? "bg-blue-500 text-white shadow-md shadow-blue-500/20" 
                : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"
            )
          }
          onClick={(event) => {
            if (
              item.url === "/orders" &&
              shouldConfirmOrders &&
              location.pathname !== "/orders"
            ) {
              event.preventDefault();
              setConfirmOrdersOpen(true);
            }
          }}
        >
          {({ isActive }) => (
            <>
              {/* Selection indicator */}
              <span
                className={cn(
                  "pointer-events-none absolute left-0 top-1/2 h-8 w-1 -translate-y-1/2 rounded-r-full bg-blue-600 transition-all duration-300 ease-out",
                  isActive ? "opacity-100 scale-y-100" : "opacity-0 scale-y-0"
                )}
              />
              
              <item.icon className={cn(
                "h-4 w-4 flex-shrink-0 transition-all duration-300 ease-in-out",
                isActive ? "scale-110" : "group-hover:scale-105"
              )} />
              {isExpanded && (
                <span className="transition-all duration-300 ease-in-out font-medium">
                  {item.title}
                </span>
              )}
            </>
          )}
        </NavLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );

  return (
    <>
      <Sidebar
        collapsible="icon"
        className="border-r border-border/40 bg-white shadow-sm transition-all duration-300 ease-in-out"
      >
        <SidebarHeader className="border-b border-border/40 p-4 pt-6">
          <div className={cn(
            "flex items-center gap-3 transition-all duration-300 ease-in-out",
            isExpanded ? "justify-between" : "justify-center"
          )}>
            {isExpanded && (
              <div className="flex items-center gap-3 overflow-hidden min-w-0 flex-1 animate-in fade-in slide-in-from-left-2 duration-300">
                <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 via-blue-600 to-blue-700 text-white shadow-lg shadow-blue-500/20 flex-shrink-0 transition-all duration-300 hover:scale-105">
                  <Cable className="h-5 w-5" />
                  <div className="absolute inset-0 rounded-xl bg-gradient-to-t from-white/20 to-transparent" />
                </div>
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-base font-bold leading-tight text-sidebar-foreground whitespace-nowrap tracking-tight">
                    CableQC System
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-sidebar-foreground/60 whitespace-nowrap">
                    Operations Console
                  </span>
                </div>
              </div>
            )}
            <div className="flex-shrink-0">
              <SidebarTrigger 
                iconVariant="hamburger"
                className="h-9 w-9 rounded-lg transition-all duration-300 ease-in-out hover:bg-gray-100 hover:scale-105 text-gray-700"
              />
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent className="gap-0 px-4 py-4 pb-20">
          <SidebarGroup className="pb-2">
            {isExpanded && (
              <SidebarGroupLabel className="px-2 mb-2 text-xs font-bold text-sidebar-foreground/60 uppercase tracking-wider transition-all duration-300 ease-in-out animate-in fade-in slide-in-from-top-1">
                Main
              </SidebarGroupLabel>
            )}
            <SidebarGroupContent>
              <SidebarMenu className="space-y-1.5">{mainItems.map((item, idx) => renderNavItem(item, idx))}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup className="pt-4">
            {isExpanded && (
              <SidebarGroupLabel className="px-2 mb-2 text-xs font-bold text-sidebar-foreground/60 uppercase tracking-wider transition-all duration-300 ease-in-out animate-in fade-in slide-in-from-top-1">
                Operations
              </SidebarGroupLabel>
            )}
            <SidebarGroupContent>
              <SidebarMenu className="space-y-1.5">{operationsItems.map((item, idx) => renderNavItem(item, idx + mainItems.length))}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="border-t border-border/40 px-4 py-4 mt-auto">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip={!isExpanded ? "Logout" : undefined}>
                <button
                  disabled={isProcessing}
                  onClick={requestLogout}
                  className={cn(
                    "group relative flex w-full items-center overflow-hidden rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-300 ease-in-out",
                    isExpanded ? "gap-3 justify-start" : "justify-center",
                    "text-sidebar-foreground hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 focus-visible:ring-offset-2",
                    isProcessing && "cursor-not-allowed opacity-50"
                  )}
                >
                  <LogOut className="h-4 w-4 flex-shrink-0 transition-transform duration-300 ease-in-out group-hover:scale-110" />
                  {isExpanded && (
                    <span className="transition-all duration-300 ease-in-out font-medium">
                      Logout
                    </span>
                  )}
                </button>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>

        <SidebarRail className="transition-all duration-300 ease-in-out hover:bg-gray-100" />
      </Sidebar>

      <LogoutConfirmDialog
        open={open}
        onOpenChange={setOpen}
        onConfirm={() => {
          void confirmLogout();
        }}
        isProcessing={isProcessing}
      />

      <AlertDialog open={confirmOrdersOpen} onOpenChange={setConfirmOrdersOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch work orders?</AlertDialogTitle>
            <AlertDialogDescription>
              You have an active production session. Returning to Work Orders will let you change the
              OF and reference assignments for the operator. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay here</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOrdersOpen(false);
                navigate("/orders");
              }}
            >
              Go to Work Orders
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
