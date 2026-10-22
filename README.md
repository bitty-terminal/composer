# Composer

Modal command-line editor for the [Bitty terminal](https://github.com/bitty-terminal/bitty):
an editable buffer over the terminal that submits as one bracketed paste.

## Overview

Composer opens a focusable overlay with an editable command line, routes a
small chord vocabulary while the modal holds input capture, and submits the
buffer to the focused panel through the Core paste pipeline. It can also hand
the draft to an allowlisted external editor (`nvim`, `vim`, or `vi`) on a
Core-owned temporary file. Opening is manual only: while the modal is closed,
input bytes flow to the PTY and the plugin touches nothing. Presentation state
only; it never mutates Terminal Truth.

## Install

Prerequisites: Bitty `>=0.0.21` and Plugin API `^1.0` (from
`bitty-plugin.toml` `[compat]`).

```sh
bitty plugin install https://github.com/bitty-terminal/composer.git
bitty plugin enable bitty-terminal.composer
bitty plugin list   # confirm state and grants
```

From a local checkout:

```sh
bitty plugin install ./composer --yes
bitty plugin enable bitty-terminal.composer
```

`bitty plugin list` confirms activation: the entry must be enabled and show the
three grants (`ui.overlay.focus`, `terminal.input.submit`, `process.editor`). A
disabled entry carries a `disabled_reason`; see
[Troubleshooting](#troubleshooting).

## Commands

| Command                          | What it does                                                                                       | Arguments                               | Default keybinding      |
| -------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------- |
| `bitty-terminal.composer:open`   | Open the modal on the current draft (or the entry hint when empty).                                | None                                    | Suggested: `alt+e`      |
| `bitty-terminal.composer:submit` | Submit the buffer through the paste pipeline; the buffer clears only on an accepted submit.        | None                                    | `ctrl+enter` (in modal) |
| `bitty-terminal.composer:cancel` | Discard the unsubmitted buffer and close the session; writes nothing.                              | None                                    | None                    |
| `bitty-terminal.composer:close`  | Close the modal and preserve the draft for the next open; writes nothing.                          | None                                    | `escape` (in modal)     |
| `bitty-terminal.composer:editor` | Round-trip the draft through the allowlisted external editor; a failed round trip keeps the draft. | `timeout_ms` (number, optional, `>= 1`) | `alt+e` (in modal)      |

## Configuration

Settings are declared in `bitty-plugin.toml` `[settings]` and resolved from
`$XDG_CONFIG_HOME/bitty/plugins/bitty-terminal.composer.lua`. Every key is
user-owned; the plugin never writes settings.

| Key               | Type   | Default        | Description                                                                                                      | Applies         |
| ----------------- | ------ | -------------- | ---------------------------------------------------------------------------------------------------------------- | --------------- |
| `open_chord`      | string | `"alt+e"`      | Manual-open chord advertised to the host keymap. Must be `<mod>+...+<single-char>`; an invalid value falls back. | Next activation |
| `newline`         | string | `"enter"`      | In-modal chord that inserts a newline.                                                                           | Next activation |
| `submit`          | string | `"ctrl+enter"` | In-modal chord that submits the buffer.                                                                          | Next activation |
| `close`           | string | `"escape"`     | In-modal chord that closes the modal and keeps the draft.                                                        | Next activation |
| `external_editor` | string | `"alt+e"`      | In-modal chord that starts the external-editor round trip.                                                       | Next activation |

```lua
-- $XDG_CONFIG_HOME/bitty/plugins/bitty-terminal.composer.lua
return {
  open_chord = "alt+e",
  newline = "enter",
  submit = "ctrl+enter",
  close = "escape",
  external_editor = "alt+e",
}
```

The four in-modal roles must stay pairwise distinct; a missing, wrong-typed, or
invalid chord falls back to the shipped default for that key only. Chords the
plugin does not declare cannot be read. The host resolves settings at activation
and pins them to the generation, so edit the file and reopen Bitty to apply a
change.

## Keybindings

The plugin suggests `alt+e` for `bitty-terminal.composer:open`; the host applies
it only when the chord is free, and user mappings always win. Rebind it with
`open_chord`, or bind the command yourself in `$XDG_CONFIG_HOME/bitty/init.lua`:

```lua
return {
  keymaps = {
    {
      chord = "ctrl+alt+e",
      action = "bitty-terminal.composer:open",
      context = "global",
    },
  },
}
```

While the modal holds capture, the in-modal roles above apply (submit first,
then close, external editor, newline, text). The open chord is idle while the
modal is open, so the default `alt+e` open chord and `alt+e` external-editor
role never compete.

## Troubleshooting

| Symptom / error                               | Meaning                                                                                                                                                                                                                                      | What to do                                                                                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `E_INCOMPATIBLE` / `E_DISABLED`               | The host application or Plugin API version is outside `[compat]`; registration stops with no commands, keymap, event, or overlay.                                                                                                            | Upgrade Bitty or install a composer revision whose ranges admit your host. Do not edit the manifest ranges.                                   |
| `E_SETTINGS_UNDECLARED`                       | Registration read a settings key absent from `[settings]`. This is a plugin defect, not a file error.                                                                                                                                        | All five keys are declared; if it still appears, report it with `bitty plugin info bitty-terminal.composer` and run `bitty --safe` meanwhile. |
| Capability denied                             | `E_CAPABILITY_DENIED` (class `runtime`): no `ui.overlay.focus` means the modal cannot open (`E_UI_UNAVAILABLE`); no `terminal.input.submit` keeps the draft and leaves the session open; no `process.editor` disables the editor round trip. | Reinstall and approve the grants, or inspect granted versus requested capabilities with `bitty plugin list`.                                  |
| `KEYS_FALLBACK`                               | One or more remapped chords were invalid or duplicated, so the whole role set fell back to the defaults.                                                                                                                                     | Fix the offending chord in the plugin file; the four in-modal roles must be distinct.                                                         |
| `bitty-terminal.composer:submit` does nothing | `Ctrl+Enter` may not arrive on a host that lost the modifier channel after an update.                                                                                                                                                        | Use the explicit `submit` command from the palette; it does not depend on chord plumbing. Report the regression with `bitty plugin info`.     |
| `NOT_OPEN`                                    | A session verb ran while the modal was closed; bytes still belong to the PTY.                                                                                                                                                                | Open the composer first.                                                                                                                      |
| `E_SPAWN_FAILED`                              | Not applicable: the plugin spawns no process; the editor is a Core-mediated `process.editor` call.                                                                                                                                           | —                                                                                                                                             |

## Scope

- `bitty-plugin.toml`: plugin id `bitty-terminal.composer`, version `0.0.1`,
  compat `bitty >=0.0.21` with `plugin-api ^1.0`, exactly three
  capabilities (`ui.overlay.focus`, `terminal.input.submit`,
  `process.editor`), a `[settings]` table declaring the five chord keys,
  lazy `open`/`submit`/`cancel`/`close`/`editor` commands and the
  `overlay.released` + `focus.changed` + `overlay.input.available` events.
- `lua/composer/init.lua`: the whole policy. `CommandBuffer` presentation
  state (never Terminal Truth), the key-chord vocabulary with defaults and
  remapping, the modal session state machine, and the open/submit/cancel/
  close/editor lifecycle over the overlay, capture, submit, and editor host
  operations. Manual open only; while closed, input bytes flow to the PTY and
  the plugin touches nothing. Every open acquires the focusable overlay plus
  transient input capture from a title/placeholder spec and paints the
  non-empty titled scene (title row plus the input line, or the entry hint
  while the buffer is empty); involuntary session ends observed through
  `overlay.released` keep the draft and close the session, and `focus.changed`
  drains stranded capture plus repaints while open.
- `tests/`: bun + wasmoon suite against the SDK `MockHost`, mirroring the
  bar plugin harness pattern. Covers W-103 T-9 (lifecycle, modal precedence,
  no-PTTY-byte-leak), T-10 (over-cap fail-closed), and T-11 (mismatch
  disable, fallback, safe mode).

## Rules

- Public API only. No filesystem, process-spawn, network, clipboard, or raw
  terminal-input authority; the editor temp path never leaves Core.
- One over-limit rule for every path (typing, paste, editor content,
  submit framing): over-limit input is rejected with the previous buffer
  intact. Nothing is truncated, nothing is emitted.
- Buffer clear on accepted submit; explicit cancel discards; Esc close and
  any involuntary release preserve the draft; failed editor round trips
  preserve the draft.
- Submit-first chord precedence (`submit`, `close`, `external_editor`,
  `newline`, text, ignored); roles must stay pairwise distinct and fall back
  to defaults when remapping is invalid.
- Version/capability mismatch disables with a diagnostic and no partial
  activation: no commands, no keymap, no events, no overlay.
- Bounds mirror Core/W-82: 64 KiB buffer cap; editor wait defaults to 120 s
  and clamps to the 300 s ceiling as documented behavior enforced by the
  host. The overlay paints the titled scene (title row plus the input line)
  with a bounded 4000-byte tail preview under the host per-update ceiling;
  the buffer itself is never preview-truncated.

## Non-goals (S-3 only)

- No Core changes, no host-API implementation, no SDK changes.
- No registry onboarding and no release; the package stays a candidate until
  CTX-0004 independently verifies temp cleanup, process, paste, and
  cancellation evidence plus Core W-103 parity.
- No second input channel: the plugin registers no hot-path callback and
  drains capture through the owner-initiated `composer.pump()` tick. Every
  session verb drains stranded capture before acting, and `focus.changed`
  drains plus repaints while open; the poll feed accepts both the spec
  envelope and the production flat event shape. Field-level key-modifier
  encodings stay parked with the host contract owner, so flat modified
  chords degrade to their bare key and the explicit session commands stay
  the exact path.

## Compat

The host validates `plugin-api ^1.0` before activation and fails closed on
mismatch. The plugin repeats the major-version gate at load as
defense in depth: on mismatch it records `disabled_reason` and registers
nothing for the generation.
