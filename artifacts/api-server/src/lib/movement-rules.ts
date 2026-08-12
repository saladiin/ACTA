const MOVEMENT_EPSILON = 1e-6;

export function effectiveMovementTurnLimit(
  maximumTurns: number,
  traits: { lumbering?: boolean },
): number {
  const normalized = Math.max(0, maximumTurns);
  return traits.lumbering ? Math.min(1, normalized) : normalized;
}

export function lumberingForwardMovementAllowed(
  traits: { lumbering?: boolean },
  turnsMadeThisActivation: number,
  requestedDistance: number,
): boolean {
  return requestedDistance <= MOVEMENT_EPSILON
    || !traits.lumbering
    || turnsMadeThisActivation <= 0;
}
