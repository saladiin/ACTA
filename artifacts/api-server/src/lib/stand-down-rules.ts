export const STAND_DOWN_RANGE_INCHES = 10;
export const STAND_DOWN_RECOVERY_TARGET = 10;

export type StandDownUnit = {
  id: number;
  ownerId: string;
  hullPoints: number;
  maxHullPoints: number;
  crewPoints?: number;
  maxCrewPoints?: number;
  x: number;
  z: number;
  baseRadiusInches: number;
  boardState?: string | null;
  damageState?: string | null;
  isDestroyed?: boolean;
  isFighter?: boolean;
  isSpaceStation?: boolean;
  surrenderedToOwnerId?: string | null;
  capturedByOwnerId?: string | null;
};

export function standDownEdgeDistance(a: StandDownUnit, b: StandDownUnit): number {
  return Math.max(
    0,
    Math.hypot(b.x - a.x, b.z - a.z) - a.baseRadiusInches - b.baseRadiusInches,
  );
}

export function standDownContributorEligible(
  contributor: StandDownUnit,
  target: StandDownUnit,
  coercingOwnerId: string,
): boolean {
  return contributor.ownerId === coercingOwnerId
    && contributor.id !== target.id
    && !contributor.isDestroyed
    && !contributor.isFighter
    && !contributor.isSpaceStation
    && !contributor.surrenderedToOwnerId
    && !contributor.capturedByOwnerId
    && (!contributor.boardState || contributor.boardState === "deployed")
    && contributor.damageState !== "adrift"
    && contributor.damageState !== "exploding-end-of-next"
    && contributor.hullPoints > 0
    && ((contributor.maxCrewPoints ?? 0) <= 0 || (contributor.crewPoints ?? 0) > 0)
    && standDownEdgeDistance(contributor, target) <= STAND_DOWN_RANGE_INCHES + 1e-6;
}

export function standDownPressureTotal(contributors: StandDownUnit[]): number {
  return contributors.reduce((total, contributor) => total + Math.max(0, contributor.hullPoints), 0);
}

export function standDownPressureSufficient(
  contributors: StandDownUnit[],
  targetStartingDamage: number,
): boolean {
  return standDownPressureTotal(contributors) > Math.max(0, targetStartingDamage);
}

export function standDownOpposedCheck(
  attackerRoll: number,
  attackerCrewQuality: number,
  attackerModifier: number,
  defenderRoll: number,
  defenderCrewQuality: number,
  defenderModifier: number,
): { attackerTotal: number; defenderTotal: number; success: boolean } {
  const attackerTotal = attackerRoll + attackerCrewQuality + attackerModifier;
  const defenderTotal = defenderRoll + defenderCrewQuality + defenderModifier;
  return {
    attackerTotal,
    defenderTotal,
    success: attackerTotal > defenderTotal,
  };
}

export function standDownRecoverySucceeds(roll: number, crewQuality: number): boolean {
  return roll + crewQuality >= STAND_DOWN_RECOVERY_TARGET;
}
