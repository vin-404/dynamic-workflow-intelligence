# Browser walkthroughs

Three scripts, each driving a real browser against a running app and failing
loudly on any console error or missing element. They are how the frontend is
verified: component unit tests would re-check what the API tests already cover
and would not have caught a single one of the real bugs these found — a lost
project on refresh, two buttons both labelled "Add", a proxy pointed at a
backend that predated the AI routes.

| Script | Covers |
|---|---|
| `journey.mjs` | The whole six-stage journey, twice: over a seeded project, and building a new workflow from empty in a domain you define on the spot |
| `ai.mjs` | The natural-language box and the plain-language summary, including that the model's typed changes are shown before anything runs |
| `hardening.mjs` | The name picker, identity across a reload, two browsers as two people, structured errors with a hint |

## Running them

Both servers have to be up, and the database should be freshly seeded:

```bash
# from the repo root
.venv/Scripts/python.exe -m backend.scripts.reset_db
.venv/Scripts/python.exe -m uvicorn backend.app.main:app --port 8001

# in another terminal
cd frontend && npm run dev
```

Then:

```bash
cd frontend
npx playwright install chromium   # once per machine
npm run e2e:all
```

Each prints `[PASS]` / `[FAIL]` per check and exits non-zero if anything
failed. Screenshots land in `e2e/.shots`, which is gitignored — they are for
looking at when something breaks, not artefacts to keep.

## Writing a new one

Assert the *claim*, not the render. `getByText("Findings")` proves a heading
exists; `the impact number can be recomputed from the two numbers beside it`
proves the product works. Four of the failures these scripts have produced
were defects in the script rather than the app — task names live in
`<input value>` where `getByText` cannot see them, a `select` indexed off the
whole page shifts as rows are added — so confirm against the API before
concluding the app is wrong.
