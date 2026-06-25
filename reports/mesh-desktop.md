# CE network benchmark report

- node: `c0be11e0ce0aaa76...`
- at: 2026-06-25T17:15:03.772Z
- base: http://127.0.0.1:8844 (height 2670)

## 1. Transport ping floor (/netgraph)

| peer | rtt_ms | samples |
|---|---:|---:|
| `12D3KooWC6vy` | 39.34 | 26 |
| `12D3KooWCNCy` | 7.16 | 1808 |

## 2. Mesh RPC round-trip (request/reply)

p50/p90/p99 in ms; req/s at concurrency 1.

| target | payload | p50 | p90 | p99 | req/s | err |
|---|---|---:|---:|---:|---:|---:|
| `25df8f158538` | _skipped_ | | | | | no reply (ce-echo not running?) |

## 2b. Directed mesh round-trip (`/mesh/send` AppAck, no responder)

The remote node ACKs at the protocol layer. This is the latency floor for directed mesh
messaging. Compare p50 to the ping floor (node+serde overhead) and watch the concurrency
curve (flat req/s + rising p50 == the path serializes / head-of-line blocks).

**peer `25df8f158538`** — by payload size:

| payload | p50 | p90 | p99 | mean | req/s |
|---|---:|---:|---:|---:|---:|
| 64B | 18.22 | 62.62 | 316.34 | 37.81 | 26 |
| 1KiB | 17.27 | 47.20 | 84.79 | 24.15 | 41 |
| 64KiB | 74.98 | 126.46 | 238.21 | 82.66 | 12 |
| 256KiB | 244.54 | 325.26 | 470.68 | 254.75 | 4 |

by concurrency (payload 1KiB):

| concurrency | p50 | p99 | req/s |
|---:|---:|---:|---:|
| 1 | 17.40 | 141.25 | 39 |
| 4 | 80.98 | 303.14 | 40 |
| 16 | 272.40 | 565.30 | 48 |
| 64 | 746.87 | 952.58 | 50 |

## 3. Blob store (local)

| op | size | p50 ms | p99 ms | MB/s (p50) | agg MB/s | err |
|---|---|---:|---:|---:|---:|---:|
| put | 4KiB | 7.68 | 137.04 | 0.5 | 0.3 | 0 |
| put | 64KiB | 10.90 | 112.49 | 5.7 | 3.5 | 0 |
| put | 1MiB | 39.80 | 197.29 | 25.1 | 19.2 | 0 |
| put | 8MiB | 0.00 | 0.00 | 0.0 | 0.0 | 25 |
| get_local | 4KiB | 3.85 | 158.60 | 1.0 | 0.3 | 0 |
| get_local | 64KiB | 11.23 | 142.85 | 5.6 | 2.7 | 0 |
| get_local | 1MiB | 83.20 | 347.31 | 12.0 | 9.5 | 0 |
| blob | 8MiB | _err_ | | | | fetch failed |

## 3b. Object round-trip (chunked, app-representative)

How ce-storage (PutObject/GetObject) and ce-drive (file up/download) actually move data:
a file split into chunks, content-addressed, transferred with client parallelism.

| object | chunks | conc | upload MB/s | up p50 ms | download MB/s | down p50 ms |
|---|---|---:|---:|---:|---:|---:|
| 4MiB | 4x1MiB | 8 | 12.7 | 268.17 | 13.5 | 166.12 |
| 16MiB | 16x1MiB | 8 | 17.7 | 428.10 | 15.0 | 443.37 |

## 4. Blob fetch (cold, cross-node)

_(no peers with ce-echo running)_

## 5. Concurrency scaling (rpc_rtt @ 1KiB)

| target | concurrency | p50 ms | p99 ms | req/s |
|---|---:|---:|---:|---:|
