#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import puppeteer from "puppeteer-core";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;

    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function usage() {
  return `
collect_x_following.mjs

Collect visible accounts from an X /following page while you browse manually.
The script connects to a running Chrome instance and passively reads profile
cards as you scroll through your following list.

Usage:
  node scripts/collect_x_following.mjs --user walterra

Options:
  --user <handle>              X handle (builds https://x.com/<handle>/following)
  --url <url>                  Direct URL override
  --browser-url <url>          Chrome debug URL (default: http://127.0.0.1:9222)
  --csv <path>                 CSV output (default: data/x-following-raw.csv)
  --jsonl <path>               JSONL output (default: data/x-following-raw.jsonl)
  --poll-interval-ms <n>       How often to read visible cards (default: 500)
  --max-users <n>              Optional hard cap on collected users
  --no-navigate                Use current tab URL, do not navigate
  --help                       Show this help

How it works:
  1. Start Chrome with remote debugging (see README).
  2. Log into x.com in that Chrome window.
  3. Run this script — it opens your /following page.
  4. Scroll through the list at your own pace.
  5. The script passively reads whatever profile cards are visible.
  6. Press Enter when you're done. The script saves collected data.

Example:
  node scripts/collect_x_following.mjs \\
    --user walterra \\
    --csv data/x-following-raw.csv \\
    --jsonl data/x-following-raw.jsonl
`;
}

function toInt(v, fallback) {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function mergeUser(existing, incoming, now) {
  if (!existing) {
    return {
      ...incoming,
      first_seen_at: now,
      last_seen_at: now,
    };
  }

  const merged = { ...existing };
  merged.last_seen_at = now;

  for (const field of ["display_name", "bio", "external_links", "raw_text", "raw_links"]) {
    const oldVal = existing[field] || "";
    const newVal = incoming[field] || "";
    if (newVal.length > oldVal.length) merged[field] = newVal;
  }

  for (const field of ["profile_url", "handle"]) {
    if (!merged[field] && incoming[field]) merged[field] = incoming[field];
  }

  merged.follows_you = existing.follows_you || incoming.follows_you;
  merged.is_following = existing.is_following || incoming.is_following;

  return merged;
}

function keyForUser(user) {
  if (user.handle) return `h:${user.handle.toLowerCase()}`;
  if (user.profile_url) return `u:${user.profile_url}`;
  return `r:${user.raw_text}`;
}

async function ensureParentDir(filePath) {
  const parent = path.dirname(filePath);
  await fs.mkdir(parent, { recursive: true });
}

async function writeOutputs(users, csvPath, jsonlPath, runStartedAt) {
  const headers = [
    "handle",
    "display_name",
    "bio",
    "profile_url",
    "external_links",
    "follows_you",
    "is_following",
    "raw_text",
    "raw_links",
    "first_seen_at",
    "last_seen_at",
    "collected_run_started_at",
  ];

  const sorted = [...users].sort((a, b) => {
    const ah = (a.handle || "").toLowerCase();
    const bh = (b.handle || "").toLowerCase();
    if (ah !== bh) return ah.localeCompare(bh);
    return (a.display_name || "").localeCompare(b.display_name || "");
  });

  const csvLines = [headers.join(",")];
  for (const u of sorted) {
    const row = [
      u.handle,
      u.display_name,
      u.bio,
      u.profile_url,
      u.external_links,
      u.follows_you,
      u.is_following,
      u.raw_text,
      u.raw_links,
      u.first_seen_at,
      u.last_seen_at,
      runStartedAt,
    ].map(csvEscape);
    csvLines.push(row.join(","));
  }

  const jsonl = sorted
    .map((u) =>
      JSON.stringify({
        ...u,
        collected_run_started_at: runStartedAt,
      }),
    )
    .join("\n");

  await ensureParentDir(csvPath);
  await ensureParentDir(jsonlPath);
  await fs.writeFile(csvPath, `${csvLines.join("\n")}\n`, "utf-8");
  await fs.writeFile(jsonlPath, jsonl ? `${jsonl}\n` : "", "utf-8");
}

function extractVisibleUsers() {
  const noise = new Set([
    "Follow",
    "Following",
    "Follows you",
    "Subscribe",
    "Subscribed",
    "Pending",
    "Blocked",
    "Unblock",
    "Accept",
    "Requested",
  ]);

  const normalizeSpace = (s) => s.replace(/\s+/g, " ").trim();

  return [...document.querySelectorAll('[data-testid="UserCell"]')].map((cell) => {
    const lines = cell.innerText
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);

    const links = [...new Set([...cell.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter(Boolean))];

    const mention = lines.find((l) => /^@[A-Za-z0-9_]{1,15}$/.test(l)) || "";
    const handleFromMention = mention ? mention.slice(1) : "";

    const handlePath =
      links.find((h) => /^\/[A-Za-z0-9_]{1,15}$/.test(h)) ||
      "";

    const avatarTestId =
      cell.querySelector('[data-testid^="UserAvatar-Container-"]')?.getAttribute('data-testid') ||
      "";
    const handleFromTestId = avatarTestId.startsWith("UserAvatar-Container-")
      ? avatarTestId.replace("UserAvatar-Container-", "")
      : "";

    const handle = handleFromMention || (handlePath ? handlePath.slice(1) : "") || handleFromTestId;

    const displayName = lines[0] || "";

    const bio = normalizeSpace(
      lines
        .filter((l) => !noise.has(l))
        .filter((l) => l !== displayName)
        .filter((l) => l !== mention)
        .filter((l) => !/^@[A-Za-z0-9_]{1,15}$/.test(l))
        .join(" "),
    );

    const profilePath = handle ? `/${handle}` : handlePath;
    const profileUrl = profilePath ? `https://x.com${profilePath}` : "";

    const externalLinks = links.filter((h) => /^https?:\/\//.test(h)).join(" | ");

    return {
      handle,
      display_name: displayName,
      bio,
      profile_url: profileUrl,
      external_links: externalLinks,
      follows_you: lines.includes("Follows you"),
      is_following: lines.includes("Following"),
      raw_text: lines.join(" | "),
      raw_links: links.join(" | "),
    };
  });
}

function injectOverlay() {
  const existing = document.getElementById("x2masto-overlay");
  if (existing) return;

  const el = document.createElement("div");
  el.id = "x2masto-overlay";
  Object.assign(el.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    zIndex: "2147483647",
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: "13px",
    fontWeight: "500",
    lineHeight: "1",
    padding: "10px 14px",
    borderRadius: "10px",
    color: "#fff",
    background: "rgba(30, 30, 30, 0.92)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    boxShadow: "0 2px 12px rgba(0,0,0,0.25)",
    transition: "background 0.2s ease, opacity 0.2s ease",
    pointerEvents: "none",
    userSelect: "none",
    display: "flex",
    alignItems: "center",
    gap: "8px",
  });

  const dot = document.createElement("span");
  dot.id = "x2masto-dot";
  Object.assign(dot.style, {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: "#facc15",
    flexShrink: "0",
    transition: "background 0.2s ease",
  });

  const label = document.createElement("span");
  label.id = "x2masto-label";
  label.textContent = "x2masto: connecting…";

  el.appendChild(dot);
  el.appendChild(label);
  document.body.appendChild(el);
}

function updateOverlay(state, count) {
  const dot = document.getElementById("x2masto-dot");
  const label = document.getElementById("x2masto-label");
  if (!dot || !label) return;

  if (state === "reading") {
    dot.style.background = "#facc15";
    label.textContent = `reading… (${count} collected)`;
  } else if (state === "ready") {
    dot.style.background = "#4ade80";
    label.textContent = `✓ scroll for more (${count} collected)`;
  } else if (state === "done") {
    dot.style.background = "#60a5fa";
    label.textContent = `done — ${count} profiles saved`;
  }
}

function removeOverlay() {
  const el = document.getElementById("x2masto-overlay");
  if (el) el.remove();
}

function waitForEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("", () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage().trim());
    return;
  }

  const browserUrl = args["browser-url"] || "http://127.0.0.1:9222";
  const user = args.user ? String(args.user).replace(/^@/, "") : "";
  const url = args.url || (user ? `https://x.com/${user}/following` : "");
  const csvPath = args.csv || "data/x-following-raw.csv";
  const jsonlPath = args.jsonl || "data/x-following-raw.jsonl";
  const pollIntervalMs = toInt(args["poll-interval-ms"], 500);
  const maxUsers = args["max-users"] ? toInt(args["max-users"], 0) : 0;
  const noNavigate = Boolean(args["no-navigate"]);

  if (!url && !noNavigate) {
    throw new Error("Please provide --user or --url (or use --no-navigate)");
  }

  const runStartedAt = new Date().toISOString();
  const seen = new Map();

  const browser = await puppeteer.connect({
    browserURL: browserUrl,
    defaultViewport: null,
  });

  let stopRequested = false;

  try {
    const pages = await browser.pages();
    const page = pages.at(-1);
    if (!page) throw new Error("No active browser tab found");

    if (!noNavigate && url) {
      console.log(`Navigating to ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded" });
    } else {
      console.log(`Using current tab: ${page.url()}`);
    }

    console.log("Waiting for follow cards to appear...");
    await page.waitForSelector('[data-testid="UserCell"]', { timeout: 120_000 });

    // Inject the in-browser status overlay
    await page.evaluate(injectOverlay);

    console.log("");
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║  Ready! Scroll through your following list in the browser.  ║");
    console.log("║  This script passively reads visible profile cards.         ║");
    console.log("║  A status badge in the browser shows when to scroll.        ║");
    console.log("║                                                             ║");
    console.log("║  Press Enter here when you're done.                         ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log("");

    // Start the "wait for Enter" promise
    const enterPromise = waitForEnter().then(() => {
      stopRequested = true;
    });

    // Also stop on Ctrl+C gracefully
    process.on("SIGINT", () => {
      stopRequested = true;
    });

    // Polling loop — passively reads visible cards without scrolling
    while (!stopRequested) {
      const now = new Date().toISOString();
      const before = seen.size;

      await page.evaluate(updateOverlay, "reading", seen.size);

      const users = await page.evaluate(extractVisibleUsers);

      for (const userRow of users) {
        const key = keyForUser(userRow);
        const merged = mergeUser(seen.get(key), userRow, now);
        seen.set(key, merged);
      }

      const after = seen.size;
      const delta = after - before;

      await page.evaluate(updateOverlay, "ready", after);

      if (delta > 0) {
        console.log(
          `  collected: ${after} unique profiles (+${delta} new)`,
        );
      }

      if (maxUsers > 0 && after >= maxUsers) {
        console.log(`Reached --max-users=${maxUsers}, stopping.`);
        break;
      }

      await Promise.race([
        new Promise((r) => setTimeout(r, pollIntervalMs)),
        enterPromise,
      ]);
    }

    const users = [...seen.values()].filter((u) => u.handle || u.display_name || u.raw_text);

    // Update overlay to "done" before writing files
    await page.evaluate(updateOverlay, "done", users.length).catch(() => {});
    await writeOutputs(users, csvPath, jsonlPath, runStartedAt);

    console.log(`\nDone.`);
    console.log(`Users collected: ${users.length}`);
    console.log(`CSV:   ${csvPath}`);
    console.log(`JSONL: ${jsonlPath}`);
  } finally {
    // Remove the overlay before disconnecting (best-effort)
    try {
      const pages = await browser.pages();
      const page = pages.at(-1);
      if (page) await page.evaluate(removeOverlay);
    } catch {
      // page may already be closed
    }
    await browser.disconnect();
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
