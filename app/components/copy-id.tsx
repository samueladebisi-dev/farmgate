"use client";
// Long provider ids: show only the tail, keep the full value in a tooltip and a Copy button.
import { useState } from "react";

export function CopyId({ value, label }: { value: string | null; label?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span>-</span>;
  const tail = value.length > 14 ? `…${value.slice(-10)}` : value;
  return (
    <span className="inline-flex items-center gap-1">
      {label && <span className="text-gray-600">{label}</span>}
      <span title={value} className="font-mono text-xs">{tail}</span>
      <button
        type="button"
        className="border px-1 text-xs"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }).catch(() => {});
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
