import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Point, Shape } from "@collab-canvas/crdt";
import { colourFor, sessionName } from "./identity.js";
import { Connection, roomFromHash, statusKind, type ConnectionView } from "./net.js";
import type { Cursor } from "./render.js";
import { draw, fitCanvas } from "./render.js";
import { PALETTE, Tools, type Colour, type ToolId } from "./tools.js";

declare global {
  interface Window {
    /** Read-only hook for end-to-end tests. Only defined in development builds. */
    __ccDebug?: { shapes: () => readonly Shape[] };
  }
}

const TOOL_BUTTONS: readonly { readonly id: ToolId; readonly label: string }[] = [
  { id: "rect", label: "Rectangle" },
  { id: "ellipse", label: "Ellipse" },
  { id: "pen", label: "Pen" },
  { id: "select", label: "Select" },
];

const PRIMARY_BUTTON = 0;

/** The view shown before the first connection event. */
const INITIAL_VIEW: ConnectionView = { status: "connecting", shapes: [], cursors: [] };

/** The display name and colour of this tab. The name is kept for the session. */
function localIdentity(): { readonly name: string; readonly colour: string } {
  const name = sessionName(() => window.sessionStorage);
  return { name, colour: colourFor(name) };
}

/** WebSocket endpoint on the page's own origin; the dev server proxies `/ws`. */
function socketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws`;
}

/** A random replica id of 32 hex digits, valid for the CRDT. */
function newReplicaId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Pointer position relative to the canvas, in CSS pixels. */
function pointOn(canvas: HTMLCanvasElement, event: ReactPointerEvent<HTMLCanvasElement>): Point {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/** The people on the canvas: this tab first, then every peer whose cursor is live. */
function PresenceList({
  name,
  colour,
  cursors,
}: {
  readonly name: string;
  readonly colour: string;
  readonly cursors: readonly Cursor[];
}) {
  return (
    <aside className="presence" aria-label="People on this canvas" data-testid="presence-list">
      <ul>
        <li>
          <span className="presence-dot" style={{ backgroundColor: colour }} aria-hidden="true" />
          <span>{name} (you)</span>
        </li>
        {cursors.map((cursor) => (
          <li key={cursor.replica}>
            <span
              className="presence-dot"
              style={{ backgroundColor: cursor.color }}
              aria-hidden="true"
            />
            <span>{cursor.name}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/** The whiteboard: toolbar, connection badge, presence list and a full-viewport canvas. */
export function App() {
  const [room] = useState(() => roomFromHash(window.location.hash));
  const [identity] = useState(localIdentity);
  const [view, setView] = useState<ConnectionView>(INITIAL_VIEW);
  const { shapes } = view;
  const [tool, setTool] = useState<ToolId>("rect");
  const [colour, setColour] = useState<Colour>(PALETTE[0]);
  const [, refresh] = useReducer((revision: number) => revision + 1, 0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const toolsRef = useRef<Tools | null>(null);
  const connectionRef = useRef<Connection | null>(null);

  useEffect(() => {
    const connection = new Connection({
      url: socketUrl(),
      room,
      replica: newReplicaId(),
      name: identity.name,
      colour: identity.colour,
      onChange: setView,
    });
    connectionRef.current = connection;
    toolsRef.current = new Tools(connection);
    connection.start();
    return () => {
      connection.close();
      connectionRef.current = null;
      toolsRef.current = null;
    };
  }, [room, identity]);

  useEffect(() => {
    window.addEventListener("resize", refresh);
    return () => {
      window.removeEventListener("resize", refresh);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Delete") {
        toolsRef.current?.deleteSelection(shapes);
        refresh();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [shapes]);

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }
    window.__ccDebug = { shapes: () => shapes };
    return () => {
      delete window.__ccDebug;
    };
  }, [shapes]);

  // Runs after every render, so the frame always matches the latest state and gesture.
  useEffect(() => {
    const canvas = canvasRef.current;
    const tools = toolsRef.current;
    if (canvas === null || tools === null) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      return;
    }
    const { width, height } = canvas.getBoundingClientRect();
    fitCanvas(ctx, width, height, window.devicePixelRatio);
    draw(ctx, tools.displayShapes(shapes), tools.selection, view.cursors);
  });

  const chooseTool = (next: ToolId): void => {
    setTool(next);
    toolsRef.current?.setTool(next);
    refresh();
  };

  const chooseColour = (next: Colour): void => {
    setColour(next);
    toolsRef.current?.setColour(next, shapes);
    refresh();
  };

  const deleteSelected = (): void => {
    toolsRef.current?.deleteSelection(shapes);
    refresh();
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== PRIMARY_BUTTON) {
      return;
    }
    const canvas = event.currentTarget;
    canvas.setPointerCapture(event.pointerId);
    toolsRef.current?.pointerDown(pointOn(canvas, event), shapes);
    refresh();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const point = pointOn(event.currentTarget, event);
    toolsRef.current?.pointerMove(point);
    connectionRef.current?.updatePresence(point);
    refresh();
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    toolsRef.current?.pointerUp(pointOn(event.currentTarget, event), shapes);
    refresh();
  };

  return (
    <div className="app">
      <header className="toolbar" role="toolbar" aria-label="Drawing tools">
        <div className="tool-group">
          {TOOL_BUTTONS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className="tool-button"
              data-testid={`tool-${id}`}
              aria-pressed={tool === id}
              onClick={() => {
                chooseTool(id);
              }}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            className="tool-button"
            data-testid="tool-delete"
            onClick={deleteSelected}
          >
            Delete
          </button>
        </div>
        <div className="palette" role="group" aria-label="Colour">
          {PALETTE.map((hex) => (
            <button
              key={hex}
              type="button"
              className="swatch"
              data-testid={`color-${hex.slice(1)}`}
              aria-label={`Colour ${hex}`}
              aria-pressed={colour === hex}
              style={{ backgroundColor: hex }}
              onClick={() => {
                chooseColour(hex);
              }}
            />
          ))}
        </div>
      </header>
      <span
        className={`badge badge-${statusKind(view.status)}`}
        data-testid="connection-status"
        data-status={statusKind(view.status)}
        role="status"
      >
        {view.status}
      </span>
      <PresenceList name={identity.name} colour={identity.colour} cursors={view.cursors} />
      <canvas
        ref={canvasRef}
        className="canvas"
        data-testid="canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
    </div>
  );
}
