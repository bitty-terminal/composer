/**
 * Composer behavior against the SDK mock host: lifecycle over the public
 * overlay + capture API (W-103 T-9), over-cap fail-closed under one
 * documented rule (T-10), and version/capability mismatch disable with
 * fallback (T-11).
 *
 * The mock host owns every capability, registration, overlay, submit, and
 * editor check; tests assert plugin policy (presentation state, chord
 * routing, buffer disposition) and that the PTY is touched only through an
 * accepted `terminal.submit`.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { lintManifestSource, MockHost } from "bitty-plugin-sdk";
import { LuaFactory } from "wasmoon";

import {
  activateComposer,
  bufferText,
  CANCEL_COMMAND,
  CLOSE_COMMAND,
  COMPOSER_CAPABILITIES,
  dispatch,
  EDITOR_COMMAND,
  ENTRY_SOURCE,
  expectedFrame,
  isOpen,
  lastCode,
  MANIFEST_SOURCE,
  OPEN_COMMAND,
  paste,
  press,
  pump,
  SUBMIT_COMMAND,
  typeText,
  type ComposerRun,
} from "./harness.js";

const runs: ComposerRun[] = [];

/**
 * Minimal `>=`/`<` comma-clause evaluator for `compat.bitty` (W-103 D1,
 * DEC-0001). The mock host only enforces the Plugin API range, so this
 * helper asserts the host-version range directly: every clause must hold,
 * missing MINOR/PATCH default to 0, and anything outside the grammar fails
 * closed.
 */
function parseDotted(raw: string): [number, number, number] | undefined {
  const parts = raw.trim().split(".");
  if (parts.length < 1 || parts.length > 3) return undefined;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    const num = Number(part);
    if (!Number.isSafeInteger(num)) return undefined;
    nums.push(num);
  }
  while (nums.length < 3) nums.push(0);
  return [nums[0] as number, nums[1] as number, nums[2] as number];
}

function compareDotted(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function rangeAdmits(range: string, version: string): boolean {
  const actual = parseDotted(version);
  if (actual === undefined) return false;
  const clauses = range.split(",");
  if (clauses.length === 0) return false;
  for (const clause of clauses) {
    const match = clause.trim().match(/^(>=|<)(\d+(?:\.\d+){0,2})$/);
    if (match === null) return false;
    const bound = parseDotted(match[2] as string);
    if (bound === undefined) return false;
    const order = compareDotted(actual, bound);
    if (match[1] === ">=" && order < 0) return false;
    if (match[1] === "<" && order >= 0) return false;
  }
  return true;
}

async function composer(
  ...args: Parameters<typeof activateComposer>
): Promise<ComposerRun> {
  const run = await activateComposer(...args);
  runs.push(run);
  return run;
}

afterEach(() => {
  for (const run of runs.splice(0)) run.close();
});

const MAX_BYTES = 64 * 1024;

describe("manifest", () => {
  test("passes the authoritative SDK linter with zero errors", () => {
    const result = lintManifestSource(MANIFEST_SOURCE);
    expect(
      result.diagnostics.filter((entry) => entry.severity === "error"),
    ).toEqual([]);
  });

  test("high-risk consent warnings name exactly the two expected grants", () => {
    const result = lintManifestSource(MANIFEST_SOURCE);
    expect(
      result.diagnostics.map((entry) => `${entry.code}:${entry.path}`).sort(),
    ).toEqual(
      [
        "capabilities.high-risk:process.editor",
        "capabilities.high-risk:terminal.input.submit",
      ].sort(),
    );
  });

  test("declares exactly the public capability set", () => {
    expect([...COMPOSER_CAPABILITIES].sort()).toEqual(
      ["process.editor", "terminal.input.submit", "ui.overlay.focus"].sort(),
    );
  });

  test("compat.bitty admits the verified host 0.0.21 (W-103 D1)", () => {
    const match = MANIFEST_SOURCE.match(/^\s*bitty\s*=\s*"([^"]+)"\s*$/m);
    expect(match?.[1]).toBe(">=0.0.21,<0.1");
    expect(rangeAdmits(match?.[1] ?? "", "0.0.21")).toBe(true);
    expect(rangeAdmits(match?.[1] ?? "", "0.0.20")).toBe(false);
    expect(rangeAdmits(match?.[1] ?? "", "0.1.0")).toBe(false);
    // Fail-closed evidence: the previous aspirational floor refused the host.
    expect(rangeAdmits(">=0.5,<1.0", "0.0.21")).toBe(false);
  });
});

describe("pure policy without a host", () => {
  test("the entry point loads with bitty absent and checks compat", async () => {
    const factory = new LuaFactory();
    const lua = await factory.createEngine({ injectObjects: false });
    try {
      await lua.doString(ENTRY_SOURCE);
      expect(await lua.doString("return composer.check_compat('1.0.0')")).toBe(
        true,
      );
      expect(await lua.doString("return composer.check_compat('1.9.9')")).toBe(
        true,
      );
      expect(await lua.doString("return composer.check_compat('2.0.0')")).toBe(
        false,
      );
      expect(await lua.doString("return composer.check_compat('0.9.0')")).toBe(
        false,
      );
      expect(await lua.doString("return composer.check_compat('nope')")).toBe(
        false,
      );
      expect(
        await lua.doString(
          "return (function() local _, err = composer.parse_open_chord('e') return err end)()",
        ),
      ).toMatch(/needs a modifier/);
      expect(
        await lua.doString(
          "return (function() local _, err = composer.parse_keys({ newline = 'enter', submit = 'enter', close = 'escape', external_editor = 'alt+e' }) return err end)()",
        ),
      ).toMatch(/distinct/);
    } finally {
      lua.global.close();
    }
  });
});

describe("T-9 lifecycle over the public overlay + capture API", () => {
  test("open, type, newline, close preserves the draft; reopen repaints it", async () => {
    const run = await composer({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    expect(await isOpen(run)).toBe(true);
    expect(run.host.submittedFrames).toEqual([]);

    await typeText(run, "hello");
    expect(await bufferText(run)).toBe("hello");
    // No PTY byte leak: typing into the modal emits nothing.
    expect(run.host.submittedFrames).toEqual([]);

    await press(run, "enter");
    expect(await bufferText(run)).toBe("hello\n");

    dispatch(run, CLOSE_COMMAND);
    expect(await isOpen(run)).toBe(false);
    expect(run.host.submittedFrames).toEqual([]);
    expect(await lastCode(run)).toBe("CLOSED");

    dispatch(run, OPEN_COMMAND);
    expect(await isOpen(run)).toBe(true);
    expect(await bufferText(run)).toBe("hello\n");
  });

  test("submit chord frames one byte-exact bracketed paste and clears", async () => {
    const run = await composer({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "hello\n");

    await press(run, "enter", { ctrl: true });
    expect(await isOpen(run)).toBe(false);
    expect(await bufferText(run)).toBe("");
    expect(await lastCode(run)).toBe("SUBMITTED");
    expect(run.host.submittedFrames).toHaveLength(1);
    expect(run.host.submittedFrames[0]).toEqual(expectedFrame("hello\n"));
  });

  test("submit while closed fails closed and touches nothing", async () => {
    const run = await composer({ environment: { VISUAL: "nvim" } });
    dispatch(run, SUBMIT_COMMAND);
    expect(await lastCode(run)).toBe("NOT_OPEN");
    expect(run.host.submittedFrames).toEqual([]);
  });

  test("modal precedence: unmatched keys and pointer input are swallowed", async () => {
    const run = await composer({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "cmd");

    await press(run, "f5");
    run.host.injectOverlayInput({ type: "pointer", data: { x: 1 } });
    await pump(run);
    expect(await bufferText(run)).toBe("cmd");
    expect(await isOpen(run)).toBe(true);
    expect(run.host.submittedFrames).toEqual([]);
  });

  test("cancel discards the buffer and writes nothing", async () => {
    const run = await composer({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "draft");
    dispatch(run, CANCEL_COMMAND);
    expect(await isOpen(run)).toBe(false);
    expect(await bufferText(run)).toBe("");
    expect(await lastCode(run)).toBe("CANCELLED");
    expect(run.host.submittedFrames).toEqual([]);
  });

  test("denied submit keeps the buffer and the open session", async () => {
    const run = await composer({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "keep me");
    run.host.setSubmitLease(false);
    await press(run, "enter", { ctrl: true });
    expect(await lastCode(run)).toBe("denied:lease-denied");
    expect(await bufferText(run)).toBe("keep me");
    expect(await isOpen(run)).toBe(true);
    expect(run.host.submittedFrames).toEqual([]);
  });

  test("editor request with a cancelled round trip keeps the draft open", async () => {
    const run = await composer({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "draft");
    await press(run, "e", { alt: true });
    expect(await lastCode(run)).toBe("cancelled");
    expect(await bufferText(run)).toBe("draft");
    expect(await isOpen(run)).toBe(true);
    expect(run.host.editorTempsCreated).toBe(run.host.editorTempsRemoved);
    expect(run.host.submittedFrames).toEqual([]);
  });

  test("edited content installs, then submits byte-exact", async () => {
    const run = await composer({ environment: { VISUAL: "vim" } });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "old");
    run.host.setEditorResult({ kind: "edited", content: "new content" });
    dispatch(run, EDITOR_COMMAND);
    expect(await lastCode(run)).toBe("EDITED");
    expect(await bufferText(run)).toBe("new content");
    expect(await isOpen(run)).toBe(true);

    await press(run, "enter", { ctrl: true });
    expect(run.host.submittedFrames).toHaveLength(1);
    expect(run.host.submittedFrames[0]).toEqual(expectedFrame("new content"));
  });

  test("hostile editor value is denied before any temp file exists", async () => {
    const run = await composer({
      environment: { VISUAL: "nano -w", EDITOR: "vim" },
    });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "draft");
    dispatch(run, EDITOR_COMMAND);
    expect(await lastCode(run)).toBe("denied:not-allowed");
    expect(await bufferText(run)).toBe("draft");
    expect(await isOpen(run)).toBe(true);
    expect(run.host.editorTempsCreated).toBe(0);
  });

  test("focus-switch revoke closes the session and keeps the draft", async () => {
    const run = await composer({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "draft");
    run.host.simulateOverlayFocusSwitch();
    await pump(run);
    expect(await isOpen(run)).toBe(false);
    expect(await lastCode(run)).toBe("RELEASED");
    expect(await bufferText(run)).toBe("draft");
    expect(run.host.submittedFrames).toEqual([]);
  });

  test("remapped chords apply: submit on Enter, newline on Shift+Enter", async () => {
    const run = await composer({
      environment: { VISUAL: "nvim" },
      settings: { submit: "enter", newline: "shift+enter" },
    });
    dispatch(run, OPEN_COMMAND);
    await press(run, "enter", { shift: true });
    expect(await bufferText(run)).toBe("\n");
    await press(run, "enter");
    expect(await isOpen(run)).toBe(false);
    expect(run.host.submittedFrames).toHaveLength(1);
    expect(run.host.submittedFrames[0]).toEqual(expectedFrame("\n"));
  });
});

describe("T-10 over-cap fails closed under one documented rule", () => {
  test("over-cap typing and paste are rejected with the prior buffer intact", async () => {
    const run = await composer({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "hello");

    // Capture events carry at most ~4 KiB each including the event envelope
    // (host per-event ceiling), so the cap is approached with bounded 4000
    // byte chunks: sixteen chunks fit beside "hello", the seventeenth would
    // exceed 64 KiB and is rejected with the buffer kept as-is.
    for (let i = 0; i < 16; i += 1) {
      await typeText(run, "x".repeat(4000));
    }
    const filled = `hello${"x".repeat(16 * 4000)}`;
    expect(await bufferText(run)).toBe(filled);

    await typeText(run, "x".repeat(4000));
    expect(await bufferText(run)).toBe(filled);
    expect(await lastCode(run)).toBe("rejected:too-large");

    await paste(run, "y".repeat(4000));
    expect(await bufferText(run)).toBe(filled);
    expect(await lastCode(run)).toBe("rejected:too-large");

    expect(await isOpen(run)).toBe(true);
    expect(run.host.submittedFrames).toEqual([]);
  });

  test("exactly-at-cap input is accepted and submits", async () => {
    const run = await composer({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    for (let i = 0; i < 16; i += 1) {
      await typeText(run, "x".repeat(4000));
    }
    await typeText(run, "x".repeat(MAX_BYTES - 16 * 4000));
    expect((await bufferText(run)).length).toBe(MAX_BYTES);
    await press(run, "enter", { ctrl: true });
    expect(await lastCode(run)).toBe("SUBMITTED");
    expect(run.host.submittedFrames).toHaveLength(1);
  });

  test("over-cap editor content keeps the draft; temps stay balanced", async () => {
    const run = await composer({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "draft");
    run.host.setEditorResult({
      kind: "edited",
      content: "z".repeat(MAX_BYTES + 1),
    });
    dispatch(run, EDITOR_COMMAND);
    expect(await lastCode(run)).toBe("unavailable:too-large");
    expect(await bufferText(run)).toBe("draft");
    expect(await isOpen(run)).toBe(true);
    expect(run.host.editorTempsCreated).toBe(run.host.editorTempsRemoved);
  });

  test("editor timeout defaults to 120s and clamps to the 300s ceiling", async () => {
    const run = await composer({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    dispatch(run, EDITOR_COMMAND);
    expect(run.host.lastEditorTimeoutMs).toBe(120_000);
    dispatch(run, EDITOR_COMMAND, { timeout_ms: 999_999 });
    expect(run.host.lastEditorTimeoutMs).toBe(300_000);
  });
});

describe("T-11 mismatch disables with a diagnostic; fallback stays Core", () => {
  test("host-level API mismatch fails activation with no partial state", () => {
    const host = new MockHost({
      manifestSource: MANIFEST_SOURCE,
      pluginApiVersion: "99.0.0",
    });
    expect(() => host.beginActivation()).toThrow(/E_LIFECYCLE_STATE/);
    expect(() => host.dispatchCommand(OPEN_COMMAND, {})).toThrow(
      /E_GENERATION_DISPOSED/,
    );
    expect(host.submittedFrames).toEqual([]);
  });

  test("plugin-level mismatch disables with a diagnostic and registers nothing", async () => {
    const factory = new LuaFactory();
    const lua = await factory.createEngine({ injectObjects: false });
    try {
      const seen: string[] = [];
      lua.global.set("bitty", {
        api_version: "99.0.0",
        settings: {
          get: () => undefined,
          set: () => true,
        },
        commands: {
          register: () => {
            seen.push("register");
            return 1;
          },
        },
        events: {
          subscribe: () => {
            seen.push("subscribe");
            return 1;
          },
        },
        keymaps: {
          suggest: () => {
            seen.push("suggest");
            return 1;
          },
        },
      });
      await lua.doString(ENTRY_SOURCE);
      expect(seen).toEqual([]);
      expect(await lua.doString("return composer.disabled")).toBe(true);
      expect(await lua.doString("return composer.disabled_reason")).toMatch(
        /\^1\.0/,
      );
    } finally {
      lua.global.close();
    }
  });

  test("safe mode fails the open with E_UI_UNAVAILABLE and emits nothing", async () => {
    const run = await composer({
      environment: { VISUAL: "nvim" },
      safeMode: true,
    });
    dispatch(run, OPEN_COMMAND);
    expect(await isOpen(run)).toBe(false);
    expect(await lastCode(run)).toBe("E_UI_UNAVAILABLE");
    expect(run.host.submittedFrames).toEqual([]);
  });

  test("missing capability denies the open with no partial activation", async () => {
    const run = await composer({
      environment: { VISUAL: "nvim" },
      grants: [],
    });
    dispatch(run, OPEN_COMMAND);
    expect(await isOpen(run)).toBe(false);
    expect(await lastCode(run)).toBe("E_CAPABILITY_DENIED");
    expect(run.host.submittedFrames).toEqual([]);
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("disposing the plugin leaves the terminal untouched (Core fallback)", async () => {
    const run = await composer({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "draft");
    run.host.dispose();
    expect(run.host.submittedFrames).toEqual([]);
    expect(() => dispatch(run, OPEN_COMMAND)).toThrow();
  });
});
