import { Link, useLocation } from "wouter";
import { useClerk } from "@clerk/react";
import { useEffect, useState, type ReactNode } from "react";
import { LogOut, LayoutDashboard, Crosshair, List, PanelLeftClose, PanelLeftOpen, Settings, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useInputProfile } from "@/hooks/use-input-profile";
import { clearTemporaryUsername, temporaryUsernameAuthEnabled } from "@/lib/temporary-user";

export function Layout({ children, title }: { children: ReactNode; title?: string }) {
  const { signOut } = useClerk();
  const [, setLocation] = useLocation();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const inputProfile = useInputProfile();
  const mobileChrome = inputProfile.layout === "compact" || inputProfile.input === "touch";
  const [navOpen, setNavOpen] = useState(false);

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
        <nav className={`p-4 flex-1 flex gap-2 hide-scrollbar ${mobileChrome ? "flex-col overflow-visible" : "flex-row md:flex-col overflow-x-auto md:overflow-visible"}`}>
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
          <Link onClick={() => mobileChrome && setNavOpen(false)} href="/vfx-showcase" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors shrink-0">
            <Sparkles className="w-4 h-4" />
            <span className="text-sm font-medium tracking-wide uppercase">VFX Range</span>
          </Link>
          <Link onClick={() => mobileChrome && setNavOpen(false)} href="/settings" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors shrink-0">
            <Settings className="w-4 h-4" />
            <span className="text-sm font-medium tracking-wide uppercase">Settings</span>
          </Link>
        </nav>
        <div className={`p-4 border-t border-border mt-auto ${mobileChrome ? "block safe-bottom" : "hidden md:block"}`}>
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
