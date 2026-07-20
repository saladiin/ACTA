# Campaign Map Inspiration

Saved: 2026-07-18

Long-term goal: add a persistent campaign mode for Babylon 5: ACTA where
players control territory, fleets, systems, resources, and unresolved conflicts
between tactical battles.

## Strongest Inspirations

### Neptune's Pride

Link: https://np.ironhelmet.com/

Why it matters:
- Persistent browser-based star map.
- Fleets travel between systems over time.
- Diplomacy, fog, slow-burn planning, and asynchronous turns.
- Good mental model for fleets moving across Babylon 5 jump routes, with ACTA
  battles triggered when hostile forces meet.

ACTA takeaway:
- Use a 2D starmap with system nodes, fleet tokens, jump-route lines, faction
  colors, and pending battle markers.
- Campaign turns can be slower than tactical games.

### Backstabbr Diplomacy

Link: https://www.backstabbr.com/

Why it matters:
- Clean browser map interaction.
- Players submit orders and the system resolves them later.
- Handles asynchronous multiplayer clearly without requiring everyone online at
  the same moment.

ACTA takeaway:
- Consider campaign order submission: move fleet, reinforce, repair, build,
  scout, blockade, withdraw.
- Resolve campaign orders at a turn deadline, then create tactical ACTA battles
  only where needed.

### Advance Wars By Web

Link: https://awbw.amarriner.com/

Why it matters:
- Browser-based tactical strategy with persistent games.
- Good examples of map readability, turn history, saved matches, and player
  flow around ongoing games.

ACTA takeaway:
- Campaign mode needs a clear active-games list, turn status, battle history,
  and replayable/inspectable outcomes.

## Map And Campaign Tools

### Hextml

Link: https://hextml.playest.net/

Why it matters:
- Browser hex map editing and campaign annotation.
- Useful for ownership, notes, fog, sectors, and GM-style map management.

ACTA takeaway:
- Could inspire an admin/dev campaign editor for systems, routes, hazards,
  faction ownership, and scenario tags.

### Campaign Mapper

Link: https://campaign-mapper.vercel.app/

Why it matters:
- Combines maps with named locations, factions, and campaign notes.
- Useful for thinking about campaign data presentation rather than just visuals.

ACTA takeaway:
- Each system should expose compact metadata: owner, income, strategic value,
  defenses, shipyards, current fleets, and open battles.

### Hexroll

Link: https://hexroll.app/

Why it matters:
- Readable generated hex-world presentation.
- Clickable locations with concise summaries.

ACTA takeaway:
- Even if the ACTA campaign map is not hex-based, locations should be clickable
  and immediately explain why they matter.

## Grand Strategy Feel

### Warnament

Link: https://warnament.com/

Why it matters:
- Province-map grand strategy with editor support.
- Territory changes hands clearly and visually.

ACTA takeaway:
- A sector/province-style overlay could work for campaigns where systems belong
  to regions rather than only isolated star nodes.

### Territorial.io

Link: https://territorial.io/

Why it matters:
- Very simple territory-control readability.
- Fast visual feedback for borders, ownership, and contested areas.

ACTA takeaway:
- Keep ownership color language obvious. Campaign mode should be readable at a
  glance before players inspect detailed fleet rosters.

## Technical References

### Red Blob Games Hex Grids

Link: https://www.redblobgames.com/grids/hexagons/

Why it matters:
- Best reference for hex-grid coordinate math, distance, pathfinding, and
  neighbor logic.

ACTA takeaway:
- If campaign mode uses hex sectors, use proven hex math instead of inventing
  coordinate handling from scratch.

### Interactive Hex World Map Using D3

Link: https://bennycheung.github.io/interactive-hex-world-map-using-d3

Why it matters:
- Lightweight browser map approach with SVG/D3-style interaction.

ACTA takeaway:
- A 2D SVG/canvas campaign layer may be easier, faster, and more stable than a
  3D galaxy map for the first campaign implementation.

## Initial Direction For ACTA

Start with a 2D starmap, not a 3D galaxy.

Recommended first concept:
- Systems are nodes.
- Jump routes are edges.
- Faction ownership is color-coded.
- Fleets are movable tokens attached to systems or routes.
- Campaign orders resolve asynchronously.
- When hostile fleets meet, the campaign creates or links to a tactical ACTA
  battle.
- Battle results persist back into campaign state: destroyed ships, damaged
  survivors, captured systems, repairs, retreats, and campaign log entries.

Good first milestone:
- Read-only campaign map prototype with clickable systems, routes, ownership,
  dummy fleet tokens, and a right-side detail panel.

Second milestone:
- Persist campaign, systems, fleets, orders, and campaign log entries in the
  existing PostgreSQL app.

Third milestone:
- Create tactical games from campaign conflicts and write battle outcomes back
  to campaign state.
