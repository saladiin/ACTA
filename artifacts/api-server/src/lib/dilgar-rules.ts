export function mastersOfDestructionCriticalMultiplier(args: {
  attackerFaction: string | null | undefined;
  weaponName: string | null | undefined;
  defaultMultiplier: number;
}): number {
  const defaultMultiplier = Math.max(1, Math.trunc(args.defaultMultiplier));
  const faction = String(args.attackerFaction ?? "").trim().toLowerCase();
  const weaponName = String(args.weaponName ?? "").trim().toLowerCase();

  if (faction !== "dilgar imperium") {
    return defaultMultiplier;
  }
  if (/\bbolters?\b/.test(weaponName)) {
    return 3;
  }
  if (/\bpulsars?\b/.test(weaponName)) {
    return 2;
  }
  return defaultMultiplier;
}
