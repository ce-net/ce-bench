#!/usr/bin/env node
/**
 * bench-s3 — benchmark a running ce-storage S3 gateway (the app, end-to-end over HTTP).
 *
 *   node examples/bench-s3.js --endpoint http://HOST:9000 [--bucket bench] [--quick]
 *
 * Drives the real S3 verbs the gateway exposes (PUT/GET/HEAD/ranged-GET/LIST/DELETE) across a sweep
 * of object sizes and client concurrency, and reports p50/p90/p99 latency + MB/s — the same
 * distribution shape as ce-netbench, so app numbers sit next to the primitive numbers.
 *
 * Measures the FULL app path: HTTP -> gateway -> ce-rs -> CE node blobs (chunked content-addressing).
 */
import { stats, timedBatch, randomBytes } from "../src/net.js";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]);
    return acc;
  }, []),
);
const endpoint = (args.endpoint || "http://127.0.0.1:9000").replace(/\/$/, "");
const bucket = args.bucket || "bench";
const quick = !!args.quick;
const KiB = 1024, MiB = 1024 * 1024;
const SIZES = quick ? [4 * KiB, 1 * MiB] : [4 * KiB, 256 * KiB, 1 * MiB, 8 * MiB, 32 * MiB];
const ITERS = quick ? 8 : 20;
const CONC = quick ? [1, 8] : [1, 4, 16];

const log = (...a) => console.error(...a);
const fmt = (n) => (n >= MiB ? `${(n / MiB).toFixed(n % MiB ? 1 : 0)}MiB` : n >= KiB ? `${(n / KiB).toFixed(0)}KiB` : `${n}B`);

async function req(method, path, body, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const res = await fetch(endpoint + path, { method, body, headers, signal: ctrl.signal });
    const buf = method === "GET" ? new Uint8Array(await res.arrayBuffer()) : (await res.text(), null);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${path}`);
    return { res, buf };
  } finally {
    clearTimeout(timer);
  }
}

log(`bench-s3: endpoint ${endpoint}, bucket ${bucket}`);
// Create bucket (idempotent-ish; ignore "already exists").
await req("PUT", `/${bucket}`).catch((e) => log(`  mb: ${e.message} (continuing)`));

const report = { tool: "bench-s3", at: new Date().toISOString(), endpoint, bucket, put: [], get: [], ranged: null, list: null, concurrency: [] };

// PUT + GET sweeps by size (concurrency 1).
for (const size of SIZES) {
  const keys = [];
  const put = await timedBatch({
    op: async (i) => {
      const key = `s/${size}-${i}-${Math.floor(i * 2654435761) % 1e9}`;
      keys.push(key);
      await req("PUT", `/${bucket}/${key}`, randomBytes(size), { "content-type": "application/octet-stream" });
    },
    iters: ITERS,
    concurrency: 1,
  });
  const ps = stats(put.latencies);
  report.put.push({ size, ms: ps, mb_per_sec: size / MiB / (ps.p50 / 1000), agg_mb_per_sec: (size * put.latencies.length) / MiB / (put.wallMs / 1000), errors: put.errors });
  log(`  PUT ${fmt(size)}: p50 ${ps.p50.toFixed(1)}ms p99 ${ps.p99.toFixed(1)}ms ${(size / MiB / (ps.p50 / 1000)).toFixed(1)} MB/s (${put.errors} err)`);

  let gi = 0;
  const get = await timedBatch({ op: async () => { await req("GET", `/${bucket}/${keys[gi++ % keys.length]}`); }, iters: ITERS, concurrency: 1 });
  const gs = stats(get.latencies);
  report.get.push({ size, ms: gs, mb_per_sec: size / MiB / (gs.p50 / 1000), agg_mb_per_sec: (size * get.latencies.length) / MiB / (get.wallMs / 1000), errors: get.errors });
  log(`  GET ${fmt(size)}: p50 ${gs.p50.toFixed(1)}ms p99 ${gs.p99.toFixed(1)}ms ${(size / MiB / (gs.p50 / 1000)).toFixed(1)} MB/s (${get.errors} err)`);
}

// Ranged GET: put one 8 MiB object, fetch a 64 KiB range repeatedly.
{
  const key = "range/obj";
  await req("PUT", `/${bucket}/${key}`, randomBytes(8 * MiB), { "content-type": "application/octet-stream" });
  const r = await timedBatch({
    op: async (i) => {
      const start = (i * 65536) % (8 * MiB - 65536);
      await req("GET", `/${bucket}/${key}`, undefined, { range: `bytes=${start}-${start + 65535}` });
    },
    iters: ITERS,
    concurrency: 1,
  });
  report.ranged = { range: "64KiB", ms: stats(r.latencies), errors: r.errors };
  log(`  GET ranged 64KiB: p50 ${report.ranged.ms.p50.toFixed(1)}ms p99 ${report.ranged.ms.p99.toFixed(1)}ms (${r.errors} err)`);
}

// LIST objects.
{
  const r = await timedBatch({ op: async () => { await req("GET", `/${bucket}`); }, iters: ITERS, concurrency: 1 });
  report.list = { ms: stats(r.latencies), errors: r.errors };
  log(`  LIST: p50 ${report.list.ms.p50.toFixed(1)}ms p99 ${report.list.ms.p99.toFixed(1)}ms (${r.errors} err)`);
}

// Concurrency sweep: GET a 1 MiB object at increasing parallelism.
{
  const key = "conc/obj";
  await req("PUT", `/${bucket}/${key}`, randomBytes(1 * MiB), { "content-type": "application/octet-stream" });
  for (const c of CONC) {
    const r = await timedBatch({ op: async () => { await req("GET", `/${bucket}/${key}`); }, iters: Math.max(ITERS, 24), concurrency: c });
    const s = stats(r.latencies);
    report.concurrency.push({ concurrency: c, ms: s, ops_per_sec: r.opsPerSec, agg_mb_per_sec: (MiB * r.latencies.length) / MiB / (r.wallMs / 1000), errors: r.errors });
    log(`  GET 1MiB c=${c}: p50 ${s.p50.toFixed(1)}ms p99 ${s.p99.toFixed(1)}ms ${r.opsPerSec.toFixed(0)} ops/s ${((MiB * r.latencies.length) / MiB / (r.wallMs / 1000)).toFixed(1)} MB/s`);
  }
}

if (args.json) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(args.json, JSON.stringify(report, null, 2));
  log(`bench-s3: wrote ${args.json}`);
}
console.log(JSON.stringify(report));
process.exit(0);
