/**
 * Debug switches whose output bypasses the structured logger, and so its
 * redaction (R-OA-27). `DEBUG=ioredis:*` prints every Redis command with its
 * arguments: `oauth:req:{rid}` keys and the stored consent request (`state`,
 * `code_challenge`, `assay_replaces`). It is never set in production; this
 * only makes it loud when it is.
 */
export function unredactedDebugWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  const debug = env.DEBUG ?? '';
  if (!/(^|[\s,])(ioredis|\*)/i.test(debug)) return null;
  return (
    `DEBUG=${debug} prints Redis commands with their arguments, unredacted: ` +
    'OAuth consent request ids and stored requests reach stdout. Never set it in production.'
  );
}
