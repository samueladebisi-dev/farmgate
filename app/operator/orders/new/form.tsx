"use client";
// Create order: type the lines, press Preview to see the full allocation computed by the server, then Save.
// Any edit after a preview clears it, so what you save is always what you previewed.
import { useRouter } from "next/navigation";
import { useState } from "react";

type Buyer = { id: number; name: string };
type Farmer = { id: string; name: string };
type Line = { farmerId: string; produce: string; kg: string; price: string };
type Terms = Record<string, { fee: string; deduction: string }>;
type Preview = {
  lines: { farmerId: string; produce: string; kg: number; price: string; gross: string }[];
  farmers: { farmerId: string; gross: string; fee: string; deduction: string; net: string }[];
  logistics: string; retained: string; expectedReceive: string; farmerNets: string; ledgerTotal: string;
};

const DEFAULT_FEE = "200"; // 2.00 in minor units, like the worked example
const DEFAULT_DEDUCTION = "100"; // 1.00 in minor units

export function NewOrderForm({ buyers, farmers }: { buyers: Buyer[]; farmers: Farmer[] }) {
  const router = useRouter();
  const [buyerUserId, setBuyer] = useState(String(buyers[0]?.id ?? ""));
  const [lines, setLines] = useState<Line[]>([{ farmerId: farmers[0]?.id ?? "", produce: "", kg: "", price: "" }]);
  const [terms, setTerms] = useState<Terms>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const termsFor = (f: string) => terms[f] ?? { fee: DEFAULT_FEE, deduction: DEFAULT_DEDUCTION };
  const used = [...new Set(lines.map((l) => l.farmerId).filter(Boolean))];
  const nameOf = (id: string) => farmers.find((f) => f.id === id)?.name ?? id;
  const touch = () => { setPreview(null); setErrors([]); };

  const body = () => ({
    buyerUserId: Number(buyerUserId),
    lines: lines.map((l) => ({ farmerId: l.farmerId, produce: l.produce, kg: l.kg, price: l.price })),
    terms: Object.fromEntries(used.map((f) => [f, { fee: termsFor(f).fee, deduction: termsFor(f).deduction }])),
  });

  async function send(url: string) {
    setBusy(true);
    setErrors([]);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body()) });
      return await res.json();
    } catch {
      setErrors(["Could not reach the server"]);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function doPreview() {
    const d = await send("/api/orders/preview");
    if (!d) return;
    if (d.ok) setPreview(d);
    else { setPreview(null); setErrors(d.errors ?? ["Invalid order"]); }
  }
  async function doSave() {
    const d = await send("/api/orders");
    if (!d) return;
    if (d.ok) router.push(`/operator/orders/${d.orderId}?notice=order_created`);
    else setErrors(d.errors ?? ["Could not save"]);
  }

  const setLine = (i: number, patch: Partial<Line>) => { touch(); setLines(lines.map((l, n) => (n === i ? { ...l, ...patch } : l))); };
  const input = "border px-2 py-2 text-base w-full";

  return (
    <div className="flex flex-col gap-6">
      <label className="flex flex-col gap-1 text-sm max-w-xs">
        Buyer
        <select className={input} value={buyerUserId} onChange={(e) => { touch(); setBuyer(e.target.value); }}>
          {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </label>

      <fieldset className="flex flex-col gap-3">
        <legend className="font-semibold">Produce lines</legend>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-2 sm:grid-cols-5 gap-2 items-end border-b pb-3">
            <label className="flex flex-col gap-1 text-sm">Farmer
              <select className={input} value={l.farmerId} onChange={(e) => setLine(i, { farmerId: e.target.value })}>
                {farmers.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">Produce
              <input className={input} value={l.produce} onChange={(e) => setLine(i, { produce: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-sm">Whole kg
              <input className={input} inputMode="numeric" value={l.kg} onChange={(e) => setLine(i, { kg: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-sm">Price per kg (USD, like 3.50)
              <input className={input} inputMode="decimal" value={l.price} onChange={(e) => setLine(i, { price: e.target.value })} />
            </label>
            <button type="button" disabled={lines.length === 1} onClick={() => { touch(); setLines(lines.filter((_, n) => n !== i)); }} className="border px-3 py-2 text-sm disabled:opacity-40">Remove line</button>
          </div>
        ))}
        <button type="button" onClick={() => { touch(); setLines([...lines, { farmerId: farmers[0]?.id ?? "", produce: "", kg: "", price: "" }]); }} className="border px-3 py-2 text-sm self-start">Add line</button>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="font-semibold">Per farmer: service fee and logistics deduction (in minor units, 100 = 1.00 USD)</legend>
        {used.map((f) => (
          <div key={f} className="grid grid-cols-3 gap-2 items-end">
            <span className="text-sm">{nameOf(f)}</span>
            <label className="flex flex-col gap-1 text-sm">Service fee
              <input className={input} inputMode="numeric" value={termsFor(f).fee} onChange={(e) => { touch(); setTerms({ ...terms, [f]: { ...termsFor(f), fee: e.target.value } }); }} />
            </label>
            <label className="flex flex-col gap-1 text-sm">Logistics deduction
              <input className={input} inputMode="numeric" value={termsFor(f).deduction} onChange={(e) => { touch(); setTerms({ ...terms, [f]: { ...termsFor(f), deduction: e.target.value } }); }} />
            </label>
          </div>
        ))}
      </fieldset>

      {errors.length > 0 && (
        <ul role="alert" className="border-2 border-red-700 px-3 py-2 text-sm list-disc pl-6">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
      )}

      <div className="flex gap-3">
        <button type="button" disabled={busy} onClick={doPreview} className="border-2 border-black px-3 py-2 font-medium disabled:opacity-40">Preview allocation</button>
        <button type="button" disabled={busy || !preview} onClick={doSave} className="border-2 border-black px-3 py-2 font-medium disabled:opacity-40">Save order</button>
      </div>

      {preview && (
        <section className="flex flex-col gap-3">
          <h2 className="font-semibold">Computed allocation (not saved yet)</h2>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead><tr>{["Recipient", "Gross", "Fee", "Logistics deduction", "Net"].map((h) => <th key={h} className="border-b-2 border-black px-2 py-1 text-left">{h}</th>)}</tr></thead>
              <tbody>
                {preview.farmers.map((f) => (
                  <tr key={f.farmerId}><td className="border-b px-2 py-1">{nameOf(f.farmerId)}</td><td className="border-b px-2 py-1 text-right">{f.gross}</td><td className="border-b px-2 py-1 text-right">{f.fee}</td><td className="border-b px-2 py-1 text-right">{f.deduction}</td><td className="border-b px-2 py-1 text-right">{f.net}</td></tr>
                ))}
                <tr><td className="border-b px-2 py-1">Logistics</td><td /><td /><td /><td className="border-b px-2 py-1 text-right">{preview.logistics}</td></tr>
                <tr><td className="border-b px-2 py-1">Cooperative retained</td><td /><td /><td /><td className="border-b px-2 py-1 text-right">{preview.retained}</td></tr>
                <tr className="font-semibold"><td className="px-2 py-1">Total</td><td /><td /><td /><td className="px-2 py-1 text-right">{preview.ledgerTotal}</td></tr>
              </tbody>
            </table>
          </div>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt>Expected receive (total gross)</dt><dd className="font-semibold">{preview.expectedReceive}</dd>
            <dt>Farmer nets</dt><dd>{preview.farmerNets}</dd>
          </dl>
          <p className="text-sm">The order starts as AWAITING_PAYMENT with unapproved allocations.</p>
        </section>
      )}
    </div>
  );
}
