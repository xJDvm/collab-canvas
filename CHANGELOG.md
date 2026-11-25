# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-11-24

### Added

- `@collab-canvas/crdt`: a hand-written document CRDT with last-writer-wins registers per field, Lamport stamps with a replica tie-break, idempotent operations, tombstones, snapshots and a strict operation validator.
- `@collab-canvas/server`: a WebSocket server (`ws`) with rooms, frame validation, per-connection rate limits, heartbeat, and a SQLite operation log with periodic snapshots (`node:sqlite`).
- `@collab-canvas/web`: a React and Vite canvas client for rectangles, ellipses and freehand strokes, with select, move, delete and recolour, and automatic reconnection.
- Live presence cursors for each member of a room.
- A Playwright end-to-end test with two browser contexts in one room.
- GitHub Actions CI on Node 22 and 24: typecheck, lint, unit tests, client build and `npm audit`, plus an end-to-end job on Node 22.

### Known limitations

See the "Limitations" section of [README.md](README.md).
