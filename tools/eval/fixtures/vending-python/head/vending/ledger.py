# Close-of-day payouts: takings leave the machine account and land in the
# operator account, one receipt per transfer, one batch id per close.

# The floor keeps micro-charges in the machine: takings only leave once they
# reach it, so an operator is not paid in single-vend receipts.
PAYOUT_FLOOR_CENTS = 500


def pick_payouts(rows, floor_cents=PAYOUT_FLOOR_CENTS):
    return [row for row in rows if row["amount_cents"] >= floor_cents]


def summarize(payouts):
    return {"count": len(payouts), "total_cents": sum(p["amount_cents"] for p in payouts)}


def group_by_operator(payouts):
    by_operator = {}
    for payout in payouts:
        by_operator.setdefault(payout["operator_id"], []).append(payout)
    return by_operator


# Per-operator close: the operator portal shows one settled batch per operator,
# not one per machine.
def settle_plan(payouts):
    return [
        {
            "operator_id": operator_id,
            "total_cents": summarize(mine)["total_cents"],
            "ids": [payout["id"] for payout in mine],
        }
        for operator_id, mine in group_by_operator(payouts).items()
    ]


# One revenue figure per machine per day, from the portal's stock export. A
# machine that has never been priced has no pricing block in the export.
def daily_total(machine_rows):
    return sum(row.get("pricing", {}).get("retail", {}).get("unit_cents") for row in machine_rows)
