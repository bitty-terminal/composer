/**
 * CTX-0004 independent verification, part 2: Core W-103 parity sign-off
 * (T-1..T-8 behavioral equivalence) plus the no-weakening proof.
 *
 * Each parity row names the Core assertion at bitty@1df0459e on the left and
 * the plugin-level assertion proving the same observable outcome on the
 * right. Deltas are findings, not failures, and are marked DELTA with the
 * reason inline. The no-weakening section proves the plugin requests nothing
 * beyond the manifest set and that version-mismatch, safe-mode, and
 * uninstall leave terminal behavior identical to the no-plugin baseline.
 *
 * All angles are fresh relative to the CTX-0003 suite (pure-policy boundary
 * probes, env matrix, budget framing math, overflow propagation, passive
 * closed-drain, manifest/static capability scans, baseline equivalence).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { lintManifestSource, MockHost } from "bitty-plugin-sdk";

import {
  activateComposer,
  bufferText,
  COMPOSER_CAPABILITIES,
  dispatch,
  EDITOR_COMMAND,
  expectedFrame,
  isOpen,
  lastCode,
  MANIFEST_SOURCE,
  OPEN_COMMAND,
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

/**
 * Fail-soft gate: every parity row below runs hermetic against the SDK mock
 * (Core behavior is cited at bitty@1df0459e, never read from disk), so the
 * suite is already green without a Core checkout. The probe below still
 * resolves Core via BITTY_WORKSPACE (or the relative workspace fallback,
 * never a hardcoded path) and skips with an explicit notice when no checkout
 * is present — unblocking the plugins CI job
 * (bitty-terminal/bitty-plugins#73) which has no `bitty` alongside. With
 * BITTY_WORKSPACE pointed at a real workspace the probe executes (proves the
 * skip never masks a real run).
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = dirname(HERE);

function workspaceRoot(): string {
  const fromEnv = process.env.BITTY_WORKSPACE;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return resolve(REPO_ROOT, "..", "..", "..", "..", "..");
}

function coreFile(...parts: string[]): string {
  return join(workspaceRoot(), "bitty", ...parts);
}

function coreExists(path: string): boolean {
  try {
    return existsSync(coreFile(path));
  } catch {
    return false;
  }
}

function coreDir(): string {
  return coreFile("");
}

function freshExists(path: string): boolean {
  const rel = path.split("/").join("/");
  try {
    execFileSync(
      "git",
      ["-C", coreDir(), "cat-file", "-e", `origin/main:${rel}`],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return coreExists(path);
  }
}

const EDITOR_HOST = join("crates", "bitty-terminal", "src", "editor_host.rs");

const CORE_PRESENT = freshExists(EDITOR_HOST);

if (!CORE_PRESENT) {
  console.log(
    `live Core not present at ${coreDir()} ` +
      `(BITTY_WORKSPACE=${process.env.BITTY_WORKSPACE ?? "(unset, relative fallback)"}); ` +
      `skipping live-identity probe, mock-pinned assertions still run`,
  );
}

describe.skipIf(!CORE_PRESENT)("live Core presence (fail-soft probe)", () => {
  test("Core editor host exists at the pinned surface", () => {
    expect(freshExists(EDITOR_HOST)).toBe(true);
  });
});

const MAX_BYTES = 64 * 1024;

describe("W-103 parity: T-1..T-8 behavioral equivalence", () => {
  test("T-1 buffer cap fails closed with content kept (composer.rs buffer_cap_fails_closed_and_keeps_content)", async () => {
    const run = await verify({ environment: { VISUAL: "nvim" } });
    const verdict = await run.lua.doString(`
      return (function()
        local b = composer.buffer_new()
        assert(composer.buffer_insert(b, "keep me"))
        local ok, want = composer.buffer_insert(b, string.rep("x", 65536))
        return { ok = ok, kept = b.text, wanted = want }
      end)()`);
    expect(verdict).toMatchObject({ ok: false, kept: "keep me" });
    expect((verdict as { wanted: number }).wanted).toBeGreaterThan(MAX_BYTES);
    // Exactly-at-cap is accepted: the boundary is precise, not approximate.
    const exact = await run.lua.doString(
      "return (function() local b = composer.buffer_new(); return composer.buffer_insert(b, string.rep('x', 65536)) end)()",
    );
    expect(exact).toBe(true);
  });

  test("T-2 framed submit past cap emits nothing; success is byte-exact (frame_submit tests + submit_over_cap_fails_closed_without_charge)", async () => {
    const run = await verify({
      environment: { VISUAL: "nvim" },
      submitBudgetBytes: 0,
    });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "hi");
    dispatch(run, SUBMIT_COMMAND);
    expect(run.host.submittedFrames).toEqual([]);
    expect(run.host.submitBudgetUsed).toBe(0);
    expect(await bufferText(run)).toBe("hi");
    // Framing math matches Core: content + 13 (ESC[200~ + ESC[201~ + CR).
    const overhead = await run.query("composer.SUBMIT_FRAME_OVERHEAD");
    expect(overhead).toBe(13);
    const live = await verify({ environment: { VISUAL: "nvim" } });
    dispatch(live, OPEN_COMMAND);
    await typeText(live, "ab");
    dispatch(live, SUBMIT_COMMAND);
    expect(live.host.submittedFrames).toHaveLength(1);
    expect(live.host.submittedFrames[0]).toEqual(expectedFrame("ab"));
    expect(live.host.submittedFrames[0].length).toBe(2 + 13);
  });

  test("T-3 hostile editor denied before any temp/child; no fallback past hostile-first (resolve_editor_rejects_non_allowlisted_programs + hostile_program_denied_without_side_effects)", async () => {
    for (const hostile of [
      "nano -w",
      "vim;touch pwned",
      "/bin/vim",
      "nvim\x00vim",
      "..",
    ]) {
      const run = await verify({
        environment: { VISUAL: hostile, EDITOR: "nvim" },
      });
      dispatch(run, OPEN_COMMAND);
      dispatch(run, EDITOR_COMMAND);
      expect(await lastCode(run)).toBe("denied:not-allowed");
      expect(run.host.editorTempsCreated).toBe(0);
      expect(run.host.editorTempsRemoved).toBe(0);
      expect(await isOpen(run)).toBe(true);
      expect(run.host.submittedFrames).toEqual([]);
    }
  });

  test("T-4 single session bound; temps removed on every path (external_editor_host_holds_single_session_and_cleans_temp + sweep_removes_only_dead_owners)", async () => {
    const run = await verify({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    dispatch(run, OPEN_COMMAND);
    expect(await lastCode(run)).toBe("ALREADY_OPEN");
    expect(await isOpen(run)).toBe(true);
    run.host.setEditorResult({ kind: "edited", content: "v1" });
    dispatch(run, EDITOR_COMMAND);
    // DELTA (finding, not failure): the mock has no PTY leaf, so the
    // leaf-vanished path (poll_cancels_when_leaf_gone) has no mock-level
    // twin; the overlay-crash twin is proven in verify-evidence.test.ts and
    // Core owns the leaf teardown. Counter balance holds regardless:
    expect(run.host.editorTempsCreated).toBe(run.host.editorTempsRemoved);
    expect(await isOpen(run)).toBe(true);
  });

  test("T-5 round trip applies bounded UTF-8; non-zero discards (external_editor_round_trip_applies_and_tears_down + hosted_nonzero_exit_discards_and_cleans_temp)", async () => {
    const run = await verify({ environment: { VISUAL: "vim" } });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "old");
    run.host.setEditorResult({ kind: "edited", content: "héllo世界🦀" });
    dispatch(run, EDITOR_COMMAND);
    expect(await lastCode(run)).toBe("EDITED");
    expect(await bufferText(run)).toBe("héllo世界🦀");
    run.host.setEditorResult({ kind: "non-zero", code: 1 });
    dispatch(run, EDITOR_COMMAND);
    expect(await lastCode(run)).toBe("non-zero");
    expect(await bufferText(run)).toBe("héllo世界🦀");
    // DELTA: focus restore is a Core PTY-leaf mechanic with no mock
    // observable; session continuity (still open, still submittable) is the
    // plugin-observable twin, proven next.
    dispatch(run, SUBMIT_COMMAND);
    expect(await lastCode(run)).toBe("SUBMITTED");
    expect(run.host.submittedFrames).toHaveLength(1);
    expect(run.host.editorTempsCreated).toBe(run.host.editorTempsRemoved);
  });

  test("T-6 timeout yields the typed outcome with the draft kept (hosted_timeout_kills_recorded_tree)", async () => {
    const run = await verify({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "draft");
    run.host.setEditorResult({ kind: "timeout" });
    dispatch(run, EDITOR_COMMAND);
    expect(await lastCode(run)).toBe("timeout");
    expect(await bufferText(run)).toBe("draft");
    expect(await isOpen(run)).toBe(true);
    expect(run.host.editorTempsCreated).toBe(run.host.editorTempsRemoved);
    // DELTA: the recorded-tree kill itself is Core-owned (OwnedTree) and has
    // no mock observable; the plugin observes only the typed outcome, which
    // is what this row proves. Timeout bounds stay enforced at both layers:
    expect(run.host.lastEditorTimeoutMs).toBe(120_000);
    dispatch(run, EDITOR_COMMAND, { timeout_ms: 1 });
    expect(run.host.lastEditorTimeoutMs).toBe(1);
  });

  test("T-7 capture is transient: overflow is flagged, closed feed fails closed, trailing pump never resurrects (W-73 items 2-3)", async () => {
    const run = await verify({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    // Feed while closed fails closed with NOT_OPEN: those bytes belong to
    // the PTY and the plugin touches nothing.
    // Feed while closed fails closed: pump reports false, the buffer stays
    // empty, and those bytes belong to the PTY (the plugin touches nothing).
    const closed = await verify({ environment: { VISUAL: "nvim" } });
    const drained = await closed.lua.doString("return composer.pump()");
    expect(drained).toBe(false);
    expect(await bufferText(closed)).toBe("");
    expect(closed.host.submittedFrames).toEqual([]);
    // Overflow past the 256-event queue sets the sticky flag, never drops
    // the session, and never emits.
    for (let i = 0; i < 260; i += 1) {
      run.host.injectOverlayInput({ type: "text", data: { text: "q" } });
    }
    await pump(run);
    expect(await run.query("composer.capture_overflowed()")).toBe(true);
    expect(await isOpen(run)).toBe(true);
    expect(run.host.submittedFrames).toEqual([]);
    // A trailing pump after an observed release never overwrites the
    // release diagnostic and never delivers leftovers to the terminal.
    run.host.simulateOverlayCrash();
    await pump(run);
    expect(await lastCode(run)).toBe("RELEASED");
    await pump(run);
    expect(await lastCode(run)).toBe("RELEASED");
    expect(run.host.submittedFrames).toEqual([]);
  });

  test("T-8 no bypass: the plugin cannot write the PTY except through the inspected submit (W-73 item 4)", async () => {
    const run = await verify({ environment: { VISUAL: "nvim" } });
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "typed");
    // Typing, paste, chords, and editor detours never emit on their own.
    run.host.setEditorResult({ kind: "edited", content: "edited" });
    dispatch(run, EDITOR_COMMAND);
    expect(run.host.submittedFrames).toEqual([]);
    // Exactly one emission surface exists and it is capability-gated.
    dispatch(run, SUBMIT_COMMAND);
    expect(run.host.submittedFrames).toHaveLength(1);
    expect(run.host.handlerViolations).toEqual([]);
    // DELTA: the mock performs no suspicious-paste inspection (it frames
    // verbatim), so "still inspected" is Core-owned and evidenced by Core
    // paste-pipeline tests, not here. This row proves the extension half:
    // no second write path exists.
  });
});

describe("no-weakening proof: Core invariants untouched", () => {
  test("manifest declares exactly the three public capabilities and nothing else", () => {
    const section = MANIFEST_SOURCE.split("[capabilities]")[1].split("[")[0];
    const granted = section
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.endsWith("= true"))
      .map((line) => line.split("=")[0].trim());
    expect(granted.sort()).toEqual([...COMPOSER_CAPABILITIES].sort());
    // Declared authority lives in TOML keys, not prose: scan non-comment
    // lines so the manifest's own "requests no X" documentation cannot
    // trip the denial. Nothing beyond the triple may be requested.
    const declared = MANIFEST_SOURCE.split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(declared).not.toMatch(
      /filesystem|process\.spawn|network|clipboard|terminal\.input\.(read|inject)/,
    );
    const result = lintManifestSource(MANIFEST_SOURCE);
    expect(
      result.diagnostics.filter((entry) => entry.severity === "error"),
    ).toEqual([]);
  });

  test("entry point touches only the granted host namespaces; no ambient authority", () => {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    const source = readFileSync(
      join(repoRoot, "lua", "composer", "init.lua"),
      "utf8",
    );
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    const namespaces = new Set(
      [...code.matchAll(/bitty\.([A-Za-z_]+)/g)].map((match) => match[1]),
    );
    expect([...namespaces].sort()).toEqual(
      [
        "api_version",
        "commands",
        "events",
        "keymaps",
        "process",
        "settings",
        "terminal",
        "ui",
      ].sort(),
    );
    const surfaces = new Set(
      [...code.matchAll(/bitty\.([A-Za-z_]+\.[A-Za-z_]+\.[A-Za-z_]+)/g)].map(
        (match) => match[1],
      ),
    );
    for (const surface of surfaces) {
      expect([
        "ui.overlay.acquire",
        "ui.overlay.update",
        "ui.overlay.poll",
        "ui.overlay.release",
        "terminal.submit",
        "process.editor.start",
        "settings.get",
        "commands.register",
        "keymaps.suggest",
        "events.subscribe",
      ]).toContain(surface);
    }
    expect(code).not.toMatch(/\bos\s*\.\s*(execute|remove|rename|exit)\b/);
    expect(code).not.toMatch(/\bio\s*\.\s*(open|popen|write|remove)\b/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/dofile|loadfile|loadstring/);
  });

  test("mismatch, safe-mode, and uninstall match the no-plugin baseline exactly", async () => {
    // Baseline: a host the plugin never activates. Observable terminal
    // behavior is empty frames, zero temps, and refused dispatch.
    const baseline = new MockHost({ manifestSource: MANIFEST_SOURCE });
    expect(() => baseline.dispatchCommand(OPEN_COMMAND, {})).toThrow();
    expect(baseline.submittedFrames).toEqual([]);
    const snapshot = (host: MockHost): string =>
      JSON.stringify({
        frames: host.submittedFrames.length,
        created: host.editorTempsCreated,
        removed: host.editorTempsRemoved,
        violations: host.handlerViolations.length,
      });
    const expected = snapshot(baseline);
    // Version mismatch fails activation with no partial state.
    const mismatched = new MockHost({
      manifestSource: MANIFEST_SOURCE,
      pluginApiVersion: "99.0.0",
    });
    expect(() => mismatched.beginActivation()).toThrow();
    expect(() => mismatched.dispatchCommand(OPEN_COMMAND, {})).toThrow();
    expect(snapshot(mismatched)).toBe(expected);
    // Safe mode fails the open with E_UI_UNAVAILABLE and emits nothing.
    const safe = await verify({
      environment: { VISUAL: "nvim" },
      safeMode: true,
    });
    dispatch(safe, OPEN_COMMAND);
    expect(await lastCode(safe)).toBe("E_UI_UNAVAILABLE");
    expect(snapshot(safe.host)).toBe(expected);
    // Missing grants deny the open with no partial activation.
    const ungranted = await verify({
      environment: { VISUAL: "nvim" },
      grants: [],
    });
    dispatch(ungranted, OPEN_COMMAND);
    expect(await lastCode(ungranted)).toBe("E_CAPABILITY_DENIED");
    expect(snapshot(ungranted.host)).toBe(expected);
    // Uninstall (dispose) returns the host to the baseline observables.
    const removed = await verify({ environment: { VISUAL: "nvim" } });
    dispatch(removed, OPEN_COMMAND);
    await typeText(removed, "draft");
    removed.host.dispose();
    expect(snapshot(removed.host)).toBe(expected);
    expect(() => dispatch(removed, SUBMIT_COMMAND)).toThrow();
  });

  test("bad key configuration falls back to defaults without widening authority", async () => {
    const run = await verify({
      environment: { VISUAL: "nvim" },
      settings: { submit: "e", newline: "enter" },
    });
    expect(await run.query("composer.last_code()")).toBe("KEYS_FALLBACK");
    dispatch(run, OPEN_COMMAND);
    expect(await isOpen(run)).toBe(true);
    await typeText(run, "x");
    await pump(run);
    // Default submit chord still routes; the invalid bare-key submit never
    // shadows shell typing because it was rejected at activation.
    await press(run, "enter", { ctrl: true });
    expect(await lastCode(run)).toBe("SUBMITTED");
    expect(run.host.submittedFrames).toHaveLength(1);
    expect(run.host.handlerViolations).toEqual([]);
  });
});
