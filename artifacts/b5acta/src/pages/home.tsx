import { Link } from "wouter";
import { Shield } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <div className="min-h-[100dvh] flex flex-col bg-background relative overflow-hidden">
      {/* Background grid pattern */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#4f4f4f2e_1px,transparent_1px),linear-gradient(to_bottom,#4f4f4f2e_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_80%_50%_at_50%_0%,#000_70%,transparent_100%)] pointer-events-none" />
      
      <header className="px-6 h-20 flex items-center justify-between border-b border-border/50 relative z-10 backdrop-blur-sm bg-background/50">
        <div className="flex items-center gap-3">
          <Shield className="w-8 h-8 text-primary shadow-[0_0_15px_rgba(251,191,36,0.3)]" />
          <span className="font-bold tracking-[0.3em] uppercase text-xl text-primary">B5:ACTA</span>
        </div>
        <div className="flex gap-4">
          <Link href="/sign-in" className="text-sm font-medium tracking-widest uppercase hover:text-primary transition-colors flex items-center px-4">
            Login
          </Link>
          <Link href="/sign-up">
            <Button variant="default" className="font-bold tracking-widest uppercase rounded-sm border border-primary/50 shadow-[0_0_10px_rgba(251,191,36,0.2)]">
              Enlist
            </Button>
          </Link>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center text-center px-6 relative z-10">
        <div className="max-w-3xl space-y-8">
          <div className="inline-block border border-primary/30 bg-primary/5 px-4 py-1.5 rounded-full">
            <span className="text-primary text-xs font-mono tracking-[0.3em] uppercase">Tactical Fleet Simulator</span>
          </div>
          <h1 className="text-5xl md:text-7xl font-bold tracking-tighter uppercase leading-[1.1] drop-shadow-sm">
            <span className="block text-foreground">A Call To</span>
            <span className="block text-primary bg-clip-text text-transparent bg-gradient-to-r from-primary to-primary/60">Arms</span>
          </h1>
          <p className="text-muted-foreground text-lg md:text-xl max-w-2xl mx-auto font-light tracking-wide">
            Assume command. Deploy your fleet. Outmaneuver opponents in synchronous and asynchronous strategic space combat.
          </p>
          <div className="pt-8">
            <Link href="/sign-up">
              <Button size="lg" className="h-14 px-8 text-base font-bold tracking-[0.2em] uppercase bg-primary hover:bg-primary/90 text-primary-foreground shadow-[0_0_20px_rgba(251,191,36,0.4)] transition-all hover:shadow-[0_0_30px_rgba(251,191,36,0.6)] rounded-sm">
                Initialize Uplink
              </Button>
            </Link>
          </div>
        </div>
      </main>

      <footer className="py-6 border-t border-border/50 text-center relative z-10 backdrop-blur-sm bg-background/50">
        <p className="text-xs text-muted-foreground font-mono uppercase tracking-[0.2em]">
          End of Line.
        </p>
      </footer>
    </div>
  );
}