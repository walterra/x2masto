#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const ACCT_RE = /(?<![\w/])@?([A-Za-z0-9_][A-Za-z0-9._-]{0,63})@([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?![\w.-])/g;
const URL_HANDLE_RE = /https?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})\/(?:@|users\/|u\/|web\/@)([A-Za-z0-9_][A-Za-z0-9._-]{0,63})/gi;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) continue;
    if (t === "--help" || t === "-h") {
      args.help = true;
      continue;
    }
    const k = t.slice(2);
    const n = argv[i + 1];
    if (!n || n.startsWith("--")) {
      args[k] = true;
    } else {
      args[k] = n;
      i += 1;
    }
  }
  return args;
}

function usage() {
  return `
match_mastodon_from_x_raw.mjs

Extract Mastodon/Fediverse handles from x-following raw data.

Usage:
  node scripts/match_mastodon_from_x_raw.mjs

Options:
  --input <path>             Input JSONL (default: data/x-following-raw.jsonl)
  --matches-output <path>    Output matches CSV (default: data/x-matches.csv)
  --import-output <path>     Output Mastodon import CSV (default: data/x-mastodon-import.csv)
  --verify                   Verify discovered handles via WebFinger
  --verify-workers <n>       Parallel workers for verify (default: 8)
  --help                     Show help
`;
}

function toInt(v, fallback) {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeCandidate(raw) {
  let h = String(raw || "").trim().replace(/^["'([{<\s]+|["'\])}>\s.,;:!?]+$/g, "");
  if (h.startsWith("@")) h = h.slice(1);

  if ((h.match(/@/g) || []).length !== 1) return null;

  const [localRaw, domainRaw] = h.split("@");
  const local = localRaw.trim();
  const domain = domainRaw.trim().replace(/\.$/, "").toLowerCase();

  if (!local || !domain || !domain.includes(".")) return null;
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,100}$/.test(local)) return null;
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) return null;

  return `${local.toLowerCase()}@${domain}`;
}

function preprocessText(text) {
  if (!text) return "";
  return String(text)
    .replace(/(https?:\/\/)\s*\|\s*/gi, "$1")
    .replace(/(https?:\/\/)\s+/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function extractCandidatesFromText(text, fieldName) {
  const s = preprocessText(text);
  if (!s) return [];

  const out = [];

  for (const m of s.matchAll(ACCT_RE)) {
    const candidate = normalizeCandidate(`${m[1]}@${m[2]}`);
    if (!candidate) continue;
    out.push({
      mastodon_handle: candidate,
      source: `acct_in_${fieldName}`,
      evidence: m[0],
    });
  }

  for (const m of s.matchAll(URL_HANDLE_RE)) {
    const candidate = normalizeCandidate(`${m[2]}@${m[1]}`);
    if (!candidate) continue;
    out.push({
      mastodon_handle: candidate,
      source: `url_in_${fieldName}`,
      evidence: m[0],
    });
  }

  return out;
}

async function verifyWebfinger(handle) {
  const [local, domain] = handle.split("@");
  const resource = encodeURIComponent(`acct:${local}@${domain}`);
  const url = `https://${domain}/.well-known/webfinger?resource=${resource}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "x2masto/0.1.0",
        Accept: "application/jrd+json, application/json;q=0.9, */*;q=0.1",
      },
      redirect: "follow",
    });
    if (!res.ok) return false;
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (!ctype.includes("json") && !ctype.includes("jrd")) return false;
    await res.json();
    return true;
  } catch {
    return false;
  }
}

async function verifyHandles(handles, workers = 8) {
  const unique = [...new Set(handles)].sort();
  const results = new Map();

  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx;
      idx += 1;
      if (i >= unique.length) break;
      const h = unique[i];
      const ok = await verifyWebfinger(h);
      results.set(h, ok);
    }
  }

  const threads = Array.from({ length: Math.max(1, workers) }, () => worker());
  await Promise.all(threads);
  return results;
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

async function ensureParent(p) {
  await fs.mkdir(path.dirname(p), { recursive: true });
}

async function writeMatchesCsv(pathOut, rows) {
  const header = [
    "X handle",
    "X display name",
    "Mastodon handle",
    "Source",
    "Verified",
    "Evidence",
  ];

  const sorted = [...rows].sort((a, b) => {
    const ah = (a.mastodon_handle || "").localeCompare(b.mastodon_handle || "");
    if (ah !== 0) return ah;
    return (a.x_handle || "").localeCompare(b.x_handle || "");
  });

  const lines = [header.join(",")];
  for (const r of sorted) {
    lines.push(
      [
        r.x_handle,
        r.x_display_name,
        r.mastodon_handle,
        r.source,
        r.verified,
        r.evidence,
      ]
        .map(csvEscape)
        .join(","),
    );
  }

  await ensureParent(pathOut);
  await fs.writeFile(pathOut, `${lines.join("\n")}\n`, "utf-8");
}

async function writeImportCsv(pathOut, handles) {
  const uniq = [...new Set(handles)].sort((a, b) => a.localeCompare(b));
  const lines = [
    "Account address,Show boosts,Notify on new posts,Languages",
    ...uniq.map((h) => `${csvEscape(h)},true,false,`),
  ];
  await ensureParent(pathOut);
  await fs.writeFile(pathOut, `${lines.join("\n")}\n`, "utf-8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage().trim());
    return;
  }

  const inputPath = args.input || "data/x-following-raw.jsonl";
  const matchesOut = args["matches-output"] || "data/x-matches.csv";
  const importOut = args["import-output"] || "data/x-mastodon-import.csv";
  const verify = Boolean(args.verify);
  const verifyWorkers = toInt(args["verify-workers"], 8);

  const raw = await fs.readFile(inputPath, "utf-8");
  const rows = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const matches = [];

  for (const row of rows) {
    const xHandle = (row.handle || "").trim();
    const xDisplayName = (row.display_name || "").trim();

    const extracted = [
      ...extractCandidatesFromText(row.bio, "bio"),
      ...extractCandidatesFromText(row.display_name, "display_name"),
      ...extractCandidatesFromText(row.raw_text, "raw_text"),
      ...extractCandidatesFromText(row.external_links, "external_links"),
      ...extractCandidatesFromText(row.raw_links, "raw_links"),
    ];

    const seenForUser = new Set();
    for (const c of extracted) {
      const key = `${c.mastodon_handle}|${c.source}`;
      if (seenForUser.has(key)) continue;
      seenForUser.add(key);

      matches.push({
        x_handle: xHandle,
        x_display_name: xDisplayName,
        mastodon_handle: c.mastodon_handle,
        source: c.source,
        evidence: c.evidence,
        verified: "skipped",
      });
    }
  }

  if (verify && matches.length > 0) {
    const handles = matches.map((m) => m.mastodon_handle);
    console.log(`Verifying ${new Set(handles).size} unique handles with ${verifyWorkers} workers...`);
    const verifiedMap = await verifyHandles(handles, verifyWorkers);
    for (const m of matches) {
      m.verified = verifiedMap.get(m.mastodon_handle) ? "yes" : "no";
    }
  }

  await writeMatchesCsv(matchesOut, matches);

  const importable = matches
    .filter((m) => m.verified !== "no")
    .map((m) => m.mastodon_handle);
  await writeImportCsv(importOut, importable);

  console.log(`Scanned rows: ${rows.length}`);
  console.log(`Matches found: ${matches.length}`);
  console.log(`Unique handles: ${new Set(matches.map((m) => m.mastodon_handle)).size}`);
  console.log(`Importable handles: ${new Set(importable).size}`);
  console.log(`Wrote matches: ${matchesOut}`);
  console.log(`Wrote import: ${importOut}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
