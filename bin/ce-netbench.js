#!/usr/bin/env node
/**
 * ce-netbench — measure CE's network primitives over the real mesh and emit a report.
 *
 *   ce-netbench [--url http://localhost:8844] [--peer <64-hex node id>]... [--out report.md]
 *               [--json report.json] [--quick] [--no-remote] [--pubsub]
 *
 * What it measures (each with p50/p90/p99 + throughput):
 *   - ping floor          transport RTT from /netgraph (libp2p ping)
 *   - rpc_rtt (self)      mesh request/reply on this node (API + serde, no network) = the floor
 *   - rpc_rtt (peer)      mesh request/reply to each peer running ce-echo
 *   - blob put / get      local content-store throughput across payload sizes
 *   - blob get (remote)   cold cross-node fetch (DHT provider lookup + transfer) per peer w/ ce-echo
 *   - concurrency sweep   rpc_rtt @ 1KiB across concurrency 1..64 (saturation behaviour)
 *   - pubsub (optional)   publish -> remote re-publish -> receipt round-trip
 *
 * Peers without ce-echo running are detected (timeout / "did not reply") and reported as skipped,
 * not failed. Requires the node api.token for the mutating probes (auto-loaded; see _env.js).
 */
import { writeFileSync } from "node:fs";
import { CeClient } from "../src/ce.js";
import {
  probeRpcRtt,
  probeBlobPut,
  probeBlobGetLocal,
  probeBlobGetRemote,
  probePubsubProp,
  pingBaseline,
  sweep,
} from "../src/net.js";
import { apiToken, parseArgs } from "./_env.js";

const args = parseArgs(process.argv.slice(2));
const baseUrl = args.url || "http://127.0.0.1:8844";
const token = args.token || apiToken();
const quick = !!args.quick;
const ce = new CeClient({ baseUrl, token, timeoutMs: 60000 });

const KiB = 1024;
const MiB = 1024 * 1024;
const RPC_SIZES = quick ? [64, 4 * KiB] : [64, KiB, 64 * KiB, 256 * KiB];
const BLOB_SIZES = quick ? [4 * KiB, 256 * KiB] : [4 * KiB, 64 * KiB, 1 * MiB, 8 * MiB];
const REMOTE_SIZES = quick ? [256 * KiB] : [256 * KiB, 4 * MiB];
const CONC_LEVELS = quick ? [1, 8] : [1, 4, 16, 64];
const RPC_ITERS = quick ? 30 : 80;
const BLOB_ITERS = quick ? 10 : 25;
const REMOTE_ITERS = quick ? 6 : 12;

const log = (...a) => console.error(...a);

const status = await ce.status().catch((e) => {
  log(`ce-netbench: cannot reach node at ${baseUrl}: ${e.message}`);
  process.exit(1);
});
const self = status.node_id;
log(`ce-netbench: self ${self.slice(0, 12)}... at ${baseUrl} (height ${status.height})`);
if (!token) log("ce-netbench: WARNING no api.token; mutating probes will fail.");

// ---- Peer discovery -------------------------------------------------------
let peers = [];
if (Array.isArray(args.peer)) peers = args.peer;
else if (typeof args.peer === "string") peers = [args.peer];
if (peers.length === 0 && !args["no-remote"]) {
  const atlas = await ce.atlas().catch(() => []);
  peers = atlas.map((p) => p.node_id).filter((id) => id && id !== self);
}
log(peers.length ? `ce-netbench: peers: ${peers.map((p) => p.slice(0, 12)).join(", ")}` : "ce-netbench: no remote peers");

const report = { tool: "ce-netbench", at: new Date().toISOString(), node: self, baseUrl, height: status.height, sections: {} };

// ---- 1. Ping floor --------------------------------------------------------
log("\n[1/6] ping floor (/netgraph)...");
report.sections.ping = await pingBaseline(ce).catch((e) => ({ error: e.message }));

// ---- 2. RPC RTT self (the API+serde floor) --------------------------------
// Needs the node's self-request short-circuit (POST /mesh/request with to == own id). Older node
// binaries route self over the network and "fail to dial self" — detect that and skip cleanly.
log("[2/6] rpc_rtt self (API + serde floor)...");
report.sections.rpc_self = [];
const selfOk = await withInlineResponder(ce, async () => {
  const t = await probeRpcRtt({ ce, to: self, bytes: 64, iters: 3, timeoutMs: 4000 });
  return t.errors < 3;
}).catch(() => false);
if (selfOk) {
  report.sections.rpc_self = await withInlineResponder(ce, () =>
    sweep({ probe: probeRpcRtt, base: { ce, to: self, iters: RPC_ITERS }, sizes: RPC_SIZES, sizeKey: "bytes", onResult: liveRpc }),
  );
} else {
  report.sections.rpc_self = { skipped: true, reason: "node lacks self-request short-circuit (dials self)" };
  log("  self rpc skipped: node routes self-request over the network (no local short-circuit)");
}

// ---- 3. RPC RTT to peers (needs ce-echo on the peer) ----------------------
log("[3/6] rpc_rtt to peers (needs ce-echo running there)...");
report.sections.rpc_peers = {};
for (const peer of peers) {
  const probe = await probeRpcRtt({ ce, to: peer, bytes: 64, iters: 5, timeoutMs: 6000 }).catch((e) => ({ error: e.message }));
  if (probe.error || probe.errors >= 5) {
    report.sections.rpc_peers[peer] = { skipped: true, reason: probe.error || "no reply (ce-echo not running?)" };
    log(`  ${peer.slice(0, 12)}: skipped (${report.sections.rpc_peers[peer].reason})`);
    continue;
  }
  report.sections.rpc_peers[peer] = await sweep({
    probe: probeRpcRtt,
    base: { ce, to: peer, iters: RPC_ITERS, timeoutMs: 15000 },
    sizes: RPC_SIZES,
    sizeKey: "bytes",
    onResult: (r) => liveRpc(r, peer),
  });
}

// ---- 4. Blob put / get local ----------------------------------------------
log("[4/6] blob put + get (local)...");
report.sections.blob_put = await sweep({ probe: probeBlobPut, base: { ce, iters: BLOB_ITERS }, sizes: BLOB_SIZES, onResult: liveBlob });
report.sections.blob_get_local = await sweep({ probe: probeBlobGetLocal, base: { ce, iters: BLOB_ITERS }, sizes: BLOB_SIZES, onResult: liveBlob });

// ---- 5. Blob get remote (cold cross-node fetch) ---------------------------
log("[5/6] blob get (remote, cold)...");
report.sections.blob_get_remote = {};
for (const peer of peers) {
  const sec = report.sections.rpc_peers[peer];
  if (sec && sec.skipped) {
    report.sections.blob_get_remote[peer] = { skipped: true, reason: "ce-echo not running" };
    continue;
  }
  report.sections.blob_get_remote[peer] = [];
  for (const size of REMOTE_SIZES) {
    const r = await probeBlobGetRemote({ ce, from: peer, size, iters: REMOTE_ITERS }).catch((e) => ({ error: e.message }));
    report.sections.blob_get_remote[peer].push(r);
    if (!r.error) log(`  ${peer.slice(0, 12)} ${fmtSize(size)}: p50 ${r.ms.p50.toFixed(1)}ms ${r.agg_mb_per_sec.toFixed(1)} MB/s (${r.fetched} ok, ${r.errors} err)`);
    else log(`  ${peer.slice(0, 12)} ${fmtSize(size)}: ${r.error}`);
  }
}

// ---- 6. Concurrency scaling sweep (rpc @ 1KiB) ----------------------------
log("[6/6] concurrency scaling (rpc_rtt @ 1KiB)...");
report.sections.concurrency = {};
const concTargets = [
  ...(selfOk ? [{ id: self, label: "self" }] : []),
  ...peers.filter((p) => !report.sections.rpc_peers[p]?.skipped).map((p) => ({ id: p, label: p.slice(0, 12) })),
];
for (const t of concTargets) {
  const run = async () =>
    sweep({ probe: probeRpcRtt, base: { ce, to: t.id, bytes: KiB, iters: Math.max(RPC_ITERS, 40), timeoutMs: 20000 }, concurrency: CONC_LEVELS, onResult: (r) => log(`  ${t.label} c=${r.concurrency}: p50 ${r.ms.p50.toFixed(1)}ms p99 ${r.ms.p99.toFixed(1)}ms ${r.reqs_per_sec.toFixed(0)} req/s`) });
  report.sections.concurrency[t.label] = t.label === "self" ? await withInlineResponder(ce, run) : await run();
}

// ---- Optional: pubsub propagation -----------------------------------------
if (args.pubsub && peers.some((p) => !report.sections.rpc_peers[p]?.skipped)) {
  log("[+] pubsub propagation...");
  report.sections.pubsub = await probePubsubProp({ ce, iters: quick ? 10 : 30 }).catch((e) => ({ error: e.message }));
}

// ---- Render ---------------------------------------------------------------
const md = renderMarkdown(report);
if (args.out) {
  writeFileSync(args.out, md);
  log(`\nce-netbench: wrote ${args.out}`);
}
if (args.json) {
  writeFileSync(args.json, JSON.stringify(report, null, 2));
  log(`ce-netbench: wrote ${args.json}`);
}
if (!args.out) console.log("\n" + md);

// ---------------------------------------------------------------------------
// Inline responder: for SELF probes we answer our own requests from this process (ce-echo would be
// a separate process). Subscribes + replies for the duration of `fn`.
async function withInlineResponder(client, fn) {
  const { startEchoResponder } = await import("../src/echo.js");
  const ac = new AbortController();
  const r = await startEchoResponder({ ce: client, signal: ac.signal, log: () => {} });
  try {
    return await fn();
  } finally {
    ac.abort();
    await r.done.catch(() => {});
  }
}

function liveRpc(r, peer) {
  const who = peer ? peer.slice(0, 12) : "self";
  log(`  ${who} ${fmtSize(r.bytes)}: p50 ${r.ms.p50.toFixed(2)}ms p99 ${r.ms.p99.toFixed(2)}ms ${r.reqs_per_sec.toFixed(0)} req/s (${r.errors} err)`);
}
function liveBlob(r) {
  log(`  ${r.kind} ${fmtSize(r.size)}: p50 ${r.ms.p50.toFixed(2)}ms ${r.mb_per_sec.toFixed(1)} MB/s (agg ${r.agg_mb_per_sec.toFixed(1)} MB/s, ${r.errors} err)`);
}

function fmtSize(n) {
  if (n >= MiB) return `${(n / MiB).toFixed(n % MiB ? 1 : 0)}MiB`;
  if (n >= KiB) return `${(n / KiB).toFixed(n % KiB ? 1 : 0)}KiB`;
  return `${n}B`;
}
function ms(x) {
  return x == null ? "-" : x.toFixed(2);
}

function renderMarkdown(rep) {
  const L = [];
  L.push(`# CE network benchmark report`);
  L.push("");
  L.push(`- node: \`${rep.node.slice(0, 16)}...\``);
  L.push(`- at: ${rep.at}`);
  L.push(`- base: ${rep.baseUrl} (height ${rep.height})`);
  L.push("");

  // Ping floor
  L.push(`## 1. Transport ping floor (/netgraph)`);
  if (rep.sections.ping?.edges?.length) {
    L.push("");
    L.push("| peer | rtt_ms | samples |");
    L.push("|---|---:|---:|");
    for (const e of rep.sections.ping.edges) L.push(`| \`${e.peer.slice(0, 12)}\` | ${e.rtt_ms?.toFixed(2)} | ${e.samples} |`);
  } else L.push("\n_(none)_");
  L.push("");

  // RPC RTT
  L.push(`## 2. Mesh RPC round-trip (request/reply)`);
  L.push("");
  L.push("p50/p90/p99 in ms; req/s at concurrency 1.");
  L.push("");
  L.push("| target | payload | p50 | p90 | p99 | req/s | err |");
  L.push("|---|---|---:|---:|---:|---:|---:|");
  for (const r of arr(rep.sections.rpc_self)) if (!r.error) L.push(rpcRow("self", r));
  for (const [peer, sec] of Object.entries(rep.sections.rpc_peers || {})) {
    if (sec.skipped) L.push(`| \`${peer.slice(0, 12)}\` | _skipped_ | | | | | ${sec.reason} |`);
    else for (const r of arr(sec)) L.push(rpcRow(peer.slice(0, 12), r));
  }
  L.push("");

  // Blob
  L.push(`## 3. Blob store (local)`);
  L.push("");
  L.push("| op | size | p50 ms | p99 ms | MB/s (p50) | agg MB/s | err |");
  L.push("|---|---|---:|---:|---:|---:|---:|");
  for (const r of arr(rep.sections.blob_put)) L.push(blobRow(r));
  for (const r of arr(rep.sections.blob_get_local)) L.push(blobRow(r));
  L.push("");

  // Remote blob
  L.push(`## 4. Blob fetch (cold, cross-node)`);
  L.push("");
  const anyRemote = Object.values(rep.sections.blob_get_remote || {}).some((v) => Array.isArray(v));
  if (anyRemote) {
    L.push("| from | size | p50 ms | p99 ms | agg MB/s | fetched | err |");
    L.push("|---|---|---:|---:|---:|---:|---:|");
    for (const [peer, rows] of Object.entries(rep.sections.blob_get_remote)) {
      if (!Array.isArray(rows)) {
        L.push(`| \`${peer.slice(0, 12)}\` | _skipped_ | | | | | ${rows.reason} |`);
        continue;
      }
      for (const r of rows) {
        if (r.error) L.push(`| \`${peer.slice(0, 12)}\` | ${fmtSize(r.size || 0)} | _err_ | | | | ${r.error} |`);
        else L.push(`| \`${peer.slice(0, 12)}\` | ${fmtSize(r.size)} | ${ms(r.ms.p50)} | ${ms(r.ms.p99)} | ${r.agg_mb_per_sec.toFixed(1)} | ${r.fetched} | ${r.errors} |`);
      }
    }
  } else L.push("_(no peers with ce-echo running)_");
  L.push("");

  // Concurrency
  L.push(`## 5. Concurrency scaling (rpc_rtt @ 1KiB)`);
  L.push("");
  L.push("| target | concurrency | p50 ms | p99 ms | req/s |");
  L.push("|---|---:|---:|---:|---:|");
  for (const [label, rows] of Object.entries(rep.sections.concurrency || {})) {
    for (const r of arr(rows)) if (!r.error) L.push(`| ${label} | ${r.concurrency} | ${ms(r.ms.p50)} | ${ms(r.ms.p99)} | ${r.reqs_per_sec.toFixed(0)} |`);
  }
  L.push("");

  if (rep.sections.pubsub) {
    L.push(`## 6. Pubsub propagation round-trip`);
    L.push("");
    const p = rep.sections.pubsub;
    if (p.error) L.push(`_error: ${p.error}_`);
    else L.push(`p50 ${ms(p.ms.p50)}ms, p90 ${ms(p.ms.p90)}ms, p99 ${ms(p.ms.p99)}ms (n=${p.ms.n}, ${p.errors} err)`);
    L.push("");
  }
  return L.join("\n");

  function rpcRow(label, r) {
    return `| \`${label}\` | ${fmtSize(r.bytes)} | ${ms(r.ms.p50)} | ${ms(r.ms.p90)} | ${ms(r.ms.p99)} | ${r.reqs_per_sec.toFixed(0)} | ${r.errors} |`;
  }
  function blobRow(r) {
    return `| ${r.kind.replace("blob_", "")} | ${fmtSize(r.size)} | ${ms(r.ms.p50)} | ${ms(r.ms.p99)} | ${r.mb_per_sec.toFixed(1)} | ${r.agg_mb_per_sec.toFixed(1)} | ${r.errors} |`;
  }
}

function arr(x) {
  return Array.isArray(x) ? x : [];
}
