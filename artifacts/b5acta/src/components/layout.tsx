import { Link } from "wouter";
import { useClerk } from "@clerk/react";
import { LogOut, LayoutDashboard, Crosshair, List, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Layout({ children, title }: { children: React.ReactNode; title?: string }) {
  const { signOut } = useClerk();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

  return (
    <div className="min-h-[100dvh] flex flex-col md:flex-row bg-background text-foreground selection:bg-primary/30">
      {/* Sidebar */}
      <aside className="w-full md:w-64 border-b md:border-b-0 md:border-r border-border bg-card flex flex-col shrink-0">
        <div className="p-4 md:p-6 border-b border-border flex items-center gap-3">
          <Shield className="w-8 h-8 text-primary" />
          <div className="flex flex-col">
            <span className="font-bold tracking-widest text-lg leading-tight">B5: ACTA</span>
            <span className="text-[10px] text-primary uppercase tracking-[0.2em] font-mono">Command</span>
          </div>
        </div>
        <nav className="p-4 flex-1 flex flex-row md:flex-col gap-2 overflow-x-auto md:overflow-visible hide-scrollbar">
          <Link href="/lobby" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors shrink-0">
            <LayoutDashboard className="w-4 h-4" />
            <span className="text-sm font-medium tracking-wide uppercase">Lobby</span>
          </Link>
          <Link href="/fleets" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors shrink-0">
            <List className="w-4 h-4" />
            <span className="text-sm font-medium tracking-wide uppercase">Fleets</span>
          </Link>
          <Link href="/games" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors shrink-0">
            <Crosshair className="w-4 h-4" />
            <span className="text-sm font-medium tracking-wide uppercase">Active Ops</span>
          </Link>
        </nav>
        <div className="p-4 border-t border-border mt-auto hidden md:block">
          <Button 
            variant="ghost" 
            className="w-full justify-start gap-3 text-muted-foreground hover:text-destructive hover:bg-destructive/10 uppercase tracking-widest text-xs"
            onClick={() => signOut({ redirectUrl: basePath || "/" })}
          >
            <LogOut className="w-4 h-4" />
            Disengage
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden relative">
        {title && (
          <header className="h-16 border-b border-border bg-background/80 backdrop-blur flex items-center px-6 shrink-0 sticky top-0 z-10">
            <h1 className="text-lg font-bold tracking-widest uppercase text-primary/90 flex items-center gap-2">
              <span className="w-2 h-2 bg-primary rounded-full animate-pulse shadow-[0_0_8px_rgba(251,191,36,0.8)]" />
              {title}
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