#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) continue;
    if (t === "--help" || t === "-h") {
      args.help = true;
      continue;
    }
    const key = t.slice(2);
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
search_mastodon_from_x_profiles.mjs

Search Mastodon accounts using scraped X profile data (handle/name), verify
via WebFinger, and output an additional import CSV.

Usage:
  node scripts/search_mastodon_from_x_profiles.mjs

Options:
  --x-raw <path>                 Input raw X JSONL (default: data/x-following-raw.jsonl)
  --known-import <path>          Existing verified import CSV to avoid duplicates
                                 (default: data/x-mastodon-import.csv)
  --matches-output <path>        Output search matches CSV
                                 (default: data/x-search-matches.csv)
  --import-output <path>         Output search-only import CSV
                                 (default: data/x-mastodon-import-search.csv)
  --combined-output <path>       Output combined import CSV
                                 (default: data/x-mastodon-import-combined.csv)
  --instances <csv>              Search instances
                                 (default: mastodon.social,hachyderm.io,fosstodon.org)
  --token <token>                Default Bearer token used for all instances
  --tokens-file <path>           JSON file mapping instance->token
                                 Example: {"mastodon.social":"...","hachyderm.io":"..."}
                                 Env fallback: MASTODON_TOKEN and
                                 MASTODON_TOKEN_<INSTANCE>
  --workers <n>                  Parallel workers (default: 3)
  --max-accounts <n>             Max X accounts to process (default: 500)
  --min-score <n>                Minimum score to accept candidate (default: 80)
  --include-name-search          Also search by display name (slower)
  --request-timeout-ms <n>       Search request timeout (default: 10000)
  --retry-429 <n>                Retry count after HTTP 429 (default: 3)
  --backoff-base-ms <n>          Initial backoff on 429 (default: 1500)
  --backoff-max-ms <n>           Max backoff on 429 (default: 60000)
  --backoff-jitter-ms <n>        Random jitter added to backoff (default: 750)
  --max-account-ms <n>           Max time spent per X account before skipping (default: 45000)
  --progress-every <n>           Emit detailed progress every N accounts (default: 25)
  --heartbeat-ms <n>             Emit heartbeat even without progress (default: 15000)
  --help                         Show this help
`;
}

function toInt(v, fallback) {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function envTokenKeyForInstance(instance) {
  return `MASTODON_TOKEN_${String(instance || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")}`;
}

async function loadTokensMap(instances, defaultToken = "", tokensFile = "") {
  const map = new Map();

  const globalEnvToken = process.env.MASTODON_TOKEN || "";

  if (defaultToken) {
    for (const inst of instances) map.set(inst, defaultToken);
  } else if (globalEnvToken) {
    for (const inst of instances) map.set(inst, globalEnvToken);
  }

  if (tokensFile) {
    try {
      const txt = await fs.readFile(tokensFile, "utf-8");
      const obj = JSON.parse(txt);
      if (obj && typeof obj === "object") {
        for (const [inst, tok] of Object.entries(obj)) {
          if (tok) map.set(inst, String(tok));
        }
      }
    } catch (e) {
      throw new Error(`Unable to read --tokens-file: ${e.message}`);
    }
  }

  for (const inst of instances) {
    const envKey = envTokenKeyForInstance(inst);
    if (process.env[envKey]) map.set(inst, process.env[envKey]);
  }

  return map;
}

async function ensureParent(p) {
  await fs.mkdir(path.dirname(p), { recursive: true });
}

function normalizeText(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(s) {
  return new Set(normalizeText(s).split(/\s+/).filter(Boolean));
}

function overlapScore(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit += 1;
  const j = hit / (ta.size + tb.size - hit);
  return Math.round(j * 25);
}

function parseCanonicalHandle(account, fallbackInstance) {
  const acctRaw = String(account?.acct || account?.username || "").trim().replace(/^@+/, "");
  const urlRaw = String(account?.url || "").trim();

  let local = "";
  let domain = "";

  if (acctRaw.includes("@")) {
    const [l, d] = acctRaw.split("@");
    local = (l || "").trim();
    domain = (d || "").trim().toLowerCase();
  } else {
    local = acctRaw;
  }

  if (!domain && urlRaw) {
    try {
      domain = new URL(urlRaw).hostname.toLowerCase();
    } catch {
      // ignore
    }
  }

  if (!domain) domain = String(fallbackInstance || "").toLowerCase();

  if (!local || !domain) return null;
  if (!/^[a-z0-9_][a-z0-9._-]{0,100}$/i.test(local)) return null;
  if (!/^[a-z0-9.-]+$/i.test(domain)) return null;
  if (!domain.includes(".")) return null;

  return `${local.toLowerCase()}@${domain.toLowerCase()}`;
}

function scoreCandidate(xRow, account, canonical) {
  const xHandle = String(xRow.handle || "").toLowerCase();
  const xDisplay = String(xRow.display_name || "");

  const acctRaw = String(account?.acct || account?.username || "").replace(/^@+/, "");
  const local = (acctRaw.split("@")[0] || "").toLowerCase();
  const candDisplay = String(account?.display_name || "");
  const candNote = String(account?.note || "");
  const candUrl = String(account?.url || "");

  let score = 0;
  const reasons = [];

  if (local && xHandle && local === xHandle) {
    score += 70;
    reasons.push("localpart_exact_handle");
  } else if (local && xHandle && (local.startsWith(xHandle) || xHandle.startsWith(local))) {
    score += 35;
    reasons.push("localpart_prefix_handle");
  }

  const dispOverlap = overlapScore(xDisplay, candDisplay);
  if (dispOverlap > 0) {
    score += dispOverlap;
    reasons.push(`display_overlap_${dispOverlap}`);
  }

  const noteOverlap = overlapScore(xDisplay, candNote);
  if (noteOverlap > 0) {
    score += Math.min(12, noteOverlap);
    reasons.push(`note_overlap_${Math.min(12, noteOverlap)}`);
  }

  if (xHandle && candUrl.toLowerCase().includes(`/@${xHandle}`)) {
    score += 12;
    reasons.push("profile_url_contains_handle");
  }

  if (canonical?.startsWith(`${xHandle}@`)) {
    score += 8;
    reasons.push("canonical_starts_with_handle");
  }

  if (account?.bot) {
    score -= 8;
    reasons.push("bot_penalty");
  }

  return { score, reasons: reasons.join("|") };
}

async function searchAccounts(instance, query, timeoutMs, token = "") {
  const url = new URL(`https://${instance}/api/v2/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("type", "accounts");
  url.searchParams.set("resolve", token ? "true" : "false");
  url.searchParams.set("limit", "8");

  const headers = {
    "User-Agent": "x2masto/0.1.0",
    Accept: "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const retryAfterRaw = res.headers.get("retry-after") || "";
    const retryAfterSecParsed = Number.parseInt(retryAfterRaw, 10);
    const retryAfterSec = Number.isFinite(retryAfterSecParsed) ? retryAfterSecParsed : 0;

    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: body?.error || "",
        retryAfterSec,
        accounts: [],
      };
    }

    const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
    return { ok: true, status: res.status, error: "", retryAfterSec, accounts };
  } catch {
    return { ok: false, status: 0, error: "network_error", retryAfterSec: 0, accounts: [] };
  }
}

async function verifyWebfinger(handle) {
  const [local, domain] = handle.split("@");
  const resource = encodeURIComponent(`acct:${local}@${domain}`);
  const url = `https://${domain}/.well-known/webfinger?resource=${resource}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "x2masto/0.1.0",
        Accept: "application/jrd+json, application/json;q=0.9, */*;q=0.1",
      },
      signal: AbortSignal.timeout(10000),
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

async function readJsonl(p) {
  const text = await fs.readFile(p, "utf-8");
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function readKnownHandlesFromImportCsv(p) {
  try {
    const text = await fs.readFile(p, "utf-8");
    const lines = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (lines.length <= 1) return new Set();
    const set = new Set();
    for (let i = 1; i < lines.length; i++) {
      const first = lines[i].split(",")[0].trim().replace(/^"|"$/g, "").toLowerCase();
      if (first && first.includes("@")) set.add(first);
    }
    return set;
  } catch {
    return new Set();
  }
}

async function writeMatchesCsv(p, rows) {
  const header = [
    "X handle",
    "X display name",
    "Query",
    "Instance",
    "Matched Mastodon handle",
    "Matched display name",
    "Matched acct raw",
    "Matched URL",
    "Score",
    "Verified",
    "Reasons",
  ];

  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.x_handle,
        r.x_display_name,
        r.query,
        r.instance,
        r.mastodon_handle,
        r.mastodon_display_name,
        r.mastodon_acct_raw,
        r.mastodon_url,
        r.score,
        r.verified,
        r.reasons,
      ]
        .map(csvEscape)
        .join(","),
    );
  }

  await ensureParent(p);
  await fs.writeFile(p, `${lines.join("\n")}\n`, "utf-8");
}

async function writeImportCsv(p, handles) {
  const uniq = [...new Set(handles.map((h) => h.toLowerCase()))].sort((a, b) => a.localeCompare(b));
  const lines = [
    "Account address,Show boosts,Notify on new posts,Languages",
    ...uniq.map((h) => `${csvEscape(h)},true,false,`),
  ];
  await ensureParent(p);
  await fs.writeFile(p, `${lines.join("\n")}\n`, "utf-8");
  return uniq;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage().trim());
    return;
  }

  const xRawPath = args["x-raw"] || "data/x-following-raw.jsonl";
  const knownImportPath = args["known-import"] || "data/x-mastodon-import.csv";
  const matchesOut = args["matches-output"] || "data/x-search-matches.csv";
  const importOut = args["import-output"] || "data/x-mastodon-import-search.csv";
  const combinedOut = args["combined-output"] || "data/x-mastodon-import-combined.csv";
  const instances = String(args.instances || "mastodon.social,hachyderm.io,fosstodon.org")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const defaultToken = String(args.token || "").trim();
  const tokensFile = String(args["tokens-file"] || "").trim();
  const workers = toInt(args.workers, 3);
  const maxAccounts = toInt(args["max-accounts"], 500);
  const minScore = toInt(args["min-score"], 80);
  const includeNameSearch = Boolean(args["include-name-search"]);
  const requestTimeoutMs = toInt(args["request-timeout-ms"], 10000);
  const retry429 = toInt(args["retry-429"], 3);
  const backoffBaseMs = toInt(args["backoff-base-ms"], 1500);
  const backoffMaxMs = toInt(args["backoff-max-ms"], 60000);
  const backoffJitterMs = toInt(args["backoff-jitter-ms"], 750);
  const maxAccountMs = Math.max(1000, toInt(args["max-account-ms"], 45000));
  const progressEvery = Math.max(1, toInt(args["progress-every"], 25));
  const heartbeatMs = Math.max(1000, toInt(args["heartbeat-ms"], 15000));

  if (instances.length === 0) throw new Error("No instances configured");

  const tokensByInstance = await loadTokensMap(instances, defaultToken, tokensFile);
  const knownHandles = await readKnownHandlesFromImportCsv(knownImportPath);
  const xRows = await readJsonl(xRawPath);

  const accounts = xRows
    .filter((r) => r?.handle)
    .map((r) => ({
      handle: String(r.handle || "").trim(),
      display_name: String(r.display_name || "").trim(),
      bio: String(r.bio || "").trim(),
    }))
    .filter((r) => r.handle.length >= 2)
    .slice(0, maxAccounts);

  const authedInstances = instances.filter((i) => Boolean(tokensByInstance.get(i)));

  console.log(`Loaded X accounts: ${xRows.length}`);
  console.log(`Processing accounts: ${accounts.length}`);
  console.log(`Known existing handles: ${knownHandles.size}`);
  console.log(`Instances: ${instances.join(", ")}`);
  console.log(`Authenticated instances: ${authedInstances.length}/${instances.length}`);
  console.log(
    `429 backoff: retry=${retry429}, base=${backoffBaseMs}ms, max=${backoffMaxMs}ms, jitter<=${backoffJitterMs}ms`,
  );
  console.log(`Per-account timeout: ${maxAccountMs}ms`);
  console.log(`Progress: every=${progressEvery} accounts, heartbeat=${heartbeatMs}ms`);
  if (authedInstances.length === 0) {
    console.log("WARNING: no authenticated instances configured. Remote resolve search may be limited.");
  }

  const verifyCache = new Map();
  const results = [];
  const foundSearchHandles = new Set();

  const stats = {
    startedAt: Date.now(),
    processed: 0,
    requests: 0,
    requestsOk: 0,
    requestsEmpty: 0,
    requestsFailed: 0,
    retry429Count: 0,
    backoffWaitMs: 0,
    statusCounts: new Map(),
    errorCounts: new Map(),
    accountsNoBest: 0,
    accountsBelowScore: 0,
    accountsTimedOut: 0,
    accountsVerifiedNo: 0,
    accountsKnownDuplicate: 0,
    accountsNewVerified: 0,
  };

  const instanceStates = new Map(
    instances.map((inst) => [
      inst,
      {
        backoffMs: 0,
        nextAllowedAt: 0,
        consecutive429: 0,
      },
    ]),
  );
  const instanceQueues = new Map();

  let index = 0;
  let completed = 0;
  let lastProgress = null;
  let lastCompletedAt = Date.now();

  function incMap(map, key, delta = 1) {
    map.set(key, (map.get(key) || 0) + delta);
  }

  function topEntries(map, n = 4) {
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${k}:${v}`)
      .join(", ");
  }

  function snapshot() {
    return {
      processed: stats.processed,
      requests: stats.requests,
      requestsOk: stats.requestsOk,
      requestsEmpty: stats.requestsEmpty,
      requestsFailed: stats.requestsFailed,
      retry429Count: stats.retry429Count,
      backoffWaitMs: stats.backoffWaitMs,
      status429: stats.statusCounts.get("429") || 0,
      matches: results.length,
      acceptedNew: stats.accountsNewVerified,
      accountsNoBest: stats.accountsNoBest,
      accountsBelowScore: stats.accountsBelowScore,
      accountsTimedOut: stats.accountsTimedOut,
      accountsVerifiedNo: stats.accountsVerifiedNo,
      accountsKnownDuplicate: stats.accountsKnownDuplicate,
    };
  }

  function printProgress() {
    const snap = snapshot();
    const elapsedSec = Math.max(1, (Date.now() - stats.startedAt) / 1000);
    const acctRate = (snap.processed / elapsedSec).toFixed(2);
    const reqRate = (snap.requests / elapsedSec).toFixed(2);

    console.log(
      `progress ${snap.processed}/${accounts.length} | matches=${snap.matches} | accepted_new=${snap.acceptedNew} | req=${snap.requests} (ok=${snap.requestsOk}, empty=${snap.requestsEmpty}, fail=${snap.requestsFailed}, 429=${snap.status429}, retries=${snap.retry429Count}) | wait=${(snap.backoffWaitMs / 1000).toFixed(1)}s | no_best=${snap.accountsNoBest} | below_score=${snap.accountsBelowScore} | timed_out=${snap.accountsTimedOut} | dup=${snap.accountsKnownDuplicate} | unverified=${snap.accountsVerifiedNo} | rate=${acctRate} acct/s ${reqRate} req/s`,
    );

    if (lastProgress) {
      const dProcessed = snap.processed - lastProgress.processed;
      const dReq = snap.requests - lastProgress.requests;
      const dMatches = snap.matches - lastProgress.matches;
      const dAccepted = snap.acceptedNew - lastProgress.acceptedNew;
      const dRetry429 = snap.retry429Count - lastProgress.retry429Count;
      const dWaitMs = snap.backoffWaitMs - lastProgress.backoffWaitMs;
      const dNoBest = snap.accountsNoBest - lastProgress.accountsNoBest;
      const dBelow = snap.accountsBelowScore - lastProgress.accountsBelowScore;
      const dTimedOut = snap.accountsTimedOut - lastProgress.accountsTimedOut;
      const dDup = snap.accountsKnownDuplicate - lastProgress.accountsKnownDuplicate;
      const dUnver = snap.accountsVerifiedNo - lastProgress.accountsVerifiedNo;

      console.log(
        `  window +${dProcessed} acct | +${dReq} req | +${dMatches} matches | +${dAccepted} accepted | +${dRetry429} retry429 | +${(dWaitMs / 1000).toFixed(1)}s wait | +${dNoBest} no_best | +${dBelow} below_score | +${dTimedOut} timed_out | +${dDup} dup | +${dUnver} unverified`,
      );
    }

    if (stats.requestsFailed > 0) {
      const statusTop = topEntries(stats.statusCounts);
      const errorTop = topEntries(stats.errorCounts);
      if (statusTop) console.log(`  fail_statuses: ${statusTop}`);
      if (errorTop) console.log(`  fail_errors: ${errorTop}`);
    }

    lastProgress = snap;
  }

  function printHeartbeat() {
    const elapsedSec = Math.max(1, (Date.now() - stats.startedAt) / 1000);
    const inFlight = Math.max(0, index - completed);
    const idleSec = ((Date.now() - lastCompletedAt) / 1000).toFixed(1);
    const statusTop = topEntries(stats.statusCounts);

    const now = Date.now();
    const waits = [...instanceStates.entries()]
      .map(([inst, st]) => ({ inst, waitMs: Math.max(0, (st?.nextAllowedAt || 0) - now), b: st?.backoffMs || 0, c429: st?.consecutive429 || 0 }))
      .filter((x) => x.waitMs > 0 || x.c429 > 0)
      .sort((a, b) => b.waitMs - a.waitMs)
      .slice(0, 3)
      .map((x) => `${x.inst}:wait=${(x.waitMs / 1000).toFixed(1)}s,backoff=${(x.b / 1000).toFixed(1)}s,c429=${x.c429}`)
      .join(" | ");

    console.log(
      `heartbeat ${completed}/${accounts.length} | in_flight=${inFlight} | idle=${idleSec}s | req=${stats.requests} (ok=${stats.requestsOk}, empty=${stats.requestsEmpty}, fail=${stats.requestsFailed}, 429=${stats.statusCounts.get("429") || 0}) | retries=${stats.retry429Count} | wait=${(stats.backoffWaitMs / 1000).toFixed(1)}s | rate=${(completed / elapsedSec).toFixed(2)} acct/s`,
    );

    if (waits) {
      console.log(`  heartbeat_instance_backoff: ${waits}`);
    }

    if (statusTop) {
      console.log(`  heartbeat_fail_statuses: ${statusTop}`);
    }
  }

  const heartbeatTimer = setInterval(() => {
    if (completed >= accounts.length) return;
    printHeartbeat();
  }, heartbeatMs);

  async function runOnInstanceQueue(instance, fn) {
    const prev = instanceQueues.get(instance) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(fn)
      .finally(() => {
        if (instanceQueues.get(instance) === next) {
          instanceQueues.delete(instance);
        }
      });
    instanceQueues.set(instance, next);
    return next;
  }

  async function searchAccountsWithBackoff(instance, query, token, deadlineTs = 0) {
    return runOnInstanceQueue(instance, async () => {
      const trace = [];
      let waitedMs = 0;

      for (let attempt = 0; attempt <= retry429; attempt += 1) {
        const state = instanceStates.get(instance) || {
          backoffMs: 0,
          nextAllowedAt: 0,
          consecutive429: 0,
        };

        let now = Date.now();
        if (deadlineTs > 0 && now >= deadlineTs) {
          const timeoutRes = { ok: false, status: -1, error: "account_deadline", retryAfterSec: 0, accounts: [] };
          return { res: timeoutRes, trace, waitedMs, timedOut: true };
        }

        if (state.nextAllowedAt > now) {
          const delay = state.nextAllowedAt - now;

          if (deadlineTs > 0 && now + delay > deadlineTs) {
            const timeoutRes = { ok: false, status: -1, error: "account_deadline", retryAfterSec: 0, accounts: [] };
            return { res: timeoutRes, trace, waitedMs, timedOut: true };
          }

          waitedMs += delay;
          stats.backoffWaitMs += delay;
          await sleep(delay);
        }

        now = Date.now();
        if (deadlineTs > 0 && now >= deadlineTs) {
          const timeoutRes = { ok: false, status: -1, error: "account_deadline", retryAfterSec: 0, accounts: [] };
          return { res: timeoutRes, trace, waitedMs, timedOut: true };
        }

        const res = await searchAccounts(instance, query, requestTimeoutMs, token);
        trace.push(res);

        if (!(res.status === 429)) {
          if (res.ok) {
            state.consecutive429 = 0;
            state.backoffMs = state.backoffMs > 0 ? Math.floor(state.backoffMs * 0.6) : 0;
            if (state.backoffMs < backoffBaseMs) state.backoffMs = 0;
            state.nextAllowedAt = Date.now();
          }
          instanceStates.set(instance, state);
          return { res, trace, waitedMs, timedOut: false };
        }

        // 429 handling
        state.consecutive429 += 1;
        stats.retry429Count += 1;

        const headerRetryMs = res.retryAfterSec > 0 ? res.retryAfterSec * 1000 : 0;
        const exponentialMs = state.backoffMs > 0 ? Math.min(backoffMaxMs, state.backoffMs * 2) : backoffBaseMs;
        const baseMs = headerRetryMs > 0 ? headerRetryMs : exponentialMs;
        const jitterMs = backoffJitterMs > 0 ? Math.floor(Math.random() * (backoffJitterMs + 1)) : 0;

        state.backoffMs = Math.min(backoffMaxMs, Math.max(backoffBaseMs, baseMs));
        state.nextAllowedAt = Date.now() + state.backoffMs + jitterMs;
        instanceStates.set(instance, state);

        if (attempt >= retry429) {
          return { res, trace, waitedMs, timedOut: false };
        }
      }

      const fallback = { ok: false, status: 0, error: "retry_exhausted", retryAfterSec: 0, accounts: [] };
      return { res: fallback, trace, waitedMs, timedOut: false };
    });
  }

  async function verifyCached(handle) {
    if (!verifyCache.has(handle)) {
      verifyCache.set(handle, await verifyWebfinger(handle));
    }
    return verifyCache.get(handle);
  }

  async function processOne(x) {
    const queries = [x.handle, `@${x.handle}`];
    if (includeNameSearch && x.display_name && normalizeText(x.display_name).length >= 3) {
      queries.push(x.display_name);
    }

    const deadlineTs = Date.now() + maxAccountMs;
    let timedOut = false;
    let best = null;

    outer: for (const q of [...new Set(queries)]) {
      for (const inst of instances) {
        if (Date.now() >= deadlineTs) {
          timedOut = true;
          break outer;
        }

        const token = tokensByInstance.get(inst) || "";
        const wrapped = await searchAccountsWithBackoff(inst, q, token, deadlineTs);
        const res = wrapped.res;

        for (const tr of wrapped.trace) {
          stats.requests += 1;
          if (!tr.ok) {
            stats.requestsFailed += 1;
            incMap(stats.statusCounts, String(tr.status || 0));
            if (tr.error) incMap(stats.errorCounts, String(tr.error));
          } else {
            stats.requestsOk += 1;
            if (tr.accounts.length === 0) stats.requestsEmpty += 1;
          }
        }

        if (wrapped.timedOut || res.error === "account_deadline") {
          timedOut = true;
          break outer;
        }

        if (!res.ok || res.accounts.length === 0) continue;

        for (const account of res.accounts) {
          const canonical = parseCanonicalHandle(account, inst);
          if (!canonical) continue;

          const scored = scoreCandidate(x, account, canonical);
          if (!best || scored.score > best.score) {
            best = {
              x_handle: x.handle,
              x_display_name: x.display_name,
              query: q,
              instance: inst,
              mastodon_handle: canonical,
              mastodon_display_name: String(account.display_name || ""),
              mastodon_acct_raw: String(account.acct || account.username || ""),
              mastodon_url: String(account.url || ""),
              score: scored.score,
              reasons: scored.reasons,
            };
          }
        }
      }
    }

    if (timedOut) {
      stats.accountsTimedOut += 1;
      return null;
    }

    if (!best) {
      stats.accountsNoBest += 1;
      return null;
    }

    if (best.score < minScore) {
      stats.accountsBelowScore += 1;
      return null;
    }

    const verified = await verifyCached(best.mastodon_handle);
    best.verified = verified ? "yes" : "no";

    if (!verified) {
      stats.accountsVerifiedNo += 1;
      return best;
    }

    if (knownHandles.has(best.mastodon_handle.toLowerCase())) {
      stats.accountsKnownDuplicate += 1;
      return best;
    }

    stats.accountsNewVerified += 1;
    foundSearchHandles.add(best.mastodon_handle.toLowerCase());
    return best;
  }

  async function worker() {
    while (true) {
      const i = index;
      index += 1;
      if (i >= accounts.length) break;

      const x = accounts[i];
      const r = await processOne(x);
      if (r) results.push(r);

      completed += 1;
      stats.processed = completed;
      lastCompletedAt = Date.now();

      if (completed % progressEvery === 0 || completed === accounts.length) {
        printProgress();
      }
    }
  }

  const pool = Array.from({ length: Math.max(1, workers) }, () => worker());
  await Promise.all(pool);
  clearInterval(heartbeatTimer);

  const sortedMatches = results.sort((a, b) => b.score - a.score || a.x_handle.localeCompare(b.x_handle));
  await writeMatchesCsv(matchesOut, sortedMatches);

  const newImportHandles = sortedMatches
    .filter((m) => m.verified === "yes")
    .map((m) => m.mastodon_handle)
    .filter((h) => !knownHandles.has(h.toLowerCase()));

  const searchOnly = await writeImportCsv(importOut, newImportHandles);
  const combined = await writeImportCsv(combinedOut, [...knownHandles, ...searchOnly]);

  const verifiedCount = sortedMatches.filter((m) => m.verified === "yes").length;
  console.log("\nDone.");
  console.log(`Search matches: ${sortedMatches.length}`);
  console.log(`Verified matches: ${verifiedCount}`);
  console.log(`New handles for search-only import: ${searchOnly.length}`);
  console.log(`Combined import total handles: ${combined.length}`);
  console.log(`Accounts timed out: ${stats.accountsTimedOut}`);
  console.log(`HTTP 429 retries: ${stats.retry429Count}`);
  console.log(`Total backoff wait: ${(stats.backoffWaitMs / 1000).toFixed(1)}s`);
  console.log(`Wrote matches: ${matchesOut}`);
  console.log(`Wrote search-only import: ${importOut}`);
  console.log(`Wrote combined import: ${combinedOut}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
