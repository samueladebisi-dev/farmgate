"use client";
// Creates a receipt link for ONE recipient and shows it (with a QR code) once. The server keeps only a hash of the token.
import { useState } from "react";

type Recipient = { id: number; name: string; reference: string };
type Created = { url: string; expiresAt: string; qrSvg: string; name: string };

export function ReceiptLinkCreator({ orderId, recipients }: { orderId: number; recipients: Recipient[] }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function create(r: Recipient) {
    setBusy(r.id);
    setError(null);
    setCreated(null);
    try {
      const res = await fetch(`/api/orders/${orderId}/receipt-links`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allocationId: r.id, hours: 24 }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not create the link");
      setCreated({ url: data.url, expiresAt: data.expiresAt, qrSvg: data.qrSvg, name: r.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the link");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {recipients.map((r) => (
          <button key={r.id} disabled={busy !== null} onClick={() => create(r)} className="border px-3 py-2 text-sm disabled:opacity-40">
            Create receipt link: {r.name} ({r.reference})
          </button>
        ))}
      </div>
      {error && <p role="alert" className="text-red-700 text-sm">{error}</p>}
      {created && (
        <div className="border-2 border-black p-3 flex flex-col gap-2">
          <p className="text-sm font-semibold">Link for {created.name}. Copy it now: it is not shown again.</p>
          <p className="text-sm break-all font-mono">{created.url}</p>
          <div className="flex gap-2">
            <button
              className="border px-3 py-1 text-sm"
              onClick={() => navigator.clipboard?.writeText(created.url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {})}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
          <p className="text-sm">Expires {created.expiresAt.replace("T", " ").slice(0, 16)} UTC.</p>
          {/* SVG generated on the server by the qrcode library from the link above */}
          <div className="w-48 h-48 border" aria-label="QR code of the receipt link" dangerouslySetInnerHTML={{ __html: created.qrSvg }} />
        </div>
      )}
    </div>
  );
}
