// Money engine. Integer minor units only: no floats anywhere in this file.
// Every amount travels with its asset code and scale (see `Amount`).

export type Amount = { minor: number; assetCode: string; assetScale: number };

/** Throws unless n is a safe whole number. */
export function assertInt(n: number, label = "amount"): number {
  if (!Number.isSafeInteger(n)) throw new Error(`${label} must be an integer number of minor units, got ${n}`);
  return n;
}

/** "10.00" -> 1000 for scale 2. String maths only. */
export function parseMajorToMinor(text: string, scale: number): number {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(text.trim());
  if (!m) throw new Error(`Not a valid amount: "${text}"`);
  const frac = m[2] ?? "";
  if (frac.length > scale) throw new Error(`"${text}" has more decimals than scale ${scale}`);
  return assertInt(Number(m[1]) * 10 ** scale + Number(frac.padEnd(scale, "0") || "0"));
}

/** 3700 -> "37.00" (no currency). */
export function formatMinor(minor: number, scale: number): string {
  assertInt(minor);
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const d = 10 ** scale;
  const whole = Math.floor(abs / d);
  const frac = String(abs % d).padStart(scale, "0");
  return `${neg ? "-" : ""}${scale > 0 ? `${whole}.${frac}` : whole}`;
}

/** 3700 -> "37.00 USD". Every amount shown in the app goes through this. */
export function formatMoney(minor: number, assetCode: string, scale: number): string {
  return `${formatMinor(minor, scale)} ${assetCode}`;
}

// ---------------------------------------------------------------------------
// Per-item allocation
// ---------------------------------------------------------------------------

export type ItemInput = { farmerId: string; grossMinor: number; feeMinor: number; deductionMinor: number };
export type ItemAllocation = ItemInput & { netMinor: number };

/** net = gross - fee - logistics deduction. Must not be negative. */
export function allocateItem(i: ItemInput): ItemAllocation {
  assertInt(i.grossMinor, "gross");
  assertInt(i.feeMinor, "fee");
  assertInt(i.deductionMinor, "deduction");
  const netMinor = i.grossMinor - i.feeMinor - i.deductionMinor;
  if (i.grossMinor < 0 || i.feeMinor < 0 || i.deductionMinor < 0 || netMinor < 0) {
    throw new Error(`Invalid allocation for ${i.farmerId}: gross ${i.grossMinor}, fee ${i.feeMinor}, deduction ${i.deductionMinor}`);
  }
  return { ...i, netMinor };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type LedgerEntry = { recipient: string; kind: "farmer" | "logistics" | "cooperative"; minor: number };
export type Ledger = {
  entries: LedgerEntry[];
  totalMinor: number;
  grossMinor: number;
  feesMinor: number;
  logisticsMinor: number;
  farmerNetsMinor: number;
};

/**
 * Builds the allocation ledger: one entry per farmer (net), logistics (sum of deductions),
 * and the cooperative's retained fees. Entries always add up to the order's gross total.
 */
export function buildLedger(items: ItemInput[]): Ledger {
  const allocs = items.map(allocateItem);
  // One farmer may appear on several items: sum nets per farmer, keep first-seen order.
  const byFarmer = new Map<string, number>();
  for (const a of allocs) byFarmer.set(a.farmerId, (byFarmer.get(a.farmerId) ?? 0) + a.netMinor);
  const grossMinor = allocs.reduce((s, a) => s + a.grossMinor, 0);
  const feesMinor = allocs.reduce((s, a) => s + a.feeMinor, 0);
  const logisticsMinor = allocs.reduce((s, a) => s + a.deductionMinor, 0);
  const farmerNetsMinor = allocs.reduce((s, a) => s + a.netMinor, 0);
  const entries: LedgerEntry[] = [
    ...[...byFarmer].map(([recipient, minor]) => ({ recipient, kind: "farmer" as const, minor })),
    { recipient: "logistics", kind: "logistics", minor: logisticsMinor },
    { recipient: "cooperative", kind: "cooperative", minor: feesMinor },
  ];
  const totalMinor = entries.reduce((s, e) => s + e.minor, 0);
  return { entries, totalMinor, grossMinor, feesMinor, logisticsMinor, farmerNetsMinor };
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/** The allocation total must equal exactly what the cooperative confirmed receiving. */
export function assertAllocationMatchesReceived(allocationTotalMinor: number, confirmedReceivedMinor: number): void {
  assertInt(allocationTotalMinor, "allocation total");
  assertInt(confirmedReceivedMinor, "confirmed received");
  if (allocationTotalMinor !== confirmedReceivedMinor) {
    throw new Error(`Allocation total ${allocationTotalMinor} does not equal confirmed received ${confirmedReceivedMinor}`);
  }
}

/**
 * Sum of quoted outgoing debits (all in the cooperative's own asset) must be
 * <= confirmed received - required reserve. Reserve is 0 for now.
 */
export function assertDebitsWithinReceived(quotedDebitsMinor: number[], confirmedReceivedMinor: number, reserveMinor = 0): void {
  quotedDebitsMinor.forEach((d) => assertInt(d, "quoted debit"));
  assertInt(confirmedReceivedMinor, "confirmed received");
  assertInt(reserveMinor, "reserve");
  const sum = quotedDebitsMinor.reduce((s, d) => s + d, 0);
  const limit = confirmedReceivedMinor - reserveMinor;
  if (sum > limit) throw new Error(`Quoted debits ${sum} exceed available ${limit} (received ${confirmedReceivedMinor} minus reserve ${reserveMinor})`);
}

// ---------------------------------------------------------------------------
// Largest remainder (for future proportional fees)
// ---------------------------------------------------------------------------

/**
 * Splits `totalMinor` across ids in proportion to integer `weight`s so shares are integers
 * that add up exactly to the total. Leftover units go to the biggest fractional remainders;
 * ties are broken by id (ascending, plain string comparison) so the result is deterministic.
 */
export function largestRemainder(totalMinor: number, parts: { id: string; weight: number }[]): Record<string, number> {
  assertInt(totalMinor, "total");
  if (totalMinor < 0) throw new Error("total must not be negative");
  if (parts.length === 0) throw new Error("need at least one part");
  const ids = new Set(parts.map((p) => p.id));
  if (ids.size !== parts.length) throw new Error("duplicate ids");
  parts.forEach((p) => {
    assertInt(p.weight, "weight");
    if (p.weight < 0) throw new Error("weights must not be negative");
  });
  const weightSum = parts.reduce((s, p) => s + p.weight, 0);
  if (weightSum === 0) throw new Error("weights must not all be zero");

  // Exact share = total * weight / weightSum. Use BigInt so the product can never overflow.
  const rows = parts.map((p) => {
    const num = BigInt(totalMinor) * BigInt(p.weight);
    const den = BigInt(weightSum);
    return { id: p.id, floor: Number(num / den), rem: num % den };
  });
  let left = totalMinor - rows.reduce((s, r) => s + r.floor, 0);
  const order = [...rows].sort((a, b) => (a.rem === b.rem ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.rem > b.rem ? -1 : 1));
  const out: Record<string, number> = {};
  rows.forEach((r) => (out[r.id] = r.floor));
  for (const r of order) {
    if (left <= 0) break;
    out[r.id] += 1;
    left -= 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Demo order builder
// ---------------------------------------------------------------------------

export type DemoItem = {
  farmerId: string;
  produce: string;
  kg: number;
  priceMinorPerKg: number;
  grossMinor: number;
  feeMinor: number;
  deductionMinor: number;
};

/**
 * The worked order from the spec at 100.00 (scale 2): Tomatoes 20kg@2.00 (A), Peppers 10kg@3.50 (B),
 * Okra 10kg@2.50 (C), fees 2.00/2.00/1.00, logistics deduction 1.00 each.
 * Other totals scale kg, fees and deductions by total/100.00. This stays exact (whole kg, whole
 * minor units) whenever the total is a multiple of 10.00, so the test amount 10.00 works: 2/1/1 kg.
 */
export function buildDemoOrder(totalMinor: number, scale = 2): DemoItem[] {
  const base = 100 * 10 ** scale; // 100.00 in minor units
  assertInt(totalMinor, "order total");
  const step = base / 10; // 10.00
  if (totalMinor <= 0 || totalMinor % step !== 0) {
    throw new Error(`Demo order total must be a positive multiple of ${formatMinor(step, scale)}`);
  }
  const scaleUp = (n: number) => {
    const v = (n * totalMinor) / base;
    if (!Number.isInteger(v)) throw new Error("Demo order does not scale to whole numbers");
    return v;
  };
  const e = (n: number) => n * 10 ** scale; // major -> minor for the base prices
  const rows = [
    { farmerId: "farmer-a", produce: "Tomatoes", kg: 20, price: e(2), fee: e(2), ded: e(1) },
    { farmerId: "farmer-b", produce: "Peppers", kg: 10, price: Math.round(3.5 * 10 ** scale), fee: e(2), ded: e(1) },
    { farmerId: "farmer-c", produce: "Okra", kg: 10, price: Math.round(2.5 * 10 ** scale), fee: e(1), ded: e(1) },
  ];
  return rows.map((r) => {
    const kg = scaleUp(r.kg);
    return {
      farmerId: r.farmerId,
      produce: r.produce,
      kg,
      priceMinorPerKg: r.price,
      grossMinor: kg * r.price,
      feeMinor: scaleUp(r.fee),
      deductionMinor: scaleUp(r.ded),
    };
  });
}

// ---------------------------------------------------------------------------
// Order planning (used by "Create order": preview and save use the same function)
// ---------------------------------------------------------------------------

export type PlanLine = { farmerId: string; produce: string; kg: number; priceMinorPerKg: number };
export type PlanFarmerTerms = { feeMinor: number; deductionMinor: number };
export type OrderPlan = {
  items: DemoItem[];
  farmers: { farmerId: string; grossMinor: number; feeMinor: number; deductionMinor: number; netMinor: number }[];
  ledger: Ledger;
  /** Expected receive = total gross of all lines. */
  expectedReceiveMinor: number;
  logisticsMinor: number;
  retainedMinor: number;
};

export class PlanError extends Error {
  constructor(public errors: string[]) {
    super(errors.join("; "));
  }
}

const MAX_LINES = 20;
const MAX_KG = 1_000_000;
const MAX_PRICE_MINOR = 1_000_000_000;

/**
 * Turns produce lines plus per-farmer fee and logistics deduction into the full allocation, integer maths only.
 * Fee and deduction are per FARMER (not per line): they are carried by that farmer's first line.
 * Collects every problem so the operator sees them all at once. A farmer's net must be above zero because a
 * payout of zero cannot be made.
 */
export function planOrder(lines: PlanLine[], terms: Record<string, PlanFarmerTerms>, scale = 2): OrderPlan {
  const errors: string[] = [];
  if (!Array.isArray(lines) || lines.length === 0) throw new PlanError(["Add at least one produce line"]);
  if (lines.length > MAX_LINES) throw new PlanError([`At most ${MAX_LINES} lines`]);

  lines.forEach((l, i) => {
    const n = i + 1;
    if (!/^farmer-[a-z0-9]+$/.test(l.farmerId ?? "")) errors.push(`Line ${n}: choose a farmer`);
    const name = String(l.produce ?? "").trim();
    if (name.length < 1 || name.length > 60 || /[\u0000-\u001f<>]/.test(name)) errors.push(`Line ${n}: produce name must be 1 to 60 plain characters`);
    if (!Number.isInteger(l.kg) || l.kg < 1 || l.kg > MAX_KG) errors.push(`Line ${n}: kg must be a whole number from 1 to ${MAX_KG}`);
    if (!Number.isSafeInteger(l.priceMinorPerKg) || l.priceMinorPerKg < 1 || l.priceMinorPerKg > MAX_PRICE_MINOR) errors.push(`Line ${n}: price per kg must be above zero`);
  });
  const farmerIds = [...new Set(lines.map((l) => l.farmerId))];
  for (const f of farmerIds) {
    const t = terms?.[f];
    if (!t) errors.push(`${f}: fee and deduction are missing`);
    else {
      if (!Number.isSafeInteger(t.feeMinor) || t.feeMinor < 0) errors.push(`${f}: service fee must be a whole number of minor units, zero or more`);
      if (!Number.isSafeInteger(t.deductionMinor) || t.deductionMinor < 0) errors.push(`${f}: logistics deduction must be a whole number of minor units, zero or more`);
    }
  }
  if (errors.length) throw new PlanError(errors);

  const seen = new Set<string>();
  const items: DemoItem[] = lines.map((l) => {
    const first = !seen.has(l.farmerId);
    seen.add(l.farmerId);
    const grossMinor = l.kg * l.priceMinorPerKg;
    if (!Number.isSafeInteger(grossMinor) || grossMinor > 1e12) errors.push(`${l.produce}: amount is too large`);
    return {
      farmerId: l.farmerId, produce: l.produce.trim(), kg: l.kg, priceMinorPerKg: l.priceMinorPerKg, grossMinor,
      feeMinor: first ? terms[l.farmerId].feeMinor : 0, deductionMinor: first ? terms[l.farmerId].deductionMinor : 0,
    };
  });
  if (errors.length) throw new PlanError(errors);

  const farmers = farmerIds.map((farmerId) => {
    const mine = items.filter((i) => i.farmerId === farmerId);
    const grossMinor = mine.reduce((s, i) => s + i.grossMinor, 0);
    const feeMinor = mine.reduce((s, i) => s + i.feeMinor, 0);
    const deductionMinor = mine.reduce((s, i) => s + i.deductionMinor, 0);
    const netMinor = grossMinor - feeMinor - deductionMinor;
    if (netMinor < 0) errors.push(`${farmerId}: fee and deduction (${formatMinor(feeMinor + deductionMinor, scale)}) are more than the gross amount (${formatMinor(grossMinor, scale)}), net would be negative`);
    else if (netMinor === 0) errors.push(`${farmerId}: net would be zero. A payout of zero cannot be made, lower the fee or deduction`);
    return { farmerId, grossMinor, feeMinor, deductionMinor, netMinor };
  });
  if (errors.length) throw new PlanError(errors);

  const ledger = buildLedger(items);
  return {
    items, farmers, ledger, expectedReceiveMinor: ledger.grossMinor, logisticsMinor: ledger.logisticsMinor, retainedMinor: ledger.feesMinor,
  };
}
