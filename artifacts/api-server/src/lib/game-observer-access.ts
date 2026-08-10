export type GameViewerRole =
  | "challenger"
  | "opponent"
  | "observer"
  | "admin-observer"
  | "eligible-observer"
  | "open-guest";

export const MAX_GAME_OBSERVERS = 2;

export function observerSeatAvailable(currentCount: number, alreadyMember: boolean): boolean {
  return alreadyMember || currentCount < MAX_GAME_OBSERVERS;
}

type ViewerGame = {
  challengerId: string;
  opponentId: string | null;
  status: string;
  allowObservers: boolean;
};

export function resolveGameViewerRole(
  game: ViewerGame,
  userId: string,
  options: {
    isAdmin: boolean;
    isObserverMember: boolean;
    controlsAiOpponent?: boolean;
  },
): GameViewerRole | null {
  if (game.challengerId === userId) return "challenger";
  if (game.opponentId === userId || options.controlsAiOpponent) return "opponent";
  if (options.isAdmin) return "admin-observer";

  const observableStatus = game.status === "active" || game.status === "completed";
  if (game.allowObservers && observableStatus) {
    return options.isObserverMember ? "observer" : "eligible-observer";
  }
  return game.status === "open" ? "open-guest" : null;
}

export function viewerRoleHasFullGameState(role: GameViewerRole): boolean {
  return role !== "eligible-observer" && role !== "open-guest";
}

export function viewerRoleCanReadPublicHistory(role: GameViewerRole): boolean {
  return role !== "eligible-observer" && role !== "open-guest";
}
