/**
 * CTX-0004 independent verification, part 1: real-platform temp/process
 * evidence plus negative paste/cancellation evidence.
 *
 * Derived from the W-73 verification items (composer-boundary.md items 2-7),
 * the W-82 limits table, and Core behavior evidence at bitty@1df0459e
 * (host.rs owned-root/sweep/submit tests, editor_host.rs session tests,
 * tests.rs external_editor_* tests). Nothing here is copied from the CTX-0003
 * suite: every assertion below is written from the contracts and the Core
 * evidence, through fresh angles (cumulative counters, exact env matrix,
 * budget/delivery denials, idle-timeout revoke, post-release input routing).
 *
 * Scoping honesty: the plugin never sees a temp path and the SDK mock
 * performs no I/O and spawns no process (wall-clock wait, tree kill, and the
 * crash-restart sweep stay Core-owned). So this file proves three layers:
 * (a) the OS primitives the discipline relies on, in a hermetic directory
 * (0600 exclusive create, 0700 root, dead-owner liveness probe);
 * (b) the plugin-observable surrogate on every editor path (create/remove
 * counters balance, outcomes never carry a path, hostile values deny with
 * zero side effects); (c) cancellation releases capture with terminal input
 * restored at mock-host level.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  activateComposer,
  bufferText,
  CANCEL_COMMAND,
  CLOSE_COMMAND,
  dispatch,
  EDITOR_COMMAND,
  expectedFrame,
  isOpen,
  lastCode,
  OPEN_COMMAND,
  paste,
  press,
  pump,
  SUBMIT_COMMAND,
  typeText,
  type ComposerRun,
} from "./harness.js";

const runs: ComposerRun[] = [];

async function verify(
  ...args: Parameters<typeof activateComposer>
): Promise<ComposerRun> {
  const run = await activateComposer(...args);
  runs.push(run);
  return run;
}

afterEach(() => {
  for (const run of runs.splice(0)) run.close();
});

/** Hermetic scratch root; removed by the caller. Never the shared tmpdir. */
function scratchRoot(): string {
  return mkdtempSync(join(tmpdir(), "ctx0004-verify-"));
}

function lastDetail(run: ComposerRun): Promise<string> {
  return run.query("composer.last_detail()") as Promise<string>;
}

describe("real-platform temp discipline (OS primitives, hermetic)", () => {
  test("0600 exclusive create: mode asserted, second create fails, cleanup removes", () => {
    const root = scratchRoot();
    try {
      const owned = join(root, "owned");
      mkdirSync(owned, { mode: 0o700 });
      expect(statSync(owned).mode & 0o777).toBe(0o700);
      const temp = join(owned, "composer-test-draft");
      writeFileSync(temp, "secret draft", { mode: 0o600, flag: "wx" });
      expect(statSync(temp).mode & 0o777).toBe(0o600);
      expect(() =>
        writeFileSync(temp, "other", { mode: 0o600, flag: "wx" }),
      ).toThrow();
      rmSync(temp);
      expect(readdirSync(owned)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("owned-root confinement: temp path stays under the owned root, nothing outside it", () => {
    const root = scratchRoot();
    try {
      const owned = join(root, "owned");
      mkdirSync(owned, { mode: 0o700, recursive: true });
      const temp = join(owned, "composer-test-draft");
      writeFileSync(temp, "draft", { mode: 0o600, flag: "wx" });
      expect(resolve(temp).startsWith(resolve(owned))).toBe(true);
      const outside = readdirSync(root).filter((entry) => entry !== "owned");
      expect(outside).toEqual([]);
      const link = join(owned, "sneaky-link");
      try {
        // Symlink-shaped entries are detectable so a policy can reject them.
        symlinkSync(temp, link);
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        rmSync(link);
      } catch {
        // Platforms without symlink privilege skip the probe; the lstat
        // discipline itself is what Core enforces (owned_root_rejects_symlink).
      }
      rmSync(temp);
      expect(readdirSync(owned)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("crash-sweep liveness probe: live pid answers, dead pid does not", () => {
    // Core's sweep rule (host.rs sweep_removes_only_dead_owners) parses the
    // owner pid from the temp name and removes only provably-dead owners.
    // This proves the kill(pid, 0) probe both halves rely on.
    expect(() => process.kill(process.pid, 0)).not.toThrow();
    expect(() => process.kill(4194303, 0)).toThrow();
  });
});

describe("temp create/remove counters on every editor path", () => {
  test("each seeded child outcome balances create/remove and keeps the session", async () => {
    const seeds = [
      { kind: "edited", content: "applied" },
      { kind: "cancelled" },
      { kind: "timeout" },
      { kind: "spawn-failed", detail: "nope" },
      { kind: "non-zero", code: 3 },
      { kind: "unavailable", reason: "temp-unavailable" },
    ] as const;
    for (const seed of seeds) {
      const run = await verify({ environment: { VISUAL: "nvim" } });
      dispatch(run, OPEN_COMMAND);
      await typeText(run, "draft");
      const created = run.host.editorTempsCreated;
      const removed = run.host.editorTempsRemoved;
      run.host.setEditorResult(seed);
      dispatch(run, EDITOR_COMMAND);
      expect(run.host.editorTempsCreated).toBe(created + 1);
      expect(run.host.editorTempsRemoved).toBe(removed + 1);
      expect(await isOpen(run)).toBe(true);
      expect(run.host.submittedFrames).toEqual([]);
      if (seed.kind === "edited") {
        expect(await bufferText(run)).toBe("applied");
      } else {
        expect(await bufferText(run)).toBe("draft");
      }
    }
  });

  test("cumulative balance across a mixed success/cancel/timeout sequence", async () => {
    const run = await verify({ environment: { VISUAL: "vim" } });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "draft");
    run.host.setEditorResult({ kind: "edited", content: "v2" });
    dispatch(run, EDITOR_COMMAND);
    run.host.setEditorResult({ kind: "timeout" });
    dispatch(run, EDITOR_COMMAND);
    run.host.setEditorResult({ kind: "cancelled" });
    dispatch(run, EDITOR_COMMAND);
    expect(await bufferText(run)).toBe("v2");
    expect(await isOpen(run)).toBe(true);
    expect(run.host.editorTempsCreated).toBe(3);
    expect(run.host.editorTempsRemoved).toBe(3);
    expect(run.host.submittedFrames).toEqual([]);
  });

  test("over-cap content is rejected at the Lua boundary, so the host write-fail path stays spare", async () => {
    // The plugin caps the buffer before Core ever sees it, which makes the
    // host-side write-fail/remove pair (mock: create/remove with
    // unavailable:too-large) unreachable-but-present defense in depth.
    const run = await verify({ environment: { VISUAL: "nvim" } });
    const accepted = await run.lua.doString(
      "return (function() local b = composer.buffer_new(); return composer.buffer_set(b, string.rep('z', 65536 + 1)) end)()",
    );
    expect(accepted).toBe(false);
    expect(run.host.editorTempsCreated).toBe(0);
    expect(run.host.editorTempsRemoved).toBe(0);
  });

  test("hostile first value denies with zero temps and no path in the outcome", async () => {
    const probe = scratchRoot();
    try {
      const before = readdirSync(probe);
      const run = await verify({
        environment: { VISUAL: "vim; rm -rf /", EDITOR: "nvim" },
      });
      dispatch(run, OPEN_COMMAND);
      await typeText(run, "draft");
      dispatch(run, EDITOR_COMMAND);
      expect(await lastCode(run)).toBe("denied:not-allowed");
      expect(run.host.editorTempsCreated).toBe(0);
      expect(run.host.editorTempsRemoved).toBe(0);
      expect(await bufferText(run)).toBe("draft");
      expect(await isOpen(run)).toBe(true);
      const outcome = JSON.stringify({
        code: await lastCode(run),
        detail: await lastDetail(run),
        dispatch: dispatch(run, EDITOR_COMMAND),
      });
      expect(outcome).not.toMatch(/tmp|composer-/);
      expect(readdirSync(probe)).toEqual(before);
      expect(run.host.handlerViolations).toEqual([]);
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  });

  test("editor precedence matrix: hostile-first never falls through", async () => {
    const cases = [
      {
        env: { VISUAL: "nano", EDITOR: "vim" },
        code: "denied:not-allowed",
        temps: 0,
      },
      { env: { VISUAL: "  ", EDITOR: "vim" }, code: "cancelled", temps: 1 },
      { env: { EDITOR: "vi" }, code: "cancelled", temps: 1 },
      { env: {}, code: "denied:no-editor", temps: 0 },
    ] as const;
    for (const { env, code, temps } of cases) {
      const run = await verify({ environment: { ...env } });
      dispatch(run, OPEN_COMMAND);
      const created = run.host.editorTempsCreated;
      dispatch(run, EDITOR_COMMAND);
      expect(await lastCode(run)).toBe(code);
      expect(run.host.editorTempsCreated - created).toBe(temps);
      expect(run.host.editorTempsCreated).toBe(run.host.editorTempsRemoved);
      expect(await isOpen(run)).toBe(true);
    }
  });
});

describe("negative paste and cancellation", () => {
  test("suspicious paste lands in the buffer only; nothing reaches the PTY", async () => {
    const run = await verify({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    // NUL is excluded: the wasmoon test bridge truncates strings at embedded
    // NUL (C-string boundary), so NUL cannot reach the plugin under test.
    // NUL inspection stays Core-owned on the real paste pipeline (T-8 DELTA).
    const suspicious = "a\x1bb\x07c d\ne\rf";
    await paste(run, suspicious);
    expect(await bufferText(run)).toBe(suspicious);
    expect(run.host.submittedFrames).toEqual([]);
    // The single emission surface frames the content verbatim through the
    // Core paste pipeline; the plugin adds no inspector and no second path.
    await press(run, "enter", { ctrl: true });
    expect(run.host.submittedFrames).toHaveLength(1);
    expect(run.host.submittedFrames[0]).toEqual(expectedFrame(suspicious));
  });

  test("over-cap submit via exhausted budget emits nothing and keeps everything", async () => {
    const run = await verify({
      environment: { VISUAL: "nvim" },
      submitBudgetBytes: 10,
    });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "hello");
    const used = run.host.submitBudgetUsed;
    dispatch(run, SUBMIT_COMMAND);
    expect(await lastCode(run)).toBe("denied:budget-exceeded");
    expect(run.host.submittedFrames).toEqual([]);
    expect(run.host.submitBudgetUsed).toBe(used);
    expect(await bufferText(run)).toBe("hello");
    expect(await isOpen(run)).toBe(true);
  });

  test("submit with no focused view is unavailable and emits nothing", async () => {
    const run = await verify({ environment: { VISUAL: "nvim" } });
    run.host.setSubmitDelivery("none");
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "hello");
    dispatch(run, SUBMIT_COMMAND);
    expect(await lastCode(run)).toBe("unavailable:no-focused-view");
    expect(run.host.submittedFrames).toEqual([]);
    expect(await bufferText(run)).toBe("hello");
    expect(await isOpen(run)).toBe(true);
  });

  test("cancel, submit, focus-switch, crash, idle-timeout all release capture", async () => {
    // Cancel and submit clear the buffer; involuntary causes keep the draft.
    // In every case capture is released so terminal input is restored: the
    // next injected event routes nowhere (undefined) and the PTY gains
    // nothing except the single accepted submit frame.
    const triggers = [
      { name: "cancel", draft: "", frames: 0 },
      { name: "submit", draft: "", frames: 1 },
      { name: "focus-switch", draft: "draft", frames: 0 },
      { name: "crash", draft: "draft", frames: 0 },
      { name: "idle-timeout", draft: "draft", frames: 0 },
    ] as const;
    for (const { name, draft, frames } of triggers) {
      const run = await verify({ environment: { VISUAL: "nvim" } });
      dispatch(run, OPEN_COMMAND);
      await typeText(run, "draft");
      if (name === "cancel") dispatch(run, CANCEL_COMMAND);
      else if (name === "submit") dispatch(run, SUBMIT_COMMAND);
      else if (name === "focus-switch") run.host.simulateOverlayFocusSwitch();
      else if (name === "crash") run.host.simulateOverlayCrash();
      else run.host.advanceTimers(31_000);
      await pump(run);
      expect(await isOpen(run)).toBe(false);
      expect(await bufferText(run)).toBe(draft);
      expect(run.host.submittedFrames).toHaveLength(frames);
      expect(
        run.host.injectOverlayInput({ type: "text", data: { text: "x" } }),
      ).toBeUndefined();
      await pump(run);
      expect(await bufferText(run)).toBe(draft);
    }
  });

  test("unload (dispose) observes released, keeps the draft, and emits nothing", async () => {
    const run = await verify({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "draft");
    run.host.dispose();
    expect(await lastCode(run)).toBe("RELEASED");
    expect(await isOpen(run)).toBe(false);
    expect(await bufferText(run)).toBe("draft");
    expect(run.host.submittedFrames).toEqual([]);
    expect(() => dispatch(run, OPEN_COMMAND)).toThrow();
    await pump(run);
    expect(await bufferText(run)).toBe("draft");
    expect(run.host.submittedFrames).toEqual([]);
  });

  test("close preserves the draft while cancel discards it; neither emits", async () => {
    const run = await verify({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "keep?");
    dispatch(run, CLOSE_COMMAND);
    expect(await lastCode(run)).toBe("CLOSED");
    expect(await bufferText(run)).toBe("keep?");
    dispatch(run, OPEN_COMMAND);
    dispatch(run, CANCEL_COMMAND);
    expect(await lastCode(run)).toBe("CANCELLED");
    expect(await bufferText(run)).toBe("");
    expect(run.host.submittedFrames).toEqual([]);
  });
});
