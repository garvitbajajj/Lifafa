import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

/** Length-independent comparison: a presented credential is attacker-controlled. */
function matches(presented, expected) {
  const a = Buffer.from(presented ?? '');
  const b = Buffer.from(expected ?? '');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * Every operator route - reads as well as writes.
 *
 * Reads are not harmless on a payment ledger: account balances, the journal, device bindings and
 * delivery attempts all disclose who paid whom. Guarding the router rather than each handler
 * means a route added later is protected by default; per-handler checks fail open, and the one
 * endpoint somebody forgets is the one that matters.
 */
export const requireAdmin = (config) => (req, res, next) => {
  // In demo mode with no token there is nothing to check - that is what makes a laptop demo
  // work with no setup. loadConfig() makes that combination impossible outside demo mode.
  if (config.demo && config.adminToken === '') return next();
  if (matches(req.get('x-admin-token'), config.adminToken)) return next();
  res.status(401).json({ code: 'ADMIN_TOKEN_REQUIRED', detail: 'supply a valid X-Admin-Token header' });
};

/** A new bridge credential: the key is returned once and only its hash is stored. */
export function newBridgeKey() {
  const apiKey = randomBytes(24).toString('base64url');
  return { apiKey, apiKeySha256: sha256Hex(apiKey) };
}

/**
 * Identifies the bridge delivering an envelope, and throttles it on its own.
 *
 * Per bridge, so one bridge flooding the service cannot starve the others - the failure mode of a
 * single global limit.
 */
export const requireBridge = (pool, config, limiter) => async (req, res, next) => {
  const nodeId = req.get('x-bridge-node-id') ?? '';
  const presented = req.get('x-bridge-key') ?? '';

  const { rows } = await pool.query('SELECT node_id, api_key_sha256 FROM bridge_nodes WHERE node_id = $1', [nodeId]);
  // The same answer for an unknown bridge and a wrong key: which one it was is not the caller's
  // business, and saying would confirm that a node id exists.
  if (rows.length === 0 || !matches(sha256Hex(presented), rows[0].api_key_sha256)) {
    return res.status(401).json({ code: 'BRIDGE_UNAUTHORISED', detail: 'unknown bridge or wrong key' });
  }

  if (!limiter.allow(nodeId, config.bridgeRatePerMinute)) {
    return res.status(429).json({ code: 'RATE_LIMITED', detail: `over ${config.bridgeRatePerMinute} requests a minute` });
  }

  req.bridgeNodeId = nodeId;
  pool.query('UPDATE bridge_nodes SET last_seen_at = now() WHERE node_id = $1', [nodeId]).catch(() => {});
  next();
};

/**
 * A fixed window per bridge, in memory.
 *
 * ponytail: per-instance counter. Two instances behind a load balancer give each bridge twice the
 * budget; move the window into the database or a shared cache if that ever matters.
 */
export function createRateLimiter(now = () => Date.now()) {
  const windows = new Map();
  return {
    allow(key, perMinute) {
      const minute = Math.floor(now() / 60_000);
      const seen = windows.get(key);
      if (!seen || seen.minute !== minute) {
        windows.set(key, { minute, count: 1 });
        return true;
      }
      seen.count += 1;
      return seen.count <= perMinute;
    },
  };
}
