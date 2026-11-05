// Runtime policy is authoritative; request flags cannot downgrade production.
export function requiresProductionPhi(...contexts) {
  return process.env.NODE_ENV === 'production' || process.env.MEDCIUS_PROFILE === 'production'
    || ['1','true'].includes(process.env.MEDCIUS_LIVE_HOSPITAL_DATA)
    || contexts.some(c => c?.profile === 'production');
}
export function assertSyncPhiAllowed(...contexts) {
  if (requiresProductionPhi(...contexts)) throw new Error('PHI_PRODUCTION_ASYNC_REQUIRED');
}
