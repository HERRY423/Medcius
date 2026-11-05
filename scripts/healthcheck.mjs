// Match the server's transport without disabling certificate validation.
const tlsKey = process.env.MEDCIUS_TLS_KEY;
const tlsCert = process.env.MEDCIUS_TLS_CERT;
const production = process.env.NODE_ENV === 'production' || process.env.MEDCIUS_PROFILE === 'production';
try {
  if (Boolean(tlsKey) !== Boolean(tlsCert) || (production && !tlsKey)) throw new Error('TLS_REQUIRED');
  const protocol = tlsKey ? 'https' : 'http';
  const result = await fetch(`${protocol}://127.0.0.1:${Number(process.env.PORT || 8080)}/health`,
    {signal:AbortSignal.timeout(4000)});
  if (!result.ok) throw new Error('NOT_HEALTHY');
} catch {
  console.error('HEALTHCHECK_FAILED');
  process.exitCode = 1;
}
