#!/usr/bin/env bash
# Nightly live smoke test for Joule: a handful of real tasks through real providers.
# Catches retired model ids, provider API changes, and escalation regressions
# before users do. Costs a few cents. Exit code 1 if any strategy falls below
# the success floor.
#
#   JOULE_GOOGLE_API_KEY=... benchmarks/smoke.sh
#   JOULE_BENCH_SLM=openrouter:meta-llama/llama-3.1-8b-instruct OPENROUTER_API_KEY=... benchmarks/smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."

FLOOR="${SMOKE_SUCCESS_FLOOR:-0.8}"
export JOULE_BENCH_LABEL="${JOULE_BENCH_LABEL:-smoke}"

echo "== live tasks (8) — slm-only, llm-only, joule-adaptive"
npx tsx benchmarks/harness/index.ts --live --strategies slm-only,llm-only,joule-adaptive --json > "benchmarks/reports/smoke-live.json"
echo "== MBPP (3 problems) — joule-adaptive"
npx tsx benchmarks/harness/index.ts --live --workload mbpp --n 3 --offset 400 --strategies joule-adaptive --json > "benchmarks/reports/smoke-mbpp.json"

node - "$FLOOR" <<'EOF'
const fs = require('fs');
const floor = Number(process.argv[2]);
let bad = 0;
for (const f of ['benchmarks/reports/smoke-live.json', 'benchmarks/reports/smoke-mbpp.json']) {
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const s of r.strategies) {
    const ok = s.successRate >= floor;
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${f.split('/').pop().padEnd(16)} ${s.strategy.padEnd(15)} success ${(s.successRate * 100).toFixed(0)}%  avg cost $${s.avgCost.toFixed(4)}  LLM used ${(s.llmUsedRate * 100).toFixed(0)}%`);
  }
  const errors = r.tasks.flatMap(t => t.errors ?? []);
  if (errors.length) console.log(`  trace errors: ${errors.slice(0, 5).join(' | ')}`);
}
process.exit(bad ? 1 : 0);
EOF
