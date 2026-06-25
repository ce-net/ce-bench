# CE app benchmarks — ce-storage & ce-drive

Date: 2026-06-25. Companion to `network-benchmark-findings.md` (the primitives). These are the two
data-heavy apps measured end-to-end on real CE infrastructure.

## ce-storage (S3 gateway) — measured on the Hetzner relay

Built `ce-storage --features gateway` on the relay (Linux), ran the S3-subset HTTP gateway against the
relay's **own** CE node (an isolated bucket index + port 9100, so production ce-net.com on :9000 was
untouched), and drove the real S3 verbs from the relay over localhost. Localhost is deliberate: it
isolates the **app + node blob path** from internet RTT (add ~ping for a remote client).

Crucially, the relay node runs `--no-mine`, so there is **no mining contention** — this is the blob
path's true ceiling, and it is fast. (Contrast the laptop primitive run, where mining jitter dragged
blob ops down with 10-20x p99 tails — see `network-benchmark-findings.md` F2/F4. Same code, no miner,
clean numbers.)

Harness: `ce-bench/examples/bench-s3.js --endpoint http://127.0.0.1:9100`. Raw JSON:
`ce-bench/reports/ce-storage-relay.json`.

### Object PUT / GET by size (concurrency 1)

| size | PUT p50 | PUT p99 | PUT MB/s | GET p50 | GET p99 | GET MB/s |
|---|---:|---:|---:|---:|---:|---:|
| 4 KiB   | 3.2 ms  | 6.1 ms  | 1.2   | 0.8 ms  | 2.0 ms  | 4.9   |
| 256 KiB | 4.8 ms  | 6.1 ms  | 52    | 2.0 ms  | 5.9 ms  | 126   |
| 1 MiB   | 11.0 ms | 13.9 ms | 91    | 6.2 ms  | 9.4 ms  | 161   |
| 8 MiB   | 38.1 ms | 61.0 ms | 210   | 18.1 ms | 33.1 ms | 441   |
| 32 MiB  | 214 ms  | 272 ms  | 149   | 155 ms  | 175 ms  | 206   |

Other verbs: **ranged GET** (64 KiB window of an 8 MiB object) p50 **1.8 ms**; **LIST** p50 **0.4 ms**.

### GET 1 MiB by concurrency

| concurrency | p50 | p99 | ops/s | MB/s |
|---:|---:|---:|---:|---:|
| 1  | 2.4 ms  | 4.9 ms  | 351 | 351 |
| 4  | 8.1 ms  | 17.4 ms | 408 | 408 |
| 16 | 24.0 ms | 37.6 ms | 393 | 393 |

### ce-storage findings

- **S1 — the app is essentially free; throughput = the blob path.** ce-storage adds little over raw
  blob put/get: 8 MiB GET at **441 MB/s**, PUT at **210 MB/s**, with tight p99 tails. The S3 verb
  mapping, bucket index, and ranged-read math are not the bottleneck.
- **S2 — GET > PUT** at every size (PUT does write + fsync + DHT announce; GET is read + serve). The
  opposite of the mining-contended laptop, confirming the laptop anomaly was scheduler jitter, not the
  storage code.
- **S3 — large objects lose throughput** (32 MiB PUT 149 MB/s vs 8 MiB 210 MB/s): chunk assembly /
  full-body buffering cost grows with size. Matches primitive finding F5 (no streaming on the big-body
  path). Multipart/streaming PUT would recover this.
- **S4 — the HTTP read path scales then flattens** (~400 ops/s for 1 MiB GET; p50 rises 2.4 -> 24 ms
  from c1 -> c16). It does NOT collapse like the directed-mesh RPC path (F1) — the axum/blob read path
  parallelizes acceptably; the node's request handling is the soft ceiling.

**Net:** ce-storage is production-fast on a non-mining host. The one real lever is streaming/multipart
for very large objects (S3); everything else is gated by the node primitives, not the app.

## ce-drive (mesh filesystem) — two-node real mesh

_(measured below once the harness run completes)_

Harness: `ce-drive-client/examples/bench_drive.rs` — boots two in-process CE nodes wired over libp2p
(node B hosts a `DriveServer`, node A drives the `ce-drive/v1` op set as a `RemoteDrive` by
capability). Every op is a real mesh request/reply between two distinct nodes; co-located so it
isolates the app + protocol + node overhead (DriveTree CRDT, content-addressed chunking,
authorize-on-every-op). Add real cross-node RTT (ce-bench send_rtt: desktop p50 ~17 ms) on top.

## Where each app was run, and why

| app | build host | run host | why |
|---|---|---|---|
| ce-storage | relay (Linux) | relay node | light build (no ce-node); gateway is HTTP + self-contained on the node — no live laptop<->relay mesh link needed |
| ce-drive | laptop (warm debug cache) | two in-process nodes | needs `ce-node` (heavy); relay too small to compile it (2.7 GB RAM / 14 GB disk, cold cache), desktop unreachable (no capability in wallet), and the laptop<->relay mesh link is stale (F6) |

To run ce-drive across **physical** machines (laptop <-> desktop), the desktop must issue the laptop a
capability (`ce grant <laptop-id> --can spawn,sync`) so the harness can be built+run there; the same
`bench_drive` binary then runs on the desktop node with node A on the laptop.
