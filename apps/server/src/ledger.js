export const HOUSE_VPA = 'house@lifafa';

/** Refused because the payer does not have the money. A decision, not an error to retry. */
export class InsufficientFunds extends Error {
  name = 'InsufficientFunds';
}

/**
 * Writes one journal entry and its postings, inside the caller's transaction.
 *
 * Takes a client rather than a pool on purpose: these rows must commit with whatever else the
 * caller is deciding - for a payment, the settlement decision itself - or not at all.
 *
 * @param {import('pg').PoolClient} client
 * @param {{idempotencyKey: string, kind: 'PAYMENT'|'GENESIS'|'TOPUP', memo?: string,
 *          movements: Array<{vpa: string, amountPaise: number}>}} entry
 * @returns {Promise<number>} the journal entry id
 */
export async function post(client, { idempotencyKey, kind, memo = '', movements }) {
  if (movements.length < 2) throw new Error('a journal entry needs at least two postings');
  const total = movements.reduce((sum, movement) => sum + movement.amountPaise, 0);
  if (total !== 0) throw new Error(`postings must sum to zero, got ${total}`);

  // Lock every account this entry touches, always in the same order. Two opposite payments -
  // alice pays bob while bob pays alice - would otherwise each hold the lock the other needs.
  const vpas = [...new Set(movements.map((movement) => movement.vpa))].sort();
  const locked = await client.query(
    'SELECT vpa, kind, balance_paise FROM accounts WHERE vpa = ANY($1) ORDER BY vpa FOR UPDATE',
    [vpas],
  );
  if (locked.rows.length !== vpas.length) {
    const found = new Set(locked.rows.map((row) => row.vpa));
    throw new Error(`no such account: ${vpas.find((vpa) => !found.has(vpa))}`);
  }

  for (const row of locked.rows) {
    const change = movements
      .filter((movement) => movement.vpa === row.vpa)
      .reduce((sum, movement) => sum + movement.amountPaise, 0);
    if (row.kind !== 'HOUSE' && row.balance_paise + change < 0) {
      throw new InsufficientFunds(`${row.vpa} has ${row.balance_paise} paise, needs ${-change}`);
    }
  }

  const { rows } = await client.query(
    'INSERT INTO journal_entries (idempotency_key, kind, memo) VALUES ($1, $2, $3) RETURNING id',
    [idempotencyKey, kind, memo],
  );
  const entryId = rows[0].id;

  for (const movement of movements) {
    await client.query('INSERT INTO postings (entry_id, vpa, amount_paise) VALUES ($1, $2, $3)', [
      entryId,
      movement.vpa,
      movement.amountPaise,
    ]);
    await client.query('UPDATE accounts SET balance_paise = balance_paise + $2 WHERE vpa = $1', [
      movement.vpa,
      movement.amountPaise,
    ]);
  }
  return entryId;
}

/** One payment: debit the payer, credit the payee. */
export const transfer = (client, { idempotencyKey, from, to, amountPaise, memo }) =>
  post(client, {
    idempotencyKey,
    kind: 'PAYMENT',
    memo,
    movements: [
      { vpa: from, amountPaise: -amountPaise },
      { vpa: to, amountPaise },
    ],
  });

/** Issues money into an account from the house float. */
export const fund = (client, { idempotencyKey, vpa, amountPaise, memo }) =>
  post(client, {
    idempotencyKey,
    kind: 'TOPUP',
    memo,
    movements: [
      { vpa: HOUSE_VPA, amountPaise: -amountPaise },
      { vpa, amountPaise },
    ],
  });

export async function openAccount(client, { vpa, holderName }) {
  await client.query('INSERT INTO accounts (vpa, holder_name) VALUES ($1, $2)', [vpa, holderName]);
}

export async function balance(db, vpa) {
  const { rows } = await db.query('SELECT balance_paise FROM accounts WHERE vpa = $1', [vpa]);
  if (rows.length === 0) throw new Error(`no such account: ${vpa}`);
  return rows[0].balance_paise;
}

/**
 * Re-derives the ledger from its postings.
 *
 * Two things must hold, always: every posting in the database sums to zero, and each account's
 * cached balance equals the sum of its own postings. Balances are a cache, and a cache that is
 * never checked is a cache that is eventually wrong.
 *
 * @returns {Promise<{holds: boolean, postingSum: number, drifts: Array<{vpa: string, balance: number, derived: number}>}>}
 */
export async function checkInvariants(db) {
  const { rows: sums } = await db.query('SELECT COALESCE(SUM(amount_paise), 0) AS total FROM postings');
  const postingSum = Number(sums[0].total);

  const { rows: drifts } = await db.query(`
    SELECT a.vpa, a.balance_paise AS balance, COALESCE(SUM(p.amount_paise), 0) AS derived
      FROM accounts a
      LEFT JOIN postings p ON p.vpa = a.vpa
     GROUP BY a.vpa, a.balance_paise
    HAVING a.balance_paise <> COALESCE(SUM(p.amount_paise), 0)
  `);

  return {
    holds: postingSum === 0 && drifts.length === 0,
    postingSum,
    drifts: drifts.map((row) => ({ vpa: row.vpa, balance: row.balance, derived: Number(row.derived) })),
  };
}
