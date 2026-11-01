/**
 * The receipt: FalkorDB's algo.maxFlow, on a live 6.0.2 instance, is what
 * produces the grant we revoke. Remove the database and this test cannot run.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { GraphDB } from "../db.js";
import { MIN_CUT } from "./paths.js";
import { cutFromMaxFlow, type FlowEdge, type MaxFlowRow } from "./mincut.js";

/** Graphs this file created; the after hook deletes exactly these. */
const created: string[] = [];

/** `pnpm test` leaves GRAPH.LIST exactly as it found it. */
after(async () => {
  for (const name of created) {
    const db = await GraphDB.open(name);
    try {
      await db.drop();
    } catch {
      /* already gone; nothing to delete */
    } finally {
      await db.close();
    }
  }
});

const FIXTURE = `
CREATE (p:Resource {name:'files', sensitivity:'private'})
CREATE (s:Resource {name:'repo', visibility:'public'})
CREATE (t:Tool {name:'git.push'})
CREATE (p)-[:FLOWS {dir:'feeds', capacity:1, grant:'git.push', revocable:true}]->(t)
CREATE (t)-[:FLOWS {dir:'emits', capacity:1, grant:'git.push', revocable:true}]->(s)
`;

test("live FalkorDB max-flow yields the grant to revoke", async (t) => {
  const name = `cut_${Date.now()}`;
  created.push(name);
  const db = await GraphDB.open(name);
  t.after(() => db.close());
  await db.write(FIXTURE);

  const listed = await db.read(`
    MATCH (a)-[e:FLOWS]->(b)
    RETURN id(e) AS id, id(a) AS fromId, id(b) AS toId,
           e.capacity AS capacity, e.grant AS grant, e.revocable AS revocable,
           e.taskCost AS taskCost
  `);
  const edges: FlowEdge[] = listed.rows.map((row) => ({
    id: Number(row["id"]),
    from: Number(row["fromId"]),
    to: Number(row["toId"]),
    capacity: Number(row["capacity"]),
    grant: row["grant"] == null ? null : String(row["grant"]),
    revocable: Boolean(row["revocable"]),
    tasksLost: Number(row["taskCost"] ?? 0),
  }));

  const sources = await db.read(`
    MATCH (p:Resource {sensitivity:'private'})
    WHERE p.visibility IS NULL OR p.visibility <> 'public'
    RETURN id(p) AS id
  `);
  const sourceIds = sources.rows.map((row) => Number(row["id"]));
  const targets = await db.read(`
    MATCH (s:Resource {visibility:'public'})
    WHERE s.sensitivity IS NULL OR s.sensitivity <> 'private'
    RETURN id(s) AS id
  `);
  const targetIds = targets.rows.map((row) => Number(row["id"]));

  const flow = await db.read(MIN_CUT);
  const row = flow.rows[0] as unknown as MaxFlowRow;
  assert.ok(row, "algo.maxFlow returned a row");
  assert.equal(row.maxFlow, 1);

  const cut = cutFromMaxFlow(sourceIds, targetIds, edges, row);
  assert.deepEqual(cut.grants, ["git.push"]);
  assert.equal(cut.side, "write");
});

test("equal-capacity live cuts rank task loss by distinct grant", async (t) => {
  const name = `cut_shared_${Date.now()}`;
  created.push(name);
  const db = await GraphDB.open(name);
  t.after(() => db.close());
  await db.write(`
CREATE (p0:Resource {sensitivity:'private'}), (p1:Resource {sensitivity:'private'}),
       (p2:Resource {sensitivity:'private'}), (p3:Resource {sensitivity:'private'}),
       (r0:Tool {name:'read.high'}), (r1:Tool {name:'read.free'}), (c:Context),
       (w0:Tool {name:'write.free'}), (w1:Tool {name:'write.shared'}),
       (s0:Resource {visibility:'public'}), (s1:Resource {visibility:'public'}),
       (s2:Resource {visibility:'public'})
CREATE (p0)-[:FLOWS {capacity:4, grant:'read.high', taskCost:3, revocable:true}]->(r0),
       (p1)-[:FLOWS {capacity:1, grant:'read.free', taskCost:0, revocable:true}]->(r1),
       (p2)-[:FLOWS {capacity:1, grant:'read.free', taskCost:0, revocable:true}]->(r1),
       (p3)-[:FLOWS {capacity:1, grant:'read.free', taskCost:0, revocable:true}]->(r1),
       (r0)-[:FLOWS {capacity:1000000, revocable:false}]->(c),
       (r1)-[:FLOWS {capacity:1000000, revocable:false}]->(c),
       (c)-[:FLOWS {capacity:1000000, revocable:false}]->(w0),
       (c)-[:FLOWS {capacity:1000000, revocable:false}]->(w1),
       (w0)-[:FLOWS {capacity:1, grant:'write.free', taskCost:0, revocable:true}]->(s0),
       (w1)-[:FLOWS {capacity:3, grant:'write.shared', taskCost:2, revocable:true}]->(s1),
       (w1)-[:FLOWS {capacity:3, grant:'write.shared', taskCost:2, revocable:true}]->(s2)
`);
  const listed = await db.read(`
    MATCH (a)-[e:FLOWS]->(b)
    RETURN id(e) AS id, id(a) AS fromId, id(b) AS toId,
           e.capacity AS capacity, e.grant AS grant, e.revocable AS revocable,
           e.taskCost AS taskCost
  `);
  const edges: FlowEdge[] = listed.rows.map((row) => ({
    id: Number(row["id"]), from: Number(row["fromId"]), to: Number(row["toId"]),
    capacity: Number(row["capacity"]), grant: row["grant"] == null ? null : String(row["grant"]),
    revocable: Boolean(row["revocable"]), tasksLost: Number(row["taskCost"] ?? 0),
  }));
  const sources = await db.read(`MATCH (p:Resource {sensitivity:'private'}) RETURN id(p) AS id`);
  const targets = await db.read(`MATCH (s:Resource {visibility:'public'}) RETURN id(s) AS id`);
  const flow = await db.read(MIN_CUT);
  const row = flow.rows[0] as unknown as MaxFlowRow;
  assert.ok(row);
  assert.equal(row.maxFlow, 7);
  const cut = cutFromMaxFlow(
    sources.rows.map((row) => Number(row["id"])),
    targets.rows.map((row) => Number(row["id"])), edges, row,
  );
  assert.deepEqual([...cut.grants].sort(), ["write.free", "write.shared"]);
  assert.equal(cut.side, "write");
  assert.equal(cut.edges.reduce((sum, edge) => sum + edge.capacity, 0), 7);
});
