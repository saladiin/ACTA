import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { setExtraHeaders } from "@workspace/api-client-react";
import { useDevUserId, setDevUserId } from "../lib/dev-user";

// DEV-ONLY player-switch. Lets a single tester act as either commander so they
// can deploy ships and play both sides of a game without two real accounts.
// Gated on import.meta.env.DEV so it is stripped from the production bundle;
// the server additionally ignores the x-dev-user-id header in production.
const PLAYERS = [
  { id: "test-user-1", label: "P1", name: "COMMANDER-1" },
  { id: "test-user-2", label: "P2", name: "COMMANDER-2" },
];

export function DevModeToggle() {
  const qc = useQueryClient();
  const activeId = useDevUserId();

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    setExtraHeaders({ "x-dev-user-id": activeId });
  }, [activeId]);

  if (!import.meta.env.DEV) return null;

  const active = PLAYERS.find(p => p.id === activeId) ?? PLAYERS[0];
  const next = PLAYERS.find(p => p.id !== activeId) ?? PLAYERS[1];

  const toggle = () => {
    setExtraHeaders({ "x-dev-user-id": next.id });
    setDevUserId(next.id);
    qc.invalidateQueries();
  };

  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded border border-amber-500/40 bg-black/90 px-3 py-1.5 font-mono text-xs shadow-lg select-none">
      <span className="text-amber-500/50 uppercase tracking-widest">DEV</span>
      <span className="text-amber-400 font-bold uppercase tracking-wider">{active.name}</span>
      <button
        onClick={toggle}
        className="ml-1 rounded border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-amber-400 hover:bg-amber-500/25 uppercase tracking-wider transition-colors cursor-pointer"
        data-testid="dev-mode-toggle"
        title={`Switch to ${next.name}`}
      >
        → {next.label}
      </button>
    </div>
  );
}
