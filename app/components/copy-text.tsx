"use client";
// Plain text in a box with a Copy button. Copying is manual: nothing is ever sent by SMS.
import { useState } from "react";

export function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <pre className="border-2 border-black bg-gray-100 p-3 text-base whitespace-pre-wrap">{text}</pre>
      <button
        type="button"
        className="border-2 border-black px-4 py-3 text-base font-medium self-start"
        onClick={() => {
          navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
        }}
      >
        {copied ? "Copied" : "Copy text"}
      </button>
    </div>
  );
}
