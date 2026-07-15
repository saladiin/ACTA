# Player FAQ: How To Play Babylon 5 ACTA Online

This FAQ explains how to play the web version of Babylon 5: A Call to Arms. It is written for new public testers, so it focuses on what to do in the app rather than every tabletop edge case.

## Getting Started

### What is this game?

This is an online version of Babylon 5: A Call to Arms, a starship miniatures game where two commanders maneuver fleets, line up weapon arcs, fire ship weapons, and try to cripple or destroy the opposing force.

The app handles most measuring, dice rolling, damage tracking, and turn bookkeeping for you.

### Do I need to know the tabletop rules first?

It helps, but you can learn by playing. The main things to understand are:

- Ships move and turn before they fire.
- Weapons need range and firing arc.
- Bigger ships take damage and crew losses before they are destroyed.
- Initiative decides who has the tempo each round.
- The app will block many illegal actions, but public alpha testers should still report anything that feels wrong.

### What should I do first?

Head to the Lobby and join an open match, or start one with another player or the AI. Create new fleets in the Fleets menu to reuse in the future; fleet reuse is still in development. You can review your current games in Active Ops.

## Fleets And Games

### How do I start a game?

Open **New Engagement**, choose your setup, select a fleet if you want to bring one immediately, and create the game. Depending on the setup, the other player may need to accept and deploy before the game begins.

### Can I play against the AI?

Yes, if AI opponent is enabled on the server. AI games are useful for quick testing, but the AI is a convenience opponent, not a tournament-grade commander.

## Board Basics

### What does the board represent?

The board is measured in inches. The 3D board uses one world unit as one inch, so movement and range are represented directly on the table.

### How do I select a ship?

Click a ship or its base. The selected ship is highlighted and its available controls appear in the side panel or board controls.

### What do the colored rings and arcs mean?

The base and arc overlays show orientation, weapon arcs, selected status, and current phase availability. Green means available; white means unavailable.

### Can I pre-measure?

Yes. The app is designed around visible ranges, arcs, and board positioning so players can make informed moves.

## Turn And Phase Flow

### What happens in a round?

A normal round flows through:

1. **Initiative**
2. **Movement**
3. **Firing**
4. **End Phase**

The app advances phases when both players have completed the required actions.

### What is initiative?

Initiative determines who controls the pace of the round. After initiative, players alternate activations through movement and firing.

### Why can only some ships act?

A ship may already have moved or fired this round, may be destroyed, may be crippled by damage effects, or may not be eligible in the current phase.

### What if I have no useful action?

Use the available pass/end controls. In some phases, the app may let you pass because you have no eligible ships or because you are done acting.

## Deployment

### How do I deploy ships?

In the right sidebar, under Fleet Yards, drag the desired ship onto the board within your marked amber deployment area. Placement is committed only when you select Commit and Engage.

### What is deployment depth?

Deployment depth controls how far onto the board each player may place ships at the start. It is selected when the game is created.

### Can I move enemy ships during deployment?

No. You only place your own fleet.

## Movement

### How does movement work?

Select an eligible ship; by default, eligible ships display a flashing green ring. On PC, press F to command the ship to move. Use Q and E to turn to port or starboard, respectively, once the ship is eligible to turn. Press Spacebar to commit the movement segment. Be sure to select any desired Special Actions before committing to movement. Once you are done moving, press N or click End Activation.

### Do ships have to move?

Usually, yes. Most ships must move at least half their current speed unless a special action or damage state allows otherwise.

### How do turns work?

Ships have turn limits based on their profile. The movement controls show what the selected ship can currently do. Some ships are more maneuverable than others.

### What is All Stop?

All Stop is a special movement choice that lets a ship remain stationary when allowed. Some variants, such as All Stop and Pivot, affect how the ship can rotate.

### What happens to adrift ships?

Adrift ships cannot maneuver normally. The app handles compulsory drift timing and movement according to its current rules implementation.

## Firing

### How do I attack?

During the Firing phase:

1. Activate a ship.
2. Select a weapon.
3. Choose an enemy target in range and arc.
4. Commit the shot.
5. Roll through the displayed dice sequence.
6. Continue with more weapons or end that ship's firing activation.

### Can one ship fire more than one weapon?

Yes. A ship can usually fire multiple weapon systems during its firing activation, but each weapon can only be used once per activation.

### Why can I not target a ship?

Common reasons:

- The target is out of range.
- The target is outside the weapon arc.
- The target is friendly.
- The selected weapon already fired.
- The firing ship is destroyed, inert, or otherwise unable to fire.
- It is not your firing activation.

### What are weapon arcs?

Weapon arcs describe where a weapon can fire: forward, aft, port, starboard, turret, boresight, and similar arcs. The app shows weapon coverage for the selected weapon when relevant.

### What is a boresight weapon?

Boresight weapons fire in a narrow forward or aft line. They require careful positioning.

### What are Energy Mines?

Energy Mines are area-style weapons. In the app, the mine projectile travels straight to the target and then creates a detonation pulse.

## Dice And Combat Results

### Who rolls the dice?

The app rolls dice for attacks, damage, criticals, and automated checks. The dice UI shows the sequence so players can follow what happened.

### What does "to hit" mean?

Attack dice must meet or beat the target's required number. Some weapon traits, such as Beam or Mini-Beam, use special hit behavior.

### What happens after a hit?

The app resolves defensive steps, then rolls damage results. Hits may cause hull damage, crew loss, critical effects, or no meaningful damage depending on the result and weapon traits.

### What are critical hits?

Critical hits represent serious system damage: engines, reactor, weapons, crew, or vital systems. Some critical effects can be repaired later; some are permanent.

### Why did a hit do no damage?

Possible reasons include bulkhead results, shields, interceptors, dodge, GEG or other defensive traits, weapon rules, or special damage handling.

## Damage, Destruction, And End Phase

### How do I know a ship is damaged?

The side panel shows hull and crew values. The 3D board also uses visual damage effects for heavily damaged or destroyed ships.

### What happens when a ship reaches zero hull?

The app resolves the appropriate destruction or damage state. Some ships may be destroyed immediately; others may become adrift or explode later depending on the result.

### Can destroyed ships still matter?

Yes. A destroyed ship may still remain on the board visually or affect cleanup timing, but it should no longer act as a normal active ship. The game rules and server state still decide what it can or cannot do.

### What happens in End Phase?

End Phase handles cleanup and end-of-round effects such as damage control, delayed explosions, adrift drift, shield/interceptor refresh, and round advancement.

### What is Damage Control?

Damage Control is the attempt to repair some ongoing critical effects. It does not simply restore all lost hull or crew.

## Special Actions

### What are special actions?

Special actions are declared choices that trade normal flexibility for a specific benefit. Examples include All Stop, All Stop and Pivot, Concentrate All Fire-power, and other ship-dependent options.

### Why can I not use a special action?

Common reasons:

- The ship is crippled, skeleton-crewed, or affected by a critical.
- The timing is wrong.
- The ship already moved or fired in a way that prevents it.
- The action requires a command check and failed.
- The current app implementation does not support that action yet.

### What is Concentrate All Fire-power?

It is a special action focused on improving fire against a nominated target. The app marks the nominated target relationship visually when active.

## Fighters

### Are fighters different from capital ships?

Yes. Fighter units have different activation and base-overlap behavior from capital ships. They are also handled separately for some phase and targeting rules.

### Can fighters overlap ships?

The app allows fighter and capital bases to overlap in situations where two capital ships would not be allowed to share the same space.

## UI And Controls

### How do I move the camera?

Use the board camera controls available for your device. Desktop and mobile/tablet controls differ slightly, but both are intended to let you inspect the board, select ships, and confirm actions.

### What does the side panel do?

The side panel shows game status, active phase, selected unit details, available actions, fleet roster, combat feedback, and AI controls when relevant.

### Why does the board show a preview?

Movement previews show where a ship would end up before you commit. Confirm the move when the preview matches your intended final position.

### Can I undo an action?

Assume no. Once a move, shot, or phase pass is confirmed, the server treats it as committed. For public testing, report misclicks or confusing controls so the UX can improve.

## AI Opponent

### How do AI turns work?

AI actions are advanced by AI step controls or automatic step controls, depending on the current build. The AI makes legal-ish choices based on the board state, but it may not be clever.

### Should I report strange AI behavior?

Yes. Include the game, round, phase, active ship, and what the AI did.

### Does AI change the rules?

No. AI should use the same server-side rules checks as a human player.

## Testing And Bug Reports

### What should I report?

Report anything that blocks play, crashes the page, produces impossible movement or firing, gives a confusing result, or differs from the expected ACTA behavior.

### What details help most?

Include:

- Game URL or game ID.
- Round and phase.
- Ship names involved.
- Weapon used, if any.
- What you expected.
- What actually happened.
- Screenshot or browser error text if available.

### What does "public alpha" mean?

It means the game is playable enough for testing, but balance, rules fidelity, UI polish, and edge cases are still being improved.

## Quick First-Turn Checklist

1. Confirm both fleets are deployed.
2. Roll or resolve initiative.
3. Activate a movement-eligible ship.
4. Move at least the required minimum unless using a valid exception.
5. Repeat until movement is complete.
6. Activate a firing-eligible ship.
7. Pick weapon and target.
8. Resolve the dice modal.
9. Fire remaining weapons or end that activation.
10. Complete End Phase and start the next round.
