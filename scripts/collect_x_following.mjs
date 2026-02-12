#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
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

Scrape visible + scrolled accounts from an X /following page using an already
running Chrome with remote debugging enabled.

Usage:
  node scripts/collect_x_following.mjs --user walterra

Options:
  --user <handle>              X handle (builds https://x.com/<handle>/following)
  --url <url>                  Direct URL override
  --browser-url <url>          Chrome debug URL (default: http://127.0.0.1:9222)
  --csv <path>                 CSV output (default: data/x-following-raw.csv)
  --jsonl <path>               JSONL output (default: data/x-following-raw.jsonl)
  --max-scrolls <n>            Max scroll steps (default: 400)
  --idle-rounds <n>            Stop after n rounds without new users (default: 12)
  --scroll-delay-ms <n>        Delay between scrolls (default: 1000)
  --max-users <n>              Optional hard cap on collected users
  --no-navigate                Use current tab URL, do not navigate
  --help                       Show this help

Example:
  node scripts/collect_x_following.mjs \
    --user walterra \
    --csv data/x-following-raw.csv \
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
  const maxScrolls = toInt(args["max-scrolls"], 400);
  const idleRoundsLimit = toInt(args["idle-rounds"], 12);
  const scrollDelayMs = toInt(args["scroll-delay-ms"], 1000);
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

    console.log("Waiting for follow cards...");
    await page.waitForSelector('[data-testid="UserCell"]', { timeout: 120_000 });

    let idleRounds = 0;
    let scrolls = 0;

    while (scrolls < maxScrolls) {
      const now = new Date().toISOString();
      const before = seen.size;

      const snapshot = await page.evaluate(() => {
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

        const users = [...document.querySelectorAll('[data-testid="UserCell"]')].map((cell) => {
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

        const scroller = document.scrollingElement || document.documentElement;
        const metrics = {
          cell_count: users.length,
          scroll_top: scroller.scrollTop,
          scroll_height: scroller.scrollHeight,
          client_height: scroller.clientHeight,
          at_bottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4,
        };

        return { users, metrics };
      });

      for (const userRow of snapshot.users) {
        const key = keyForUser(userRow);
        const merged = mergeUser(seen.get(key), userRow, now);
        seen.set(key, merged);
      }

      const after = seen.size;
      const delta = after - before;

      if (delta === 0) {
        idleRounds += 1;
      } else {
        idleRounds = 0;
      }

      console.log(
        `scroll=${scrolls} cards=${snapshot.metrics.cell_count} unique=${after} (+${delta}) idle=${idleRounds}/${idleRoundsLimit}`,
      );

      if (maxUsers > 0 && after >= maxUsers) {
        console.log(`Reached --max-users=${maxUsers}, stopping.`);
        break;
      }

      if (idleRounds >= idleRoundsLimit) {
        console.log("No new users for too many rounds, stopping.");
        break;
      }

      await page.evaluate(() => {
        const amount = Math.floor(window.innerHeight * 0.92);
        window.scrollBy(0, amount);
      });

      scrolls += 1;
      await new Promise((r) => setTimeout(r, scrollDelayMs));
    }

    const users = [...seen.values()].filter((u) => u.handle || u.display_name || u.raw_text);
    await writeOutputs(users, csvPath, jsonlPath, runStartedAt);

    console.log(`\nDone.`);
    console.log(`Users collected: ${users.length}`);
    console.log(`CSV:   ${csvPath}`);
    console.log(`JSONL: ${jsonlPath}`);
  } finally {
    await browser.disconnect();
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
