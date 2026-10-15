/**
 * bitty#1972 (last #1966 follow-up): the open scene carries title/placeholder
 * chrome (never a bare pill), and queued capture input reaches the buffer
 * through owner-initiated drains.
 *
 * The production Rust bridge serves flat `{seq,type,text}` poll events while
 * the spec mock serves `{seq,type,data}` envelopes; the plugin feeds both.
 * Scene assertions read the mock's retained session scene/spec (exactly what
 * the session-owned acquire/update presented).
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  activateComposer,
  bufferText,
  CLOSE_COMMAND,
  dispatch,
  EDITOR_COMMAND,
  expectedFrame,
  injectFlat,
  isOpen,
  lastCode,
  OPEN_COMMAND,
  publishFocus,
  pump,
  sessionScene,
  sessionSpec,
  SUBMIT_COMMAND,
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

describe("open scene chrome (never a bare pill)", () => {
  test("open acquires with title/placeholder and paints the titled scene", async () => {
    const run = await scenePump({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    expect(await isOpen(run)).toBe(true);
    expect(sessionSpec(run)).toEqual({
      title: "Composer",
      placeholder: expect.stringContaining("ctrl+enter"),
    });
    expect(sessionScene(run)).toEqual({
      kind: "List",
      children: [
        { kind: "Text", text: "Composer" },
        { kind: "Text", text: expect.stringContaining("Type a command") },
      ],
    });
  });

  test("typed input repaints the input line; the title row stays", async () => {
    const run = await scenePump({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "hi");
    expect(sessionScene(run)).toEqual({
      kind: "List",
      children: [
        { kind: "Text", text: "Composer" },
        { kind: "Text", text: "hi" },
      ],
    });
  });
});

describe("production flat poll shape feeds the buffer", () => {
  test("flat text and paste insert like their envelope twins", async () => {
    const run = await scenePump({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    injectFlat(run, { type: "text", text: "ab" });
    await pump(run);
    expect(await bufferText(run)).toBe("ab");
    injectFlat(run, { type: "paste", text: "cd" });
    await pump(run);
    expect(await bufferText(run)).toBe("abcd");
    expect(run.host.submittedFrames).toEqual([]);
  });

  test("flat CR/LF literals route through the Enter role (composer#21)", async () => {
    const run = await scenePump({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    injectFlat(run, { type: "key", text: "x" });
    await pump(run);
    expect(await bufferText(run)).toBe("x");
    // Headed Return arrives as produced text "\r", not as a key:Enter
    // label: under defaults it must newline exactly like the label path.
    injectFlat(run, { type: "key", text: "\r" });
    await pump(run);
    expect(await bufferText(run)).toBe("x\n");
    injectFlat(run, { type: "key", text: "\n" });
    await pump(run);
    expect(await bufferText(run)).toBe("x\n\n");
    expect(await isOpen(run)).toBe(true);
    expect(run.host.submittedFrames).toEqual([]);
  });

  test("flat CR literal submits under custom enter-submits (composer#21)", async () => {
    const run = await scenePump({
      environment: { VISUAL: "nvim" },
      settings: { submit: "enter", newline: "shift+enter" },
    });
    dispatch(run, OPEN_COMMAND);
    injectFlat(run, { type: "text", text: "CUSTOMSUB42" });
    await pump(run);
    injectFlat(run, { type: "key", text: "\r" });
    await pump(run);
    expect(await lastCode(run)).toBe("SUBMITTED");
    expect(await isOpen(run)).toBe(false);
    expect(await bufferText(run)).toBe("");
    expect(run.host.submittedFrames).toHaveLength(1);
    expect(run.host.submittedFrames[0]).toEqual(expectedFrame("CUSTOMSUB42"));
  });

  test("flat key literals insert; key:Enter newlines; other labels swallow", async () => {
    const run = await scenePump({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    injectFlat(run, { type: "key", text: "x" });
    await pump(run);
    expect(await bufferText(run)).toBe("x");
    injectFlat(run, { type: "key", text: "key:Enter" });
    await pump(run);
    expect(await bufferText(run)).toBe("x\n");
    injectFlat(run, { type: "key", text: "key:F5" });
    injectFlat(run, { type: "key", text: "key:e" });
    await pump(run);
    expect(await bufferText(run)).toBe("x\n");
    expect(await isOpen(run)).toBe(true);
    expect(run.host.submittedFrames).toEqual([]);
  });

  test("flat over-cap input rejects with the prior buffer intact", async () => {
    const run = await scenePump({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "kept");
    injectFlat(run, { type: "text", text: "z".repeat(64 * 1024) });
    await pump(run);
    expect(await bufferText(run)).toBe("kept");
    expect(await lastCode(run)).toBe("rejected:too-large");
    expect(await isOpen(run)).toBe(true);
  });
});

describe("owner-initiated drains (verbs + focus)", () => {
  test("submit drains stranded input first, then submits it", async () => {
    const run = await scenePump({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    injectFlat(run, { type: "text", text: "queued" });
    dispatch(run, SUBMIT_COMMAND);
    expect(await lastCode(run)).toBe("SUBMITTED");
    expect(await bufferText(run)).toBe("");
    expect(await isOpen(run)).toBe(false);
    expect(run.host.submittedFrames).toHaveLength(1);
    expect(run.host.submittedFrames[0]).toEqual(expectedFrame("queued"));
  });

  test("re-open while open drains and repaints, session unchanged", async () => {
    const run = await scenePump({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    injectFlat(run, { type: "key", text: "hi" });
    dispatch(run, OPEN_COMMAND);
    expect(await lastCode(run)).toBe("ALREADY_OPEN");
    expect(await isOpen(run)).toBe(true);
    expect(await bufferText(run)).toBe("hi");
    expect(sessionScene(run)).toEqual({
      kind: "List",
      children: [
        { kind: "Text", text: "Composer" },
        { kind: "Text", text: "hi" },
      ],
    });
  });

  test("focus.changed drains and repaints while open, no-op while closed", async () => {
    const run = await scenePump({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    injectFlat(run, { type: "text", text: "fc" });
    publishFocus(run);
    expect(await bufferText(run)).toBe("fc");
    expect(await isOpen(run)).toBe(true);
    dispatch(run, CLOSE_COMMAND);
    expect(await lastCode(run)).toBe("CLOSED");
    publishFocus(run);
    expect(await lastCode(run)).toBe("CLOSED");
    expect(await isOpen(run)).toBe(false);
  });

  test("a release observed mid-drain survives the trailing verb", async () => {
    const run = await scenePump({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "draft");
    run.host.simulateOverlayFocusSwitch();
    dispatch(run, SUBMIT_COMMAND);
    expect(await lastCode(run)).toBe("RELEASED");
    expect(await bufferText(run)).toBe("draft");
    expect(await isOpen(run)).toBe(false);
    expect(run.host.submittedFrames).toEqual([]);
  });
});

describe("fail-closed degrades (palette pattern, no crash)", () => {
  test("host without the capture table fails open closed, no throw", async () => {
    const run = await scenePump({
      environment: { VISUAL: "nvim" },
      noOverlayTable: true,
    });
    dispatch(run, OPEN_COMMAND);
    expect(await isOpen(run)).toBe(false);
    expect(await lastCode(run)).toBe("E_UI_UNAVAILABLE");
    expect(run.host.submittedFrames).toEqual([]);
    expect(run.host.handlerViolations).toEqual([]);
  });

  test("host without submit keeps the buffer and the open session", async () => {
    const run = await scenePump({
      environment: { VISUAL: "nvim" },
      noSubmitSurface: true,
    });
    dispatch(run, OPEN_COMMAND);
    expect(await isOpen(run)).toBe(true);
    await typeText(run, "kept");
    dispatch(run, SUBMIT_COMMAND);
    expect(await lastCode(run)).toBe("unavailable:no-submit");
    expect(await bufferText(run)).toBe("kept");
    expect(await isOpen(run)).toBe(true);
    expect(run.host.submittedFrames).toEqual([]);
  });

  test("host without editor keeps the draft and the open session", async () => {
    const run = await scenePump({
      environment: { VISUAL: "nvim" },
      noEditorSurface: true,
    });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "draft");
    dispatch(run, EDITOR_COMMAND);
    expect(await lastCode(run)).toBe("unavailable:no-editor");
    expect(await bufferText(run)).toBe("draft");
    expect(await isOpen(run)).toBe(true);
  });
});
