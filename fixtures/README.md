# Fixtures

| File | What | Source |
|---|---|---|
| `oracle/ninja-default.code.txt` | The reference PoB2 code (poe.ninja default config). | `Demonad112/upgraded-disco-companion` `packages/core/test/reference/ninja-default/code.txt` @ `e300acf` |
| `oracle/ninja-default.oracle.json` | What headless PoB2 v0.23.1 (`7d6f530`, LuaJIT) computes for it: 109 stats, 107 PlayerStats, TotalDPS 186706.45241768. | same folder, `oracle.json` (written by the companion's `npm run pob2:oracle`) |
| `oracle/ninja-default.groups.oracle.json` | One row per skill group / active skill (18 groups, 21 rows). | same folder, `groups.oracle.json` |
| `Yykiuy.txt` | The owner's code. When present, `test/parity.test.mjs` requires TotalDPS 186,706 for it too. | the owner |

The oracle files are copied byte for byte and never edited by hand. After a PoB bump, regenerate them in the companion and copy them again (see the README).
