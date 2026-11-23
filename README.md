# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/smadavv-airdrop/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/smadavv-airdrop/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an AI edit payload to a file tree. One tool for the four shapes a coding agent
emits: unified diffs (git's, with `diff --git`, `---`/`+++`, renames, creations and deletions),
SEARCH/REPLACE blocks (Aider's `<<<<<<< SEARCH` … `>>>>>>> REPLACE`), V4A patches (Codex's
`*** Begin Patch` … `*** End Patch`) and JSON edits (`create`, `str_replace`, `insert`). It
matches lines at three tiers (exact, ignoring trailing space and tab, then ignoring leading
whitespace too, re-indenting at that third tier), keeps every file's own line break, applies
edits all-or-nothing, and reports what it did in byte order.

## Run it

```sh
node main.ts change.patch     # read the patch from a file
git diff | node main.ts       # or from stdin; --check reports without writing
```

Nothing to install: Node 22 and the standard library. `runner.ts` is the kit's harness, used
when the grader sets `MAKEFUN_ENV_URL`; `main.ts` hands over to it.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
