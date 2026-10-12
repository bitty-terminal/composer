/**
 * Runs `lua/composer/init.lua` in a real Lua VM (wasmoon) against the SDK
 * mock host (bitty-plugin-sdk `MockHost`).
 *
 * The mock host owns every contract check: manifest linting, capability
 * gates, the activation registration window, overlay session ownership,
 * submit budgets and framing, editor allowlist and timeouts, and compat
 * validation. The harness only bridges the injected `bitty` table into Lua,
 * drives the owner-initiated `composer.pump()` drain, and exposes scalar
 * state queries so tests assert on plain values.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MockHost } from "bitty-plugin-sdk";
import { LuaFactory, type LuaEngine } from "wasmoon";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MANIFEST_SOURCE = readFileSync(
  join(REPO_ROOT, "bitty-plugin.toml"),
  "utf8",
);
export const ENTRY_SOURCE = readFileSync(
  join(REPO_ROOT, "lua/composer/init.lua"),
  "utf8",
);

/** Capabilities the manifest requests; tests grant all of them by default. */
export const COMPOSER_CAPABILITIES = [
  "ui.overlay.focus",
  "terminal.input.submit",
  "process.editor",
] as const;

export const OPEN_COMMAND = "bitty-terminal.composer:open";
export const SUBMIT_COMMAND = "bitty-terminal.composer:submit";
export const CANCEL_COMMAND = "bitty-terminal.composer:cancel";
export const CLOSE_COMMAND = "bitty-terminal.composer:close";
export const EDITOR_COMMAND = "bitty-terminal.composer:editor";

export interface ComposerRun {
  readonly host: MockHost;
  readonly lua: LuaEngine;
  /** Scalar Lua state query: `composer.is_open()`, `composer.last_code()`. */
  query(expr: string): Promise<unknown>;
  close(): void;
}

export interface ComposerRunOptions {
  readonly grants?: readonly string[];
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly safeMode?: boolean;
  readonly submitBudgetBytes?: number;
  readonly pluginApiVersion?: string;
  /** Degraded host: drop `bitty.ui.overlay` before activation (pre-W-01 bridge). */
  readonly noOverlayTable?: boolean;
  /** Degraded host: drop `bitty.terminal.submit` before activation. */
  readonly noSubmitSurface?: boolean;
  /** Degraded host: drop `bitty.process.editor` before activation. */
  readonly noEditorSurface?: boolean;
}

const factory = new LuaFactory();

/**
 * Map JS `null` results to `undefined` so they reach Lua as `nil` (the
 * mock host models Lua `nil` as `null`; wasmoon cannot push `null`).
 */
function nilSafe<T>(table: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
    if (typeof value === "function") {
      out[key] = (...args: unknown[]): unknown => {
        const result = (value as (...a: unknown[]) => unknown)(...args);
        return result === null ? undefined : result;
      };
    } else if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = nilSafe(value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** Activate the plugin once: grants, settings, init.lua, end activation. */
export async function activateComposer(
  options: ComposerRunOptions = {},
): Promise<ComposerRun> {
  const host = new MockHost({
    manifestSource: MANIFEST_SOURCE,
    ...(options.environment !== undefined
      ? { environment: options.environment }
      : {}),
    ...(options.safeMode !== undefined ? { safeMode: options.safeMode } : {}),
    ...(options.submitBudgetBytes !== undefined
      ? { submitBudgetBytes: options.submitBudgetBytes }
      : {}),
    ...(options.pluginApiVersion !== undefined
      ? { pluginApiVersion: options.pluginApiVersion }
      : {}),
  });
  for (const capability of options.grants ?? COMPOSER_CAPABILITIES) {
    host.grant(capability);
  }
  if (options.noOverlayTable === true) {
    delete (host.bitty as unknown as { ui: Record<string, unknown> }).ui[
      "overlay"
    ];
  }
  if (options.noSubmitSurface === true) {
    delete (host.bitty as unknown as { terminal: Record<string, unknown> })
      .terminal["submit"];
  }
  if (options.noEditorSurface === true) {
    delete (host.bitty as unknown as { process: Record<string, unknown> })
      .process["editor"];
  }
  host.beginActivation();
  for (const [key, value] of Object.entries(options.settings ?? {})) {
    host.bitty.settings.set(key, value as never);
  }

  const lua = await factory.createEngine({ injectObjects: false });
  lua.global.set("bitty", nilSafe(host.bitty));
  const run: ComposerRun = {
    host,
    lua,
    async query(expr: string): Promise<unknown> {
      return lua.doString(`return ${expr}`);
    },
    close(): void {
      lua.global.close();
    },
  };
  try {
    await lua.doString(ENTRY_SOURCE);
    host.endActivation();
  } catch (error) {
    lua.global.close();
    throw error;
  }
  return run;
}

/** Dispatch a session command by qualified name. */
export function dispatch(
  run: ComposerRun,
  command: string,
  args: unknown = {},
): unknown {
  return run.host.dispatchCommand(command, args);
}

/** Drain already-queued capture events through the plugin (owner tick). */
export async function pump(run: ComposerRun): Promise<void> {
  await run.lua.doString("composer.pump()");
}

/** Feed one captured key press, then drain. */
export async function press(
  run: ComposerRun,
  key: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
): Promise<void> {
  run.host.injectOverlayInput({
    type: "key",
    data: {
      key,
      ctrl: mods.ctrl === true,
      alt: mods.alt === true,
      shift: mods.shift === true,
    },
  });
  await pump(run);
}

/** Feed typed text, then drain. */
export async function typeText(run: ComposerRun, text: string): Promise<void> {
  run.host.injectOverlayInput({ type: "text", data: { text } });
  await pump(run);
}

/** Feed a paste payload, then drain. */
export async function paste(run: ComposerRun, text: string): Promise<void> {
  run.host.injectOverlayInput({ type: "paste", data: { text } });
  await pump(run);
}

/**
 * Read the mock's retained overlay session scene: exactly what the last
 * session-owned update painted. Test-only access to mock internals (the
 * mock owns the contract surface); `undefined` when no session is live.
 */
export function sessionScene(run: ComposerRun): unknown {
  const session = (
    run.host as unknown as { overlaySession?: { scene?: unknown } }
  ).overlaySession;
  return session?.scene;
}

/**
 * Read the mock's retained acquire spec (title/placeholder passed on open).
 * `undefined` when no session is live.
 */
export function sessionSpec(run: ComposerRun): unknown {
  const session = (
    run.host as unknown as { overlaySession?: { spec?: unknown } }
  ).overlaySession;
  return session?.spec;
}

/**
 * Inject one production-flat overlay input event (`{seq,type,text}` with no
 * `data` envelope, the shape the Rust bridge serves) directly into the
 * live session queue without draining. A call with no live session is a
 * no-op, mirroring the mock's input routing.
 */
export function injectFlat(
  run: ComposerRun,
  event: { readonly type: string; readonly text?: string },
): void {
  const session = (
    run.host as unknown as {
      overlaySession?: { queue: unknown[]; nextSeq: number };
    }
  ).overlaySession;
  if (session === undefined) return;
  const seq = session.nextSeq;
  session.nextSeq = seq + 1;
  session.queue.push(
    event.text === undefined
      ? { seq, type: event.type }
      : { seq, type: event.type, text: event.text },
  );
}

/** Publish a focus transition to the plugin (payload per the mock v1 shape). */
export function publishFocus(run: ComposerRun, viewId = 1): void {
  run.host.publish("focus.changed", { view_id: viewId });
}

/** Scalar state readers (plain values, no table conversion). */
export async function isOpen(run: ComposerRun): Promise<boolean> {
  return (await run.query("composer.is_open()")) as boolean;
}

export async function bufferText(run: ComposerRun): Promise<string> {
  return (await run.query("composer.buffer_text()")) as string;
}

export async function lastCode(run: ComposerRun): Promise<string> {
  return (await run.query("composer.last_code()")) as string;
}

/** Byte-exact bracketed-paste frame the host emits for `content`. */
export function expectedFrame(content: string): Buffer {
  return Buffer.concat([
    Buffer.from("[200~", "utf8"),
    Buffer.from(content, "utf8"),
    Buffer.from("[201~", "utf8"),
    Buffer.from("\r", "utf8"),
  ]);
}
