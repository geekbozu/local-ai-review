# vending service

A machine sells snacks from numbered slots. `sell` drops one product and returns
the change; payouts settle at close of day, once per operator, at or above the
payout floor.

Restock plans come from the supplier feed, shelf labels are printed from the same
feed, and the portal reads one revenue figure per machine per day.
