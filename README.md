# composer

W-103 S-3 (CTX-0003) Lua policy package for the Bitty command composer:
a modal command line over the public host API only. Accepted contracts are
W-73 (composer boundary, bitty-docs) and W-82 (composer architecture,
bitty-terminal-docs); the SDK binding is bitty-plugin-sdk at `d5d117d`.

## Scope

- `bitty-plugin.toml`: plugin id `bitty-terminal.composer`, version `0.0.1`,
  compat `bitty >=0.5,<1.0` with `plugin-api ^1.0`, exactly three
  capabilities (`ui.overlay.focus`, `terminal.input.submit`,
  `process.editor`), lazy `open`/`submit`/`cancel`/`close`/`editor` commands
  and the `overlay.released` event.
- `lua/composer/init.lua`: the whole policy. `CommandBuffer` presentation
  state (never Terminal Truth), the key-chord vocabulary with defaults and
  remapping, the modal session state machine, and the open/submit/cancel/
  close/editor lifecycle over the overlay, capture, submit, and editor host
  operations. Manual open only; while closed, input bytes flow to the PTY and
  the plugin touches nothing.
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
  host. The overlay shows a bounded 4000-byte tail preview under the host
  per-update ceiling; the buffer itself is never preview-truncated.

## Non-goals (S-3 only)

- No Core changes, no host-API implementation, no SDK changes.
- No registry onboarding and no release; the package stays a candidate until
  CTX-0004 independently verifies temp cleanup, process, paste, and
  cancellation evidence plus Core W-103 parity.
- No second input channel: the plugin registers no hot-path callback and
  drains capture through the owner-initiated `composer.pump()` tick.

## Compat

The host validates `plugin-api ^1.0` before activation and fails closed on
mismatch. The plugin repeats the major-version gate at load as
defense in depth: on mismatch it records `disabled_reason` and registers
nothing for the generation.
