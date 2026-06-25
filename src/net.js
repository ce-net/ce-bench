/**
 * @ce-net/bench — NETWORK & PRIMITIVE benchmarks.
 *
 * Where `benchmarks.js` measures a node's raw *compute* (CPU/mem/disk/LLM), this module measures the
 * latency and throughput of CE's *network primitives* as an app actually experiences them, over the
 * real mesh:
 *
 *   - mesh request/reply round-trip   (`/mesh/request` -> echo responder -> reply)
 *   - blob put / get (local)          (`/blobs`)
 *   - blob get (cold, cross-node)     (DHT provider lookup + transfer)
 *   - pubsub propagation              (`/mesh/publish` -> remote re-publish -> receipt)  [optional]
 *   - transport ping floor            (`/netgraph`, for comparison)
 *
 * Every latency probe reports a full distribution (p50/p90/p99) plus throughput, and every probe can
 * be swept across payload sizes and concurrency levels to answer "how does it scale?".
 *
 * Pure web-standard APIs (fetch/crypto/performance). Runs in Node 18+, Deno, Bun, and the browser.
 * Anti-cheat / determinism is N/A here: these are first-party latency measurements of the operator's
 * own mesh, not adversarial capability claims.
 *
 * @packageDocumentation
 */

import { CeClient } from "./ce.js";

const now =
  typeof performance !== "undefined" && performance.now
    ? () => performance.now()
    : () => Number(process.hrtime.bigint() / 1000n) / 1000;

/** Coerce a CeClient | base-url string | undefined into a CeClient. */
function asCe(ce) {
  if (ce instanceof CeClient) return ce;
  if (typeof ce === "string") return new CeClient({ baseUrl: ce });
  if (ce && typeof ce === "object") return new CeClient(ce);
  return new CeClient();
}

/** Fill a Uint8Array with pseudo-random bytes (crypto if available, else a cheap LCG). */
export function randomBytes(n) {
  const out = new Uint8Array(n);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    // getRandomValues caps at 65536 bytes per call.
    for (let off = 0; off < n; off += 65536) crypto.getRandomValues(out.subarray(off, Math.min(off + 65536, n)));
    return out;
  }
  let s = 0x9e3779b9 ^ n;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s & 0xff;
  }
  return out;
}

/**
 * Distribution summary of a sample array (milliseconds). Percentiles use nearest-rank.
 * @param {number[]} samples
 */
export function stats(samples) {
  const n = samples.length;
  if (n === 0) return { n: 0, min: 0, max: 0, mean: 0, p50: 0, p90: 0, p99: 0, stdev: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = s.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const pct = (p) => s[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))];
  return {
    n,
    min: s[0],
    max: s[n - 1],
    mean,
    p50: pct(50),
    p90: pct(90),
    p99: pct(99),
    stdev: Math.sqrt(variance),
  };
}

/**
 * Run `iters` async operations with up to `concurrency` in flight, timing each. Returns the per-op
 * latencies (ms), the total wall time, and ops/sec (iters / wall). This is the engine under every
 * probe — a single op factory keeps the latency and throughput numbers consistent.
 *
 * @param {object} a
 * @param {(i:number) => Promise<any>} a.op   Factory producing the i-th operation's promise.
 * @param {number} a.iters
 * @param {number} [a.concurrency]            Default 1 (pure latency). >1 measures saturation.
 * @param {number} [a.warmup]                 Untimed ops to prime caches/connections. Default 1.
 * @returns {Promise<{latencies:number[], wallMs:number, opsPerSec:number, errors:number, errorSample?:string}>}
 */
export async function timedBatch({ op, iters, concurrency = 1, warmup = 1 }) {
  for (let i = 0; i < warmup; i++) {
    try {
      await op(-1 - i);
    } catch {
      /* warmup errors are non-fatal */
    }
  }
  const latencies = [];
  let errors = 0;
  let errorSample;
  let next = 0;
  const wallStart = now();
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= iters) return;
      const t0 = now();
      try {
        await op(i);
        latencies.push(now() - t0);
      } catch (e) {
        errors++;
        if (!errorSample) errorSample = e instanceof Error ? e.message : String(e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, iters) }, worker));
  const wallMs = now() - wallStart;
  return { latencies, wallMs, opsPerSec: latencies.length ? (latencies.length / wallMs) * 1000 : 0, errors, errorSample };
}

/** Bench topic the echo responder (src/echo.js) answers on. */
export const ECHO_TOPIC = "ce-bench/echo";
/** Bench pubsub topics: publish on REQ, responder re-publishes the payload on RES. */
export const PUBSUB_REQ_TOPIC = "ce-bench/pub";
export const PUBSUB_RES_TOPIC = "ce-bench/pub-echo";

/**
 * Mesh request/reply round-trip latency to `to`, at a fixed payload size. The target must run the
 * echo responder on ECHO_TOPIC. `to === self node id` exercises the node's local self-request path
 * (a useful "API + serialization overhead, zero network" floor).
 *
 * @param {object} a
 * @param {CeClient|string|object} a.ce
 * @param {string} a.to                 64-hex node id of the responder.
 * @param {number} [a.bytes]            Payload size each way. Default 64.
 * @param {number} [a.iters]            Default 50.
 * @param {number} [a.concurrency]      Default 1.
 * @param {number} [a.timeoutMs]        Per-request timeout. Default 10000.
 * @param {string} [a.topic]            Default ECHO_TOPIC.
 */
export async function probeRpcRtt(a) {
  const ce = asCe(a.ce);
  const bytes = a.bytes ?? 64;
  const payload = randomBytes(bytes);
  const r = await timedBatch({
    op: () => ce.meshRequest({ to: a.to, topic: a.topic ?? ECHO_TOPIC, payload, timeoutMs: a.timeoutMs ?? 10000 }),
    iters: a.iters ?? 50,
    concurrency: a.concurrency ?? 1,
  });
  return {
    kind: "rpc_rtt",
    target: a.to,
    bytes,
    concurrency: a.concurrency ?? 1,
    ms: stats(r.latencies),
    reqs_per_sec: r.opsPerSec,
    errors: r.errors,
    errorSample: r.errorSample,
  };
}

/**
 * Directed message round-trip ("send RTT"): time `POST /mesh/send` to a peer. The peer's NODE answers
 * with an `AppAck` from its protocol handler the moment it enqueues the message — no app responder
 * required. This is the purest app-visible transport+protocol RTT for directed mesh messaging (the
 * latency floor under request/reply, which adds the remote app's stream->reply hop on top). Works to
 * any live peer; compare against the `/netgraph` ping floor to see node+serde overhead.
 *
 * @param {object} a
 * @param {CeClient|string|object} a.ce
 * @param {string} a.to                64-hex node id of a live peer.
 * @param {number} [a.bytes]           Payload size. Default 64.
 * @param {number} [a.iters]           Default 50.
 * @param {number} [a.concurrency]     Default 1.
 */
export async function probeSendRtt(a) {
  const ce = asCe(a.ce);
  const bytes = a.bytes ?? 64;
  const payload = randomBytes(bytes);
  const topic = "ce-bench/sink"; // arbitrary; AppAck does not depend on a subscriber
  const r = await timedBatch({
    op: () => ce.meshSend(a.to, topic, payload),
    iters: a.iters ?? 50,
    concurrency: a.concurrency ?? 1,
  });
  return {
    kind: "send_rtt",
    target: a.to,
    bytes,
    concurrency: a.concurrency ?? 1,
    ms: stats(r.latencies),
    reqs_per_sec: r.opsPerSec,
    errors: r.errors,
    errorSample: r.errorSample,
  };
}

/**
 * Blob PUT throughput/latency at a fixed size. Each op uploads a fresh random blob (distinct bytes
 * => distinct hash => no dedupe short-circuit).
 */
export async function probeBlobPut(a) {
  const ce = asCe(a.ce);
  const size = a.size ?? 1 << 20;
  const r = await timedBatch({
    op: (i) => {
      const b = randomBytes(size);
      // Make the first bytes vary by index so concurrent ops never collide on content hash.
      b[0] = i & 0xff;
      b[1] = (i >> 8) & 0xff;
      return ce.putBlob(b);
    },
    iters: a.iters ?? 20,
    concurrency: a.concurrency ?? 1,
  });
  const st = stats(r.latencies);
  return {
    kind: "blob_put",
    size,
    concurrency: a.concurrency ?? 1,
    ms: st,
    mb_per_sec: mbPerSec(size, st.p50),
    agg_mb_per_sec: (size * r.latencies.length) / (1 << 20) / (r.wallMs / 1000),
    errors: r.errors,
    errorSample: r.errorSample,
  };
}

/**
 * Blob GET (local hit) latency/throughput. Uploads one blob, then reads it back repeatedly — after
 * the first read it is a warm local-FS read, isolating the node's serve path from the network.
 */
export async function probeBlobGetLocal(a) {
  const ce = asCe(a.ce);
  const size = a.size ?? 1 << 20;
  const hash = await ce.putBlob(randomBytes(size));
  const r = await timedBatch({
    op: () => ce.getBlob(hash),
    iters: a.iters ?? 20,
    concurrency: a.concurrency ?? 1,
  });
  const st = stats(r.latencies);
  return {
    kind: "blob_get_local",
    size,
    concurrency: a.concurrency ?? 1,
    ms: st,
    mb_per_sec: mbPerSec(size, st.p50),
    agg_mb_per_sec: (size * r.latencies.length) / (1 << 20) / (r.wallMs / 1000),
    errors: r.errors,
    errorSample: r.errorSample,
  };
}

/**
 * Blob GET (cold, cross-node). The responder on `from` uploads a fresh blob and returns its hash via
 * RPC (topic ECHO_TOPIC + "/putblob"); we then GET it locally — which misses, triggering a DHT
 * provider lookup + transfer from `from`. This is THE number that matters for content distribution:
 * cold cross-node fetch latency and throughput. Each iteration uses a new blob to defeat caching.
 *
 * @param {object} a
 * @param {CeClient|string|object} a.ce
 * @param {string} a.from               Responder node id holding the blobs.
 * @param {number} [a.size]             Default 1 MiB.
 * @param {number} [a.iters]            Default 10.
 * @param {number} [a.timeoutMs]        Default 30000 (cold fetch can be slow).
 */
export async function probeBlobGetRemote(a) {
  const ce = asCe(a.ce);
  const size = a.size ?? 1 << 20;
  const iters = a.iters ?? 10;
  const latencies = [];
  let errors = 0;
  let errorSample;
  const wallStart = now();
  let got = 0;
  let bytesMoved = 0;
  for (let i = 0; i < iters; i++) {
    try {
      // Ask the remote to mint a blob of `size`; reply payload is the hash (utf-8 hex).
      const hashBytes = await ce.meshRequest({
        to: a.from,
        topic: ECHO_TOPIC + "/putblob",
        payload: u32le(size),
        timeoutMs: a.timeoutMs ?? 30000,
      });
      const hash = new TextDecoder().decode(hashBytes).trim();
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`responder returned bad hash: ${hash.slice(0, 40)}`);
      const t0 = now();
      const blob = await ce.getBlob(hash);
      latencies.push(now() - t0);
      bytesMoved += blob.length;
      got++;
    } catch (e) {
      errors++;
      if (!errorSample) errorSample = e instanceof Error ? e.message : String(e);
    }
  }
  const wallMs = now() - wallStart;
  const st = stats(latencies);
  return {
    kind: "blob_get_remote",
    from: a.from,
    size,
    ms: st,
    mb_per_sec: mbPerSec(size, st.p50),
    agg_mb_per_sec: bytesMoved / (1 << 20) / (wallMs / 1000),
    fetched: got,
    errors,
    errorSample,
  };
}

/**
 * Object round-trip: chunk a `size`-byte object into `chunkSize` blobs, PUT them all (optionally in
 * parallel), then GET them all back. This is exactly how ce-storage (S3 PutObject/GetObject) and
 * ce-drive (file upload/download) move data — content-addressed chunks over the blob primitive — so
 * it is the app-representative large-file throughput number. Reports separate upload/download
 * aggregate MB/s plus per-chunk latency.
 *
 * @param {object} a
 * @param {CeClient|string|object} a.ce
 * @param {number} [a.size]            Object size in bytes. Default 16 MiB.
 * @param {number} [a.chunkSize]       Chunk size. Default 1 MiB (matches ce-rs data::chunk_object).
 * @param {number} [a.concurrency]     Parallel chunk PUT/GET. Default 8 (what a real client uses).
 */
export async function probeObjectRoundtrip(a) {
  const ce = asCe(a.ce);
  const size = a.size ?? 16 * (1 << 20);
  const chunkSize = a.chunkSize ?? 1 << 20;
  const concurrency = a.concurrency ?? 8;
  const nChunks = Math.max(1, Math.ceil(size / chunkSize));
  // Distinct content per chunk (and per call) so nothing is deduped away.
  const salt = randomBytes(8);
  const mkChunk = (i) => {
    const b = randomBytes(chunkSize);
    b.set(salt, 0);
    b[8] = i & 0xff;
    b[9] = (i >> 8) & 0xff;
    return b;
  };

  // Upload
  const upStart = now();
  const hashes = new Array(nChunks);
  const upLat = [];
  {
    let next = 0;
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= nChunks) return;
        const t0 = now();
        hashes[i] = await ce.putBlob(mkChunk(i));
        upLat.push(now() - t0);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, nChunks) }, worker));
  }
  const upMs = now() - upStart;

  // Download
  const dnStart = now();
  const dnLat = [];
  let dnBytes = 0;
  {
    let next = 0;
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= nChunks) return;
        const t0 = now();
        const bytes = await ce.getBlob(hashes[i]);
        dnLat.push(now() - t0);
        dnBytes += bytes.length;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, nChunks) }, worker));
  }
  const dnMs = now() - dnStart;

  const total = chunkSize * nChunks;
  return {
    kind: "object_roundtrip",
    size,
    chunkSize,
    nChunks,
    concurrency,
    upload: { ms: stats(upLat), agg_mb_per_sec: total / (1 << 20) / (upMs / 1000), wall_ms: upMs },
    download: { ms: stats(dnLat), agg_mb_per_sec: dnBytes / (1 << 20) / (dnMs / 1000), wall_ms: dnMs },
  };
}

/**
 * Pubsub propagation latency: publish a stamped message on PUBSUB_REQ_TOPIC; the responder, which
 * mirrors it onto PUBSUB_RES_TOPIC, bounces it back. We measure publish -> receipt round-trip on a
 * live subscription. Requires the responder running with pubsub mirroring enabled.
 *
 * @param {object} a
 * @param {CeClient|string|object} a.ce
 * @param {number} [a.iters]      Default 20.
 * @param {number} [a.timeoutMs]  Per-message wait. Default 5000.
 */
export async function probePubsubProp(a) {
  const ce = asCe(a.ce);
  const iters = a.iters ?? 20;
  const timeoutMs = a.timeoutMs ?? 5000;
  await ce.subscribe(PUBSUB_RES_TOPIC).catch(() => {});
  await ce.subscribe(PUBSUB_REQ_TOPIC).catch(() => {});
  const ac = new AbortController();
  // Map nonce -> resolver for in-flight pings.
  const pending = new Map();
  const consume = (async () => {
    try {
      for await (const m of ce.meshMessageStream(ac.signal)) {
        if (m.topic !== PUBSUB_RES_TOPIC) continue;
        const nonce = m.payload_hex.slice(0, 16); // first 8 bytes
        const r = pending.get(nonce);
        if (r) {
          r(now());
          pending.delete(nonce);
        }
      }
    } catch {
      /* aborted */
    }
  })();
  const latencies = [];
  let errors = 0;
  let errorSample;
  try {
    for (let i = 0; i < iters; i++) {
      const nonceBytes = randomBytes(8);
      const nonceHex = [...nonceBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      const t0 = now();
      const p = new Promise((res, rej) => {
        pending.set(nonceHex, res);
        setTimeout(() => {
          if (pending.delete(nonceHex)) rej(new Error("pubsub timeout"));
        }, timeoutMs);
      });
      try {
        await ce.publish(PUBSUB_REQ_TOPIC, nonceBytes);
        const tEnd = await p;
        latencies.push(tEnd - t0);
      } catch (e) {
        errors++;
        if (!errorSample) errorSample = e instanceof Error ? e.message : String(e);
      }
    }
  } finally {
    ac.abort();
    await consume.catch(() => {});
  }
  return { kind: "pubsub_prop", ms: stats(latencies), errors, errorSample };
}

/**
 * Transport ping floor from `/netgraph` — the libp2p-measured RTT per peer. Not an active probe;
 * it's the baseline every app-level number sits on top of (RPC RTT should be ping + serde + queueing).
 */
export async function pingBaseline(a) {
  const ce = asCe(typeof a === "object" && a.ce !== undefined ? a.ce : a);
  const edges = await ce.netgraph();
  return {
    kind: "ping_baseline",
    edges: edges.map((e) => ({ peer: e.peer, rtt_ms: e.rtt_ms, samples: e.samples })),
  };
}

/**
 * Scaling sweep: run a probe across a grid of payload sizes and concurrency levels, returning a flat
 * array of results. This is the "how does it scale?" answer — read p99 and aggregate throughput
 * across the grid to see where the primitive saturates or degrades.
 *
 * @param {object} a
 * @param {(args:object)=>Promise<any>} a.probe   e.g. probeRpcRtt / probeBlobPut.
 * @param {object} a.base                         Base args (ce, to/from, iters, ...).
 * @param {number[]} [a.sizes]                    Payload sizes to sweep (sets `bytes` or `size`).
 * @param {number[]} [a.concurrency]              Concurrency levels to sweep.
 * @param {"bytes"|"size"} [a.sizeKey]            Which arg key the probe reads. Default "size".
 * @param {(p:object)=>void} [a.onResult]         Called as each cell completes (for live output).
 */
export async function sweep(a) {
  const sizes = a.sizes ?? [a.sizeKey === "bytes" ? 64 : 1 << 20];
  const conc = a.concurrency ?? [1];
  const sizeKey = a.sizeKey ?? "size";
  const out = [];
  for (const size of sizes) {
    for (const c of conc) {
      // Catch per-cell so one bad size/concurrency (e.g. an oversized upload the node RSTs) is
      // recorded as an error cell rather than aborting the whole sweep/run.
      let res;
      try {
        res = await a.probe({ ...a.base, [sizeKey]: size, concurrency: c });
      } catch (e) {
        res = { error: e instanceof Error ? e.message : String(e), [sizeKey]: size, concurrency: c, errors: 1 };
      }
      out.push(res);
      if (a.onResult) a.onResult(res);
    }
  }
  return out;
}

function mbPerSec(bytes, ms) {
  if (!ms) return 0;
  return bytes / (1 << 20) / (ms / 1000);
}

function u32le(n) {
  const b = new Uint8Array(4);
  b[0] = n & 0xff;
  b[1] = (n >> 8) & 0xff;
  b[2] = (n >> 16) & 0xff;
  b[3] = (n >>> 24) & 0xff;
  return b;
}
