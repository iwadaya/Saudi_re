import { parseErrorBody } from './errorBody.js';

export function getPricingDriftPayload(error) {
  const body = parseErrorBody(error) || {};
  const code = body.code || error?.code;
  if (code !== 'PRICING_DRIFT') return null;
  return {
    message: body.error || error?.message || 'Pricing drift detected',
    requestId: body.requestId || error?.requestId || null,
    drifts: Array.isArray(body.drifts) ? body.drifts : [],
  };
}

export function formatPricingDriftMessage(error) {
  const payload = getPricingDriftPayload(error);
  if (!payload) return null;
  const count = payload.drifts.length;
  const suffix = payload.requestId ? ` Request ${payload.requestId}.` : '';
  if (!count) return `${payload.message}.${suffix}`;
  return `${payload.message}: ${count} drift${count === 1 ? '' : 's'} found.${suffix}`;
}

export default formatPricingDriftMessage;
