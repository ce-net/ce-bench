#!/usr/bin/env node
/**
 * ce-echo — run the ce-bench echo responder against a local CE node, so other nodes can measure
 * mesh RPC round-trip, cold cross-node blob fetch, and pubsub propagation *to* this node.
 *
 *   ce-echo [--url http://localhost:8844] [--token <api.token>] [--quiet]
 *
 * The token is auto-loaded from the platform data dir (or CE_API_TOKEN). Runs until Ctrl-C.
 */
import { CeClient } from "../src/ce.js";
import { startEchoResponder } from "../src/echo.js";
import { apiToken, parseArgs } from "./_env.js";

const args = parseArgs(process.argv.slice(2));
const baseUrl = args.url || "http://127.0.0.1:8844";
const token = args.token || apiToken();
if (!token) {
  console.error("ce-echo: no api.token found (data dir or CE_API_TOKEN). Writes will be rejected.");
  process.exit(1);
}

const ce = new CeClient({ baseUrl, token, timeoutMs: 60000 });

const status = await ce.status().catch((e) => {
  console.error(`ce-echo: cannot reach node at ${baseUrl}: ${e.message}`);
  process.exit(1);
});
console.error(`ce-echo: node ${status.node_id.slice(0, 12)}... at ${baseUrl} (height ${status.height})`);

const ac = new AbortController();
const responder = await startEchoResponder({ ce, signal: ac.signal });
console.error("ce-echo: responding. Ctrl-C to stop.");

if (!args.quiet) {
  setInterval(() => {
    const c = responder.counts;
    console.error(`[ce-echo] echo=${c.echo} putblob=${c.putblob} pubsub=${c.pubsub} errors=${c.errors}`);
  }, 15000).unref();
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.error("\nce-echo: stopping...");
    ac.abort();
    setTimeout(() => process.exit(0), 200);
  });
}
await responder.done;
