# CE network benchmark report

- node: `c0be11e0ce0aaa76...`
- at: 2026-06-25T16:52:52.246Z
- base: http://127.0.0.1:8844 (height 2670)

## 1. Transport ping floor (/netgraph)

| peer | rtt_ms | samples |
|---|---:|---:|
| `12D3KooWC6vy` | 39.34 | 26 |
| `12D3KooWCNCy` | 9.23 | 1719 |

## 2. Mesh RPC round-trip (request/reply)

p50/p90/p99 in ms; req/s at concurrency 1.

| target | payload | p50 | p90 | p99 | req/s | err |
|---|---|---:|---:|---:|---:|---:|
| `21f5c206ffbf` | _skipped_ | | | | | no reply (ce-echo not running?) |

## 3. Blob store (local)

| op | size | p50 ms | p99 ms | MB/s (p50) | agg MB/s | err |
|---|---|---:|---:|---:|---:|---:|
| put | 4KiB | 9.94 | 331.65 | 0.4 | 0.1 | 0 |
| put | 256KiB | 10.12 | 166.75 | 24.7 | 6.7 | 0 |
| get_local | 4KiB | 4.12 | 9.99 | 0.9 | 0.7 | 0 |
| get_local | 256KiB | 20.67 | 307.08 | 12.1 | 3.4 | 0 |

## 4. Blob fetch (cold, cross-node)

_(no peers with ce-echo running)_

## 5. Concurrency scaling (rpc_rtt @ 1KiB)

| target | concurrency | p50 ms | p99 ms | req/s |
|---|---:|---:|---:|---:|
