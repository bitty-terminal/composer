/**
 * composer#16 / bitty#1972 (SDK#149): the host raises the coalescable
 * `overlay.input.available` observation while a modal session is open so
 * queued capture input is drained and the scene repainted on the cold path.
 *
 * The handler mirrors `focus.changed`: it pumps only while the session is
 * open, `M.pump()` is itself guarded (a revoked session records RELEASED and
 * keeps the draft), and while closed the handler does nothing, so a trailing
 * nudge after RELEASED can never resurrect a released session.
 *
 * Mirrors the open-scene/owner-initiated-drain conventions in
 * `scene-pump.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  activateComposer,
  bufferText,
  CLOSE_COMMAND,
  dispatch,
  injectFlat,
  isOpen,
  lastCode,
  OPEN_COMMAND,
  sessionScene,
  typeText,
  type ComposerRun,
} from "./harness.js";

const runs: ComposerRun[] = [];

async function scenePump(
  ...args: Parameters<typeof activateComposer>
): Promise<ComposerRun> {
  const run = await activateComposer(...args);
  runs.push(run);
  return run;
}

afterEach(() => {
  for (const run of runs.splice(0)) run.close();
});

/** Publish the coalescable host nudge (payload per the closed v1 shape). */
function nudge(
  run: ComposerRun,
  owner = "bitty-terminal.composer",
  queued = 1,
): void {
  run.host.publish("overlay.input.available", { owner, queued });
}

describe("overlay.input.available cold-path drain (composer#16)", () => {
  test("a nudge while open drains queued input and repaints the scene", async () => {
    const run = await scenePump({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    expect(await isOpen(run)).toBe(true);
    // Strand a key and a text frame in the live capture queue without a
    // driver tick, exactly as an unhandled host nudge would leave them.
    injectFlat(run, { type: "key", text: "hi" });
    injectFlat(run, { type: "text", text: "!" });
    expect(await bufferText(run)).toBe("");
    nudge(run);
    expect(await bufferText(run)).toBe("hi!");
    expect(await isOpen(run)).toBe(true);
    expect(sessionScene(run)).toEqual({
      kind: "List",
      children: [
        { kind: "Text", text: "Composer" },
        { kind: "Text", text: "hi!" },
      ],
    });
    expect(run.host.submittedFrames).toEqual([]);
  });

  test("a nudge while closed is a no-op", async () => {
    const run = await scenePump({ environment: { VISUAL: "nvim" } });
    // Closed from the start: nothing to drain, the session stays down.
    nudge(run);
    expect(await isOpen(run)).toBe(false);
    expect(await bufferText(run)).toBe("");
    // And after an explicit close: the recorded code and empty signal survive.
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "hi");
    dispatch(run, CLOSE_COMMAND);
    expect(await lastCode(run)).toBe("CLOSED");
    nudge(run);
    expect(await lastCode(run)).toBe("CLOSED");
    expect(await isOpen(run)).toBe(false);
    expect(run.host.submittedFrames).toEqual([]);
  });

  test("a trailing nudge after RELEASED never resurrects the session", async () => {
    const run = await scenePump({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "draft");
    // Involuntary release (focus switch): Core owns the session, the draft
    // is kept, and the plugin records RELEASED.
    run.host.simulateOverlayFocusSwitch();
    expect(await lastCode(run)).toBe("RELEASED");
    expect(await isOpen(run)).toBe(false);
    // A trailing nudge must not reopen, repump, or touch the PTY.
    nudge(run, "bitty-terminal.composer", 3);
    expect(await lastCode(run)).toBe("RELEASED");
    expect(await isOpen(run)).toBe(false);
    expect(await bufferText(run)).toBe("draft");
    expect(run.host.submittedFrames).toEqual([]);
  });
});
