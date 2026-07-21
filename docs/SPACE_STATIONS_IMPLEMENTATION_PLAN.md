# Space Stations Implementation Plan

## Source And Scope

Primary source: `rules 2nd edition/A Call To Arms - Powers & Principalities.pdf`.

- PDF pages 41-43 (printed pages 40-42): station deployment, attacks,
  damage, thresholds, interceptors, criticals, special actions, boarding,
  cores, and modules.
- PDF pages 51-53 (printed pages 50-52): Earth Alliance modules.
- PDF pages 62-63 (printed pages 61-62): worked examples and the Orion
  Space Station profile.
- `rules 2nd edition/Powers and Principalities errata.pdf` contains no Orion
  or general space-station correction.

The initial implementation target is the published Orion Space Station. The
same engine should later support custom station cores and modules without
encoding each station as a special case.

## Orion Rules Profile

- Faction: Earth Alliance
- Priority: Raid (Border Station core)
- Hull: 4
- Damage: 75
- Heavily Damaged threshold: 40
- Crippled threshold: 20
- Troops: 15
- Hardpoints: 9
- Crew Quality: fixed at 4
- Speed/Turns: 0; Immobile
- Traits: Anti-Fighter 4, Interceptors 5, Space Station
- Medium Pulse Cannon: Turret, 15 inches, 5 AD, Twin-Linked
- Missile Rack: Turret, 45 inches, 5 AD, Precise, Slow-Loading, Super AP

The checked-in ship-model schema currently supports only one Damage threshold.
The data seed therefore uses 20 as the Crippled threshold. The 40-point Heavily
Damaged threshold requires the station state work below.

## Current Compatibility

Already reusable:

- Raid fleet-allocation cost and Earth Alliance roster grouping.
- Turret arcs and normal weapon traits, including Twin-Linked, Precise,
  Slow-Loading, and Super AP.
- Generic Anti-Fighter and Interceptor parsing.
- Troops are stored on ship profiles for future boarding rules.

Not rules-complete:

- Speed 0 prevents translation, but stations can still enter the ordinary
  movement activation and Special Action paths.
- Ordinary ships have one damage threshold; stations require two.
- Normal catastrophic damage, critical-hit, Damage Control, interceptor, and
  destruction paths do not implement the station exceptions.
- A generic LOS-obstacle utility now exists in the working tree, but station
  units are not yet registered as 1-inch blockers. Boarding is absent.
- No Orion 3D asset is currently checked in under `orion-space-station.glb`,
  so the board uses the normal missing-model fallback until an asset is added.

## Delivery Plan

### 1. Station Identity And State

- Add an explicit station unit kind derived from structured model data rather
  than repeatedly parsing the display trait string.
- Add `heavyDamageThreshold` alongside the existing cripple threshold on ship
  models and deployed units.
- Add an `inoperable` unit state distinct from adrift, exploding, and
  destroyed. An inoperable station remains on the table and takes no actions.
- Lock station Crew Quality to 4 at deployment and reject later modifiers.
- Preserve separate collision radius and the rules-defined 1-inch LOS-blocking
  radius so station visuals do not distort measurement.

### 2. Fleet Building And Deployment

- Enforce no more than one station in a standard fleet.
- Permit station placement anywhere inside the owning deployment zone.
- Exclude Immobile stations from movement activation counts so they cannot be
  used to manipulate alternating initiative.
- Reject movement and heading changes after deployment. Keep a future
  exception for a Planet-Killer module that supplies Speed and Turns.
- Add a station roster warning until all station rules are enabled.

### 3. Station Firing And Defence

- Keep all mounted station weapons in the Turret arc and resolve attacks using
  the normal ship firing pipeline.
- Ensure stations do not receive or depend on the obsolete Targets trait.
- Replace per-weapon interceptor spending with a station pool allocated once
  when an enemy ship announces all weapon systems for its attack.
- Discard allocated station Interceptor dice until the next round.
- Halve available Interceptors, rounding down, whenever a station crosses a
  damage threshold.
- Register operational and inoperable stations with the existing LOS-obstacle
  utility and reject fire when the segment between two ships passes within
  1 inch of a station centre.

### 4. Damage, Thresholds, And Criticals

- Detect crossing 40 Damage as Heavily Damaged and 20 as Crippled.
- At each crossed threshold, roll once for every surviving weapon system and
  Special Trait; destroy each on a 6. Handle Interceptors through their special
  halving rule instead of ordinary trait loss.
- Add the six-result Space Station Critical Hits table: Reactor Fluctuation,
  Launch Tubes Blocked, Station-Keeping Thrusters Damaged, Command & Control,
  Weapon System Offline, and Reactor Explosion.
- Record the round each station critical was inflicted and automatically
  repair it in the following turn's End Phase.
- Disable Damage Control for stations.
- At 0 Damage, set `inoperable`; do not roll the ordinary ship Damage Table and
  do not remove the station as destroyed.

### 5. Actions, Fighters, And AI

- Hide and reject every Special Action for stations.
- Block all actions once inoperable while retaining the station as a LOS and
  collision object.
- Apply Launch Tubes Blocked to fighter deployment once station hangars are
  supported.
- Teach AI activation selection to skip stations in movement, fire normally
  with operational station weapons, allocate station Interceptors, and stop
  acting when inoperable.
- Teach AI target evaluation that an inoperable station is a scenario object,
  not a normal destroyed-ship target.

### 6. Boarding And Capture

- Use Troops 15 as the Orion's defending strength.
- After defenders reach zero, resolve each attacking Troop: 1 removes the
  attacker, 2-5 inflicts that much Damage, and 6 causes a station critical.
- Add capture/surrender ownership and scenario outcomes without deleting the
  station object.
- Keep campaign repair/capture rules behind a later campaign feature flag.

### 7. Presentation And Asset Work

- Add a dedicated station status panel showing `75 / 40 / 20`, operational
  weapons/traits, and the remaining Interceptor pool.
- Provide threshold and inoperable visual states without ship-style drifting
  or destruction movement.
- Import an Orion GLB and isolate its rotating ring as an animation clip or
  named child group. Rotation is visual-only and must not alter weapon arcs or
  board heading.
- Scale labels and health bars for the larger silhouette while keeping them
  viewer-facing in tactical mode.

### 8. Verification And Rollout

- Unit-test both threshold crossings, weapon/trait loss rolls, station critical
  timing, Interceptor allocation, Special Action rejection, and zero-Damage
  inoperability.
- Add integration tests for deployment limits, skipped movement activation,
  Turret firing, LOS blocking, AI behavior, and boarding.
- Add a deterministic Orion scenario fixture for desktop and mobile testing.
- Keep competitive/public station selection marked experimental until phases
  1-5 pass automated and two-player regression testing.
