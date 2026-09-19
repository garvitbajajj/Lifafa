import { type Bytes, concat, utf8 } from './bytes.ts';
import { CanonicalReader, CanonicalWriter, MalformedError } from './canonical.ts';
import { verifySignature } from './identity.ts';

/**
 * The service's signed answer: this payment was settled, or refused and why.
 *
 * Signed so it can travel back through the same untrusted phones that carried the payment, and
 * the payer can check it came from the service. (Carrying it back is not built yet - see the
 * threat model. The service does issue and store them.)
 */
export interface Receipt {
  readonly idempotencyKey: string;
  readonly outcome: 'SETTLED' | 'REJECTED';
  /** Why it was refused; empty when settled. */
  readonly reason: string;
  /** The ledger entry that moved the money; 0 when refused. */
  readonly journalEntryId: number;
  readonly decidedAt: number;
}

export interface SignedReceipt {
  readonly receipt: Receipt;
  readonly signature: Bytes;
}

const RECEIPT_DOMAIN = utf8('lifafa/receipt/1\n');

export function encodeReceipt(receipt: Receipt): Bytes {
  return new CanonicalWriter()
    .string(receipt.idempotencyKey)
    .u8(receipt.outcome === 'SETTLED' ? 1 : 2)
    .string(receipt.reason)
    .u64(receipt.journalEntryId)
    .u64(receipt.decidedAt)
    .toBytes();
}

export function decodeReceipt(bytes: Bytes): Receipt {
  const reader = new CanonicalReader(bytes);
  const idempotencyKey = reader.string();
  const outcomeCode = reader.u8();
  if (outcomeCode !== 1 && outcomeCode !== 2) throw new MalformedError(`unknown receipt outcome ${outcomeCode}`);
  const receipt: Receipt = {
    idempotencyKey,
    outcome: outcomeCode === 1 ? 'SETTLED' : 'REJECTED',
    reason: reader.string(),
    journalEntryId: reader.u64(),
    decidedAt: reader.u64(),
  };
  reader.end();
  return receipt;
}

export function signReceipt(signer: { sign(message: Bytes): Bytes }, receipt: Receipt): SignedReceipt {
  return { receipt, signature: signer.sign(concat(RECEIPT_DOMAIN, encodeReceipt(receipt))) };
}

export function verifyReceipt(servicePublicKey: Bytes, signed: SignedReceipt): boolean {
  return verifySignature(servicePublicKey, concat(RECEIPT_DOMAIN, encodeReceipt(signed.receipt)), signed.signature);
}
