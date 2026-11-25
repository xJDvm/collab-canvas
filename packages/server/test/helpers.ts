import { WebSocket, type RawData } from "ws";
import type { ServerFrame } from "../src/protocol.js";

/** Milliseconds to wait for an expected frame before a test fails. */
const FRAME_TIMEOUT_MS = 2_000;

/** Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A raw WebSocket client that queues every server frame it receives. */
export class Peer {
  readonly socket: WebSocket;
  /** Resolves with the close code once the socket is closed. */
  readonly closeCode: Promise<number>;
  readonly #queue: ServerFrame[] = [];
  readonly #waiters: Array<(frame: ServerFrame) => void> = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data: RawData) => {
      const frame = JSON.parse(data.toString()) as ServerFrame;
      const waiter = this.#waiters.shift();
      if (waiter === undefined) {
        this.#queue.push(frame);
      } else {
        waiter(frame);
      }
    });
    this.closeCode = new Promise((resolve) => {
      socket.once("close", (code: number) => {
        resolve(code);
      });
    });
  }

  /** Opens a connection to `ws://127.0.0.1:<port>`. */
  static connect(port: number): Promise<Peer> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const peer = new Peer(socket);
    return new Promise((resolve, reject) => {
      socket.once("open", () => {
        socket.off("error", reject);
        resolve(peer);
      });
      socket.once("error", reject);
    });
  }

  /** Sends a JSON-serialisable frame. */
  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** Sends raw text, bypassing serialisation. */
  sendRaw(text: string): void {
    this.socket.send(text);
  }

  /** Returns the next server frame, waiting up to {@link FRAME_TIMEOUT_MS}. */
  next(): Promise<ServerFrame> {
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for a frame"));
      }, FRAME_TIMEOUT_MS);
      this.#waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  /** Removes and returns every frame that arrived and was not yet read. */
  drain(): ServerFrame[] {
    return this.#queue.splice(0);
  }

  /** Drops the socket immediately. */
  terminate(): void {
    this.socket.terminate();
  }
}

/** Connects a peer, sends `hello` and returns it together with the welcome frame. */
export async function join(
  port: number,
  room: string,
  replica: string,
): Promise<{ peer: Peer; welcome: ServerFrame }> {
  const peer = await Peer.connect(port);
  peer.send({ type: "hello", room, replica });
  return { peer, welcome: await peer.next() };
}

/** Rejects with `label` if `promise` does not settle within `ms` milliseconds. */
export function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out: ${label}`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/** Narrows a server frame to the given type, failing the test if it is another frame. */
export function frameOf<T extends ServerFrame["type"]>(
  frame: ServerFrame,
  type: T,
): Extract<ServerFrame, { type: T }> {
  if (frame.type !== type) {
    throw new Error(`expected a ${type} frame, got ${frame.type}`);
  }
  return frame as Extract<ServerFrame, { type: T }>;
}
