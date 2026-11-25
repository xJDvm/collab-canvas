/** Runtime settings of the WebSocket server. Every limit is enforced; none is advisory. */
export interface Config {
  /** Interface the server binds to. */
  readonly host: string;
  /** TCP port to bind. `0` asks the operating system for an ephemeral port. */
  readonly port: number;
  /** Path of the SQLite database file (or `:memory:`). */
  readonly dbPath: string;
  /** Largest accepted WebSocket message, in bytes. */
  readonly maxPayload: number;
  /** Connections accepted by the whole server at the same time. */
  readonly maxConnections: number;
  /** Members a single room accepts at the same time. */
  readonly maxConnectionsPerRoom: number;
  /** Sustained operations per second allowed per connection. */
  readonly opsPerSecond: number;
  /** Operations a connection may send in a burst before the sustained rate applies. */
  readonly opsBurst: number;
  /** Presence updates per second allowed per connection. Excess updates are dropped silently. */
  readonly presencePerSecond: number;
  /** Interval between heartbeat pings, in milliseconds. */
  readonly heartbeatIntervalMs: number;
  /** A connection without a pong for this long is terminated, in milliseconds. */
  readonly heartbeatTimeoutMs: number;
  /** Time allowed between accepting a connection and its `hello`, in milliseconds. */
  readonly helloTimeoutMs: number;
  /** Invalid frames tolerated on one connection; the frame that reaches this count closes it. */
  readonly maxInvalidFrames: number;
}

const DEFAULTS = {
  maxPayload: 64 * 1024,
  maxConnections: 200,
  maxConnectionsPerRoom: 50,
  opsPerSecond: 60,
  opsBurst: 120,
  presencePerSecond: 30,
  heartbeatIntervalMs: 15_000,
  heartbeatTimeoutMs: 30_000,
  helloTimeoutMs: 5_000,
  maxInvalidFrames: 5,
} as const;

const PORT_PATTERN = /^(0|[1-9][0-9]{0,4})$/;
const MAX_PORT = 65_535;
const MAX_HOST_LENGTH = 253;

/**
 * Builds the server configuration from environment variables `HOST`, `PORT` and
 * `DB_PATH`, falling back to their defaults (`127.0.0.1`, `8787`, `./collab-canvas.db`).
 * All other limits take the fixed defaults of the design.
 *
 * @throws RangeError if a variable is set to an invalid value. The message names
 *   the variable but does not echo its value.
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Config {
  return {
    ...DEFAULTS,
    host: parseHost(env.HOST ?? "127.0.0.1"),
    port: parsePort(env.PORT ?? "8787"),
    dbPath: parseDbPath(env.DB_PATH ?? "./collab-canvas.db"),
  };
}

function parseHost(raw: string): string {
  if (raw.length === 0 || raw.length > MAX_HOST_LENGTH || /\s/.test(raw)) {
    throw new RangeError("HOST must be a non-empty host name or IP address without whitespace");
  }
  return raw;
}

function parsePort(raw: string): number {
  if (!PORT_PATTERN.test(raw) || Number(raw) > MAX_PORT) {
    throw new RangeError(`PORT must be an integer from 0 to ${MAX_PORT}`);
  }
  return Number(raw);
}

function parseDbPath(raw: string): string {
  if (raw.length === 0 || raw.includes("\0")) {
    throw new RangeError("DB_PATH must be a non-empty path without NUL characters");
  }
  return raw;
}
