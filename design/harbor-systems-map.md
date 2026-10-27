# Harbor Systems Map

Current implementation, 5 September 2026. See [GDD](GDD.md) and [balance tables](balance-tables.md) for complete rules and odds.

```mermaid
flowchart TD
    Join[Guest name and saved token] --> Session[Load or create session]
    Session --> Loop[Connected server cast loop]
    Bait[Bait wallet] -->|Spend selected stake| Loop
    Rod[Rod level 1–10] -->|Duration and odds| Loop
    Stake[Stake] -->|Frozen cast modifiers| Loop
    Loop -->|Successful catch| Fish[Fish bag: cap 80]
    Fish -->|Cash in species or all| XP[Fishing Power XP]
    Loop -->|Conditional chest roll| Chest[Chest bag: cap 60]
    Chest --> Open[One weighted reward]
    Open --> XP
    Open --> Bait
    Open --> Gem[Uncut gems: cap 120]
    Open --> Pearl[Pearl: no current sink]
    Gem --> Appraise[Four independent grades and jitter]
    Appraise --> Gold[Gold Coin]
    Gold --> Shop[Bait shop: four pack sizes]
    Shop --> Bait
    Gold -->|Buy missing XP| XP
    XP --> Rod
    Stock[Shared stock: cap 50000] -->|Purchase removes bait| Shop
    Loop -->|Resolved bait returns| Stock
    Regen[One free bait per 8 seconds below 25] --> Bait
    Session --> Social[Chat, presence, leaderboard]
    Session --> Save[MongoDB save every 5 seconds]
```

Catches award no Gold and no immediate XP. Chests award no direct Gold. Gems are a minority chest outcome; XP is the most likely. Sparks and Bonus Catch are removed. Legacy consumables remain usable but have no current acquisition path. Regeneration has capped return-session catch-up; there is no offline catch simulation. A full fish bag blocks casts, a full chest bag loses new chest drops, and a full gem bag rerolls gem rewards over the remaining chest entries.
