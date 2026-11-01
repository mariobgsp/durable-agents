# Branches

Two long-lived branches, one rule: **work lands on `develop`, `main` only receives merges from `develop`.**
No feature, fix or docs branches: one integration branch, and `main` as the record of what was proven.

| Branch | Holds | Who writes it |
| --- | --- | --- |
| `develop` | Integration: every change, in the order it was made | all commits — contributors and the fleet itself |
| `main` | What a device actually runs, once it has been tested | merges from `develop` only |

## The rules

1. **Every change is committed to `develop`.** A topic branch is not created for a change, and a pull request
   opened into `main` from anything other than `develop` is refused by
   [`.github/workflows/branch-guard.yml`](../.github/workflows/branch-guard.yml).
2. **`main` takes a merge only from `develop`,** and only after the change has been run and tested (below).
3. **`main` stays protected.** Direct pushes are refused by the remote, so even a one-line emergency fix
   travels through `develop`. There is no bypass path worth remembering.
4. **`develop` is kept level with `main` by fast-forward.** After a `develop → main` merge the two are equal;
   do not merge `main` back into `develop` unless `main` carries a commit `develop` does not.

Why this shape: `dura.service` runs the daemon from the working tree of this checkout, so the branch that is
checked out is the branch that runs. A single integration branch means the code under test and the code the
fleet edits are the same code, and `main` stops being a queue of untested work.

## What "tested" means before `develop → main`

- `npm run check` is clean (tsc plus the language guard).
- The e2e suite passes — `node scripts/e2e/run.mjs`, or the scenarios the change touches.
- The daemon was restarted on it, and `dura status` plus `dura doctor` are clean, with one live conversation
  on the active transport.
- The pull request body names the evidence: the commands and the decisive lines from their output.

A change that cannot be tested yet stays on `develop` until it can. That is the point of having the branch.

## Day to day

```bash
git switch develop
git pull --ff-only

# ... make the change ...

npm run check
git add -A
git commit -m "fix(scope): what changed and why"
git push origin develop
```

When the change is ready for `main`:

```bash
gh pr create --base main --head develop --title "..." --body "evidence: ..."
gh pr merge --merge          # only after the owner's go-ahead
```

## The fleet follows the same rule

The orchestrator and the maintainer edit this checkout directly, so they commit on `develop` and never on
`main`, and they never create a branch per task. The checkout on a device is left on `develop`.
