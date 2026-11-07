# MyJawn — P1 core-world prototype

A runnable multiplayer slice of MyJawn: two (or more) browsers register, log in,
land in the same isometric lobby, walk around, chat, visit each other's rooms,
buy furniture with Notes, decorate, and claim the daily soda-machine faucet.
Graphics are placeholders — real sprites drop into `assets/` with no code changes.

## Run it

```bash
cd ~/workspace/myjawn/app
npm install        # only dependency: ws
node server.js     # http://localhost:3030  (PORT env to change)
```

Open http://localhost:3030 in two browsers (or one browser + one private window),
register two accounts, and play. Persistence is `data.sqlite` in this folder
(built-in `node:sqlite`; delete the file to reset the world). Passwords are
hashed with `crypto.scrypt` + per-user salt. Node 24 used in development
(any Node ≥ 22.5 with `node:sqlite` works).

## Smoke test

With the server running:

```bash
node test/smoke.js
```

Two scripted WebSocket clients register, meet in the lobby, move, chat, claim
the faucet, buy/place/remove furniture, and probe the permission + collision
rules. Prints PASS/FAIL per check.

## Protocol summary (WebSocket, JSON)

Client → server (first message must be `{t:"auth", token}`):

| message | fields | effect |
|---|---|---|
| `join` | `room` (`"lobby"` or `"user:<name>"`) | enter a room |
| `move` | `x, y` | walk; server pathfinds (4-dir BFS) and validates |
| `chat` | `text` | room broadcast (≤200 chars) |
| `buy` | `itemId` | deduct Notes, add to inventory (server-checked) |
| `place` | `itemId, x, y, rot` | place owned furniture (own room only) |
| `moveFurni` | `instId, x, y, rot` | move/rotate placed furniture (own room only) |
| `remove` | `instId` | return furniture to inventory (own room only) |
| `setStyle` | `floor` / `wall` | change own room's floor/wall style |
| `faucet` | — | +25 Notes, once per 24h, needs a soda machine in the room |

Server → client: `roomState`, `playerJoin`, `playerLeave`, `move` (with `path`),
`chat`, `furniUpdate`, `you` (your Notes + inventory), `bought`, `faucet`, `error`.

REST: `POST /api/register`, `POST /api/login` → `{token, username, notes}`;
`GET /api/me` (Bearer token); `GET /api/catalogue`.

## Rules enforced server-side

- Room grid 12×10; movement is bounds- and collision-checked (furniture cells
  block, rugs are walkable) and the destination must be reachable by path.
- Only a room's owner can place/move/remove furniture or restyle it.
- New accounts start with 150 Notes. The lobby's soda machine is the starter
  faucet (+25♪ / 24h per account).
- Room layouts (furniture, floor, wall) persist per room in SQLite.

## Where the art plugs in

`assets/` holds the sprites; `assets/manifest.json` maps ids → files:

- `items`: catalogue ids (`C1`…`C14`) → PNG per item (bottom-anchored iso sprite)
- `floors`: `wood` / `carpet` / `checker` → one tile image (64×32 diamond)
- `avatar`: a single avatar sprite (drawn ~40×56 at the tile)

The client preloads the manifest and uses any sprite that loads; anything
missing renders as the colored placeholder block (catalogue `color` + item
number). The avatar layer system (paper-doll bases + wearables, see
`../ALIGNMENT-RESEARCH.md`) plugs into the same `avatar` slot later.

## Layout

```
server.js          HTTP + WebSocket server, all game rules
catalogue.json     store items (id, name, price, grid w/d, color, walkable)
public/index.html  the whole client (canvas iso renderer + UI)
assets/            sprites + manifest.json
test/smoke.js      two-client protocol smoke test
data.sqlite        world state (created on first run)
```

## Known gaps (P1 scope)

- Placeholder avatars are a single sprite — no paper-doll customization yet.
- No moderation tooling, no word filter, no DMs (P3 per PLAN.md).
- Music mixer, voting, charts are P2; furniture can't stack; no rotation
  preview ghost while placing (rotation happens after placement).
- Sessions never expire; one WebSocket per account is not enforced.
