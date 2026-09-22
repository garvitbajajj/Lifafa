import { randomUUID } from 'node:crypto';
import { DeviceIdentity, encodeEnvelope, paymentInstruction, sealSigned, signInstruction } from '@lifafa/protocol';

const SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * A phone. It knows its own key, its VPA, and the settlement service's public key - which it
 * fetched the last time it had signal. Nothing here talks to the service: that is the point.
 */
export class DeviceAgent {
  #identity;
  #sequence = 0;

  constructor({ identity = DeviceIdentity.generate(), vpa, serverPublicKey, serverKeyId, now = () => Date.now() }) {
    this.#identity = identity;
    // Exposed so a simulation can build a second agent on the same key - one phone claiming to
    // pay from an account it is not bound to, for instance.
    this.identity = identity;
    this.vpa = vpa;
    this.deviceId = identity.deviceId;
    this.publicKey = identity.publicKey;
    this.serverPublicKey = serverPublicKey;
    this.serverKeyId = serverKeyId;
    this.now = now;
  }

  /** Signs a payment. Offline, this is all a payer can do. */
  compose({ to, amountPaise, ttlMs = SIX_HOURS, sequence, nonce = randomUUID() }) {
    const signedAt = this.now();
    const instruction = paymentInstruction({
      senderVpa: this.vpa,
      receiverVpa: to,
      amountPaise,
      nonce,
      deviceSequence: sequence ?? ++this.#sequence,
      signedAt,
      expiresAt: signedAt + ttlMs,
    });
    return signInstruction(this.#identity, instruction);
  }

  /** Seals a signed payment into an envelope ready to hand to a neighbour. */
  seal(signed) {
    return encodeEnvelope(sealSigned(signed, this.serverPublicKey, this.serverKeyId));
  }

  pay(options) {
    return this.seal(this.compose(options));
  }

  /**
   * Seals the same signed payment again. The bytes differ completely - a fresh ephemeral key -
   * but it is the same payment, which is what defeats deduplication by packet hash.
   */
  reseal(signed) {
    return this.seal(signed);
  }

  /**
   * Two different payments from one balance, signed while offline. Both are valid; the service
   * cannot refuse them at signing time because it never sees signing. This is what the offline
   * allowance exists to bound.
   */
  doubleSpend({ to, amountPaise }) {
    const sequence = ++this.#sequence;
    return [
      this.seal(this.compose({ to, amountPaise, sequence })),
      this.seal(this.compose({ to, amountPaise, sequence })),
    ];
  }
}
