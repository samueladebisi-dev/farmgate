import type { Metadata } from "next";
import "./globals.css";
import { logoutAction } from "./actions";
import { getActor } from "../lib/auth";

export const metadata: Metadata = { title: "Argus Payments", description: "Cooperative payment workflow (test network)" };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-black">
        {/* Persistent banner on every page */}
        <div className="bg-yellow-300 border-b-2 border-black px-4 py-2 text-center text-sm font-bold uppercase tracking-wide">
          TEST NETWORK, PLAY MONEY ONLY
        </div>
        <header className="border-b px-4 py-3 flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold">Argus Payments</span>
          {actor && (
            <form action={logoutAction} className="flex items-center gap-3 text-sm">
              <span>
                {actor.name} ({actor.role})
              </span>
              <button className="border px-3 py-1">Log out</button>
            </form>
          )}
        </header>
        <main className="mx-auto max-w-4xl p-4">{children}</main>
      </body>
    </html>
  );
}
