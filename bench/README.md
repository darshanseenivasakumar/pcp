# bench

- `seeded_bugs/`: Person 2. Bad patches (`*.diff` + `expected.json`) for tiny_repo and Flask.
- `tasks/`: Person 1. Reference diffs for Flask Tasks A/B.
- `results.md`, `results.csv`: written by `pcp-bench` (Person 1's runner, in `verifier/pcp_verifier/bench.py`).
- `repos/`: gitignored clones (e.g. pallets/flask 3.1.3) fetched by the runner.
