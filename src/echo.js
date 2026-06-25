/**
 * @ce-net/bench — ECHO RESPONDER.
 *
 * A zero-dependency mesh service that answers the network-benchmark probes (src/net.js). Run one on
 * every node you want to measure *to*; the probing node then gets real, app-level numbers for the
 * round-trip and content-fetch paths.
 *
 * It speaks only the node's own HTTP API (subscribe + message stream + reply/publish), so it runs
 * anywhere a CE node runs — laptop, relay, browser-adjacent, behind NAT — with nothing but the
 * node's api.token.
 *
 * Topics it serves:
 *   - ECHO_TOPIC ("ce-bench/echo")            request/reply: replies with the exact request payload.
 *   - ECHO_TOPIC + "/putblob"                 request payload = u32-le size; mints a random blob of
 *                                             that size, stores it, replies with the 64-hex hash.
 *                                             (Lets a remote probe trigger a cold cross-node fetch.)
 *   - PUBSUB_REQ_TOPIC ("ce-bench/pub")       pubsub: re-publishes the payload on PUBSUB_RES_TOPIC,
 *                                             so a publisher can time propagation round-trip.
 *
 * @packageDocumentation
 */

import { CeClient } from "./ce.js";
import { ECHO_TOPIC, PUBSUB_REQ_TOPIC, PUBSUB_RES_TOPIC, randomBytes } from "./net.js";

const PUTBLOB_TOPIC = ECHO_TOPIC + "/putblob";

/**
 * Start the echo responder. Resolves once subscriptions are established and returns a handle with
 * `stop()` and live counters. Runs until `signal` aborts or `stop()` is called.
 *
 * @param {object} [a]
 * @param {CeClient|string|object} [a.ce]   Client / base-url / options. Default localhost:8844.
 * @param {(line:string)=>void} [a.log]     Logger. Default console.error (keeps stdout clean).
 * @param {AbortSignal} [a.signal]
 * @returns {Promise<{stop:()=>void, counts:{echo:number,putblob:number,pubsub:number,errors:number}, done:Promise<void>}>}
 */
export async function startEchoResponder(a = {}) {
  const ce = a.ce instanceof CeClient ? a.ce : new CeClient(typeof a.ce === "string" ? { baseUrl: a.ce } : a.ce ?? {});
  const log = a.log ?? ((l) => console.error(l));
  const counts = { echo: 0, putblob: 0, pubsub: 0, errors: 0 };

  for (const t of [ECHO_TOPIC, PUTBLOB_TOPIC, PUBSUB_REQ_TOPIC, PUBSUB_RES_TOPIC]) {
    await ce.subscribe(t);
  }
  log(`[ce-echo] subscribed: ${ECHO_TOPIC}, ${PUTBLOB_TOPIC}, ${PUBSUB_REQ_TOPIC}`);

  const ac = new AbortController();
  if (a.signal) a.signal.addEventListener("abort", () => ac.abort(), { once: true });

  const done = (async () => {
    // Reconnect loop: SSE streams can drop; keep re-subscribing to the message feed until aborted.
    while (!ac.signal.aborted) {
      try {
        for await (const m of ce.meshMessageStream(ac.signal)) {
          handle(ce, m, counts, log).catch((e) => {
            counts.errors++;
            log(`[ce-echo] handler error: ${e instanceof Error ? e.message : e}`);
          });
        }
      } catch (e) {
        if (ac.signal.aborted) break;
        counts.errors++;
        log(`[ce-echo] stream dropped, reconnecting: ${e instanceof Error ? e.message : e}`);
        await sleep(500);
      }
    }
  })();

  return { stop: () => ac.abort(), counts, done };
}

async function handle(ce, m, counts, log) {
  if (m.topic === ECHO_TOPIC) {
    if (m.reply_token != null) {
      await ce.meshReply(m.reply_token, hexToBytes(m.payload_hex));
      counts.echo++;
    }
    return;
  }
  if (m.topic === PUTBLOB_TOPIC) {
    if (m.reply_token != null) {
      const size = readU32le(hexToBytes(m.payload_hex)) || 1 << 20;
      const hash = await ce.putBlob(randomBytes(size));
      await ce.meshReply(m.reply_token, new TextEncoder().encode(hash));
      counts.putblob++;
    }
    return;
  }
  if (m.topic === PUBSUB_REQ_TOPIC) {
    // Mirror the payload back on the response topic so the publisher can time propagation.
    await ce.publish(PUBSUB_RES_TOPIC, hexToBytes(m.payload_hex));
    counts.pubsub++;
    return;
  }
}

function hexToBytes(hex) {
  const h = hex ?? "";
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function readU32le(b) {
  if (b.length < 4) return 0;
  return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
