#!/usr/bin/env bun
/**
 * Keep the user-facing README configuration table honest.
 *
 * The manifest `[settings]` table is the host-enforced allowlist: an
 * undeclared `bitty.settings.get` fails closed with
 * `E_SETTINGS_UNDECLARED`. The README `## Configuration` table is the user
 * contract. This check fails when:
 *
 * - a declared key is missing from the README table;
 * - the README documents a key the manifest does not declare;
 * - a documented type or default disagrees with the declaration.
 *
 * Usage:
 *
 *   bun scripts/check-readme-settings.mjs
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Manifest kind -> label used in the README table. */
const TYPE_LABELS = {
  bool: "boolean",
  int: "integer",
  string: "string",
  "string-array": "string array",
};

const CONFIG_HEADING = /^## Configuration\s*$/m;
const TABLE_HEADER = /^\|\s*Key\s*\|/i;
const NEXT_HEADING = /^## /m;

/** Strip surrounding whitespace and one pair of Markdown backticks. */
function cellText(cell) {
  return cell.trim().replace(/^`+/, "").replace(/`+$/, "").trim();
}

/** Render a declared default exactly as the README table spells it. */
function expectedDefault(value) {
  return JSON.stringify(value);
}

/**
 * Check one repository checkout.
 *
 * @param {{ root?: string, manifest?: string, readme?: string }} options
 * @returns {string[]} human-readable failures (empty means the table matches)
 */
export function checkReadmeSettings(options = {}) {
  const root = options.root ?? process.cwd();
  const manifestPath = resolve(root, options.manifest ?? "bitty-plugin.toml");
  const readmePath = resolve(root, options.readme ?? "README.md");

  const manifest = Bun.TOML.parse(readFileSync(manifestPath, "utf8"));
  const declared = manifest.settings ?? {};
  const readme = readFileSync(readmePath, "utf8");
  const errors = [];

  const heading = CONFIG_HEADING.exec(readme);
  if (heading === null) {
    return ["README is missing the '## Configuration' section"];
  }

  const afterHeading = readme.slice(heading.index + heading[0].length);
  const next = NEXT_HEADING.exec(afterHeading);
  const section =
    next === null ? afterHeading : afterHeading.slice(0, next.index);
  const lines = section.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => TABLE_HEADER.test(line));
  if (headerIndex < 0) {
    return ["README '## Configuration' section has no settings table"];
  }

  /** @type {Map<string, { type: string, defaultValue: string }>} */
  const documented = new Map();
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("|")) {
      break;
    }
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map(cellText);
    const [key, type, defaultValue] = cells;
    if (key === undefined || key === "") {
      continue;
    }
    if (documented.has(key)) {
      errors.push(`README documents setting '${key}' more than once`);
      continue;
    }
    documented.set(key, {
      type: type ?? "",
      defaultValue: defaultValue ?? "",
    });
  }

  for (const key of Object.keys(declared)) {
    if (!documented.has(key)) {
      errors.push(`declared setting '${key}' is missing from the README table`);
    }
  }

  for (const [key, row] of documented) {
    const declaration = declared[key];
    if (declaration === undefined) {
      errors.push(`README documents undeclared setting '${key}'`);
      continue;
    }

    const expectedType = TYPE_LABELS[declaration.type] ?? declaration.type;
    if (row.type !== expectedType) {
      errors.push(
        `setting '${key}' type is '${row.type}' in the README; manifest declares '${expectedType}'`,
      );
    }

    const expected = expectedDefault(declaration.default);
    if (row.defaultValue !== expected) {
      errors.push(
        `setting '${key}' default is '${row.defaultValue}' in the README; manifest declares '${expected}'`,
      );
    }
  }

  return errors;
}

if (import.meta.main) {
  const errors = checkReadmeSettings();
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`readme-settings: FAIL ${error}`);
    }
    process.exit(1);
  }
  console.log(
    "readme-settings: OK README configuration table matches bitty-plugin.toml [settings]",
  );
}
