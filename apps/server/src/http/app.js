import { b64, deviceIdOf, unb64 } from '@lifafa/protocol';
import { existsSync } from 'node:fs';
import express from 'express';
import * as claims from '../claims.js';
import { withTransaction } from '../db/pool.js';
import { ingest } from '../ingest.js';
import { rotate } from '../keystore.js';
import { checkInvariants, fund, openAccount } from '../ledger.js';
import * as receipts from '../receipts.js';
import { registerDevice, revoke, topUpAllowance } from '../registry.js';
import { createRateLimiter, newBridgeKey, requireAdmin, requireBridge } from './auth.js';
import { createDemo } from './demo.js';

/**
 * The HTTP surface. Two audiences, with different credentials:
 *
 *   - bridges, which deliver envelopes and need to be told what to do with their copy;
 *   - operators, who open accounts, register devices and inspect the ledger.
 *
 * Only the settlement key and the ingest endpoint are public, and both are needed by devices and
 * bridges that have no operator credentials.
 */
export function createApp({ pool, keys, config, webRoot }) {
  const app = express();
  app.use(express.json({ limit: '32kb' }));

  // The built dashboard, when there is one. Serving it from the same process keeps the demo to a
  // single command; in development Vite serves it instead and proxies /api here.
  if (webRoot && existsSync(webRoot)) app.use(express.static(webRoot));

  const limiter = createRateLimiter();
  const admin = requireAdmin(config);

  // ------------------------------------------------------------------------------------------
  // Public: what a phone needs before it goes offline, and where a bridge delivers.
  // ------------------------------------------------------------------------------------------

  app.get('/api/settlement-key', (_req, res) => {
    const current = keys.keyRing.current();
    res.json({
      keyId: current.keyId,
      publicKeyBase64: b64(current.publicKey),
      receiptPublicKeyBase64: b64(keys.serviceIdentity.publicKey),
      suite: 'HPKE base mode, DHKEM(X25519, HKDF-SHA256), AES-256-GCM',
    });
  });

  /**
   * The status code tells the bridge what to do with its copy, which is the only thing it can
   * act on: 200 decided, forget it. 202 someone else is deciding, keep it. 422 this can never be
   * valid, drop it. 503 try again later.
   */
  app.post('/api/bridge/ingest', requireBridge(pool, config, limiter), async (req, res, next) => {
    const wire = decodeBase64(req.body?.envelopeBase64);
    if (!wire) return res.status(400).json({ code: 'BAD_REQUEST', detail: 'envelopeBase64 must be base64' });

    try {
      const result = await ingest(pool, {
        wire,
        bridgeNodeId: req.bridgeNodeId,
        keyRing: keys.keyRing,
        serviceIdentity: keys.serviceIdentity,
      });
      res.status(statusFor(result.outcome)).json(result);
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------------------------------------
  // Operator: everything below needs the admin token, reads included.
  // ------------------------------------------------------------------------------------------

  app.post('/api/admin/accounts', admin, async (req, res) => {
    const { vpa, holderName } = req.body ?? {};
    if (!isVpa(vpa) || !isName(holderName)) {
      return res.status(400).json({ code: 'BAD_REQUEST', detail: 'vpa and holderName are required' });
    }
    try {
      await withTransaction(pool, (client) => openAccount(client, { vpa, holderName }));
      res.status(201).json({ vpa, holderName });
    } catch (error) {
      if (isUniqueViolation(error)) return res.status(409).json({ code: 'ALREADY_EXISTS', detail: vpa });
      throw error;
    }
  });

  app.post('/api/admin/accounts/:vpa/fund', admin, async (req, res) => {
    const { amountPaise, reference } = req.body ?? {};
    if (!isAmount(amountPaise) || !isName(reference)) {
      return res.status(400).json({ code: 'BAD_REQUEST', detail: 'amountPaise and reference are required' });
    }
    // Idempotent on the operator's reference, so a retried call credits once.
    const idempotencyKey = `topup/${reference}`;
    try {
      await withTransaction(pool, (client) =>
        fund(client, { idempotencyKey, vpa: req.params.vpa, amountPaise, memo: reference }),
      );
      res.status(201).json({ vpa: req.params.vpa, amountPaise, credited: true });
    } catch (error) {
      if (isUniqueViolation(error)) return res.status(200).json({ vpa: req.params.vpa, amountPaise, credited: false });
      if (/no such account/.test(error.message)) return res.status(404).json({ code: 'NO_SUCH_ACCOUNT', detail: req.params.vpa });
      throw error;
    }
  });

  app.post('/api/admin/devices', admin, async (req, res) => {
    const { vpa, publicKeyBase64, allowancePaise, perPaymentCapPaise } = req.body ?? {};
    const publicKey = decodeBase64(publicKeyBase64);
    if (!isVpa(vpa) || !publicKey || publicKey.length !== 32) {
      return res.status(400).json({ code: 'BAD_REQUEST', detail: 'vpa and a 32-byte publicKeyBase64 are required' });
    }
    const deviceId = await withTransaction(pool, (client) =>
      registerDevice(client, {
        vpa,
        publicKey,
        ...(isAmount(allowancePaise) ? { allowancePaise } : {}),
        ...(isAmount(perPaymentCapPaise) ? { perPaymentCapPaise } : {}),
      }),
    );
    res.json({ deviceId, vpa });
  });

  app.post('/api/admin/devices/:deviceId/top-up', admin, async (req, res) => {
    const { amountPaise } = req.body ?? {};
    if (!isAmount(amountPaise)) return res.status(400).json({ code: 'BAD_REQUEST', detail: 'amountPaise is required' });
    try {
      const allowancePaise = await withTransaction(pool, (client) =>
        topUpAllowance(client, req.params.deviceId, amountPaise),
      );
      res.json({ deviceId: req.params.deviceId, allowancePaise });
    } catch (error) {
      if (/no such device/.test(error.message)) return res.status(404).json({ code: 'NO_SUCH_DEVICE', detail: req.params.deviceId });
      throw error;
    }
  });

  app.post('/api/admin/devices/:deviceId/revoke', admin, async (req, res) => {
    await withTransaction(pool, (client) => revoke(client, req.params.deviceId, req.body?.reason ?? 'revoked by operator'));
    res.json({ deviceId: req.params.deviceId, state: 'REVOKED' });
  });

  app.post('/api/admin/bridges', admin, async (req, res) => {
    const { nodeId } = req.body ?? {};
    if (!isName(nodeId)) return res.status(400).json({ code: 'BAD_REQUEST', detail: 'nodeId is required' });
    const { apiKey, apiKeySha256 } = newBridgeKey();
    try {
      await pool.query('INSERT INTO bridge_nodes (node_id, api_key_sha256) VALUES ($1, $2)', [nodeId, apiKeySha256]);
    } catch (error) {
      if (isUniqueViolation(error)) return res.status(409).json({ code: 'ALREADY_EXISTS', detail: nodeId });
      throw error;
    }
    // The only time this key is ever readable.
    res.status(201).json({ nodeId, apiKey });
  });

  app.post('/api/admin/keys/rotate', admin, async (_req, res) => {
    keys.keyRing = await rotate(pool);
    res.json({ currentKeyId: keys.keyRing.currentKeyId, keyIds: keys.keyRing.all().map((key) => key.keyId) });
  });

  // Inspection.
  app.get('/api/accounts', admin, async (_req, res) => {
    const { rows } = await pool.query('SELECT vpa, holder_name, kind, balance_paise FROM accounts ORDER BY vpa');
    res.json(rows);
  });

  app.get('/api/journal', admin, async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT e.id, e.idempotency_key, e.kind, e.memo, e.created_at,
              json_agg(json_build_object('vpa', p.vpa, 'amountPaise', p.amount_paise) ORDER BY p.id) AS postings
         FROM journal_entries e JOIN postings p ON p.entry_id = e.id
        GROUP BY e.id ORDER BY e.id DESC LIMIT 50`,
    );
    res.json(rows);
  });

  app.get('/api/attempts', admin, async (_req, res) => {
    const { rows } = await pool.query('SELECT * FROM ingest_attempts ORDER BY received_at DESC LIMIT 50');
    res.json(rows);
  });

  app.get('/api/claims', admin, async (_req, res) => {
    res.json({
      counts: await claims.countByState(pool),
      recent: (await pool.query('SELECT * FROM idempotency_claims ORDER BY claimed_at DESC LIMIT 50')).rows,
    });
  });

  app.get('/api/devices', admin, async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT d.device_id, d.vpa, d.state, d.registered_at, e.allowance_paise, e.per_payment_cap_paise
         FROM devices d LEFT JOIN offline_envelopes e ON e.device_id = d.device_id
        ORDER BY d.registered_at DESC LIMIT 50`,
    );
    res.json(rows);
  });

  app.get('/api/receipts', admin, async (_req, res) => {
    const { rows } = await pool.query('SELECT * FROM receipts ORDER BY decided_at DESC LIMIT 50');
    res.json({ undelivered: await receipts.countUndelivered(pool), recent: rows });
  });

  app.get('/api/invariants', admin, async (_req, res) => {
    res.json(await checkInvariants(pool));
  });

  // The simulated mesh behind the dashboard. Demo mode only: it signs payments for demo phones,
  // which a real deployment must never do.
  if (config.demo) app.use('/api/demo', createDemo({ pool, keys }));

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'up', database: 'PostgreSQL' });
    } catch (error) {
      res.status(503).json({ status: 'down', detail: error.message });
    }
  });

  app.use((_req, res) => res.status(404).json({ code: 'NOT_FOUND', detail: 'no such route' }));

  // Anything unhandled is the service's fault, not the caller's: say so, and say nothing else.
  app.use((error, _req, res, _next) => {
    console.error('unhandled error', error);
    res.status(500).json({ code: 'INTERNAL_ERROR', detail: 'the service failed to handle this request' });
  });

  return app;
}

const statusFor = (outcome) =>
  ({ SETTLED: 200, REJECTED: 200, IN_PROGRESS: 202, INVALID: 422, TRANSIENT: 503 })[outcome] ?? 500;

const VPA = /^[A-Za-z0-9._-]{2,48}@[A-Za-z0-9.-]{2,15}$/;
const isVpa = (value) => typeof value === 'string' && VPA.test(value);
const isName = (value) => typeof value === 'string' && value.length > 0 && value.length <= 120;
const isAmount = (value) => Number.isSafeInteger(value) && value > 0;
const isUniqueViolation = (error) => error.code === '23505';

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return unb64(value);
  } catch {
    return null;
  }
}

export { deviceIdOf };
