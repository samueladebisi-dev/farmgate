// Tiny plain UI helpers shared by the pages.
import { formatMoney } from "../../lib/money";

export const money = (a: { minor: number; assetCode: string; assetScale: number }) => formatMoney(a.minor, a.assetCode, a.assetScale);

export function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} className="border-b-2 border-black px-2 py-1 text-left whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export const Td = ({ children, right }: { children?: React.ReactNode; right?: boolean }) => (
  <td className={`border-b px-2 py-1 whitespace-nowrap ${right ? "text-right" : ""}`}>{children}</td>
);
