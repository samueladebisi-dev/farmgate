"use client";
// Authorize button: disabled once the quote runs out (checked every second in the browser).
// The server re-checks expiry anyway, so this is only a convenience.
import { useEffect, useState } from "react";

export function AuthorizeButton({ orderId, expiresAtMs, minMs }: { orderId: number; expiresAtMs: number; minMs: number }) {
  const [enabled, setEnabled] = useState(true); // the server only renders this button when the quote is valid
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => {
      const ms = expiresAtMs - Date.now();
      setLeft(Math.max(0, Math.floor(ms / 1000)));
      setEnabled(ms >= minMs);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [expiresAtMs, minMs]);

  return (
    <form method="POST" action={`/api/orders/${orderId}/authorize`} className="flex flex-col gap-1">
      <button disabled={!enabled} className="border-2 border-black px-3 py-2 font-medium disabled:opacity-40">
        Authorize payment in wallet
      </button>
      <span className="text-sm">
        {enabled ? (left === null ? "" : `Quote valid for about ${left} more seconds`) : "This quote has expired. Get a new quote."}
      </span>
    </form>
  );
}
