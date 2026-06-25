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

## ce-drive (mesh filesystem) — two-node real mesh, built + run on the relay

Harness: `ce-drive-client/examples/bench_drive.rs` — boots two in-process CE nodes wired over libp2p
(node B hosts a `DriveServer`, node A drives the `ce-drive/v1` op set as a `RemoteDrive` by
capability). Every op is a real mesh request/reply between two distinct nodes; co-located, so it
isolates the app + protocol + node overhead (DriveTree CRDT, content-addressed chunking,
authorize-on-every-op) — add real cross-node RTT (ce-bench send_rtt: desktop p50 ~17 ms) on top.
Built lean (no debuginfo) and run on the relay; raw: `ce-bench/reports/ce-drive-relay.txt`.

| op | p50 ms | p90 ms | p99 ms | MB/s (p50) |
|---|---:|---:|---:|---:|
| open / handshake   | 888  | 1332 | 1425 | - |
| mkdir              | 137  | 139  | 856  | - |
| write 4 KiB        | 1090 | 1306 | 1384 | 0.0 |
| write 64 KiB       | 959  | 1157 | 1242 | 0.1 |
| write 256 KiB      | 987  | 1111 | 1178 | 0.3 |
| write 1 MiB        | 1128 | 1416 | 1416 | 0.9 |
| write 4 MiB        | 2338 | 2703 | 2703 | 1.7 |
| read 4 KiB         | 143  | 145  | 773  | 0.0 |
| read 64 KiB        | 145  | 379  | 909  | 0.4 |
| read 256 KiB       | 146  | 533  | 711  | 1.7 |
| read 1 MiB         | 163  | 945  | 945  | 6.1 |
| read 4 MiB         | 261  | 1371 | 1371 | 15.3 |
| read ranged 64 KiB | 140  | 640  | 786  | 0.4 |
| list_all           | 146  | 152  | 156  | - |
| mirror bootstrap   | 2453 (single) | | | - |
| mirror sync 1 chg  | 2784 | 3846 | 5690 | - |

(4 transient RPC retries across the whole run — the directed RPC itself was stable here; the earlier
aborts were a harness bug, not the mesh.)

### ce-drive findings

- **D1 (P0) — ~140 ms metadata-op floor = the DriveServer's 100 ms inbox poll.** mkdir / small read /
  list / ranged-read all land at p50 ~137-146 ms with almost no size dependence. `DriveServer.run(100)`
  **polls `/mesh/messages` every 100 ms** instead of consuming the push stream (`/mesh/messages/stream`,
  which the node already exposes and ce-echo uses). Every op pays ~half the poll interval. Switching
  serve.rs to the SSE stream would roughly halve the floor immediately.
- **D2 (P0) — writes have a ~1 s floor and ~1-2 MB/s throughput**, ~6-8x slower than reads at every
  size (write 1 MiB 1128 ms vs read 1 MiB 163 ms). A write is `put_object` (chunk -> blob PUT + DHT
  announce **per chunk**) + a commit RPC + a feed append — several poll-gated round trips stacked on
  the slow blob PUT path (primitive F4). This is the dominant ce-drive cost.
- **D3 — reads scale with size, writes don't.** read 4 MiB hits 15 MB/s (chunk fetch parallelizes via
  ReadPlan); writes stay ~1-2 MB/s (serial chunk PUT + announce). Parallelizing chunk PUT and making
  the announce fire-and-forget (primitive F4 fix) would lift write throughput directly.
- **D4 — Mirror is expensive**: bootstrap 2.45 s, sync-one-change p50 2.78 s (p99 5.69 s). It
  reconstructs/polls the DriveTree + change feed + beacon; the per-sync cost makes `rdev watch`-style
  live mirroring laggy. Push-driven change delivery (D1) plus incremental feed application would help.

### Comparison: ce-storage vs ce-drive (same blob substrate)

ce-storage GET 1 MiB = **6 ms / 161 MB/s**; ce-drive read 1 MiB = **163 ms / 6 MB/s** — ~25x slower.
Both sit on the same content-addressed blobs; the gap is entirely ce-drive's mesh+poll+CRDT path vs
ce-storage's direct local HTTP->blob. The takeaway: the blob substrate is fast (ce-storage proves it);
ce-drive's latency is **its own** poll-based transport (D1) and serial write path (D2), both fixable
in the app without node changes.

## Where each app was run, and why

| app | build host | run host | notes |
|---|---|---|---|
| ce-storage | relay (Linux) | relay node | light build (no ce-node); gateway is HTTP, self-contained on the node — benchmarked over localhost on the relay |
| ce-drive | relay (Linux) | relay (2 in-process nodes) | needs `ce-node` (heavy); built lean (no debuginfo, ~3.5 min) with an 8 GB swapfile for the link; `bench_drive` boots its own 2-node mesh, so it runs entirely on the relay |

Both apps were built and run on the relay. ce-drive's harness is self-contained (it spins up its own
two CE nodes), so the co-located numbers isolate app overhead; for a cross-continent figure add the
measured cross-node RTT from the primitive report. Running it across **physical** machines
(e.g. laptop host <-> desktop client) needs the desktop to grant the laptop a capability
(`ce grant <laptop-id> --can spawn,sync`); the same binary then runs there unchanged.
