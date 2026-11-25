// Restock planning: turn a supplier feed into slot refills that respect each
// slot's capacity. Pure functions — the caller owns persistence.

export type FeedItem = {
  slot: string;
  productId: string;
  onHand: number;
  offered: number;
};

export type RestockLine = {
  slot: string;
  productId: string;
  units: number;
};

export type RestockPlan = {
  machineId: string;
  lines: RestockLine[];
  totalUnits: number;
};

export function planRestock(
  feed: { machineId: string; items: FeedItem[] },
  capacities: Record<string, number>,
): RestockPlan {
  const bySlot = new Map<string, RestockLine>();
  for (const item of feed.items) {
    if (item.offered <= 0) continue; // nothing on offer: skip, never zero-fill
    const capacity = capacities[item.slot];
    if (capacity === undefined) continue; // unknown slot: the machine does not stock it
    const space = Math.max(0, capacity - item.onHand);
    const units = Math.min(item.offered, space);
    // A slot listed twice in one feed: the later line wins, the same rule mergePlans applies.
    if (units > 0) bySlot.set(item.slot, { slot: item.slot, productId: item.productId, units });
  }
  const lines = [...bySlot.values()];
  return {
    machineId: feed.machineId,
    lines,
    totalUnits: lines.reduce((sum, line) => sum + line.units, 0),
  };
}

// Two feeds for one machine merge slot by slot: the later feed wins on
// conflicts, and a slot neither feed mentions contributes nothing.
export function mergePlans(left: RestockPlan, right: RestockPlan): RestockPlan {
  if (left.machineId !== right.machineId) throw new RangeError("plans are for different machines");
  const lines = new Map(left.lines.map((line) => [line.slot, line]));
  for (const line of right.lines) lines.set(line.slot, line);
  const merged = [...lines.values()];
  return { machineId: left.machineId, lines: merged, totalUnits: merged.reduce((s, l) => s + l.units, 0) };
}

// Slots apply in machine order, so a partial application always covers the
// same prefix of the plan.
export function sortLines(lines: RestockLine[]): RestockLine[] {
  return [...lines].sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
}

export async function applyRestock(
  save: (slot: string, productId: string, units: number) => Promise<void>,
  plan: RestockPlan,
): Promise<number> {
  for (const line of sortLines(plan.lines)) {
    await save(line.slot, line.productId, line.units);
  }
  return plan.lines.length;
}
