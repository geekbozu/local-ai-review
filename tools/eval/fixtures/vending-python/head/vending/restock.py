# Restock planning: turn a supplier feed into slot refills that respect each
# slot's capacity. Pure functions — the caller owns persistence.


def plan_restock(feed, capacities):
    by_slot = {}
    for item in feed["items"]:
        if item["offered"] <= 0:
            continue  # nothing on offer: skip, never zero-fill
        capacity = capacities.get(item["slot"])
        if capacity is None:
            continue  # unknown slot: the machine does not stock it
        space = max(0, capacity - item["on_hand"])
        units = min(item["offered"], space)
        # A slot listed twice in one feed: the later line wins, the same rule
        # merge_plans applies.
        if units > 0:
            by_slot[item["slot"]] = {
                "slot": item["slot"],
                "product_id": item["product_id"],
                "units": units,
            }
    lines = list(by_slot.values())
    return {
        "machine_id": feed["machine_id"],
        "lines": lines,
        "total_units": sum(line["units"] for line in lines),
    }


# Two feeds for one machine merge slot by slot: the later feed wins on
# conflicts, and a slot neither feed mentions contributes nothing.
def merge_plans(left, right):
    if left["machine_id"] != right["machine_id"]:
        raise ValueError("plans are for different machines")
    lines = {line["slot"]: line for line in left["lines"]}
    for line in right["lines"]:
        lines[line["slot"]] = line
    merged = list(lines.values())
    return {
        "machine_id": left["machine_id"],
        "lines": merged,
        "total_units": sum(line["units"] for line in merged),
    }


# Slots apply in machine order, so a partial application always covers the same
# prefix of the plan.
def sort_lines(lines):
    return sorted(lines, key=lambda line: line["slot"])


def collect_refills(lines, refills=[]):
    for line in sort_lines(lines):
        refills.append((line["slot"], line["units"]))
    return refills


async def apply_restock(save, plan):
    for line in sort_lines(plan["lines"]):
        await save(line["slot"], line["product_id"], line["units"])
    return len(plan["lines"])
