/**
 * Turn FalkorDB's max-flow into the set of grants to revoke.
 *
 * `CALL algo.maxFlow` is the engine feature this product cannot live without:
 * it returns the flow on each edge, not the cut. The cut — the minimum-capacity set of
 * grants whose removal breaks every leak — is derived here from the residual
 * graph. Without the flow there is no cut, and without FalkorDB there is no flow.
 *
 * A max-flow admits two canonical minimum cuts: one hugged to the sources, one
 * hugged to the sinks. Both close the modelled route set and both are proven minimal by
 * the same flow value. The product picks the cheaper one for the owner: fewer
 * distinct grants first, fewer broken tasks second, and on a full tie the sink
 * side — so the agent keeps its ability to read and loses only the publish.
 */

export interface FlowEdge {
  id: number;
  from: number;
  to: number;
  capacity: number;
  grant: string | null;
  revocable: boolean;
  /** Declared tasks that call this tool. Capacity is 1 + tasksLost. */
  tasksLost?: number;
  /** Optional labels for citations; unit tests build edges without them. */
  fromLabel?: string;
  toLabel?: string;
}

export type CutSide = "read" | "write" | "mixed" | "none";

export interface Cut {
  /** Distinct revocable grants in the cut, in graph order. */
  grants: string[];
  /** Every original edge that crosses the cut. */
  edges: FlowEdge[];
  maxFlow: number;
  /**
   * Which side of the flow the cut severs. Only `cutFromMaxFlow` knows which
   * node ids are private stores and which are public sinks, so only it sets this.
   */
  side?: CutSide;
}

type Residual = Map<number, { to: number; cap: number }[]>;

function residualGraph(edges: FlowEdge[], flowByEdge: Map<number, number>): Residual {
  const residual: Residual = new Map();
  const add = (from: number, to: number, cap: number) => {
    if (cap <= 1e-9) return;
    const list = residual.get(from) ?? [];
    list.push({ to, cap });
    residual.set(from, list);
  };
  for (const e of edges) {
    const flow = flowByEdge.get(e.id) ?? 0;
    add(e.from, e.to, e.capacity - flow);
    add(e.to, e.from, flow);
  }
  return residual;
}

/**
 * reverse=false: nodes reachable FROM starts.
 * reverse=true:  nodes that can REACH starts (walk the reversed arcs).
 */
function walk(residual: Residual, starts: number[], reverse: boolean): Set<number> {
  const adjacency: Map<number, number[]> = new Map();
  const link = (a: number, b: number) => {
    const list = adjacency.get(a) ?? [];
    list.push(b);
    adjacency.set(a, list);
  };
  for (const [from, arcs] of residual) {
    for (const arc of arcs) {
      if (reverse) link(arc.to, from);
      else link(from, arc.to);
    }
  }
  const seen = new Set<number>(starts);
  const queue = [...starts];
  while (queue.length > 0) {
    const node = queue.shift() as number;
    for (const next of adjacency.get(node) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

function grantsOf(crossing: FlowEdge[]): string[] {
  return [
    ...new Set(crossing.filter((e) => e.revocable && e.grant).map((e) => e.grant as string)),
  ];
}

/**
 * Residual BFS from the source nodes. An edge is in the cut when its tail is
 * still reachable and its head is not — the canonical min cut hugged to the
 * sources.
 */
export function minCut(
  sources: number[],
  edges: FlowEdge[],
  flowByEdge: Map<number, number>,
  maxFlow: number,
): Cut {
  const side = walk(residualGraph(edges, flowByEdge), sources, false);
  const crossing = edges.filter(
    (e) => e.capacity > 0 && side.has(e.from) && !side.has(e.to),
  );
  return { grants: grantsOf(crossing), edges: crossing, maxFlow };
}

/**
 * The canonical min cut hugged to the sinks: an edge crosses when its head can
 * still reach a target in the residual and its tail cannot.
 */
export function sinkSideCut(
  targets: number[],
  edges: FlowEdge[],
  flowByEdge: Map<number, number>,
  maxFlow: number,
): Cut {
  const side = walk(residualGraph(edges, flowByEdge), targets, true);
  const crossing = edges.filter(
    (e) => e.capacity > 0 && !side.has(e.from) && side.has(e.to),
  );
  return { grants: grantsOf(crossing), edges: crossing, maxFlow };
}

/**
 * Both cuts are minimum by value. Pick the one that costs the owner less:
 * fewer distinct grants to revoke, then fewer broken tasks, then the sink side.
 */
export function chooseCut(a: Cut, b: Cut): Cut {
  // A cut you cannot execute is not a fix. Never prefer an all-grant-less cut
  // over one with a revocable grant, even when it looks smaller.
  const actionable = (c: Cut) => (c.edges.length === 0 || c.grants.length > 0 ? 0 : 1);
  if (actionable(a) !== actionable(b)) return actionable(a) < actionable(b) ? a : b;
  if (a.grants.length !== b.grants.length) return a.grants.length < b.grants.length ? a : b;
  const pain = (c: Cut) => {
    const costs = new Map<string, number>();
    for (const edge of c.edges) {
      if (!edge.revocable || !edge.grant) continue;
      // Ingest repeats a tool's task cost on each of its resource edges.
      costs.set(edge.grant, Math.max(costs.get(edge.grant) ?? 0, edge.tasksLost ?? 0));
    }
    return [...costs.values()].reduce((sum, cost) => sum + cost, 0);
  };
  if (pain(a) !== pain(b)) return pain(a) < pain(b) ? a : b;
  return b;
}

/** Which side of the flow a cut severs, given the endpoint id sets. */
export function cutSide(cut: Cut, sourceIds: number[], targetIds: number[]): CutSide {
  if (cut.edges.length === 0) return "none";
  const fromSource = cut.edges.every((e) => sourceIds.includes(e.from));
  const intoSink = cut.edges.every((e) => targetIds.includes(e.to));
  if (fromSource && !intoSink) return "read";
  if (intoSink && !fromSource) return "write";
  return "mixed";
}

/** The shape `algo.maxFlow` returns through the typed FalkorDB client. */
export interface MaxFlowRow {
  maxFlow: number;
  edges: { id: number }[];
  edgeFlows: number[];
}

/**
 * Join a FalkorDB max-flow reply to the graph's edges and return the cut.
 * This is the only place the product turns a FalkorDB result into a decision.
 */
export function cutFromMaxFlow(
  sources: number[],
  targets: number[],
  allEdges: FlowEdge[],
  row: MaxFlowRow | undefined,
): Cut {
  // Degenerate graphs (no private store, no public sink, no FLOWS at all) can
  // reach here with no row. "Nothing to cut" is a valid answer; a crash is not.
  if (!row) return { grants: [], edges: [], maxFlow: 0, side: "none" };
  const flowByEdge = new Map<number, number>();
  row.edges.forEach((edge, i) => {
    flowByEdge.set(edge.id, row.edgeFlows[i] ?? 0);
  });
  const chosen = chooseCut(
    minCut(sources, allEdges, flowByEdge, row.maxFlow),
    sinkSideCut(targets, allEdges, flowByEdge, row.maxFlow),
  );
  return { ...chosen, side: cutSide(chosen, sources, targets) };
}
