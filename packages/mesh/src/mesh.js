import { fingerprint } from '@lifafa/protocol';
import { seededRandom } from './random.js';

/**
 * A phone in the mesh. It holds envelopes it has been handed and passes them on.
 *
 * What it can see is an opaque blob and a hop count. It cannot read a payment, and it has no way
 * to tell a real one from a forged one - which is why the settlement service decides everything
 * and carriers decide nothing.
 */
export class MeshNode {
  constructor(id, { isBridge = false } = {}) {
    this.id = id;
    this.isBridge = isBridge;
    /** fingerprint -> { wire, hops } */
    this.held = new Map();
  }

  hold(wire, hops = 0) {
    const key = fingerprint(wire);
    if (this.held.has(key)) return false;
    this.held.set(key, { wire, hops });
    return true;
  }

  forget(key) {
    this.held.delete(key);
  }

  get count() {
    return this.held.size;
  }
}

/**
 * A mesh of phones with links between them.
 *
 * Deliberately not a fully connected graph. The reference implementation simulated every phone
 * being able to reach every other, which makes delivery succeed trivially and proves nothing
 * about a real mesh: the interesting cases are long paths, lost packets and partitions.
 */
export class Mesh {
  /**
   * @param {object} options
   * @param {MeshNode[]} options.nodes
   * @param {Array<[string, string]>} options.links
   * @param {number} [options.dropProbability] chance a single hand-off fails
   * @param {number} [options.seed]
   */
  constructor({ nodes, links, dropProbability = 0, seed = 1 }) {
    this.nodes = new Map(nodes.map((node) => [node.id, node]));
    this.links = links;
    this.dropProbability = dropProbability;
    this.random = seededRandom(seed);
    this.partitioned = new Set();
  }

  /** A chain: phone -> stranger -> stranger -> bridge. The hardest shape for a payment to cross. */
  static chain(ids, { bridges = [ids.at(-1)], ...options } = {}) {
    const nodes = ids.map((id) => new MeshNode(id, { isBridge: bridges.includes(id) }));
    const links = ids.slice(1).map((id, index) => [ids[index], id]);
    return new Mesh({ nodes, links, ...options });
  }

  /** Each phone linked to a few others, chosen by the seed. */
  static random(ids, { degree = 2, bridges = [ids.at(-1)], seed = 1, ...options } = {}) {
    const random = seededRandom(seed);
    const nodes = ids.map((id) => new MeshNode(id, { isBridge: bridges.includes(id) }));
    const links = [];
    for (const id of ids) {
      for (const other of random.shuffled(ids.filter((candidate) => candidate !== id)).slice(0, degree)) {
        if (!links.some(([a, b]) => (a === id && b === other) || (a === other && b === id))) links.push([id, other]);
      }
    }
    return new Mesh({ nodes, links, seed, ...options });
  }

  node(id) {
    return this.nodes.get(id);
  }

  bridges() {
    return [...this.nodes.values()].filter((node) => node.isBridge);
  }

  /** Cuts every link between the named phones and the rest. */
  partition(ids) {
    this.partitioned = new Set(ids);
  }

  heal() {
    this.partitioned = new Set();
  }

  #reachable(a, b) {
    if (this.partitioned.size === 0) return true;
    return this.partitioned.has(a) === this.partitioned.has(b);
  }

  /**
   * One round of gossip: every phone offers what it holds to its neighbours.
   *
   * Offers are computed from a snapshot taken before the round, so an envelope cannot cross the
   * whole mesh in a single round just because of the order the nodes happen to be visited.
   *
   * @returns {number} how many envelopes were handed over
   */
  gossipRound() {
    const snapshot = [...this.nodes.values()].map((node) => ({ node, holding: [...node.held.entries()] }));
    let handovers = 0;

    for (const [a, b] of this.links) {
      if (!this.#reachable(a, b)) continue;
      for (const [from, to] of [
        [a, b],
        [b, a],
      ]) {
        const source = snapshot.find((entry) => entry.node.id === from);
        const target = this.nodes.get(to);
        for (const [, { wire, hops }] of source.holding) {
          if (this.dropProbability > 0 && this.random.chance(this.dropProbability)) continue;
          if (target.hold(wire, hops + 1)) handovers++;
        }
      }
    }
    return handovers;
  }

  /**
   * Every bridge uploads what it holds.
   *
   * A bridge forgets an envelope only when the service says it is decided. Anything else - the
   * claim is held elsewhere, a transient failure - and it keeps its copy, because it may be the
   * delivery that eventually settles the payment.
   *
   * @param {(wire: Uint8Array, nodeId: string) => Promise<{bridgeShouldRetain: boolean}>} upload
   */
  async flushBridges(upload) {
    const results = [];
    for (const bridge of this.bridges()) {
      for (const [key, { wire }] of [...bridge.held.entries()]) {
        const result = await upload(wire, bridge.id);
        results.push({ nodeId: bridge.id, result });
        if (!result.bridgeShouldRetain) bridge.forget(key);
      }
    }
    return results;
  }

  /** Total envelopes held across the mesh, for a dashboard or an assertion. */
  get inFlight() {
    return [...this.nodes.values()].reduce((total, node) => total + node.count, 0);
  }
}
