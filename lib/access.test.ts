import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, getAllocations, getFarmerRecord, getOrderItems, listOrders, type Actor } from "./access";
import { applyMigrations, openDb, type Db } from "./db";
import { seedDatabase } from "./seed";

let db: Db;
const actorFor = (username: string): Actor => {
  const u = db.prepare("SELECT id, role, name, linked_farmer_id FROM users WHERE username = ?").get(username) as {
    id: number; role: Actor["role"]; name: string; linked_farmer_id: string | null;
  };
  return { id: u.id, role: u.role, name: u.name, linkedFarmerId: u.linked_farmer_id };
};

beforeEach(() => {
  db = openDb(":memory:");
  applyMigrations(db);
  seedDatabase(db, { orderTotalMinor: 10000, passwords: { buyer: "b", operator: "o", farmerA: "a", farmerB: "bb", farmerC: "c" } });
});

describe("farmers can only read their own data", () => {
  it("farmer A can read farmer A", () => {
    const recs = getFarmerRecord(db, actorFor("farmer-a"), "farmer-a");
    expect(recs).toHaveLength(1);
    expect(recs[0].allocation?.net).toEqual({ minor: 3700, assetCode: "USD", assetScale: 2 });
    expect(recs[0].allocation?.farmerWords).toBe("Not started");
  });

  it("farmer A cannot read farmer B or C", () => {
    const a = actorFor("farmer-a");
    expect(() => getFarmerRecord(db, a, "farmer-b")).toThrow(ForbiddenError);
    expect(() => getFarmerRecord(db, a, "farmer-c")).toThrow(ForbiddenError);
  });

  it("farmer cannot read orders, other items or the allocation table", () => {
    const a = actorFor("farmer-a");
    expect(() => listOrders(db, a)).toThrow(ForbiddenError);
    expect(() => getAllocations(db, a, 1)).toThrow(ForbiddenError);
  });

  it("farmer record never contains other farmers' amounts", () => {
    const text = JSON.stringify(getFarmerRecord(db, actorFor("farmer-b"), "farmer-b"));
    expect(text).not.toContain("Tomatoes");
    expect(text).not.toContain("farmer-a");
    expect(text).not.toContain("3700");
  });

  it("buyer cannot read a farmer record or allocations", () => {
    const b = actorFor("buyer");
    expect(() => getFarmerRecord(db, b, "farmer-a")).toThrow(ForbiddenError);
    expect(() => getAllocations(db, b, 1)).toThrow(ForbiddenError);
  });

  it("operator can read everything; buyer sees only their own order", () => {
    const op = actorFor("operator");
    expect(getFarmerRecord(db, op, "farmer-c")).toHaveLength(1);
    expect(getAllocations(db, op, 1)).toHaveLength(5);
    expect(listOrders(db, op)).toHaveLength(1);
    expect(listOrders(db, actorFor("buyer"))).toHaveLength(1);
    expect(getOrderItems(db, actorFor("buyer"), 1)).toHaveLength(3);
  });

  it("a second buyer cannot see the first buyer's order", () => {
    db.prepare("INSERT INTO users (username, role, name, password_hash) VALUES ('buyer2','buyer','Other','x')").run();
    expect(listOrders(db, actorFor("buyer2"))).toHaveLength(0);
    expect(() => getOrderItems(db, actorFor("buyer2"), 1)).toThrow();
  });
});
