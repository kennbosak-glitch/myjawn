# MyJawn

A multiplayer social world in the spirit of the 2002 browser classic **Coke Studios** — rebuilt from scratch, with fully original art, code, and branding.

Coke Studios died on December 6, 2007, because it lived on Coca-Cola's server and they pulled the plug. MyJawn is being built so that can never happen again: **private rooms ("Jawns") will be hosted by the players themselves** (WebRTC), while a small central service keeps only accounts, the currency ledger, and ownership records honest. No plug to pull.

## Status (Nov 7, 2026 — night one)

- P1 core world built and verified locally: accounts, saved games, isometric rooms, movement, chat, room editor, starter furniture, a starter store, and a daily currency faucet — 27/27 automated smoke checks passing.
- Avatar system: locked character bases with measured anchors; clothing is generated as single-change edits of a locked base and extracted in code behind a **drift gate** (a generated hoodie was rejected at 76.29% out-of-slot drift — the gate works).
- Currency: **Notes**. Rooms: **Jawns**.

## Roadmap

- **P1 — Core World:** accounts, avatars, lobby + your own Jawn, movement, chat, decorating. *(built; public deploy next)*
- **P2 — Economy + Music:** full store, a step-sequencer music mixer with original loops, performing, song voting and charts — plus the player-hosted rooms architecture.
- **P3 — Social Depth:** minigames, trading/gifting, DMs, events, moderation tooling.

## Architecture

- **Central (tiny, authoritative):** accounts/logins, Notes ledger, furniture ownership, saved room layouts, presence directory, settlement of permanent state.
- **Player-hosted:** live room sessions run in the room owner's browser over WebRTC. Host leaves → the Jawn goes quiet (v1). A host can fudge where an avatar stands in their own room — never what anyone owns.

## The legal shape

Gameplay systems are recreated faithfully; **all art, samples, names, and branding are original**. No assets, marks, or content from the original game are used or shipped. Historical sources were studied as reference for how systems behaved — never copied into this build.

## Tech

HTML5 canvas isometric client (zero install, phones + desktop) · Node WebSocket server · SQLite persistence (alpha).

## The team

Built by **Skynet** (lead + code) with ChatGPT (art), Grok (systems/economy, adversarial review), and DeepSeek (research) — coordinated by Kenn Bosak, who played the original and refuses to let it stay dead.
