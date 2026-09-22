import { concat, utf8 } from './bytes.js';
import { CanonicalReader, CanonicalWriter, MalformedError } from './canonical.js';
import { verifySignature } from './identity.js';

/**
 * The service's signed answer: this payment was settled, or refused and why.
 *
 * Signed so it can travel back through the same untrusted phones that carried the payment, and
 * the payer can check it came from the service.
 *
 * @typedef {object} Receipt
 * @property {string} idempotencyKey
 * @property {'SETTLED'|'REJECTED'} outcome
 * @property {string} reason         why it was refused; empty when settled
 * @property {number} journalEntryId the ledger entry that moved the money; 0 when refused
 * @property {number} decidedAt
 */

const RECEIPT_DOMAIN = utf8('lifafa/receipt/1\n');

export function encodeReceipt(receipt) {
  return new CanonicalWriter()
    .string(receipt.idempotencyKey)
    .u8(receipt.outcome === 'SETTLED' ? 1 : 2)
    .string(receipt.reason)
    .u64(receipt.journalEntryId)
    .u64(receipt.decidedAt)
    .toBytes();
}

export function decodeReceipt(bytes) {
  const reader = new CanonicalReader(bytes);
  const idempotencyKey = reader.string();
  const outcomeCode = reader.u8();
  if (outcomeCode !== 1 && outcomeCode !== 2) throw new MalformedError(`unknown receipt outcome ${outcomeCode}`);
  const receipt = {
    idempotencyKey,
    outcome: outcomeCode === 1 ? 'SETTLED' : 'REJECTED',
    reason: reader.string(),
    journalEntryId: reader.u64(),
    decidedAt: reader.u64(),
  };
  reader.end();
  return receipt;
}

export function signReceipt(signer, receipt) {
  return { receipt, signature: signer.sign(concat(RECEIPT_DOMAIN, encodeReceipt(receipt))) };
}

export function verifyReceipt(servicePublicKey, signed) {
  return verifySignature(servicePublicKey, concat(RECEIPT_DOMAIN, encodeReceipt(signed.receipt)), signed.signature);
}
