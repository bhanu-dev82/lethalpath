<div align="left">
  <img src="docs/logo.svg" width="72" alt="LethalPath logo">
</div>

# LethalPath

*Find the MCP tool combinations that let an agent leak your data, and compute a minimum cut of permissions that closes them.*

[![CI](https://github.com/bhanu-dev82/lethalpath/actions/workflows/ci.yml/badge.svg)](https://github.com/bhanu-dev82/lethalpath/actions/workflows/ci.yml)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-0B6E99?style=flat-square)](./LICENSE)
[![FalkorDB 6.0.2](https://img.shields.io/badge/FalkorDB-6.0.2-C0392B?style=flat-square)](https://www.falkordb.com)
[![node ≥20](https://img.shields.io/badge/node-%E2%89%A520-026E00?style=flat-square)](https://nodejs.org)
[![pnpm 9](https://img.shields.io/badge/pnpm-9-B45309?style=flat-square)](https://pnpm.io)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](./CONTRIBUTING.md)

**Powered by [FalkorDB](https://www.falkordb.com).** The leak search is a Cypher
query; the fix is `CALL algo.maxFlow` plus a residual cut in TypeScript.

Finds modelled routes by which an AI agent can be tricked into leaking data
across its MCP servers, then computes a minimum-capacity cut and chooses the
cheaper of the two canonical cuts by grant count, declared-task cost, then the
write side.

Made by [Bhanu Nagpure](https://github.com/bhanu-dev82). Live site:
[devanshustudios.com/lethalpath](https://www.devanshustudios.com/lethalpath/).
**Demo:** [3:20 walkthrough](https://www.devanshustudios.com/lethalpath/#demo) ·
live conductor: `bash scripts/live-demo.sh`.

**How FalkorDB is used.** Every scan is a FalkorDB graph (`scan_<name>`). The
route query is Cypher; the fix is `CALL algo.maxFlow` on that graph, followed by
a residual cut in TypeScript. Product reads go through `GRAPH.RO_QUERY`, so a
generated query cannot write. The guard appends its decisions to a per-session
audit graph (`sessions_<id>`); the block decision itself is in-process. The
table [below](#falkordb-features-this-product-calls) lists every call, including
what we do not claim: shortest-path indexes (CCH) are documented and are not in
6.0.2.

> Numbers appear in this README only with the file that contains them named
> beside them — the eval results, the live-evidence log, or the fixture itself.

**New here? Jump to the [Quick start](#quick-start).**

## Contents

- [Why the graph is load-bearing](#why-the-graph-is-load-bearing)
- [The problem](#the-problem)
- [Quick start](#quick-start)
- [The graph](#the-graph)
- [The queries](#the-queries)
- [FalkorDB features this product calls](#falkordb-features-this-product-calls)
- [Engine facts](#engine-facts)
- [Results](#results)
- [Limits](#limits)
- [Data](#data)
- [What we learned](#what-we-learned)
- [Credits and prior work](#credits-and-prior-work)
- [AI use](#ai-use) · [Licence](#licence)

---

## Why the graph is load-bearing

Remove the graph and the route, the cut and the receipt stop existing.

| What the product does | What runs it | What happens if FalkorDB is removed |
|---|---|---|
| Find the leak route | `MATCH … -[:FLOWS*1..5]->(ctx)-[:FLOWS*1..5]->` — bounded segments anchored at the tainted context | There is no path. A list of tools cannot express "through this folder". |
| Choose the permission to revoke | `CALL algo.maxFlow` then a residual cut | There is no flow, so there is no cut. `cutFromMaxFlow` has nothing to consume. |
| Prove the fix closed it | `VERIFY_FIX`, the same traversal with `$revoked` excluded | There is no second query to re-run. The promise has no receipt. |
| Keep analysis read-only | `GRAPH.RO_QUERY` | The server-side rejection is gone. An application regex is not the same guarantee. |

`packages/core/src/analysis/mincut.live.test.ts` is the executable version of
this table: it opens FalkorDB 6.0.2, runs `algo.maxFlow`, and checks the cut.

## The problem

An agent that can read text an attacker controls, read private data, and write
somewhere public can be steered into exfiltrating that data. Each tool behaves
exactly as documented — the bug is in the *arrangement*. Simon Willison calls
this the [lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/).

The arrangement is a path: `untrusted → private → public`. Paths are what graphs
answer, and a vector index cannot.

## Quick start

```bash
git clone https://github.com/bhanu-dev82/lethalpath && cd lethalpath
docker compose up -d                     # FalkorDB 6.0.2, pinned by tag — not :latest
pnpm install
pnpm build                               # every workspace package, in dependency order

node packages/cli/dist/index.js scan     # builds the graph, lists the routes
node packages/cli/dist/index.js fix      # algo.maxFlow → the computed cut
node packages/cli/dist/index.js scan data/fixtures/clean.json   # the abstention
node packages/cli/dist/index.js scan --mcp data/fixtures/mcp-demo.json   # label a real MCP config, then scan it

pnpm --filter @lethalpath/core test      # the suite, against the live instance
pnpm --filter @lethalpath/guard demo     # demo MCP session with simulated tool results: the poisoned push is blocked, a clean one is not
pnpm --filter @lethalpath/eval evaluate  # the 40-case eval the Results section quotes
```

Or run the whole sequence with pauses between acts — the same commands, the
same output, plus a trimmed 567-route dump:

```bash
bash scripts/live-demo.sh          # pauses between acts
bash scripts/live-demo.sh --no-pause   # straight through
```

`scan` and `fix` accept `--json`; both read the fixture `data/fixtures/fs-git.json`
by default. One graph per config: `scan_fs-git`, `scan_clean` — FalkorDB's
multigraph model is the isolation.

Already running FalkorDB (say, from an earlier `docker compose up -d`)? Skip
that step — every command here talks to `localhost:6379` and fails loudly if
nothing answers.

`--mcp mcp.json` puts the labeler (`packages/labeler`) in front of the same
pipeline: the rules table labels every tool, unmatched tools are **named, not
hidden**, and secrets never leave the machine — values and token-shaped server
names alike are redacted before anything reaches the graph. Point it at a real
config and the graph is your own arrangement — the committed
`data/fixtures/mcp-demo.json` prints 567 routes and a nine-grant cut that
closes the route set.

![the scan_mcp-github-filesystem-git graph in FalkorDB Browser](./docs/browser-scan-mcp.png)

*The demo config after `scan --mcp data/fixtures/mcp-demo.json`: 40 tools across
three servers — 49 nodes, 120 edges. The stats bar shows the Browser's default
`LIMIT 100` view of that graph.*

### What `scan` prints

```
LethalPath  ·  built for FalkorDB 6.0.2

config    fs-git · A public issue steers the agent through the private folder out to a public repo
graph     scan_fs-git · 11 nodes · 9 edges · ready
guard     GRAPH.RO_QUERY · LIMIT 100 · 3 s timeout · write keywords refused
engine    leak two anchored segments through the tainted context · fix CALL algo.maxFlow + residual min-cut

LEAK PATHS
  1  4 hops  project folder → filesystem.read → context → git.push → public repo
     injection  github issue → github.read → context
     in         project folder · ~/work/stats
     out        public repo · github.com/acme/notes

1 route found — every one of them is a permission you granted.
  next  lethalpath fix
```

### What `fix` prints

```
max-flow   2
cut        write side · git.push → public repo
revoke     git.push
verified   0 of 1 routes remain (leak query re-run without git.push)
tasks      3 of 4 keep working
           loses: publish the changelog
```

The cost model is `capacity = 1 + declared tasks that use the grant`, so the
min-cut prefers the permission that breaks fewer declared tasks. The fix is
then *verified* by re-running the leak query with the revoked grants excluded:
a count of 0 is the receipt.

## The graph

| node | holds |
|---|---|
| `Server` | which MCP server supplies which tools |
| `Resource` | data, by label only: `kind`, `scope`, `trust`, `sensitivity`, `visibility` |
| `Tool` | `name`, `server`, `labelSource`, `labelConf` |
| `Context` | one hub per agent: what the context window can absorb |
| `Meta` | config id, counts, and the `ready` flag — the last write of ingest |

One capacity relationship type, because `algo.maxFlow` on 6.0.2 accepts exactly
one. The structural `HOSTS` edge is not passed to max-flow:

```cypher
(a)-[:FLOWS {dir: 'feeds'|'emits', capacity, revocable, grant, taskCost}]->(b)
```

| movement | edge | capacity |
|---|---|---|
| tool reads a resource | `(res)-[:FLOWS]->(tool)` | `1 + taskCost` |
| tool writes a resource | `(tool)-[:FLOWS]->(res)` | `1 + taskCost` |
| tool fills the context | `(tool)-[:FLOWS]->(context)` | `1000000` (structural) |
| context feeds a tool | `(context)-[:FLOWS]->(tool)` | `1000000` (structural) |

`grant` is the tool name — the permission you would revoke. Structural hub edges
can never land in a cut; their capacity dwarfs every real cost. `(:Meta).ready`
flips only after the whole graph is built, so a scan never reads a half-built
graph.

![the scan_fs-git graph in FalkorDB Browser](./docs/browser-scan-fs-git.png)

*`scan_fs-git` in the FalkorDB Browser (`localhost:3000` after
`docker compose up -d`): 11 nodes, 9 edges, the `FLOWS`/`HOSTS` legend, and the
Browser's own stats bar. The capture steps — read-only, `GRAPH.RO_QUERY` — are
in [`docs/browser-shots.md`](./docs/browser-shots.md).*

### The queries

**1 — The route (`LEAK_PATH`).** Untrusted input reaches the context through one
tool; a private store reaches a public sink through a chain that passes through
the *same* context. That "through the same context" clause is the one a join
cannot write and a vector index cannot express.

```cypher
MATCH inj = (u:Resource {trust:'untrusted'})-[:FLOWS]->(:Tool)-[:FLOWS]->(ctx:Context)
MATCH leak = (p:Resource {sensitivity:'private'})
             -[:FLOWS*1..5]->(ctx)
             -[:FLOWS*1..5]->(s:Resource {visibility:'public'})
RETURN u.kind AS injected_from,
       [n IN nodes(inj) | coalesce(n.kind, n.name, n.id)] AS injection,
       [n IN nodes(leak) | coalesce(n.kind, n.name, n.id)] AS chain,
       [n IN nodes(leak) WHERE n:Tool | n.name] AS tools,
       length(leak) AS hops
ORDER BY hops ASC LIMIT 25
```

The `chain` and `injection` columns exist so citations resolve to `kind` and
`scope` ("project folder · ~/work/stats"), never to internal node ids. When two
resources share a kind, the CLI prints `scope omitted — 2 resources share this
kind` instead of guessing which one the route ran through.

The two bounded segments are anchored at the injecting context on purpose. A
free `*2..10` walk can re-enter the shared hub and enumerate exponentially — a
twelve-tool config timed the server out; the anchored form answers in hundreds
of milliseconds at twenty. It also tightens the semantics: the route must pass
through the tainted context itself, not merely some context.

The list itself is capped at 25 rows so a display never explodes. `LEAK_COUNT`
runs the same anchored traversal without the cap, and `scan` prints both — a
capped list must never be mistaken for the count.

On a graph where many tools chain through the shared hub, the walk count
explodes combinatorially: a 40-tool config of that shape — committed as
`data/fixtures/many-tools.json` — produces 126,321 walks, and the *ordered*
query dies at the server's budget while `LEAK_COUNT`, which materialises no
path values, answers comfortably inside it. `scan` catches that and retries
with `LEAK_PATH_FAST` — the same traversal without `ORDER BY`, so `LIMIT 25`
applies while rows stream — and prints that the order is arbitrary. If even
that fails it counts without listing. `--json` carries `pathOrder`, so nothing
downstream mistakes arbitrary for shortest, and the cut is never affected:
`fix data/fixtures/many-tools.json` revokes one grant and verifies 0 of
126,321 routes remain.

**2 — The fix (`MIN_CUT`).** One `CALL`, sources are private stores, targets are
public sinks:

```cypher
MATCH (p:Resource {sensitivity:'private'})
WHERE p.visibility IS NULL OR p.visibility <> 'public'
WITH collect(p) AS src
MATCH (s:Resource {visibility:'public'})
WHERE s.sensitivity IS NULL OR s.sensitivity <> 'private'
WITH src, collect(s) AS dst
CALL algo.maxFlow({sourceNodes: src, targetNodes: dst,
                   relationshipTypes: ['FLOWS'], capacityProperty: 'capacity'})
YIELD maxFlow, edges, edgeFlows
RETURN maxFlow, edges, edgeFlows
```

`algo.maxFlow` returns flows, not the cut. The cut is derived from the residual
graph in `packages/core/src/analysis/mincut.ts`. A max-flow admits two canonical
minimum cuts — one hugged to the sources, one to the sinks. Both close every
route; the product picks the one that costs you less: a cut you can actually
execute first (an all-grant-less cut is not a fix), fewer distinct grants
second, fewer broken tasks third, and on a full tie the **write** side, so the
agent keeps its ability to read and loses only the publish.

The `WHERE` clauses keep a resource that is somehow labelled both private and
public out of both sides: max-flow requires disjoint source and sink sets, and
that label combination is a config smell worth refusing, not crashing on.

**3 — The receipt (`VERIFY_FIX`).** The same traversal, with the revoked grants'
edges excluded through a list parameter (`$revoked` binds via the `CYPHER k=v`
prefix, like every parameter here):

```cypher
MATCH (u:Resource {trust:'untrusted'})-[:FLOWS]->(:Tool)-[:FLOWS]->(ctx:Context)
MATCH leak = (p:Resource {sensitivity:'private'})
             -[:FLOWS*1..5]->(ctx)
             -[:FLOWS*1..5]->(s:Resource {visibility:'public'})
WHERE all(rel IN relationships(leak) WHERE rel.grant IS NULL OR NOT (rel.grant IN $revoked))
RETURN count(leak) AS remaining
```

Zero rows is the receipt. The CLI runs it on every `fix`; the test suite proves
both directions (1 route before the revoke, 0 after).

## FalkorDB features this product calls

Every FalkorDB call this repository makes:

| Feature | Where | Why it has to be FalkorDB |
|---|---|---|
| `algo.maxFlow` | `MIN_CUT` in `paths.ts`, consumed by `cutFromMaxFlow` | The fix. One relationship type, verified on 6.0.2. |
| Bounded variable-length segments anchored at a bound node + `relationships(path)` | `LEAK_PATH`, `VERIFY_FIX` | The laundering hop, and the receipt. |
| `GRAPH.RO_QUERY` | `GraphDB.read` — analysis and CLI reads | Cannot write, enforced by the server. |
| `id()` | joining `edgeFlows` back onto grants | Edge identity across two queries. |
| Multigraph (`select_graph`) | one `scan_*` per config, `sessions_*` per session | One graph per scan or session; deleting a run is deleting a graph. |
| Pinned image `falkordb/falkordb:6.0.2` | `docker-compose.yml` | The engine we verified, not whatever `:latest` is tomorrow. |

We do **not** use CCH. It is documented but not present in 6.0.2.

## Engine facts

Pinned to `falkordb/falkordb:6.0.2`. Verified on that image, not assumed from docs:

- `algo.maxFlow` requires exactly one relationship type and returns flows, not cuts.
- Parameters bind through the `CYPHER k=v` query prefix; the trailing `PARAMS` form
  does not bind.
- A relationship list variable cannot be bound alongside a named path in the same
  pattern; `relationships(path)` works.
- JavaScript UDFs require `falkor.register()` and are not restored on restart.
- Shortest-path indexes (CCH) are **not available** in 6.0.2. We do not use them.

## Results

The harness in `packages/eval` generates 40 seeded scan configs with known
ground truth — planted routes, laundering-only routes, clean configs, and tie
cases where both canonical cuts are available — then measures the engine and
writes `packages/eval/results/detection.json` and `fix-quality.json`. This
section quotes only those files, and they are committed.

```bash
pnpm --filter @lethalpath/eval build && node packages/eval/dist/run.js
```

| Suite | Cases | Passed | Failed |
|---|---|---|---|
| detection → `results/detection.json` | 40 | 40 | 0 |
| fix-quality → `results/fix-quality.json` | 40 | 40 | 0 |

Both files break the same 40 cases down the same way: **leak 16/16 ·
laundering 8/8 · clean 8/8 · tie 8/8**, `failures` empty in both. The
generator is seeded (`mulberry32`, seed 20261017), and every case ran live
against FalkorDB 6.0.2 at `localhost:6379` on 2026-10-17.

Detection asks whether the scan finds the planted route — and stays silent on
the eight clean configs. Fix-quality asks whether the cut matches the
constructed answer, whether `VERIFY_FIX` takes the route count to zero, and
how many declared tasks keep working. The eight clean cases return an empty
cut; the verification and task checks are not run on them. The tie cases are
the ones where both canonical cuts close the route set; they exercise the
documented write-side tie-break.

These are synthetic configs from our own generator, so they show the engine is
consistent with its spec, not that it is accurate on real users' setups.

One run on a config that is not ours: `data/fixtures/mcp-public-readmes.json`
copies the GitHub, filesystem and git entries from the official MCP server
READMEs. `scan --mcp` on it finds 567 routes; `fix` revokes the 9 write grants
(every github write plus `git.push`) and the re-run finds 0. The public-readmes
transcript used the 6.0.1 module build
(`docs/live-evidence/public-readmes-2026-10-17T18:54:57Z.log`); a config with
the same three servers (`data/fixtures/mcp-demo.json`) was run on the pinned
6.0.2 container in `docs/live-evidence/run-2026-10-17T13:52:42Z.log` and gives
the same count.

## Limits

- **Labels are inferred** from tool names, not verified against server code. Unmatched tools are
  named as unlabelled, never silently trusted.
- **The traversal is bounded** at five hops on each side of the context. Longer routes are outside
  the model.
- **The runtime guard is a demo**: real MCP stdio, simulated tool results. No real GitHub,
  filesystem or git server sits behind it yet.
- **The 40-case eval is synthetic** and generated by us. It shows the engine is consistent with its
  spec, not that it is accurate on real user setups.
- **The label gold set is self-authored**: a regression check, not external ground truth.
- **No CCH, no JavaScript UDF, no index.** We do not use or claim them on 6.0.2.
- **Computer-use servers** (screen read plus click/type) hold the whole trifecta inside one server,
  so name-based labels cannot separate input, private data and sink. The cheapest static cut there
  is revoking the write side, which leaves the server useless; these need runtime rules (#3).

## Data

Public and synthetic only. The graph stores capability *labels*, never file
contents, message bodies or credentials. The sessions graph the guard writes
holds tool names, decisions and a short hash of the arguments — never the
arguments. Fixtures and eval configs are synthetic; demo repositories hold fake
secrets.

## What we learned

- **We planned the wrong product first.** An MCP tool *router* is a real pain,
  but its fix does not need a graph, and it already ships elsewhere. That made
  it a thin wrapper around a data store, so we dropped it. The replacement makes
  the graph load-bearing: remove it and the route, the cut, and the receipt all
  stop existing.
- **The docs were ahead of the engine.** The shortest-path index (CCH) is
  documented and does not run on the pinned image; same for the trailing
  `PARAMS` parameter form. We verified by execution, wrote the fallbacks (a
  residual min-cut; the `CYPHER k=v` prefix), and recorded both rather than
  quoting benchmarks we could not reproduce.
- **A constraint simplified the model.** `algo.maxFlow` accepts exactly one
  relationship type, so `FEEDS`/`EMITS` collapsed into one `FLOWS` type with a
  `dir` property. The final schema is simpler than the plan.
- **The cut is not the flow.** Our first fix query expected `algo.maxFlow` to
  return a cut. It returns flows; the cut is ours to compute, and the product is
  better for it — that code is where the cut-selection logic lives.
- **A guard is only as good as its refusal order.** The first version appended a
  `LIMIT` to write statements too; the fix was to refuse write keywords *before*
  dispatch, not to sanitise after. Same lesson at the server: `GRAPH.RO_QUERY`
  rejects, it does not negotiate.
- **Contrast is measurable, not a vibe.** The first palette failed AAA on two
  surfaces; the shipped one was measured pair by pair.

## Credits and prior work

- [Bhanu Nagpure](https://github.com/bhanu-dev82) — creator of LethalPath. Live site: https://www.devanshustudios.com/lethalpath/
- [FalkorDB](https://www.falkordb.com/) — the engine every query runs on. See [FalkorDB features this product calls](#falkordb-features-this-product-calls).
- Simon Willison — the [lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/), the framing this product builds on.
- Related tools and papers that informed the design are listed with links in
  [`docs/RELATED-WORK.md`](./docs/RELATED-WORK.md).

## AI use

See [`AI_DISCLOSURE.md`](./AI_DISCLOSURE.md).

## Licence

Apache-2.0. See [`LICENSE`](./LICENSE).
