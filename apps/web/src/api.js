/** Every call the dashboard makes. Failures return null rather than throwing, so one dead panel
 *  cannot blank the page - a lesson from a dashboard where a single 500 hid everything else. */

async function call(path, { method = 'GET', body } = {}) {
  try {
    const response = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export const api = {
  mesh: () => call('/api/demo/state'),
  accounts: () => call('/api/accounts'),
  journal: () => call('/api/journal'),
  claims: () => call('/api/claims'),
  receipts: () => call('/api/receipts'),
  invariants: () => call('/api/invariants'),
  settlementKey: () => call('/api/settlement-key'),

  compose: (payment) => call('/api/demo/compose', { method: 'POST', body: payment }),
  doubleSpend: (payment) => call('/api/demo/double-spend', { method: 'POST', body: payment }),
  gossip: () => call('/api/demo/gossip', { method: 'POST' }),
  flush: () => call('/api/demo/flush', { method: 'POST' }),
  partition: () => call('/api/demo/partition', { method: 'POST' }),
  heal: () => call('/api/demo/heal', { method: 'POST' }),
  reset: () => call('/api/demo/reset', { method: 'POST' }),
  rotateKeys: () => call('/api/admin/keys/rotate', { method: 'POST' }),
};

export const rupees = (paise) => {
  const amount = Math.abs(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${paise < 0 ? '−' : ''}₹${amount}`;
};
