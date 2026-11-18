// Shape check for the query the wallet sends back after consent.
// Known parameters must have the right format. Unknown parameter NAMES are not refused (we cannot know every
// extra the wallet might add and a refusal would block a genuine payment); their names are noted in the audit log instead.
const SHAPES: Record<string, RegExp> = {
  gs: /^[0-9a-f-]{36}$/, // our own consent reference (uuid)
  order: /^[1-9]\d{0,9}$/,
  purpose: /^(BUYER_PAYMENT|PAYOUT)$/,
  hash: /^[A-Za-z0-9+/_=-]{20,128}$/,
  interact_ref: /^[A-Za-z0-9._~-]{1,128}$/,
  result: /^[a-z_]{1,40}$/,
};

export type CallbackShape = { ok: true; unknown: string[] } | { ok: false; reason: string };

export function checkCallbackQuery(q: URLSearchParams): CallbackShape {
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const [k, v] of q.entries()) {
    if (seen.has(k)) return { ok: false, reason: `DUPLICATE_PARAM_${k.slice(0, 20)}` };
    seen.add(k);
    const re = SHAPES[k];
    if (!re) unknown.push(k.slice(0, 30));
    else if (!re.test(v)) return { ok: false, reason: `BAD_PARAM_${k}` };
  }
  return { ok: true, unknown };
}
