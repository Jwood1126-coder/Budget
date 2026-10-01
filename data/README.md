# Legacy data folder

The first version of this app read a private normalized dataset from `data/budget-data.json`.
That file still works: `tools/build.cjs` uses it when `private/budget-data.json` does not exist,
and it is converted from the earlier format when the app loads.

New imports are written to `private/`. Everything in this folder except this README is git-ignored.
