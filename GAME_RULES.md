# Deliveroo.js Game Rules

This document describes the core game mechanics of Deliveroo.js, an educational grid-based parcel collection game.

## Tile Types

The game grid consists of tiles with different types that determine agent movement and behavior.

| Type | Name | Description |
|------|------|-------------|
| `"0"` | Wall | Non-walkable tile. Agents cannot enter or pass through walls. |
| `"1"` | Parcel Spawner | Parcels spawn on this tile periodically according to the `generation_event` configuration. |
| `"2"` | Delivery Zone | Agents can deposit carried parcels here to earn reward points. Scoring only occurs when a parcel is put down on a delivery tile. |
| `"3"` | Walkable | Standard traversable tile. Agents can move freely on walkable tiles. |
| `"4"` | Base | Reserved tile type (appears in maps but functions similarly to walkable in standard gameplay). |
| `"5"` | Obstacle (Crate) | Pushable obstacle. Agents can push crates by walking into them. The `!` suffix (e.g., `"5!"`) indicates an initially locked crate. |

### Directional Tiles

Directional tiles enforce one-way movement flow:

| Type | Direction | Movement Effect |
|------|-----------|----------------|
| `"↑"` | Up | Entry is allowed from any direction **except from above** (entering against the arrow, i.e. moving down onto the tile, is prohibited). Exit is unrestricted. |
| `"→"` | Right | Entry is allowed from any direction **except from the right** (entering against the arrow, i.e. moving left onto the tile, is prohibited). Exit is unrestricted. |
| `"↓"` | Down | Entry is allowed from any direction **except from below** (entering against the arrow, i.e. moving up onto the tile, is prohibited). Exit is unrestricted. |
| `"←"` | Left | Entry is allowed from any direction **except from the left** (entering against the arrow, i.e. moving right onto the tile, is prohibited). Exit is unrestricted. |

**Entry vs Exit Rules:**
- Directional tiles restrict **entry only**: an agent may enter from any direction EXCEPT the one directly opposite the arrow (the only blocked move is stepping onto the tile *against* the arrow). Lateral entry (perpendicular to the arrow) is allowed.
- **Exit is unrestricted** — once on a directional tile, an agent may leave in any direction.
- Violating the entry restriction applies a penalty to the agent.

**Locked Tiles:**
- Tiles can be temporarily locked during animations to prevent concurrent access
- Locked tiles reject movement attempts and apply a penalty

---

## Agent Actions

Agents interact with the game world through the Controller class, which provides synchronized actions.

### Movement Actions

All movement actions return the new position on success or `false` on failure.

```javascript
async up()    // Move up (dy: +1)
async down()  // Move down (dy: -1)
async left()  // Move left (dx: -1)
async right() // Move right (dx: +1)
```

**Movement Process:**
1. Check directional tile entry restrictions (to destination tile) — the move is rejected only if the destination is a directional tile entered against its arrow. Exit from the current tile is never restricted.
2. Verify destination tile is walkable and not locked
3. If destination has a crate, attempt to push it
4. Execute step-by-step animated movement
5. Return new position

**Tile occupancy — one agent per tile:**
At most one agent may occupy any tile at a time. This applies universally: no two agents — whether teammates or enemies — can share a tile. A movement action whose destination is already occupied by any agent fails and applies a penalty, exactly like moving into a wall.

**Failure Conditions (all apply a penalty):**
- Destination tile is non-walkable (`type "0"`)
- Destination tile is locked
- Destination tile is occupied by another agent (teammate or enemy)
- Directional tile entry restriction violated (entered against the arrow)
- Crate cannot be pushed (blocked, not an obstacle tile, or locked)
- Crate destination contains another crate

### Pickup Action

```javascript
async pickUp()
```

**Behavior:**
- Collects ALL uncarried parcels at the agent's current position
- Each picked-up parcel is added to the agent's `carryingParcels` Set
- Returns an array of all picked parcels
- Parcels maintain their current reward value and decay state

**Constraint:**
- Agent can carry unlimited parcels (no capacity limit in current implementation)

### Putdown Action

```javascript
async putDown(ids?: string[])
```

**Parameters:**
- `ids` (optional): Array of parcel IDs to drop. If not provided, drops all carried parcels.

**Behavior:**
1. Filter carried parcels by provided IDs (or drop all if none specified)
2. For each parcel:
   - Remove from agent's `carryingParcels` Set
   - Set `carriedBy` to `null` (uncarried)
   - **If current tile is a delivery zone (`type "2"`):** add `parcel.reward` to agent score, then delete the parcel (removes it from the game world)
   - **Otherwise (any non-delivery tile):** the parcel is dropped on the ground at the agent's current position. It is **not** deleted — it remains on the map as an uncarried parcel and can be picked up again by any agent.
3. Update agent's total score by summing rewards of delivered parcels
4. Return array of dropped parcels

**Scoring:**
- Only parcels put down on delivery tiles (`type "2"`) contribute to score
- Score equals the sum of reward values of delivered parcels
- A scored parcel is deleted after scoring; a parcel dropped off a delivery tile is not scored and persists on the map

---

## Crate Pushing Mechanics

Crates are obstacle tiles (`type "5"`) that agents can push by walking into them.

### Push Conditions

A crate can be pushed if ALL conditions are met:

1. **Agent walks onto crate's tile** - Agent initiates movement toward the crate's position
2. **Crate destination is type "5"** - The tile beyond the crate must also be an obstacle tile (can be `"5"` or `"5!"`)
3. **Crate destination is not locked** - The destination tile must be unlocked
4. **No crate at destination** - Another crate cannot be occupying the destination tile

### Push Process

```
Agent at (x, y) pushes crate at (x+1, y):
1. Check crate at destination (x+2, y) is type "5" and not locked
2. Check no crate already at (x+2, y)
3. Move crate to (x+2, y)
4. Agent moves to (x+1, y)
```

### Failure Behavior

If a crate cannot be pushed:
- Movement fails
- Penalty is applied to the agent
- Agent stays at current position
- Crate remains at original position

---

## Parcel Reward Decay

Parcels lose value over time through a decay system.

### Initial Reward

New parcels receive an initial reward value calculated via `RewardDecayingSystem.calculateReward()`:

```
reward = floor(random() * variance * 2 + (avg - variance))
```

Where `avg` and `variance` come from `config.GAME.parcels`:
- `reward_avg`: Average reward value (default: 30)
- `reward_variance`: Spread around average (default: 10)

**Example:** With `avg=30` and `variance=10`, reward ranges from 20 to 40.

If an override reward is provided during parcel creation, that value is used directly.

### Decay Process

Parcels decay by 1 point per `decaying_event` tick (default: every 1 second):

```javascript
parcel.reward = floor(parcel.reward - 1)
```

### Expiration

A parcel is considered **expired** when its reward reaches 0 or below:
- The `expired` flag is set to `true`
- Expired parcels cannot be picked up
- Expired parcels that are not carried simply remain on the map (no removal from grid, only from scoring consideration)

---

## Scoring Rules

### Score Calculation

Agent score is updated only when parcels are successfully delivered:

```
agent.score += parcel.reward (at time of delivery)
```

### Score Events

- **Delivery**: When an agent puts down a parcel on a delivery tile, the parcel's current reward is added to the agent's score
- **Console Log**: The game logs delivery events showing: `AgentName(agentId) putDown N parcels (+ X pti -> Y pti)`

### Penalties

Penalties reduce an agent's score (stored separately in `agent.penalty`):

| Action | Penalty |
|--------|---------|
| Invalid movement | -1 (configurable via `PENALTY`) |
| Concurrent action conflict | -1 (trying to act while previous action in progress) |
| Directional tile restriction violation | -1 |

Penalties are cumulative and logged to console but do not directly reduce the score.

### Agent Deletion Cleanup

When an agent is deleted:
1. Wait for any pending action to complete
2. Unlock the agent's current tile
3. Put down all carried parcels (handles score updates and cleanup)
4. Emit deletion event and clear listeners

---

## Game Configuration

Key configuration values (from `config.js`):

| Parameter | Default | Description |
|-----------|---------|-------------|
| `GAME.player.movement_duration` | 50ms | Time for one movement step |
| `GAME.player.observation_distance` | 5 | How far agents can perceive |
| `GAME.player.capacity` | — | No upper bound: an agent can carry an unlimited number of parcels |
| `GAME.parcels.generation_event` | "1s" | Interval for spawning new parcels |
| `GAME.parcels.decaying_event` | "1s" | Interval for reward decay |
| `GAME.parcels.max` | — | No cap: any number of parcels may exist on the map at once |
| `GAME.parcels.reward_avg` | 30 | Average initial reward |
| `GAME.parcels.reward_variance` | 10 | Reward variance |
| `PENALTY` | 1 | Penalty value for violations |
| `CLOCK` | 50ms | Game tick interval |

---

## Tile Type Summary Table

```
Type    Description
─────────────────────────────────────────────────
"0"     Wall (non-walkable)
"1"     Parcel Spawner (parcels generate here)
"2"     Delivery Zone (scoring happens here)
"3"     Walkable (standard traversable)
"4"     Base (reserved tile type)
"5"     Obstacle/Crate (pushable)
"5!"    Locked Crate (cannot be pushed initially)
"↑"     Directional Up (one-way flow)
"→"     Directional Right (one-way flow)
"↓"     Directional Down (one-way flow)
"←"     Directional Left (one-way flow)
```

---

## Action Summary

| Action | Returns | Side Effects |
|--------|---------|--------------|
| `up()`, `down()`, `left()`, `right()` | New position or `false` | May push crate, may apply penalty |
| `pickUp()` | Array of picked parcels | Adds parcels to `carryingParcels` |
| `putDown(ids?)` | Array of dropped parcels | Updates score if on delivery tile, deletes parcels |
