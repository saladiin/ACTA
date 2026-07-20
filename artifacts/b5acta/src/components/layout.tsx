import { Link, useLocation } from "wouter";
import { useClerk } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { LogOut, LayoutDashboard, Crosshair, List, PanelLeftClose, PanelLeftOpen, CircleHelp, ScrollText, Settings, Sparkles, ShieldCheck, Newspaper, ChevronDown, ChevronUp, Ship } from "lucide-react";
import { Button } from "@/components/ui/button";
import { customFetch } from "@workspace/api-client-react";
import { APP_BUILD_SHA } from "@/lib/build-version";
import { useInputProfile } from "@/hooks/use-input-profile";
import { clearTemporaryUsername, temporaryUsernameAuthEnabled } from "@/lib/temporary-user";

type AdminMeResponse = {
  isAdmin: boolean;
};

type AppVersionResponse = {
  buildSha: string;
};

export function Layout({ children, title, sidebarBottom }: { children: ReactNode; title?: string; sidebarBottom?: ReactNode }) {
  const { signOut } = useClerk();
  const [, setLocation] = useLocation();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const inputProfile = useInputProfile();
  const mobileChrome = inputProfile.layout === "compact" || inputProfile.input === "touch";
  const [navOpen, setNavOpen] = useState(false);
  const [navMenuOpen, setNavMenuOpen] = useState(false);
  const { data: adminMe } = useQuery({
    queryKey: ["admin-me"],
    queryFn: () => customFetch<AdminMeResponse>("/api/admin/me", { responseType: "json" }),
    retry: false,
    staleTime: 60_000,
  });
  const { data: appVersion } = useQuery({
    queryKey: ["app-version"],
    queryFn: () => customFetch<AppVersionResponse>("/api/version", { responseType: "json" }),
    retry: false,
    staleTime: 0,
    refetchInterval: 180_000,
    refetchOnWindowFocus: true,
  });
  const showAdminNav = adminMe?.isAdmin === true;
  const updateAvailable = Boolean(appVersion?.buildSha && appVersion.buildSha !== APP_BUILD_SHA);

  useEffect(() => {
    setNavOpen(!mobileChrome);
  }, [mobileChrome]);

  return (
    <div
      className="min-h-[100dvh] flex flex-col md:flex-row bg-background text-foreground selection:bg-primary/30"
      data-input={inputProfile.input}
      data-layout={inputProfile.layout}
      data-platform={inputProfile.platform}
    >
      {mobileChrome && (
        <>
          <button
            type="button"
            aria-label={navOpen ? "Close command navigation" : "Open command navigation"}
            aria-expanded={navOpen}
            onClick={() => setNavOpen(open => !open)}
            className={`mobile-side-drawer-tab mobile-side-drawer-tab-left fixed left-0 top-24 z-50 flex h-12 w-9 items-center justify-center border border-l-0 border-border bg-card/95 text-primary shadow-lg transition-transform ${
              navOpen ? "translate-x-64" : "translate-x-0"
            }`}
            data-testid="button-mobile-main-nav-toggle"
          >
            {navOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
          </button>
          {navOpen && (
            <button
              type="button"
              aria-label="Close command navigation overlay"
              className="fixed inset-0 z-30 bg-black/45 md:hidden"
              onClick={() => setNavOpen(false)}
              data-testid="overlay-mobile-main-nav"
            />
          )}
        </>
      )}
      {/* Sidebar */}
      <aside
        className={`z-40 border-border bg-card flex flex-col shrink-0 safe-top transition-transform duration-200 ease-out ${
          mobileChrome
            ? `fixed inset-y-0 left-0 w-64 border-r shadow-2xl overflow-y-auto ${navOpen ? "translate-x-0" : "-translate-x-full"}`
            : "w-full md:w-64 border-b md:border-b-0 md:border-r"
        }`}
        data-state={navOpen ? "open" : "closed"}
        data-testid="main-navigation-sidebar"
      >
        <div className="p-4 md:p-6 border-b border-border flex items-center gap-3">
          <img
            src={`${basePath}/logo.png`}
            alt="Babylon 5 Wheel of Fire"
            className="h-12 w-12 shrink-0 object-contain drop-shadow-[0_0_12px_rgba(249,115,22,0.35)]"
          />
          <div className="flex flex-col leading-none">
            <span className="font-bold text-base tracking-[0.08em] text-stone-100">Babylon 5:</span>
            <span className="mt-1 text-[11px] text-primary uppercase tracking-[0.2em] font-mono">Wheel of Fire</span>
          </div>
        </div>
        <nav className="p-4 flex flex-col gap-2 hide-scrollbar overflow-y-auto overflow-x-hidden">
          <button
            type="button"
            aria-expanded={navMenuOpen}
            onClick={() => setNavMenuOpen((open) => !open)}
            className="flex items-center gap-3 rounded-md border border-border/80 bg-background/40 px-3 py-2 text-left text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
            data-testid="button-toggle-main-menu"
          >
            <List className="w-4 h-4" />
            <span className="flex-1 text-sm font-medium tracking-wide uppercase">Menu</span>
            {navMenuOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          {navMenuOpen && (
            <div className="flex flex-col gap-1 border-l border-border/70 pl-2">
              <Link onClick={() => mobileChrome && setNavOpen(false)} href="/lobby" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors shrink-0">
                <LayoutDashboard className="w-4 h-4" />
                <span className="text-sm font-medium tracking-wide uppercase">Lobby</span>
              </Link>
              <Link onClick={() => mobileChrome && setNavOpen(false)} href="/fleets" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors shrink-0">
                <List className="w-4 h-4" />
                <span className="text-sm font-medium tracking-wide uppercase">Fleets</span>
              </Link>
              <Link onClick={() => mobileChrome && setNavOpen(false)} href="/games" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors shrink-0">
                <Crosshair className="w-4 h-4" />
                <span className="text-sm font-medium tracking-wide uppercase">Active Ops</span>
              </Link>
              {import.meta.env.DEV && (
                <>
                  <Link onClick={() => mobileChrome && setNavOpen(false)} href="/naval-id" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors shrink-0">
                    <Ship className="w-4 h-4" />
                    <span className="text-sm font-medium tracking-wide uppercase">Naval ID</span>
                  </Link>
                  <Link onClick={() => mobileChrome && setNavOpen(false)} href="/vfx-showcase" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors shrink-0">
                    <Sparkles className="w-4 h-4" />
                    <span className="text-sm font-medium tracking-wide uppercase">VFX Range</span>
                  </Link>
                </>
              )}
              <Link onClick={() => mobileChrome && setNavOpen(false)} href="/credits" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors shrink-0">
                <ScrollText className="w-4 h-4" />
                <span className="text-sm font-medium tracking-wide uppercase">Credits</span>
              </Link>
              <Link onClick={() => mobileChrome && setNavOpen(false)} href="/faq" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors shrink-0">
                <CircleHelp className="w-4 h-4" />
                <span className="text-sm font-medium tracking-wide uppercase">FAQ</span>
              </Link>
              <Link onClick={() => mobileChrome && setNavOpen(false)} href="/update-log" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors shrink-0">
                <Newspaper className="w-4 h-4" />
                <span className="text-sm font-medium tracking-wide uppercase">Update Log</span>
              </Link>
              <Link onClick={() => mobileChrome && setNavOpen(false)} href="/settings" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors shrink-0">
                <Settings className="w-4 h-4" />
                <span className="text-sm font-medium tracking-wide uppercase">Settings</span>
              </Link>
              {showAdminNav && (
                <Link onClick={() => mobileChrome && setNavOpen(false)} href="/admin" className="flex items-center gap-3 px-3 py-2 rounded-md border border-primary/20 bg-primary/5 hover:bg-primary/10 text-primary transition-colors shrink-0">
                  <ShieldCheck className="w-4 h-4" />
                  <span className="text-sm font-medium tracking-wide uppercase">Admin</span>
                </Link>
              )}
            </div>
          )}
        </nav>
        {sidebarBottom && (
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
            {sidebarBottom}
          </div>
        )}
        <div className={`p-4 border-t border-border mt-auto space-y-2 ${mobileChrome ? "block safe-bottom" : "hidden md:block"}`}>
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70" data-testid="text-app-build">
            Build {APP_BUILD_SHA}
          </div>
          <Button 
            variant="ghost" 
            className="w-full justify-start gap-3 text-muted-foreground hover:text-destructive hover:bg-destructive/10 uppercase tracking-widest text-xs"
            onClick={() => {
              if (temporaryUsernameAuthEnabled) {
                clearTemporaryUsername();
                setLocation("/sign-in", { replace: true });
                return;
              }
              signOut({ redirectUrl: basePath || "/" });
            }}
          >
            <LogOut className="w-4 h-4" />
            Disengage
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden relative">
        {updateAvailable && (
          <div className="z-20 border-b border-amber-400/50 bg-amber-400/10 px-4 py-2 font-mono text-[11px] text-amber-100 md:px-6" data-testid="banner-update-available">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>New build available. Refresh before continuing.</span>
              <button
                type="button"
                className="rounded border border-amber-300/60 bg-amber-300 px-2 py-0.5 font-bold text-black hover:bg-amber-200"
                onClick={() => window.location.reload()}
                data-testid="button-refresh-build"
              >
                Refresh
              </button>
            </div>
          </div>
        )}
        {title && (
          <header className="min-h-16 border-b border-border bg-background/80 backdrop-blur flex items-center px-4 md:px-6 py-3 shrink-0 sticky top-0 z-10">
            <h1 className="text-base md:text-lg font-bold tracking-widest uppercase text-primary/90 flex items-center gap-2 min-w-0">
              <span className="w-2 h-2 bg-primary rounded-full animate-pulse shadow-[0_0_8px_rgba(251,191,36,0.8)]" />
              <span className="truncate">{title}</span>
            </h1>
          </header>
        )}
        <div className="flex-1 overflow-auto bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-secondary/20 via-background to-background">
          {children}
        </div>
      </main>
    </div>
  );
}
