import { DeviceIdentity, ServerKeyRing, fingerprint, open } from '@lifafa/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { DeviceAgent } from '../src/agent.js';
import { Mesh } from '../src/mesh.js';
import { seededRandom } from '../src/random.js';

const KEY_ID = 1;
const IDS = ['phone-alice', 'stranger-1', 'stranger-2', 'bridge-cafe'];

let ring;
let alice;

beforeEach(() => {
  ring = ServerKeyRing.generate(KEY_ID);
  alice = new DeviceAgent({
    identity: DeviceIdentity.generate(),
    vpa: 'alice@lifafa',
    serverPublicKey: ring.current().publicKey,
    serverKeyId: KEY_ID,
  });
});

const payment = () => alice.pay({ to: 'bob@lifafa', amountPaise: 25_000 });

describe('carrying a payment across the mesh', () => {
  it('reaches the bridge one hop per round, not instantly', () => {
    const mesh = Mesh.chain(IDS);
    const wire = payment();
    mesh.node('phone-alice').hold(wire);

    // Three links between the payer and the bridge, so three rounds.
    expect(mesh.node('bridge-cafe').count).toBe(0);
    mesh.gossipRound();
    mesh.gossipRound();
    expect(mesh.node('bridge-cafe').count).toBe(0);
    mesh.gossipRound();
    expect(mesh.node('bridge-cafe').count).toBe(1);
  });

  it('arrives intact: carriers pass bytes on, they do not touch them', () => {
    const mesh = Mesh.chain(IDS);
    const wire = payment();
    mesh.node('phone-alice').hold(wire);
    for (let round = 0; round < 3; round++) mesh.gossipRound();

    const carried = [...mesh.node('bridge-cafe').held.values()][0];
    expect(fingerprint(carried.wire)).toBe(fingerprint(wire));
    expect(open(carried.wire, ring).ok).toBe(true);
    expect(carried.hops).toBe(3);
  });

  it('a carrier sees an opaque blob, not a payment', () => {
    const mesh = Mesh.chain(IDS);
    mesh.node('phone-alice').hold(payment());
    mesh.gossipRound();

    const [{ wire }] = [...mesh.node('stranger-1').held.values()];
    expect(open(wire, ServerKeyRing.generate(KEY_ID)).ok).toBe(false);
    expect(Buffer.from(wire).includes(Buffer.from('alice@lifafa'))).toBe(false);
  });

  it('holds each envelope once, however many times it is offered', () => {
    const mesh = Mesh.chain(IDS);
    mesh.node('phone-alice').hold(payment());
    for (let round = 0; round < 6; round++) mesh.gossipRound();

    expect([...mesh.nodes.values()].every((node) => node.count === 1)).toBe(true);
  });
});

describe('a mesh that loses packets and splits', () => {
  it('still delivers despite loss, given enough rounds', () => {
    const mesh = Mesh.chain(IDS, { dropProbability: 0.5, seed: 20260922 });
    mesh.node('phone-alice').hold(payment());

    let rounds = 0;
    while (mesh.node('bridge-cafe').count === 0 && rounds < 50) {
      mesh.gossipRound();
      rounds++;
    }

    expect(mesh.node('bridge-cafe').count).toBe(1);
    expect(rounds).toBeGreaterThan(3); // loss cost it rounds, but not the payment
  });

  it('cannot cross a partition, and crosses once it heals', () => {
    const mesh = Mesh.chain(IDS);
    mesh.partition(['phone-alice', 'stranger-1']);
    mesh.node('phone-alice').hold(payment());

    for (let round = 0; round < 10; round++) mesh.gossipRound();
    expect(mesh.node('bridge-cafe').count).toBe(0);

    mesh.heal();
    for (let round = 0; round < 3; round++) mesh.gossipRound();
    expect(mesh.node('bridge-cafe').count).toBe(1);
  });

  it('is reproducible: the same seed loses the same packets', () => {
    const run = () => {
      const mesh = Mesh.chain(IDS, { dropProbability: 0.4, seed: 99 });
      mesh.node('phone-alice').hold(payment());
      let rounds = 0;
      while (mesh.node('bridge-cafe').count === 0 && rounds < 50) {
        mesh.gossipRound();
        rounds++;
      }
      return rounds;
    };

    expect(run()).toBe(run());
  });
});

describe('bridges uploading', () => {
  it('forgets an envelope the service decided, and keeps one it did not', async () => {
    const mesh = Mesh.chain(IDS);
    mesh.node('phone-alice').hold(payment());
    for (let round = 0; round < 3; round++) mesh.gossipRound();

    await mesh.flushBridges(async () => ({ bridgeShouldRetain: true }));
    expect(mesh.node('bridge-cafe').count).toBe(1);

    await mesh.flushBridges(async () => ({ bridgeShouldRetain: false }));
    expect(mesh.node('bridge-cafe').count).toBe(0);
  });

  it('two bridges both carry the payment, so either can deliver it', async () => {
    const mesh = Mesh.chain([...IDS, 'bridge-bus'], { bridges: ['bridge-cafe', 'bridge-bus'] });
    mesh.node('phone-alice').hold(payment());
    for (let round = 0; round < 4; round++) mesh.gossipRound();

    const uploads = [];
    await mesh.flushBridges(async (wire, nodeId) => {
      uploads.push(nodeId);
      return { bridgeShouldRetain: false };
    });

    expect(uploads).toEqual(['bridge-cafe', 'bridge-bus']);
  });
});

describe('what a payer can do offline', () => {
  it('re-sealing one payment gives different bytes every time', () => {
    const signed = alice.compose({ to: 'bob@lifafa', amountPaise: 10_000 });
    const first = alice.reseal(signed);
    const second = alice.reseal(signed);

    expect(fingerprint(first)).not.toBe(fingerprint(second));

    const opened = open(second, ring);
    expect(opened.ok).toBe(true);
    expect(opened.signed.instruction.nonce).toBe(signed.instruction.nonce);
  });

  it('can sign two payments against the same balance, which is why limits exist', () => {
    const [first, second] = alice.doubleSpend({ to: 'bob@lifafa', amountPaise: 50_000 });

    const a = open(first, ring);
    const b = open(second, ring);
    expect(a.ok && b.ok).toBe(true);
    // Two different payments - different nonces - signed with one sequence number.
    expect(a.signed.instruction.nonce).not.toBe(b.signed.instruction.nonce);
    expect(a.signed.instruction.deviceSequence).toBe(b.signed.instruction.deviceSequence);
  });
});

describe('the seeded random generator', () => {
  it('repeats exactly for one seed and differs across seeds', () => {
    const sequence = (seed) => Array.from({ length: 5 }, seededRandom(seed));

    expect(sequence(42)).toEqual(sequence(42));
    expect(sequence(42)).not.toEqual(sequence(43));
  });
});
