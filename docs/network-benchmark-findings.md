# CE network & primitive benchmark — findings and improvements

Date: 2026-06-25. Measured on the live production mesh (not a simulation).

This complements the compute-fabric benchmark (`ce-bench` CPU/mem/disk/LLM). It measures the
**latency and throughput of CE's core network primitives as an app experiences them** — mesh RPC,
directed messaging, blob/object transfer — and how they scale with payload size and concurrency.

## How to reproduce

```
# On every node you want to measure TO (gives it a responder for request/reply + cold fetch):
node bin/ce-echo.js

# From the probing node:
node bin/ce-netbench.js --peer <64-hex node id> --out report.md --json report.json
node bin/ce-netbench.js --quick --no-remote        # local-only, fast
```

`ce-netbench` auto-loads the node api.token, discovers peers from `/atlas`, and degrades gracefully
(peers without `ce-echo`, or stale links, are reported as skipped — never a hard failure).

## Topology measured

| node | role | link to laptop |
|---|---|---|
| laptop (this Mac, arm64) | prober | — |
| desktop (Debian, 4c/16GB, behind NAT) | live peer | direct DCUtR, ping **5–7 ms**, fresh (1700+ ping samples) |
| relay (Hetzner 4vCPU/4GB) | bootstrap | ping 39 ms but **stale — last seen 7.4 h ago** |

## Headline numbers (laptop -> desktop, ping floor 7 ms)

Canonical run: `reports/mesh-desktop.md` / `.json`. Absolute numbers move run-to-run with node load
(mining + sync bursts cause large p99 tails — itself finding F2); the *shapes* below are stable.

| primitive | result |
|---|---|
| directed RPC RTT, 64 B–1 KiB | p50 **17–18 ms**, p99 **85–316 ms** (5–18x tail over a 7 ms link) |
| directed RPC RTT, 64 KiB / 256 KiB | p50 **75 ms / 245 ms** (~1 MB/s effective payload throughput) |
| directed RPC concurrency 1 -> 64 (1 KiB) | p50 **17 -> 747 ms** (44x), throughput **39 -> 50 req/s** (flat) |
| local blob PUT, 1 MiB | p50 **40 ms**, **p99 197 ms** (5x tail, loopback) |
| local blob GET, 1 MiB | p50 **83 ms** — *slower than PUT* |
| object 4 / 16 MiB chunked (c=8) | up **12.7 / 17.7 MB/s**, down **13.5 / 15.0 MB/s** |
| blob PUT, 8 MiB | **ECONNRESET** (25/25) — connection dropped mid-upload |

## Findings

### F1 (P0) — Directed mesh RPC does not parallelize; throughput ceiling ~40–50 req/s
`send_rtt` at 1 KiB: concurrency 1 / 4 / 16 / 64 -> p50 **17 / 81 / 272 / 747 ms** (44x), while
throughput barely moves (**39 / 40 / 48 / 50 req/s**). 64x the offered concurrency buys ~1.3x
throughput and 44x the latency — there is no parallel speedup, only queueing. Every RPC funnels through a single-threaded path: HTTP handler ->
`cmd_tx` mpsc(128) -> the one mesh actor (`Swarm` is `!Sync`) -> `send_request`, and inbound requests
go `event_tx` mpsc(256) -> the node's single event loop -> handled serially with `.await` + locks.
**Impact:** every mesh-native app (ce-drive, ce-db, ce-query, ce-fn) is capped at ~25–30 req/s per
peer and its tail latency explodes under load.

### F2 (P0) — Severe tail latency even at concurrency 1
64 B / 1 KiB RPC: p50 ~16–22 ms but **p99 230–480 ms** (10–20x). The `select!` event loop is starved
in bursts by gossip / block sync / mining, and blocking `std::fs` calls run on the async worker
threads. Apps see unpredictable multi-hundred-ms stalls on otherwise-trivial calls.

### F3 (P1) — Large payloads over directed RPC are very slow (~0.5 MB/s)
RPC RTT vs size: 64 B = 20 ms, 64 KiB = 135–160 ms, 256 KiB = 448 ms. Effective payload throughput is
~0.5 MB/s over a 7 ms link. Directed AppRequest is the wrong channel for bulk data.

### F4 (P0) — Blob/object data path is loopback-bound and erratic
Chunked object transfer (the app data path) runs at **12–18 MB/s** loopback on a good run but
collapses to **2–3 MB/s** when the node is busy (observed across runs); local 1 MiB blob GET (p50
83 ms) is consistently *slower than PUT* (p50 40 ms), with 5x p99 tails — all with no network
involved. Causes: (a) `std::fs::read/write` (blocking) inside async axum handlers, contending with the
mining runtime; (b) `provide_chunk` (DHT announce) is **awaited on every PUT**; (c) the same
tail-latency jitter as F2. **Impact:** ce-storage `PutObject/GetObject` and ce-drive file
upload/download are gated to low/erratic MB/s before the network is even reached.

### F5 (P1) — Large uploads reset under load
An 8 MiB blob PUT during mining returned **ECONNRESET** mid-stream. The PUT handler takes the whole
body as `axum::body::Bytes` (full buffering, no streaming/backpressure); under runtime contention the
connection times out / resets. Large-object writes are unreliable.

### F6 (P1) — Relay link goes stale and is not re-established
The laptop last saw the relay **7.4 h ago**; directed RPC to it fails with "Failed to dial the
requested peer" even though it is the public bootstrap. Only the desktop link stays warm. There is no
keepalive / automatic redial of bootstrap/relay peers, so long-lived nodes silently lose the relay
path (and with it, reachability to NAT'd peers that depend on the circuit).

### F7 (P2) — Self-request short-circuit missing in the deployed binary
`POST /mesh/request` to the node's own id returns "Failed to dial the requested peer". The source has
a local self-delivery path (`api.rs` self-request branch) but the running binary predates it.
Co-located apps cannot do request/reply to themselves. Fix: rebuild + redeploy the node.

## Recommended improvements (prioritized)

**P0 — unblock the primitives**
1. Handle inbound RPC concurrently: spawn a task per `IncomingRpc` on the node side instead of serial
   `.await` in the event loop; never hold a lock across an await. This breaks the ~25 req/s ceiling
   (F1) and removes most of the tail (F2).
2. Move blob IO off the async threads: `tokio::fs` / `spawn_blocking`, and/or run the HTTP API on a
   dedicated runtime isolated from mining (F2, F4).
3. Don't `await provide_chunk` on the PUT hot path — announce fire-and-forget / batched (F4).

**P1 — bulk data + resilience**
4. Move bulk transfer (blobs/objects/files) onto dedicated streams (the `FetchChunk` data path /
   libp2p `Stream`), chunked + parallel, with streaming request bodies + backpressure so large
   uploads don't buffer-then-RST (F3, F5).
5. Prefer QUIC for RPC substreams (no TCP head-of-line blocking) and raise concurrent-substream
   limits (F1).
6. Keepalive + auto-redial bootstrap/relay peers so the relay link never goes stale (F6).

**P2**
7. Rebuild/redeploy the node to ship the self-request short-circuit (F7).
8. Reduce per-op channel hops in the RPC path; add event-loop fairness so gossip/mining bursts don't
   starve RPC (F2).

## App benchmarks (ce-storage, ce-drive, ...)

These apps move data as content-addressed chunks over the blob primitive, so their throughput is
**bounded by F4/F5 above**. The `object_roundtrip` probe approximates their data path directly
(4–16 MiB object = 12–18 MB/s on a good run, 2–3 MB/s under load). Next step: build `ce-storage --features gateway` and drive its
S3 `PutObject/GetObject/ListObjectsV2` endpoints, and the `ce-drive-client` file ops, through the same
latency/throughput harness to measure the app-level overhead *on top of* the primitive floor. Until
P0/P1 land, app numbers will track the primitive ceiling, not app logic.
