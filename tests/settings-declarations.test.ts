/**
 * Regression for composer#23: activation failed on Bitty 0.0.24 with
 * `E_SETTINGS_UNDECLARED` for `newline`. The host fails an undeclared
 * `bitty.settings.get` closed, so a manifest without the matching `[settings]`
 * declarations aborts registration before any command, keymap, or event
 * exists, and the modal can never open.
 *
 * The declarations themselves are in the manifest. This suite keeps them
 * fixed: the declared key set must equal exactly what registration reads, the
 * kinds and shipped defaults must match the Lua fallbacks, activation must
 * succeed from an empty settings file and from explicit user values, and the
 * README configuration table must document exactly the declared keys with
 * their types and defaults.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { loadManifestModel } from "bitty-plugin-sdk";
import { LuaFactory } from "wasmoon";

import { checkReadmeSettings } from "../scripts/check-readme-settings.mjs";

import {
  activateComposer,
  bufferText,
  dispatch,
  ENTRY_SOURCE,
  isOpen,
  lastCode,
  MANIFEST_SOURCE,
  OPEN_COMMAND,
  press,
  typeText,
  type ComposerRun,
} from "./harness.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Module-level chord constants registration reads its settings against. */
interface ComposerModule {
  readonly DEFAULT_KEYS: Readonly<Record<string, string>>;
  readonly DEFAULT_OPEN_CHORD: string;
}

/** Load `lua/composer/init.lua` without a host (the pure policy surface). */
async function loadModule(): Promise<ComposerModule> {
  const factory = new LuaFactory();
  const lua = await factory.createEngine({ injectObjects: false });
  try {
    return (await lua.doString(ENTRY_SOURCE)) as ComposerModule;
  } finally {
    lua.global.close();
  }
}

const MODEL = loadManifestModel(MANIFEST_SOURCE);
const MODULE = await loadModule();

/** Every key registration passes to `bitty.settings.get`. */
const READ_KEYS = [...Object.keys(MODULE.DEFAULT_KEYS), "open_chord"];

const runs: ComposerRun[] = [];

async function composer(
  options: Parameters<typeof activateComposer>[0],
): Promise<ComposerRun> {
  const run = await activateComposer(options);
  runs.push(run);
  return run;
}

afterEach(() => {
  for (const run of runs.splice(0)) run.close();
});

describe("composer#23 settings declarations match the entry point", () => {
  test("the manifest declares a [settings] table", () => {
    expect(MODEL.hasSettingsTable).toBe(true);
    expect(MODEL.settings.size).toBeGreaterThan(0);
  });

  test("every bitty.settings.get key is declared and nothing extra is", () => {
    expect(READ_KEYS.length).toBeGreaterThan(0);
    expect([...MODEL.settings.keys()].sort()).toEqual([...READ_KEYS].sort());
  });

  test("the README configuration table matches the manifest", () => {
    expect(checkReadmeSettings({ root: REPO_ROOT })).toEqual([]);
  });

  test("declared kinds and defaults match the Lua fallbacks", () => {
    const expected: Record<string, string> = {
      ...MODULE.DEFAULT_KEYS,
      open_chord: MODULE.DEFAULT_OPEN_CHORD,
    };
    for (const key of READ_KEYS) {
      expect(MODEL.settings.get(key)?.kind).toBe("string");
      expect(MODEL.settings.get(key)?.default).toBe(expected[key]);
    }
  });

  test("the declared-key model is closed: no key outside the read set", () => {
    // The host turns this closed map into `E_SETTINGS_UNDECLARED` for any
    // read outside it (proven against the mock host in `composer.test.ts`),
    // so the equality above is what keeps registration from aborting.
    expect(MODEL.settings.get("unclaimed")).toBeUndefined();
    expect(MODEL.settings.get("newline")?.default).toBe(
      MODULE.DEFAULT_KEYS.newline,
    );
  });
});

describe("composer#23 activation with declared settings", () => {
  test("an empty settings file activates and routes the default chords", async () => {
    const run = await composer({ settings: {} });
    expect(await lastCode(run)).toBe("ok");
    dispatch(run, OPEN_COMMAND);
    expect(await isOpen(run)).toBe(true);
    await typeText(run, "echo");
    // Shipped defaults are in force: Enter inserts, Ctrl+Enter submits.
    await press(run, "enter");
    expect(await bufferText(run)).toBe("echo\n");
    await press(run, "enter", { ctrl: true });
    expect(await isOpen(run)).toBe(false);
    expect(await lastCode(run)).toBe("SUBMITTED");
    expect(run.host.submittedFrames).toHaveLength(1);
  }, 20_000);

  test("activation with no settings bridge values also succeeds", async () => {
    // No `settings` argument at all: the host serves the shipped manifest
    // defaults for every declared key.
    const run = await composer();
    expect(await lastCode(run)).toBe("ok");
    dispatch(run, OPEN_COMMAND);
    await press(run, "enter", { ctrl: true });
    expect(await lastCode(run)).toBe("SUBMITTED");
  }, 20_000);

  test("explicit values are honored", async () => {
    const run = await composer({
      settings: { newline: "shift+enter", submit: "enter" },
    });
    expect(await lastCode(run)).toBe("ok");
    dispatch(run, OPEN_COMMAND);
    await typeText(run, "x");
    await press(run, "enter", { shift: true });
    expect(await bufferText(run)).toBe("x\n");
    await press(run, "enter");
    expect(await lastCode(run)).toBe("SUBMITTED");
    expect(run.host.submittedFrames).toHaveLength(1);
  }, 20_000);
});
