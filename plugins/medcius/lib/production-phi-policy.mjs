// Runtime policy is authoritative; request flags cannot downgrade production.
import { isLiveHospitalDataEnabled } from './clinical-landing-policy.mjs';

export function requiresProductionPhi(...contexts) {
  return process.env.NODE_ENV === 'production' || process.env.MEDCIUS_PROFILE === 'production'
    || isLiveHospitalDataEnabled()
    || contexts.some(c => c?.profile === 'production');
}
export function assertSyncPhiAllowed(...contexts) {
  if (requiresProductionPhi(...contexts)) throw new Error('PHI_PRODUCTION_ASYNC_REQUIRED');
}
