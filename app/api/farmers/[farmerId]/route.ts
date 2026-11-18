import { NextResponse } from "next/server";
import { getFarmerRecord } from "../../../../lib/access";
import { withRole } from "../../../../lib/auth";
import { getDb } from "../../../../lib/db";
import { BadRequestError } from "../../../../lib/guard";

// Operator: any farmer. Farmer: only their own id (anything else is 403).
export const GET = withRole<{ params: Promise<{ farmerId: string }> }>(
  ["operator", "farmer"],
  async (actor, _req, ctx) => {
    const { farmerId } = await ctx.params;
    if (!/^farmer-[a-z0-9]{1,20}$/.test(farmerId)) throw new BadRequestError("Invalid farmer id");
    return NextResponse.json({ records: getFarmerRecord(getDb(), actor, farmerId) });
  },
  { limit: "read" },
);
