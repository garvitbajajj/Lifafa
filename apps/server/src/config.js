/**
 * Configuration, checked at startup rather than at the moment it first matters.
 *
 * A service that starts happily and is insecure is worse than one that refuses to start and says
 * why: the first is discovered by an attacker, the second by whoever ran it.
 */
export function loadConfig(env = process.env) {
  const demo = env.LIFAFA_DEMO === 'true';
  const adminToken = env.LIFAFA_ADMIN_TOKEN ?? '';

  if (!demo && adminToken.length < 24) {
    throw new Error(
      'LIFAFA_ADMIN_TOKEN must be set to at least 24 characters, or LIFAFA_DEMO=true for a local demo. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"',
    );
  }

  return {
    demo,
    adminToken,
    port: Number(env.PORT ?? 3000),
    /** Requests one bridge may make per minute, per instance. */
    bridgeRatePerMinute: Number(env.LIFAFA_BRIDGE_RATE ?? 600),
  };
}
