import { DeviceAgent, Mesh } from '@lifafa/mesh';
import { Router } from 'express';
import { withTransaction } from '../db/pool.js';
import { ingest } from '../ingest.js';
import { fund, openAccount } from '../ledger.js';
import { registerDevice } from '../registry.js';

/**
 * A mesh you can watch: five phones in a line, two of them bridges.
 *
 *   phone-alice -> stranger-1 -> stranger-2 -> bridge-cafe -> bridge-bus
 *
 * Only mounted in demo mode. It signs payments on behalf of demo phones, which a real deployment
 * must never do - the whole design rests on the private key never leaving the payer's device.
 */

const NODES = ['phone-alice', 'stranger-1', 'stranger-2', 'bridge-cafe', 'bridge-bus'];
const BRIDGES = ['bridge-cafe', 'bridge-bus'];

const PEOPLE = [
  { vpa: 'alice@lifafa', holderName: 'Alice', openingPaise: 500_000, node: 'phone-alice' },
  { vpa: 'chai@lifafa', holderName: 'Chai stall', openingPaise: 0, node: null },
  { vpa: 'bob@lifafa', holderName: 'Bob', openingPaise: 100_000, node: null },
];

export function createDemo({ pool, keys }) {
  const router = Router();
  let mesh = newMesh();
  let agents = new Map();

  function newMesh() {
    return Mesh.chain(NODES, { bridges: BRIDGES, dropProbability: 0, seed: Date.now() & 0xffff });
  }

  /** Opens the demo accounts and phones if they are not there yet. */
  async function ensureWorld() {
    for (const person of PEOPLE) {
      await withTransaction(pool, async (client) => {
        const { rows } = await client.query('SELECT 1 FROM accounts WHERE vpa = $1', [person.vpa]);
        if (rows.length > 0) return;
        await openAccount(client, { vpa: person.vpa, holderName: person.holderName });
        if (person.openingPaise > 0) {
          await fund(client, {
            idempotencyKey: `demo-opening/${person.vpa}`,
            vpa: person.vpa,
            amountPaise: person.openingPaise,
            memo: 'demo opening balance',
          });
        }
      });
    }

    for (const person of PEOPLE.filter((candidate) => candidate.node)) {
      if (agents.has(person.vpa)) continue;
      const agent = new DeviceAgent({
        vpa: person.vpa,
        serverPublicKey: keys.keyRing.current().publicKey,
        serverKeyId: keys.keyRing.currentKeyId,
      });
      await withTransaction(pool, (client) => registerDevice(client, { vpa: person.vpa, publicKey: agent.publicKey }));
      agents.set(person.vpa, agent);
    }
  }

  const state = () => ({
    nodes: NODES.map((id) => {
      const node = mesh.node(id);
      return {
        id,
        isBridge: node.isBridge,
        partitioned: mesh.partitioned.has(id),
        holding: [...node.held.entries()].map(([fingerprint, held]) => ({
          fingerprint: fingerprint.slice(0, 12),
          hops: held.hops,
          bytes: held.wire.length,
        })),
      };
    }),
    links: mesh.links,
    partitioned: mesh.partitioned.size > 0,
    inFlight: mesh.inFlight,
  });

  router.get('/state', async (_req, res) => {
    await ensureWorld();
    res.json(state());
  });

  router.post('/compose', async (req, res) => {
    await ensureWorld();
    const from = req.body?.from ?? 'alice@lifafa';
    const to = req.body?.to ?? 'chai@lifafa';
    const amountPaise = Number(req.body?.amountPaise ?? 25_000);
    const agent = agents.get(from);
    if (!agent) return res.status(400).json({ code: 'NO_SUCH_PHONE', detail: from });

    const wire = agent.pay({ to, amountPaise });
    mesh.node(PEOPLE.find((person) => person.vpa === from).node).hold(wire);
    res.json({ ...state(), signed: { from, to, amountPaise, bytes: wire.length } });
  });

  /** Two payments from one balance, signed offline - what the allowance and sequence check exist for. */
  router.post('/double-spend', async (req, res) => {
    await ensureWorld();
    const agent = agents.get('alice@lifafa');
    const [first, second] = agent.doubleSpend({ to: req.body?.to ?? 'chai@lifafa', amountPaise: Number(req.body?.amountPaise ?? 25_000) });
    mesh.node('phone-alice').hold(first);
    mesh.node('phone-alice').hold(second);
    res.json(state());
  });

  router.post('/gossip', (_req, res) => {
    const handovers = mesh.gossipRound();
    res.json({ ...state(), handovers });
  });

  /** Both bridges upload what they hold, at the same moment, as bridges do. */
  router.post('/flush', async (_req, res) => {
    const outcomes = [];
    await mesh.flushBridges(async (wire, nodeId) => {
      const result = await ingest(pool, {
        wire,
        bridgeNodeId: nodeId,
        keyRing: keys.keyRing,
        serviceIdentity: keys.serviceIdentity,
      });
      outcomes.push({ nodeId, outcome: result.outcome, code: result.code, replay: result.replay, detail: result.detail });
      return result;
    });
    res.json({ ...state(), outcomes });
  });

  router.post('/partition', (_req, res) => {
    mesh.partition(['phone-alice', 'stranger-1']);
    res.json(state());
  });

  router.post('/heal', (_req, res) => {
    mesh.heal();
    res.json(state());
  });

  /**
   * Clears the mesh and gives every demo payer a fresh phone. The double-spend button revokes
   * Alice's phone - correctly - so without a fresh one the demo could never be run twice.
   */
  router.post('/reset', async (_req, res) => {
    mesh = newMesh();
    agents = new Map();
    await ensureWorld();
    res.json(state());
  });

  return router;
}
