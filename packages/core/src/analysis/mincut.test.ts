/**
 * The min-cut, proven on graphs whose answers are known by hand.
 * No database: this is the arithmetic FalkorDB's flow is fed into.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chooseCut,
  cutFromMaxFlow,
  cutSide,
  minCut,
  sinkSideCut,
  type Cut,
  type FlowEdge,
} from "./mincut.js";

// private --1--> tool --1--> public. Both edges saturated. The source-side cut
// is the first edge, because nothing downstream of it is reachable.
const edges: FlowEdge[] = [
  { id: 0, from: 0, to: 2, capacity: 1, grant: "filesystem.write", revocable: true },
  { id: 1, from: 2, to: 1, capacity: 1, grant: "git.push", revocable: true },
];
const flow = new Map<number, number>([
  [0, 1],
  [1, 1],
]);

test("saturated path cuts at the source edge", () => {
  const cut = minCut([0], edges, flow, 1);
  assert.equal(cut.maxFlow, 1);
  assert.deepEqual(cut.grants, ["filesystem.write"]);
  assert.equal(cut.edges.length, 1);
});

test("a structural edge with spare capacity is not the cut", () => {
  const wide: FlowEdge[] = [
    { id: 0, from: 0, to: 2, capacity: 1, grant: "git.push", revocable: true },
    { id: 1, from: 2, to: 1, capacity: 1_000_000, grant: null, revocable: false },
  ];
  const cut = minCut([0], wide, new Map([[0, 1], [1, 1]]), 1);
  assert.deepEqual(cut.grants, ["git.push"]);
  assert.ok(cut.edges.every((e) => e.revocable));
});

test("no flow means no cut", () => {
  const cut = minCut([0], edges, new Map(), 0);
  assert.deepEqual(cut.grants, []);
  assert.equal(cut.edges.length, 0);
});

// A dumbbell: both edges saturated, so the cut is genuinely ambiguous — one
// canonical cut sits at the source edge, the other at the sink edge.
const dumbbell: FlowEdge[] = [
  { id: 0, from: 0, to: 1, capacity: 2, grant: "files.read", revocable: true, tasksLost: 3 },
  { id: 1, from: 1, to: 2, capacity: 2, grant: "git.push", revocable: true, tasksLost: 0 },
];
const dumbbellFlow = new Map<number, number>([
  [0, 2],
  [1, 2],
]);

test("both canonical cuts close the route", () => {
  assert.deepEqual(minCut([0], dumbbell, dumbbellFlow, 2).grants, ["files.read"]);
  assert.deepEqual(sinkSideCut([2], dumbbell, dumbbellFlow, 2).grants, ["git.push"]);
});

test("the tie-break prefers the cut that breaks fewer tasks", () => {
  const chosen = chooseCut(
    minCut([0], dumbbell, dumbbellFlow, 2),
    sinkSideCut([2], dumbbell, dumbbellFlow, 2),
  );
  assert.deepEqual(chosen.grants, ["git.push"]);
});

test("on a full tie the write side wins, so the read survives", () => {
  const readSide: Cut = {
    grants: ["files.read"],
    edges: [
      { id: 0, from: 0, to: 1, capacity: 1, grant: "files.read", revocable: true, tasksLost: 0 },
    ],
    maxFlow: 1,
  };
  const writeSide: Cut = {
    grants: ["git.push"],
    edges: [
      { id: 1, from: 1, to: 2, capacity: 1, grant: "git.push", revocable: true, tasksLost: 0 },
    ],
    maxFlow: 1,
  };
  assert.deepEqual(chooseCut(readSide, writeSide).grants, ["git.push"]);
});

test("cutSide names the side from the endpoints", () => {
  const a = minCut([0], dumbbell, dumbbellFlow, 2);
  const b = sinkSideCut([2], dumbbell, dumbbellFlow, 2);
  assert.equal(cutSide(a, [0], [2]), "read");
  assert.equal(cutSide(b, [0], [2]), "write");
  assert.equal(cutSide({ grants: [], edges: [], maxFlow: 0 }, [0], [2]), "none");
});

test("zero flow cuts nothing on either side", () => {
  assert.equal(sinkSideCut([2], dumbbell, new Map(), 0).edges.length, 0);
});

test("a revocable min cut beats one with nothing to revoke", () => {
  // The sink-side crossing has a grant; the source-side crossing does not.
  // Ranking by size alone would pick the cut nobody can execute.
  const pair: FlowEdge[] = [
    { id: 0, from: 0, to: 2, capacity: 1, grant: null, revocable: false },
    { id: 1, from: 2, to: 1, capacity: 1, grant: "g_ts", revocable: true },
  ];
  const cut = cutFromMaxFlow([0], [1], pair, {
    maxFlow: 1,
    edges: [{ id: 0 }, { id: 1 }],
    edgeFlows: [1, 1],
  });
  assert.deepEqual(cut.grants, ["g_ts"]);
  assert.equal(cut.side, "write");
});

test("no max-flow row is an empty cut, not a crash", () => {
  const cut = cutFromMaxFlow([0], [1], dumbbell, undefined);
  assert.deepEqual(cut, { grants: [], edges: [], maxFlow: 0, side: "none" });
});

// Both canonical cuts have capacity 7 and two grants. Read loses 3 tasks;
// write loses 2. Counting repeated resource edges instead makes write cost 4.
const equalCapacityEdges: FlowEdge[] = [
  { id: 0, from: 0, to: 4, capacity: 4, grant: "read.high", revocable: true, tasksLost: 3 },
  { id: 1, from: 1, to: 5, capacity: 1, grant: "read.free", revocable: true, tasksLost: 0 },
  { id: 2, from: 2, to: 5, capacity: 1, grant: "read.free", revocable: true, tasksLost: 0 },
  { id: 3, from: 3, to: 5, capacity: 1, grant: "read.free", revocable: true, tasksLost: 0 },
  { id: 4, from: 4, to: 6, capacity: 1_000_000, grant: null, revocable: false },
  { id: 5, from: 5, to: 6, capacity: 1_000_000, grant: null, revocable: false },
  { id: 6, from: 6, to: 7, capacity: 1_000_000, grant: null, revocable: false },
  { id: 7, from: 6, to: 8, capacity: 1_000_000, grant: null, revocable: false },
  { id: 8, from: 7, to: 9, capacity: 1, grant: "write.free", revocable: true, tasksLost: 0 },
  { id: 9, from: 8, to: 10, capacity: 3, grant: "write.shared", revocable: true, tasksLost: 2 },
  { id: 10, from: 8, to: 11, capacity: 3, grant: "write.shared", revocable: true, tasksLost: 2 },
];
const equalCapacityFlows = [4, 1, 1, 1, 4, 3, 1, 6, 1, 3, 3];

test("equal-capacity cuts count task loss once per grant", () => {
  const flows = new Map(equalCapacityFlows.map((value, id) => [id, value]));
  const read = minCut([0, 1, 2, 3], equalCapacityEdges, flows, 7);
  const write = sinkSideCut([9, 10, 11], equalCapacityEdges, flows, 7);
  for (const cut of [read, write]) {
    assert.equal(cut.edges.reduce((sum, edge) => sum + edge.capacity, 0), 7);
    assert.equal(cut.grants.length, 2);
    for (const edge of cut.edges) assert.equal(edge.capacity, 1 + (edge.tasksLost ?? 0));
  }
  assert.deepEqual(chooseCut(read, write).grants, ["write.free", "write.shared"]);
  assert.equal(cutFromMaxFlow([0, 1, 2, 3], [9, 10, 11], equalCapacityEdges, {
    maxFlow: 7,
    edges: equalCapacityEdges.map(({ id }) => ({ id })),
    edgeFlows: equalCapacityFlows,
  }).side, "write");
});

test("grant task costs do not depend on edge ordering", () => {
  const repeated: Cut = {
    grants: ["read"], maxFlow: 1,
    edges: [
      { id: 0, from: 0, to: 1, capacity: 1, grant: "read", revocable: true, tasksLost: 1 },
      { id: 1, from: 0, to: 2, capacity: 1, grant: "read", revocable: true, tasksLost: 3 },
    ],
  };
  const other: Cut = {
    grants: ["write"], maxFlow: 1,
    edges: [{ id: 2, from: 2, to: 3, capacity: 1, grant: "write", revocable: true, tasksLost: 2 }],
  };
  assert.equal(chooseCut(repeated, other), other);
  assert.equal(chooseCut({ ...repeated, edges: [...repeated.edges].reverse() }, other), other);
});

test("task loss ignores non-revocable and grant-less edges", () => {
  const a: Cut = { grants: ["a"], maxFlow: 1, edges: [
    { id: 0, from: 0, to: 1, capacity: 1, grant: "a", revocable: true },
    { id: 1, from: 1, to: 2, capacity: 1, grant: null, revocable: false, tasksLost: 99 },
    { id: 2, from: 2, to: 3, capacity: 1, grant: "structural", revocable: false, tasksLost: 99 },
  ] };
  const b: Cut = { grants: ["b"], maxFlow: 1, edges: [
    { id: 3, from: 3, to: 4, capacity: 1, grant: "b", revocable: true, tasksLost: 1 },
  ] };
  assert.equal(chooseCut(a, b), a);
});
