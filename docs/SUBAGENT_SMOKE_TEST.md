# Repeatable local parallel-worker smoke test

Paste this into a chat rooted in a local test folder. No GitHub connection, remote, clean checkout, or manual Git initialization is required. The runtime uses isolated private snapshots for plain or dirty folders, with checked integration and coordinator undo checkpoints.

```text
Run a small end-to-end parallel worker test in this folder. Preserve all existing work. Use a fresh, uniquely named subdirectory such as agent-smoke-<timestamp>; if it already exists, choose another name. Do not require a clean Git checkout, initialize Git, connect a remote, stash, or reset anything. Existing unrelated files are not a blocker.

Spawn three write-capable background agents with AgentSpawn, giving each a short name and exclusive files inside the new subdirectory. Launch all three before waiting:
- Slugify: src/slugify.mjs and test/slugify.test.mjs. Lowercase and trim text, replace each run of non-ASCII-alphanumeric characters with a hyphen, and strip edge hyphens.
- Unique: src/unique.mjs and test/unique.test.mjs. Stable deduplication using SameValueZero, including NaN and zero.
- Chunk: src/chunk.mjs and test/chunk.test.mjs. Nonmutating chunks; reject sizes that are not positive integers.

Use dependency-free JavaScript modules and node:test. Each agent writes and tests only its assigned files in its isolated workspace. While they work, the parent writes a small README in the new subdirectory. Do not have multiple agents edit the same file.

Wait for all workers and verify integration before running node --test on the three integrated test files. Do not claim success if any worker, integration, or test failed. Report the exact test result, changed files, actual observed overlap (without inventing timings), and any errors or blockers. Finish with a short table and this display equation:
$$T_{parallel} \approx \max(T_1,T_2,T_3)+T_{integration}$$
Stop once the requested checks pass. Do not run unrelated repository-wide validation.
```

A model or service protocol failure is separate from workspace setup. If a call changes identity or disappears at finalization, preserve the error and its session ID rather than rerunning mutations blindly.
