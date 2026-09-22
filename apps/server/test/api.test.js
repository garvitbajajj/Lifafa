import { randomUUID } from 'node:crypto';
import {
  DeviceIdentity,
  b64,
  encodeEnvelope,
  paymentInstruction,
  seal,
  unb64,
} from '@lifafa/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { loadOrCreateKeys } from '../src/keystore.js';
import { checkInvariants } from '../src/ledger.js';
import { startTestDatabase } from './support/database.js';

const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';
const HOUR = 60 * 60 * 1000;

let database;
let pool;
let keys;
let server;
let baseUrl;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  keys = await loadOrCreateKeys(pool);

  const config = loadConfig({ LIFAFA_ADMIN_TOKEN: ADMIN_TOKEN, LIFAFA_BRIDGE_RATE: '500' });
  const app = createApp({ pool, keys, config });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, 120_000);

afterAll(async () => {
  const report = await checkInvariants(pool);
  await new Promise((resolve) => server.close(resolve));
  await database.stop();
  expect(report.holds, JSON.stringify(report)).toBe(true);
});

const call = (path, { method = 'GET', body, headers = {} } = {}) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const asAdmin = (path, options = {}) =>
  call(path, { ...options, headers: { 'x-admin-token': ADMIN_TOKEN, ...options.headers } });

/** An account, a device bound to it, and a bridge that can deliver for it. */
async function setUpPayer(amountPaise = 100_000) {
  const suffix = randomUUID().slice(0, 8);
  const payer = `alice${suffix}@lifafa`;
  const payee = `bob${suffix}@lifafa`;
  const phone = DeviceIdentity.generate();

  await asAdmin('/api/admin/accounts', { method: 'POST', body: { vpa: payer, holderName: 'Alice' } });
  await asAdmin('/api/admin/accounts', { method: 'POST', body: { vpa: payee, holderName: 'Bob' } });
  await asAdmin(`/api/admin/accounts/${payer}/fund`, {
    method: 'POST',
    body: { amountPaise, reference: `onboarding/${payer}` },
  });
  await asAdmin('/api/admin/devices', {
    method: 'POST',
    body: { vpa: payer, publicKeyBase64: b64(phone.publicKey) },
  });

  const bridge = await (
    await asAdmin('/api/admin/bridges', { method: 'POST', body: { nodeId: `bridge-${suffix}` } })
  ).json();

  return { payer, payee, phone, bridge };
}

async function currentKey() {
  const body = await (await call('/api/settlement-key')).json();
  return { keyId: body.keyId, publicKey: unb64(body.publicKeyBase64) };
}

function envelopeFor({ payer, payee, phone }, key, overrides = {}) {
  const now = Date.now();
  const instruction = paymentInstruction({
    senderVpa: payer,
    receiverVpa: payee,
    amountPaise: 25_000,
    nonce: randomUUID(),
    deviceSequence: 1,
    signedAt: now,
    expiresAt: now + 6 * HOUR,
    ...overrides,
  });
  return b64(encodeEnvelope(seal(instruction, phone, key.publicKey, key.keyId)));
}

const deliver = (envelopeBase64, bridge) =>
  call('/api/bridge/ingest', {
    method: 'POST',
    body: { envelopeBase64 },
    headers: { 'x-bridge-node-id': bridge.nodeId, 'x-bridge-key': bridge.apiKey },
  });

describe('what a phone and a bridge can reach without credentials', () => {
  it('publishes the settlement key, and nothing private with it', async () => {
    const response = await call('/api/settlement-key');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(unb64(body.publicKeyBase64)).toHaveLength(32);
    expect(JSON.stringify(body)).not.toMatch(/private|secret|seed/i);
  });

  it('reports its health', async () => {
    expect((await (await call('/health')).json()).status).toBe('up');
  });

  it('refuses ingest without bridge credentials, and with the wrong key', async () => {
    const { bridge } = await setUpPayer();

    expect((await call('/api/bridge/ingest', { method: 'POST', body: {} })).status).toBe(401);
    expect(
      (
        await call('/api/bridge/ingest', {
          method: 'POST',
          body: {},
          headers: { 'x-bridge-node-id': bridge.nodeId, 'x-bridge-key': 'wrong' },
        })
      ).status,
    ).toBe(401);
  });
});

describe('delivering a payment', () => {
  it('settles it, and says the bridge may stop carrying it', async () => {
    const context = await setUpPayer();
    const response = await deliver(envelopeFor(context, await currentKey()), context.bridge);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.outcome).toBe('SETTLED');
    expect(body.bridgeShouldRetain).toBe(false);

    const accounts = await (await asAdmin('/api/accounts')).json();
    expect(accounts.find((account) => account.vpa === context.payee).balance_paise).toBe(25_000);
  });

  it('answers a second delivery of the same envelope with the same decision', async () => {
    const context = await setUpPayer();
    const envelope = envelopeFor(context, await currentKey());

    const first = await (await deliver(envelope, context.bridge)).json();
    const second = await deliver(envelope, context.bridge);
    const body = await second.json();

    expect(second.status).toBe(200);
    expect(body.replay).toBe(true);
    expect(body.journalEntryId).toBe(first.journalEntryId);
  });

  it('answers bytes that can never be a payment with 422, so the bridge drops them', async () => {
    const { bridge } = await setUpPayer();
    const response = await deliver(b64(Buffer.from('not an envelope at all')), bridge);

    expect(response.status).toBe(422);
    expect((await response.json()).outcome).toBe('INVALID');
  });

  it('rejects a malformed request body with 400, not 500', async () => {
    const { bridge } = await setUpPayer();
    const response = await call('/api/bridge/ingest', {
      method: 'POST',
      body: { envelopeBase64: '!!! not base64 !!!' },
      headers: { 'x-bridge-node-id': bridge.nodeId, 'x-bridge-key': bridge.apiKey },
    });

    expect(response.status).toBe(400);
  });

  it('throttles one bridge on its own, without touching the others', async () => {
    const config = loadConfig({ LIFAFA_ADMIN_TOKEN: ADMIN_TOKEN, LIFAFA_BRIDGE_RATE: '3' });
    const app = createApp({ pool, keys, config });
    const throttled = app.listen(0);
    await new Promise((resolve) => throttled.once('listening', resolve));
    const url = `http://127.0.0.1:${throttled.address().port}/api/bridge/ingest`;

    const { bridge } = await setUpPayer();
    const send = () =>
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bridge-node-id': bridge.nodeId,
          'x-bridge-key': bridge.apiKey,
        },
        body: JSON.stringify({ envelopeBase64: b64(Buffer.from('garbage')) }),
      });

    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await send()).status);
    await new Promise((resolve) => throttled.close(resolve));

    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
  }, 30_000);
});

describe('operator routes', () => {
  it.each([
    ['GET', '/api/accounts'],
    ['GET', '/api/journal'],
    ['GET', '/api/attempts'],
    ['GET', '/api/claims'],
    ['GET', '/api/devices'],
    ['GET', '/api/receipts'],
    ['GET', '/api/invariants'],
    ['POST', '/api/admin/accounts'],
    ['POST', '/api/admin/bridges'],
    ['POST', '/api/admin/keys/rotate'],
  ])('%s %s needs the operator token', async (method, path) => {
    const response = await call(path, { method, body: method === 'POST' ? {} : undefined });
    expect(response.status).toBe(401);
  });

  it('opens an account once, and says so the second time', async () => {
    const vpa = `carol${randomUUID().slice(0, 8)}@lifafa`;

    expect((await asAdmin('/api/admin/accounts', { method: 'POST', body: { vpa, holderName: 'Carol' } })).status).toBe(201);
    expect((await asAdmin('/api/admin/accounts', { method: 'POST', body: { vpa, holderName: 'Carol' } })).status).toBe(409);
  });

  it('refuses a malformed VPA', async () => {
    const response = await asAdmin('/api/admin/accounts', {
      method: 'POST',
      body: { vpa: 'carol<script>@lifafa', holderName: 'Carol' },
    });
    expect(response.status).toBe(400);
  });

  it('credits a retried funding call only once', async () => {
    const { payer } = await setUpPayer(0 || 100_000);
    const reference = `manual/${randomUUID()}`;

    const first = await asAdmin(`/api/admin/accounts/${payer}/fund`, { method: 'POST', body: { amountPaise: 5_000, reference } });
    const retry = await asAdmin(`/api/admin/accounts/${payer}/fund`, { method: 'POST', body: { amountPaise: 5_000, reference } });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect((await retry.json()).credited).toBe(false);

    const accounts = await (await asAdmin('/api/accounts')).json();
    expect(accounts.find((account) => account.vpa === payer).balance_paise).toBe(105_000);
  });

  it('registers, tops up and revokes a device', async () => {
    const context = await setUpPayer();
    const deviceId = context.phone.deviceId;

    const toppedUp = await (
      await asAdmin(`/api/admin/devices/${deviceId}/top-up`, { method: 'POST', body: { amountPaise: 10_000 } })
    ).json();
    expect(toppedUp.allowancePaise).toBe(210_000);

    expect((await asAdmin(`/api/admin/devices/${deviceId}/revoke`, { method: 'POST', body: {} })).status).toBe(200);

    const delivered = await deliver(envelopeFor(context, await currentKey()), context.bridge);
    expect((await delivered.json()).code).toBe('DEVICE_REVOKED');
  });

  it('reports a sound ledger', async () => {
    const body = await (await asAdmin('/api/invariants')).json();
    expect(body.holds).toBe(true);
    expect(body.postingSum).toBe(0);
  });

  it('returns 404 for an unknown route rather than an error page', async () => {
    expect((await call('/api/nope')).status).toBe(404);
  });
});

describe('key rotation', () => {
  it('rotates, and still opens an envelope sealed to the key before it', async () => {
    const context = await setUpPayer();
    const oldKey = await currentKey();
    const inFlight = envelopeFor(context, oldKey);

    const rotated = await (await asAdmin('/api/admin/keys/rotate', { method: 'POST' })).json();
    expect(rotated.currentKeyId).toBeGreaterThan(oldKey.keyId);
    expect((await currentKey()).keyId).toBe(rotated.currentKeyId);

    const response = await deliver(inFlight, context.bridge);
    expect((await response.json()).outcome).toBe('SETTLED');

    // And a payment sealed to the new key settles too.
    const fresh = envelopeFor(context, await currentKey(), { deviceSequence: 2 });
    expect((await (await deliver(fresh, context.bridge)).json()).outcome).toBe('SETTLED');
  }, 30_000);
});

describe('configuration', () => {
  it('refuses to start without an operator token outside demo mode', () => {
    expect(() => loadConfig({})).toThrow(/LIFAFA_ADMIN_TOKEN/);
    expect(() => loadConfig({ LIFAFA_ADMIN_TOKEN: 'too-short' })).toThrow(/24 characters/);
  });

  it('allows an open demo, which is what makes a laptop demo work with no setup', () => {
    expect(loadConfig({ LIFAFA_DEMO: 'true' }).demo).toBe(true);
  });
});
