import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function runNode(args) {
  return spawnSync(process.execPath, args, {
    cwd: rootDir,
    encoding: "utf-8",
  });
}

test("all CLIs return help output", () => {
  const scripts = [
    "scripts/collect_x_following.mjs",
    "scripts/match_mastodon_from_x_raw.mjs",
    "scripts/search_mastodon_from_x_profiles.mjs",
  ];

  for (const script of scripts) {
    const res = runNode([script, "--help"]);
    assert.equal(res.status, 0, `${script} exited non-zero: ${res.stderr}`);
    assert.match(res.stdout, /Usage:/, `${script} help did not include usage`);
  }
});

test("match script extracts and normalizes Mastodon handles", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "x2masto-test-"));
  const inputPath = path.join(tmpDir, "input.jsonl");
  const matchesOut = path.join(tmpDir, "matches.csv");
  const importOut = path.join(tmpDir, "import.csv");

  const rows = [
    {
      handle: "alice_x",
      display_name: "Alice",
      bio: "Find me at @Alice@hachyderm.io",
      raw_text: "",
      external_links: "",
      raw_links: "",
    },
    {
      handle: "bob_x",
      display_name: "Bob",
      bio: "",
      raw_text: "",
      external_links: "https://mastodon.social/@Bob",
      raw_links: "",
    },
    {
      handle: "carol_x",
      display_name: "Carol",
      bio: "",
      raw_text: "",
      external_links: "",
      raw_links: "https://fosstodon.org/users/Carol",
    },
    {
      handle: "noise",
      display_name: "Noise",
      bio: "not-a-handle@localhost",
      raw_text: "",
      external_links: "",
      raw_links: "",
    },
  ];

  const jsonl = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
  await writeFile(inputPath, jsonl, "utf-8");

  const res = runNode([
    "scripts/match_mastodon_from_x_raw.mjs",
    "--input",
    inputPath,
    "--matches-output",
    matchesOut,
    "--import-output",
    importOut,
  ]);

  assert.equal(res.status, 0, `match script exited non-zero: ${res.stderr}`);

  const importCsv = await readFile(importOut, "utf-8");
  const importLines = importCsv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(",")[0].trim().replace(/^"|"$/g, ""));

  assert.deepEqual(importLines, ["alice@hachyderm.io", "bob@mastodon.social", "carol@fosstodon.org"]);

  const matchesCsv = await readFile(matchesOut, "utf-8");
  assert.match(matchesCsv, /Alice/i);
  assert.match(matchesCsv, /mastodon.social/i);
  assert.doesNotMatch(matchesCsv, /localhost/i);
});
