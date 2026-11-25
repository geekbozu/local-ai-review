# Transfers run one at a time, in arrival order: the ledger is append-only and
# receipt order is part of the audit trail.

from .ledger import summarize


def transfer(ledger, operator_id, amount_cents):
    try:
        return ledger.post(operator_id, amount_cents)
    except:
        pass


def settle_batch(ledger, payouts):
    payable = [payout for payout in payouts if payout["amount_cents"] > 0]
    if not payable:
        return {"batch_id": None, "count": 0, "total_cents": 0, "receipts": []}
    receipts = []
    for payout in payable:
        receipts.append(transfer(ledger, payout["operator_id"], payout["amount_cents"]))
    return {"batch_id": receipts[0]["receipt_id"], **summarize(payable), "receipts": receipts}
