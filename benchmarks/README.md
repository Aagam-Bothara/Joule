# Joule Benchmarks

Reproducible benchmarks measuring Joule's differentiating features against baselines.

## Running

```bash
# Full suite (all 6 benchmarks)
npx tsx benchmarks/suite.ts

# Single benchmark
npx tsx benchmarks/suite.ts --cost
npx tsx benchmarks/suite.ts --latency
npx tsx benchmarks/suite.ts --success
npx tsx benchmarks/suite.ts --budget
npx tsx benchmarks/suite.ts --governance
npx tsx benchmarks/suite.ts --multi-agent

# JSON output (for CI / dashboards)
npx tsx benchmarks/suite.ts --json
```

## Benchmarks

### 1. Cost Control

Compares total cost across 3 routing strategies:
- **Cloud-only baseline** — always uses the strongest (most expensive) model
- **Local-only baseline** — always uses the cheapest local model
- **Joule routed** — adaptive routing with budget awareness

Measures: total cost, tokens used, cost savings percentage.

### 2. Latency Overhead

Measures the performance cost of Joule's safety features:
- Task execution without governance (baseline)
- Task execution with governance enabled

Measures: avg/min/max/p50 latency, governance overhead in ms and percentage.

### 3. Task Success Rate

Runs identical tasks across budget levels (`low`, `medium`, `high`) and measures:
- Completion rate
- Budget exhaustion rate
- Average steps per task
- Retry count

### 4. Budget Enforcement

Tests hard cap compliance — runs expensive tasks against a low budget:
- Tracks whether budget limits are actually enforced
- Measures enforcement rate (should be 100%)
- Compares against high budget control group

### 5. Governance Compliance

Tests policy enforcement accuracy:
- Dangerous tools blocked by governance policies
- Safe tools still execute normally (no false positives)
- Block rate for policy-denied tools

### 6. Multi-Agent Overhead

Compares single-agent vs multi-step execution:
- Latency overhead of coordination
- Cost overhead
- Step count comparison
- Completion rate comparison

## Live Benchmarks (Real Providers)

Run the same 6 benchmarks against real LLM providers with actual API costs:

```bash
# Requires at least one provider (Ollama or cloud API key)
npx tsx benchmarks/live.ts

# Single benchmark
npx tsx benchmarks/live.ts --cost
npx tsx benchmarks/live.ts --latency
npx tsx benchmarks/live.ts --success
npx tsx benchmarks/live.ts --budget
npx tsx benchmarks/live.ts --governance
npx tsx benchmarks/live.ts --multi-agent

# Override default budget
npx tsx benchmarks/live.ts --budget medium

# JSON output
npx tsx benchmarks/live.ts --json
```

### Provider Detection

Live benchmarks auto-detect available providers:

| Provider | Detection |
|----------|-----------|
| Ollama | `http://localhost:11434` reachable |
| Anthropic | `JOULE_ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY` set |
| OpenAI | `JOULE_OPENAI_API_KEY` or `OPENAI_API_KEY` set |
| Google | `JOULE_GOOGLE_API_KEY` or `GOOGLE_API_KEY` set |

### Real Tasks

8 tasks with variable complexity are used across benchmarks:

- **Low complexity**: Explain a concept, summarize a topic, list items
- **Medium complexity**: Compare/contrast, write code, analyze tradeoffs
- **High complexity**: Design a system, write a comprehensive report

## How It Works

### Mock Suite (`suite.ts`)

Runs through the real Joule engine with mock providers that simulate:
- Realistic per-call costs (SLM: $0.0001, LLM: $0.003)
- Realistic latency (SLM: 30ms, LLM: 150ms)
- Configurable failure rates
- Accurate token counting

No live API keys required. Results are deterministic and reproducible.

### Live Suite (`live.ts`)

Runs through the real Joule engine with real LLM providers:
- Actual API calls to Ollama, Anthropic, OpenAI, or Google
- Real token counts and costs from provider responses
- Real latency measurements including network overhead
- Real energy tracking via Joule's built-in metrics

Requires at least one provider available. Results vary between runs.

## All Benchmarks

| File | Description |
|------|-------------|
| [`suite.ts`](suite.ts) | Mock 6-category benchmark suite (deterministic) |
| [`live.ts`](live.ts) | Live 6-category benchmark suite (real providers) |
| [`routing-comparison.ts`](routing-comparison.ts) | Simulated routing cost comparison |
| [`energy-savings-demo.ts`](energy-savings-demo.ts) | Energy/carbon tracking demonstration |

## Escalation Harness (`harness/`)

Compares routing strategies on identical tasks through the same engine:

```bash
npx tsx benchmarks/harness/index.ts                  # mock runner (deterministic, free)
npx tsx benchmarks/harness/index.ts --live           # real providers
npx tsx benchmarks/harness/index.ts --strategies slm-only,llm-only,joule-adaptive
npx tsx benchmarks/harness/index.ts --tasks needs-consult,needs-handoff --json
```

```
harness/
├── workloads/     mock scenarios, 8 live tasks, MBPP (427 problems), HumanEval (164), MBPP bundles (long-horizon),
│                  SWE-bench Lite (real repositories in their official docker images, hidden tests)
├── strategies/    slm-only, mid-only, llm-only, static-router, naive-cascade, frugal-cascade, automix, pre-router,
│                  joule-adaptive, joule-ladder, and the ablations joule-no-consult / joule-advice / joule-no-verify /
│                  joule-self-conf / joule-no-static
├── evaluators/    success (deterministic vs status-judged), cost, latency, escalation
├── runners/       mock runner, live runner
├── report.py      merge reports across seeds / labels into the README tables (mean ± sd, precision, recall)
├── learned-trigger.py   offline study: can a learned trigger beat the rules?
├── swe-selftest.ts      checks the SWE-bench evaluation pipeline (base must fail, gold patch must pass)
└── index.ts       entry point; writes benchmarks/reports/harness-*.json

lifecycle/
├── record.ts      one experiment record per agent run, from the lifecycle events a run emits
├── analyze.ts     percentiles, tool-wait buckets, cross-agent concurrency, model-demand overlap
├── validate.ts    data-quality checks; malformed traces are flagged and excluded, not averaged in
├── types.ts       record / workflow-summary / aggregate shapes
├── crews/         crew definitions for the crew experiment (real file_read / shell_exec work)
├── crew-runner.ts runs real crews in one process and writes records + manifest
└── cli.ts         collect and analyze; writes benchmarks/experiments/lifecycle/
```

### Lifecycle characterization

Every instrumented run emits agent lifecycle events (`ready`, `model_running`, `tool_wait`,
`completed` / `failed` / `cancelled`) and a timing rollup. This tooling turns those into a dataset
and characterizes it: where the wall clock goes, how long individual tool-wait windows are, and how
much of the work actually overlaps across agents.

```bash
npx tsx benchmarks/lifecycle/cli.ts collect            # benchmarks/reports/harness-*.json -> runs.jsonl
npx tsx benchmarks/lifecycle/cli.ts analyze            # runs.jsonl -> report + workflows.jsonl + summary.json
npx tsx benchmarks/lifecycle/cli.ts analyze <file.json|file.jsonl> [--out-dir <dir>] [--json]
pnpm lifecycle:collect && pnpm lifecycle:analyze       # same two steps through package scripts
```

Datasets land in `benchmarks/experiments/lifecycle/` (`runs.jsonl`, `workflows.jsonl`,
`summary.json`) and are gitignored like `benchmarks/reports/`; the code that produces them is not.
One record per agent run carries identity (`agentId`, `agentRole`, `parentTaskId`), the timing
rollup, every individual tool-wait window, and the raw events. Crew runs produce one record per
agent, so full-mode and direct-mode agents are directly comparable.

Concurrency is computed by sweeping lifecycle interval boundaries, never by polling:
`maxConcurrentAgents`, `maxConcurrentModelRunning`, `maxConcurrentToolWait`, their time-weighted
averages, and `modelDemandOverlapMs` — the wall-clock time two or more agents under one parent task
are inside a model call at once. Tool-wait windows are also bucketed (`<100ms`, `100-500ms`,
`500ms-1s`, `1-2s`, `2-5s`, `5-10s`, `10s+`) so the distribution is visible rather than an average.

One caveat: lifecycle timestamps come from a monotonic clock, which is only comparable inside a
single process. Records carry the `runId` they came from, and concurrency is only ever computed
within one `runId`.

#### Collecting real workloads

Two experiments feed the same pipeline. Single-agent runs come from the existing harness — MBPP
writes a real file and runs a real Python process per task, so its waits are genuine:

```bash
JOULE_BENCH_SLM=openrouter:<small> JOULE_BENCH_LLM=openrouter:<large> JOULE_BENCH_LABEL=real-single \
  npx tsx benchmarks/harness/index.ts --live --workload mbpp --n 20 --offset 400 --strategies joule-adaptive
npx tsx benchmarks/lifecycle/cli.ts collect --label real-single --out-dir benchmarks/experiments/lifecycle/real-single
npx tsx benchmarks/lifecycle/cli.ts analyze benchmarks/experiments/lifecycle/real-single/runs.jsonl
```

Crew runs come from `crew-runner.ts`, which executes the definitions in `lifecycle/crews/` against
real repository work and writes records plus a manifest:

```bash
OPENROUTER_API_KEY=... npx tsx benchmarks/lifecycle/crew-runner.ts --workflows 10 --model <model>
npx tsx benchmarks/lifecycle/cli.ts analyze benchmarks/experiments/lifecycle/real-crews/runs.jsonl
# cheap plumbing check against a local model, one workflow, no API cost:
npx tsx benchmarks/lifecycle/crew-runner.ts --workflows 1 --crew smoke --provider ollama --model phi3:latest \
  --out-dir benchmarks/experiments/lifecycle/smoke --label smoke
```

The runner changes nothing about execution: `parallel` crews overlap their agents through
`Promise.allSettled`, `sequential` ones do not, and everything runs in one process so the
concurrency numbers stay valid. Each experiment directory gets a `manifest.json` with the label,
timestamp, git commit, provider/model, execution modes, the workflows or reports it came from, and
the data-quality result.

Model selection for live runs: `JOULE_BENCH_SLM`, `JOULE_BENCH_MID` (optional middle rung) and
`JOULE_BENCH_LLM` as `<provider>:<model>` with provider one of `google`, `anthropic`, `openai`,
`openrouter`, `ollama`. OpenRouter runs report the billed cost from the API response rather than a
price table. Hybrid "thinking" models get reasoning turned off (open models) or set to minimal
(OpenAI) by default; override with `JOULE_BENCH_REASONING="<model>=off|minimal|low,..."`.

Every task run yields a `TaskReport`:

```json
{ "success": true, "cost": 0.0048, "latencyMs": 41, "slmTokens": 600, "llmTokens": 400,
  "consultations": 1, "handoffs": 0, "toolCalls": 3, "trajectoryLength": 4 }
```

Routing quality needs ground truth, so the harness runs every task under
`slm-only` and `llm-only` as counterfactuals:

- **Escalation precision** — of the tasks where adaptive escalated, how many did slm-only actually fail on.
- **Escalation recall** — of the tasks slm-only failed and llm-only solved, how many adaptive escalated on.
- **Consultation success** — consultations after which the SLM finished without a handoff.
- **Handoff success** — handoffs that ended in success.

Deterministic and status-judged successes are reported separately (`verifierKind`).

The mock runner skips `static-router` because its planner speaks a different
JSON format than the scripted step-agent replies; use `--live` for it.

### Latest live results (2026-09-03)

Setup: 8 live tasks, budget `high`, SLM = `gemini-2.5-flash`, LLM = `gemini-2.5-pro`
(cost-ranked routing picked it over Claude Sonnet), tools: file_read, file_write,
shell_exec, http_fetch. Success is deterministic for the two tool tasks and
status-judged for the six knowledge tasks. Total spend for the run: about $0.09.

| strategy        | success | avg cost | avg SLM tok | avg LLM tok | avg latency | consults | handoffs |
|-----------------|--------:|---------:|------------:|------------:|------------:|---------:|---------:|
| slm-only        |     88% |  $0.0006 |        3713 |           0 |      2033ms |        0 |        0 |
| llm-only        |    100% |  $0.0057 |           0 |        3801 |      8679ms |        0 |        0 |
| static-router   |    100% |  $0.0025 |         959 |           0 |      3559ms |        0 |        0 |
| naive-cascade   |    100% |  $0.0012 |        3789 |         386 |      3287ms |        0 |        0 |
| joule-adaptive  |    100% |  $0.0014 |        3812 |         657 |      4872ms |        1 |        1 |

Routing quality from the counterfactual runs: escalation precision 100% (1/1),
recall 100% (1/1), handoff success 100%, consultation success 0% (the one
consultation did not unblock the SLM; the handoff did). Adaptive cost was 25%
of llm-only. Eight tasks is a small sample: treat these as a smoke test of the
harness, not a result.

### Baselines

Every strategy runs the same engine, tools and prompts; only the routing differs.

| strategy | what it does | stands in for |
|---|---|---|
| `slm-only` / `llm-only` | step agent pinned to one tier | counterfactual ground truth |
| `static-router` | plan-then-execute pipeline with per-call complexity routing | Joule before adaptive execution |
| `naive-cascade` | whole task on the SLM; rerun on the LLM if the run did not complete | EcoAssistant-style hierarchy |
| `frugal-cascade` | whole task on the SLM; a cheap scorer rates the answer; rerun on the LLM below 0.7 | FrugalGPT (scorer approximated by an SLM call) |
| `automix` | whole task on the SLM; the SLM verifies its own answer 3 times; rerun on the LLM on majority NO | AutoMix self-verification |
| `pre-router` | one SLM classification call picks SLM or LLM for the whole task | RouteLLM / Hybrid LLM (router approximated by an SLM call) |
| `joule-adaptive` | SLM-first step agent with continue / consult / handoff / abort | this work |

Scorer, verifier and router calls are charged to the strategy that made them (`gateCost`), and their verdicts are kept in each task report (`gateOutputs`).

### MBPP workload

```bash
curl -sL -o benchmarks/data/sanitized-mbpp.json \
  https://raw.githubusercontent.com/google-research/google-research/master/mbpp/sanitized-mbpp.json
JOULE_BENCH_SLM=google:gemini-2.5-flash JOULE_BENCH_LLM=google:gemini-2.5-pro \
  npx tsx benchmarks/harness/index.ts --live --workload mbpp --n 30
OPENROUTER_API_KEY=... JOULE_BENCH_LABEL=openrouter \
  JOULE_BENCH_SLM=openrouter:meta-llama/llama-3.1-8b-instruct JOULE_BENCH_LLM=openrouter:openai/gpt-4o \
  npx tsx benchmarks/harness/index.ts --live --workload mbpp --n 30
```

Each problem gets a sandbox directory with its tests; the agent writes `solution.py` and may run the tests itself. Success is decided by the harness re-running the tests in a fresh Python process, never by the agent's own claim. `JOULE_BENCH_LABEL` separates sandboxes and report files so pairs can run concurrently.

### MBPP comparison against cascade and routing baselines (2026-09-04)

30 sanitized-MBPP problems (task ids ascending from the start of the set), budget `high`,
one seed, temperature 0.2, all eight strategies. Success is deterministic: the harness
re-runs each problem's tests in a fresh Python process. Total spend for both pairs: about $5.

**Pair A — Gemini 2.5 Flash (SLM) / Gemini 2.5 Pro (LLM).** Flash solves all 30 alone,
so this pair only measures unnecessary escalations.

| strategy        | success | avg cost | LLM used | avg LLM tok | consults | handoffs |
|-----------------|--------:|---------:|---------:|------------:|---------:|---------:|
| slm-only        |    100% |  $0.0042 |       0% |           0 |        0 |        0 |
| llm-only        |    100% |  $0.0180 |     100% |       14454 |        0 |        0 |
| static-router   |     77% |  $0.0317 |       0% |           0 |        0 |        0 |
| naive-cascade   |    100% |  $0.0043 |       0% |           0 |        0 |        0 |
| frugal-cascade  |    100% |  $0.0069 |      13% |        2174 |        0 |        0 |
| automix         |    100% |  $0.0077 |      13% |        2275 |        0 |        0 |
| pre-router      |    100% |  $0.0045 |       0% |           0 |        0 |        0 |
| joule-adaptive  |    100% |  $0.0046 |       3% |         116 |        2 |        0 |

**Pair B — Llama 3.1 8B (SLM, via OpenRouter) / GPT-4o (LLM, via OpenRouter).** The small
model fails almost half the problems alone, so escalation quality matters.

| strategy        | success | avg cost | cost / llm-only | LLM used | escalated | needed | precision | recall | consult ok | handoff ok |
|-----------------|--------:|---------:|----------------:|---------:|----------:|-------:|----------:|-------:|-----------:|-----------:|
| slm-only        |     53% |  $0.0003 |            0.01 |       0% |         — |     14 |         — |      — |          — |          — |
| llm-only        |    100% |  $0.0323 |            1.00 |     100% |         — |     14 |         — |      — |          — |          — |
| static-router   |     63% |  $0.0032 |            0.10 |       0% |         0 |     14 |       n/a |     0% |          — |          — |
| naive-cascade   |     97% |  $0.0168 |            0.52 |      50% |        15 |     14 |       53% |    57% |          — |          — |
| frugal-cascade  |     97% |  $0.0099 |            0.31 |      30% |         9 |     14 |       56% |    36% |          — |          — |
| automix         |    100% |  $0.0161 |            0.50 |      43% |        13 |     14 |       69% |    64% |          — |          — |
| pre-router      |     67% |  $0.0013 |            0.04 |       3% |         1 |     14 |      100% |     7% |          — |          — |
| joule-adaptive  |     97% |  $0.0095 |            0.29 |      70% |        21 |     14 |       57% |    86% |        76% |        80% |

Reading the numbers:

- On pair B, trajectory-level escalation matches the best whole-task cascade (FrugalGPT-style)
  on success and cost, with fewer LLM tokens per task (3,062 vs 3,566) and no scorer call, and it
  catches more of the needed escalations (recall 86% vs 36%).
- Of the 21 tasks where Joule consulted the LLM, 16 were finished by the small model after one
  focused answer (consultation success 76%). Only 5 tasks needed a handoff; 4 of those succeeded.
  The one failure was GPT-4o giving up after taking over.
- The AutoMix-style baseline reaches 100% but at 1.7x Joule's cost, because self-verification
  by an 8B model escalates on a majority "no" that is often wrong in both directions.
- The RouteLLM-style pre-router is only as good as its router: an 8B router answered SMALL on
  29 of 30 problems (several verdicts were not even parseable), so it inherits slm-only's failures.
- The legacy static-router pipeline is dominated on both pairs: it fails on plan parsing and,
  on pair A, costs more than llm-only while succeeding less often.

Limitations: 30 problems from the easy end of MBPP, one seed, one run per condition. The small
model is stochastic, so the counterfactual "needed" set is itself noisy; precision and recall
should be read as indicative. A paper-grade run needs several hundred problems, three or more
seeds, a harder slice (`--offset`), and at least one more model pair.

**Pair C — Llama 3.1 8B (SLM, via OpenRouter) / Gemini 2.5 Flash (LLM).** Same 30 problems;
tests whether an efficient mid-tier model can serve as the escalation target instead of a
frontier model. Total spend for the pair: $0.37.

| strategy        | success | avg cost | cost / llm-only | LLM used | precision | recall | consult ok | handoff ok |
|-----------------|--------:|---------:|----------------:|---------:|----------:|-------:|-----------:|-----------:|
| slm-only        |     57% |  $0.0003 |            0.07 |       0% |         — |      — |          — |          — |
| llm-only        |    100% |  $0.0044 |            1.00 |     100% |         — |      — |          — |          — |
| naive-cascade   |    100% |  $0.0026 |            0.59 |      50% |       53% |    62% |          — |          — |
| frugal-cascade  |    100% |  $0.0027 |            0.61 |      53% |       44% |    54% |          — |          — |
| joule-adaptive  |    100% |  $0.0023 |            0.51 |      83% |       52% |   100% |        72% |       100% |

Against pair B (same small model, GPT-4o as the escalation target), Joule's cost per task fell
from $0.0095 to $0.0023 and success rose from 97% to 100%: on this workload Flash resolves
everything the 8B model cannot, so the frontier model is never needed. This is the case for a
three-rung ladder (SLM → efficient LLM → frontier LLM) with escalation climbing one rung on
evidence rather than an SLM predicting which rung is required.

### Trigger fix: retry budget and verifier progress (2026-09-04)

Two changes to the escalation trigger, then pair C re-run with **three** slm-only runs per
problem so escalations are scored against P(SLM solves task) instead of one noisy label:

1. A verification failure is the agent's to retry first (`escalation.verifyRetries`, default 1).
   CONSULT fires on the next failure only if it did not improve on the previous attempt.
2. The verifier reports a pass fraction ("3/5 tests passed"); an improving fraction counts as
   progress in the confidence engine, the stall rule, and the soft thresholds. The MBPP test
   script now runs each assert independently so partial fixes are visible.

Both trigger versions scored against the same 3-run labels (11 of 30 problems have P(SLM) < 0.5):

| trigger | success | avg cost | LLM used | precision | soft precision | wasted (P(SLM) ≥ 0.8) | recall | consults | handoffs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| old (consult on first verify failure) | 100% | $0.0023 | 25/30 | 44% | 44% | 9 | 100% | 36 | 7 |
| new (retry, then consult without improvement) | 100% | $0.0015 | 12/30 | 75% | 67% | 2 | 82% | 8 | 8 |
| frugal-cascade (same run, for reference) | 100% | $0.0024 | 12/30 | 58% | 53% | 4 | 64% | — | — |

Cost per task fell 35% at unchanged 100% success; unnecessary escalations on problems the SLM
solves at least 80% of the time dropped from 9 to 2. Recall fell from 100% to 82% because two
"needed" problems were solved by the SLM on retry, which is the intended trade. With the easy
consults gone, the remaining ones are harder (4 of 8 resolved without handoff); all 8 handoffs
succeeded. Same caveats as above: 30 easy problems, one seed per strategy run.

Harness changes made along the way: `--repeats N` for counterfactual slm-only runs, soft
precision and "wasted" columns, per-workload checkpoints to `benchmarks/reports/partial-*.json`,
`--resume <file>` to continue a crashed run, a 15-second watchdog inside the MBPP test script
(a solution with an infinite loop used to outlive the shell timeout on Windows and lock the sandbox).

### HumanEval workload and the model-compatibility matrix

```bash
# HumanEval (164 problems), same harness, hidden check(candidate) tests
curl -sL -o benchmarks/data/HumanEval.jsonl.gz https://raw.githubusercontent.com/openai/human-eval/master/data/HumanEval.jsonl.gz
gzip -d benchmarks/data/HumanEval.jsonl.gz
npx tsx benchmarks/harness/index.ts --live --workload humaneval --n 164 --repeats 3 \
  --strategies slm-only,llm-only,frugal-cascade,joule-adaptive

# Which small models can drive the step agent? One line per model:
JOULE_BENCH_SLM=openrouter:qwen/qwen-2.5-7b-instruct JOULE_BENCH_LLM=google:gemini-2.5-flash \
  JOULE_BENCH_LABEL=matrix-qwen npx tsx benchmarks/harness/index.ts --live --workload mbpp \
  --offset 230 --n 20 --strategies slm-only,joule-adaptive
```

Useful flags: `--repeats N` runs slm-only N times per task for P(SLM solves) labels, `--offset` picks
an unseen slice, `--resume benchmarks/reports/partial-<workload>-<label>.json` continues a crashed
run, and `JOULE_BENCH_LABEL` keeps concurrent runs in separate sandboxes and report files.

### Model compatibility matrix (2026-09-04)

Which small models can drive the step agent? Each model ran `slm-only` and `joule-adaptive` (escalating to Gemini 2.5 Flash) on the same 20 unseen MBPP problems (offset 230). "Malformed turns" is the average number of agent turns per task whose reply could not be parsed as an action, after the parser's JSON repair. Qwen3 8B is a thinking model that took up to five minutes per task and hit rate limits on OpenRouter, so its row is partial.

| small model | slm-only success | slm-only cost | avg steps | malformed turns | adaptive success | adaptive cost | LLM used | consults | handoffs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| meta-llama/llama-3.2-3b-instruct | 0% | $0.0003 | 4.5 | 1.80 | 90% | $0.0039 | 100% | 5 | 20 |
| meta-llama/llama-3.1-8b-instruct | 45% | $0.0004 | 3.6 | 0.10 | 100% | $0.0030 | 65% | 10 | 9 |
| qwen/qwen-2.5-7b-instruct | 70% | $0.0008 | 3.4 | 0.00 | 100% | $0.0032 | 40% | 8 | 8 |
| qwen/qwen3-8b (partial 4 tasks) | 100% | $0.0010 | 2.8 | 0.00 | 100% | $0.0016 | 25% | 1 | 0 |
| google/gemini-2.5-flash-lite | 85% | $0.0023 | 3.3 | 0.05 | 95% | $0.0036 | 25% | 5 | 5 |
| openai/gpt-4o-mini | 65% | $0.0029 | 3.5 | 0.00 | 100% | $0.0041 | 35% | 7 | 4 |
| deepseek/deepseek-chat | 80% | $0.0045 | 3.2 | 0.00 | 100% | $0.0056 | 20% | 4 | 3 |
| anthropic/claude-haiku-4.5 | 60% | $0.0286 | 3.6 | 0.55 | 95% | $0.0301 | 45% | 9 | 7 |
| meta-llama/llama-3.3-70b-instruct | 75% | $0.0018 | 3.3 | 0.10 | 95% | $0.0035 | 25% | 5 | 5 |

Every model reaches 90 to 100% with adaptive escalation, including a 3B model that solves nothing on its own (it hands off almost every task, so it is the most expensive row). The 7B to 9B open models are the sweet spot: Qwen 2.5 7B and Llama 3.1 8B finish 100% at about $0.003 per problem, a third of the LLM-only cost, with zero or near-zero malformed turns.

### Scaled run: 200 unseen MBPP problems, three seeds (2026-09-04)

Main pair Llama 3.1 8B → Gemini 2.5 Flash, problems 30 to 230 of the sanitized set (never used during development), all eight strategies, slm-only run three times per problem for labels, Joule and the FrugalGPT-style cascade run three times. Second pair Llama 3.1 8B → GPT-4o-mini reuses the main pair's labels. Frontier spot check: 20 problems with GPT-4o.

```
Labeled tasks: 200; P(SLM)<0.5: 88; 0.5..0.8: 37; >=0.8: 75; needed (P<0.5 & LLM ok): 81
slm-only success (mean of repeats): 55%   llm-only success: 97%

slm-only: n=600 runs, success 55%, avg cost $0.0004
Pair: Llama 3.1 8B → Gemini 2.5 Flash (seed 1)
| strategy        | n   | success | avg cost | gate | cost/llm-only | LLM used | precision | soft | wasted | recall | consult ok | handoff ok | avg latency |
|-----------------|----:|--------:|---------:|-----:|--------------:|---------:|----------:|-----:|-------:|-------:|-----------:|-----------:|------------:|
| llm-only        | 200 |     97% |  $0.0056 | $0.0000 |          1.00 |     100% |       41% |  45% |     75 |   100% |        n/a |        n/a |        7.5s |
| static-router   | 200 |     57% |  $0.0008 | $0.0000 |          0.14 |       0% |       n/a |  n/a |      0 |     0% |        n/a |        n/a |       15.2s |
| naive-cascade   | 200 |     95% |  $0.0030 | $0.0000 |          0.53 |      42% |       76% |  81% |      6 |    78% |        n/a |        n/a |       14.0s |
| frugal-cascade  | 200 |     95% |  $0.0033 | $0.0000 |          0.58 |      48% |       66% |  72% |     12 |    78% |        n/a |        n/a |       13.1s |
| automix         | 200 |     97% |  $0.0037 | $0.0000 |          0.66 |      55% |       65% |  68% |     17 |    88% |        n/a |        n/a |       12.0s |
| pre-router      | 200 |     55% |  $0.0004 | $0.0000 |          0.07 |       0% |       n/a |  n/a |      0 |     0% |        n/a |        n/a |        7.7s |
| joule-adaptive  | 200 |     96% |  $0.0021 | $0.0000 |          0.38 |      51% |       69% |  72% |     14 |    86% |        47% |        89% |       12.7s |

joule-adaptive over 3 seeds (n=200/200/200): success 96% ± 1.0  cost/llm-only 0.39 ± 0.02  precision 68% ± 1.2  recall 85% ± 5.1  LLM used 51% ± 3.8  consult ok 40% ± 5.8  handoff ok 89% ± 2.2
frugal-cascade over 3 seeds (n=200/200/200): success 96% ± 0.5  cost/llm-only 0.60 ± 0.02  precision 66% ± 0.4  recall 81% ± 2.9  LLM used 50% ± 1.9

Pair 2 llm-only (GPT-4o-mini): success 84%  (labels reuse main slm-only; 'needed' uses main llm-only)
Pair: Llama 3.1 8B → GPT-4o-mini
| strategy        | n   | success | avg cost | gate | cost/llm-only | LLM used | precision | soft | wasted | recall | consult ok | handoff ok | avg latency |
|-----------------|----:|--------:|---------:|-----:|--------------:|---------:|----------:|-----:|-------:|-------:|-----------:|-----------:|------------:|
| llm-only        | 200 |     84% |  $0.0024 | $0.0000 |          1.00 |     100% |       41% |  45% |     75 |   100% |        n/a |        n/a |        8.4s |
| frugal-cascade  | 200 |     86% |  $0.0016 | $0.0000 |          0.68 |      47% |       67% |  71% |     11 |    78% |        n/a |        n/a |       20.4s |
| joule-adaptive  | 200 |     83% |  $0.0011 | $0.0000 |          0.46 |      50% |       62% |  66% |     19 |    75% |        52% |        36% |       15.3s |

Frontier spot check: Llama 3.1 8B → GPT-4o (20 tasks)
| strategy        | n   | success | avg cost | gate | cost/llm-only | LLM used | precision | soft | wasted | recall | consult ok | handoff ok | avg latency |
|-----------------|----:|--------:|---------:|-----:|--------------:|---------:|----------:|-----:|-------:|-------:|-----------:|-----------:|------------:|
| llm-only        |  20 |     95% |  $0.0427 | $0.0000 |          1.00 |     100% |       40% |  45% |      7 |   100% |        n/a |        n/a |        6.2s |
| joule-adaptive  |  20 |     95% |  $0.0115 | $0.0000 |          0.27 |      40% |       75% |  71% |      1 |    75% |        57% |        75% |       19.2s |

Total spend: $8.38 over 3440 runs
```

Reading: Joule matches the best success rate within seed noise at 0.39 of large-model cost, against 0.53 to 0.66 for the cascades, with the highest recall among escalating strategies at comparable precision. Pre-routing before any evidence (RouteLLM-style with a small router) and the old plan-then-execute pipeline stay near the small model's own success rate. With a weaker large model (GPT-4o-mini) the cascade edges Joule on success by three points at 48% more cost, and handoff success drops to 36%: the upper rung matters, which is the argument for a three-rung ladder with an efficient mid-tier. With a frontier model (GPT-4o) Joule matches it at 27% of its cost.

### HumanEval, 164 problems, Llama 3.1 8B → Gemini 2.5 Flash (2026-09-04)

Same harness and labels method (slm-only three times per problem). Hidden `check(candidate)` tests; no partial pass counts, so the verifier reports pass/fail only.

```
harness-live-humaneval-he-main-2026-09-04T10-46-07-614Z.json  runs=984
labeled 164; P(SLM)<0.5: 116; needed 111; slm-only mean 34%; llm-only 96%
| strategy        | n   | success | avg cost | cost/llm-only | LLM used | precision | recall | wasted | consult ok | handoff ok | avg latency |
|-----------------|----:|--------:|---------:|--------------:|---------:|----------:|-------:|-------:|-----------:|-----------:|------------:|
| slm-only        | 492 |     34% | $0.0004 |          0.06 |       0% |       n/a |    n/a |      - |        n/a |        n/a |       15.4s |
| llm-only        | 164 |     96% | $0.0063 |          1.00 |      99% |       n/a |    n/a |      - |        n/a |        n/a |        8.8s |
| frugal-cascade  | 164 |     93% | $0.0045 |          0.72 |      63% |       79% |    74% |      4 |        n/a |        n/a |       20.0s |
| joule-adaptive  | 164 |     96% | $0.0040 |          0.64 |      79% |       72% |    84% |     10 |        22% |        94% |       20.5s |
spend: $2.63
```

Joule matches the large model (96%) at 64% of its cost with 84% recall; the FrugalGPT-style cascade reaches 93% at 72%. With a small model this weak (34% alone), handoffs do the work (94% succeed) and consultations rarely suffice (22%).

### Long-horizon bundles and the learned trigger

```bash
# 30 tasks of 4 MBPP problems each: "implement these functions in one module, all tests must pass"
npx tsx benchmarks/harness/index.ts --live --workload mbpp-bundle --bundle 4 --n 30 --offset 30 \
  --strategies slm-only,llm-only,frugal-cascade,joule-adaptive

# Three-rung ladder: small -> efficient -> frontier (JOULE_BENCH_MID enables the middle rung)
JOULE_BENCH_SLM=openrouter:meta-llama/llama-3.1-8b-instruct JOULE_BENCH_MID=google:gemini-2.5-flash \
  JOULE_BENCH_LLM=openrouter:openai/gpt-4o npx tsx benchmarks/harness/index.ts --live --workload mbpp \
  --offset 230 --n 50 --strategies slm-only,mid-only,llm-only,joule-adaptive,joule-ladder

# Offline study: can a logistic model over the confidence signals beat the rules?
python benchmarks/harness/learned-trigger.py --labels main-a,main-b,he-main
```

`joule-adaptive` is the two-tier policy (small → top); `joule-ladder` climbs small → middle → top.
The bundle workload raises the step cap to 60 per task and reports test pass fractions, so a
partial module counts as progress for the verifier. `learned-trigger.py` trains on every
slm-only trajectory (the run outcome is a clean label for each step, since those runs never
escalate), holds out 30% of tasks, and replays "escalate when P(success) < theta" against the
same P(SLM) labels the rules are scored with.

### Learned trigger: result (2026-09-04)

`learned-trigger.py` on the main MBPP and HumanEval runs (1,092 slm-only trajectories over 364 tasks, 30% of tasks held out):

| | AUC |
|---|---:|
| per decision point, predicting eventual small-model success | 0.89 |
| at the first decision only | 0.51 |
| at the second decision only | 0.89 |

Replayed as a trigger on the held-out trajectories, the best threshold (0.3) gives precision 68% and
recall 91%; the rule-based policy on the same tasks gives 69% and 90%. The signals carry no
information before the first tool result and verifier outcome, and after it the rules already act
on them. A better classifier over the same signals does not help; richer evidence at the step
(the content of failing tests, the diff the agent made) is the next lever.

### Three-rung ladder (2026-09-04)

50 unseen MBPP problems (offset 230). Small = Llama 3.1 8B, middle = Gemini 2.5 Flash, top = GPT-4o. `joule-adaptive` is the two-tier policy (small → top); `joule-ladder` climbs small → middle → top on evidence, skipping the middle rung on reasoning breakdowns. Labels from a single slm-only run, so precision and recall are noisier than in the scaled run.

```
| strategy        | tasks | success | avg cost | gate cost | LLM used | avg SLM tok | avg LLM tok | avg latency | consults | handoffs |
|-----------------|------:|--------:|---------:|----------:|---------:|------------:|------------:|------------:|---------:|---------:|
| slm-only        |    50 |     62% |  $0.0004 |   $0.0000 |       0% |       19715 |           0 |     21367ms |        0 |        0 |
| mid-only        |    50 |     96% |  $0.0061 |   $0.0000 |     100% |           0 |           0 |      7755ms |        0 |        0 |
| llm-only        |    50 |     90% |  $0.0482 |   $0.0000 |     100% |           0 |       18180 |      8559ms |        0 |        0 |
| joule-adaptive  |    50 |     86% |  $0.0190 |   $0.0000 |      50% |       21153 |        6630 |     23765ms |       24 |       13 |
| joule-ladder    |    50 |     94% |  $0.0070 |   $0.0000 |      38% |       20295 |        1853 |     41698ms |       25 |       17 |

Routing quality (ground truth from counterfactuals: slm-only 62% over 1 run(s)/task, llm-only 90%):
| strategy        | success | cost / llm-only | escalated | needed | precision | soft prec. | wasted | recall | consult ok | handoff ok |
|-----------------|--------:|----------------:|----------:|-------:|----------:|-----------:|-------:|-------:|-----------:|-----------:|
| mid-only        |     96% |            0.13 |        50 |     14 |       28% |        38% |     31 |   100% |        n/a |        n/a |
| joule-adaptive  |     86% |            0.39 |        25 |     14 |       44% |        64% |      9 |    79% |        50% |        46% |
| joule-ladder    |     94% |            0.15 |        19 |     14 |       32% |        58% |      8 |    43% |        22% |        80% |

Latency: avg 20629ms  p50 9238ms  p95 40498ms  max 1158874ms
```

The ladder reaches 94% at 15% of GPT-4o's cost; the two-tier policy 86% at 39%; GPT-4o alone 90%. The ladder used the middle rung on 18 tasks and the top rung on only 6, and 12 of its 15 handoffs succeeded (80%) against 6 of 13 (46%) when the small model handed straight to GPT-4o. Flash alone solves 96% for $0.006 on this slice, so the cheapest correct choice here is the middle model by itself; the ladder's value is reaching that outcome without knowing in advance which rung is enough. Spend for the run: $4.04, most of it the GPT-4o baseline.

### Long-horizon bundles (2026-09-04)

30 tasks of four MBPP problems each (problems 30 to 150 of the sanitized set), Llama 3.1 8B → Gemini 2.5 Flash, budget raised to 600k tokens and 60 tool calls, step cap 60. Trajectories run 8 to 15 steps on average (up to 40). Labels from a single slm-only run per task.

```
| strategy        | tasks | success | avg cost | gate cost | LLM used | avg SLM tok | avg LLM tok | avg latency | consults | handoffs |
|-----------------|------:|--------:|---------:|----------:|---------:|------------:|------------:|------------:|---------:|---------:|
| slm-only        |    30 |     20% |  $0.0023 |   $0.0000 |       0% |      112067 |           0 |     56057ms |        0 |        0 |
| llm-only        |    30 |     53% |  $0.0286 |   $0.0000 |     100% |           0 |       79118 |     60723ms |        0 |        0 |
| frugal-cascade  |    30 |     57% |  $0.0217 |   $0.0000 |      67% |       91374 |       54791 |     54910ms |        0 |        0 |
| joule-adaptive  |    30 |     67% |  $0.0136 |   $0.0000 |      80% |       76454 |       33876 |     58995ms |       52 |       22 |

Routing quality (ground truth from counterfactuals: slm-only 20% over 1 run(s)/task, llm-only 53%):
| strategy        | success | cost / llm-only | escalated | needed | precision | soft prec. | wasted | recall | consult ok | handoff ok |
|-----------------|--------:|----------------:|----------:|-------:|----------:|-----------:|-------:|-------:|-----------:|-----------:|
| frugal-cascade  |     57% |            0.76 |        20 |     15 |       50% |        80% |      4 |    67% |        n/a |        n/a |
| joule-adaptive  |     67% |            0.47 |        24 |     15 |       54% |        92% |      2 |    87% |         8% |        55% |

Latency: avg 57671ms  p50 41397ms  p95 118174ms  max 1131185ms
```

Joule is the best strategy on both axes: 67% success at 47% of the large model's cost, against 57% at 76% for the FrugalGPT-style cascade and 53% for the large model alone. On long trajectories the small model's incremental work is worth keeping: Joule hands off with a partly built module and passing tests, so the large model finishes rather than restarts. Consultations rarely unblock the small model here (2 of 24), handoffs do (12 of 22). This run needed three policy rules that short tasks never exercised: rising test pass fractions count as progress, a test run that repeats a verified result is not a second failure, and failures are counted within a window of recent steps rather than over the whole run. Spend: $1.99.

### Ablations: one design choice removed at a time (2026-09-05)

Same 50 unseen MBPP problems as the ladder run (offset 230), Llama 3.1 8B → Gemini 2.5 Flash,
three slm-only runs per problem for the labels. Every row is `joule-adaptive` with exactly one
switch flipped (`benchmarks/harness/strategies/ablations.ts`); engine, tools, prompts and models are
identical. Consultations in `joule-adaptive` now run in patch mode (the advisor may return the
edit itself); `joule-advice` is the previous prose-only behaviour.

```
python benchmarks/harness/report.py --labels abl
| strategy         | success | cost / llm-only | LLM used | precision | recall | wasted | consult ok | handoff ok | consults | handoffs |
|------------------|--------:|----------------:|---------:|----------:|-------:|-------:|-----------:|-----------:|---------:|---------:|
| llm-only (Flash) |     98% |            1.00 |     100% |           |        |        |            |            |          |          |
| slm-only (Llama) |     67% |            0.13 |       0% |           |        |        |            |            |          |          |
| joule-adaptive   |     98% |            0.24 |      38% |       53% |    77% |      5 |        83% |        75% |       21 |        4 |
| joule-advice     |     98% |            0.42 |      40% |       55% |    85% |      2 |        40% |        92% |       34 |       12 |
| joule-no-consult |     98% |            0.40 |      88% |       30% |   100% |     19 |        n/a |        98% |        0 |       44 |
| joule-no-static  |     96% |            0.26 |      38% |       53% |    77% |      3 |        79% |        50% |       19 |        4 |
| joule-self-conf  |     96% |            0.28 |      46% |       52% |    92% |      6 |        74% |        88% |       25 |        8 |
| joule-no-verify  |     80% |            0.21 |       6% |       67% |    15% |      1 |       100% |       100% |        1 |        2 |
```

What each row says:

- **Consult before handoff** (`joule-no-consult`): success is unchanged, cost rises from 0.24 to
  0.40 of Flash-only, and the large model touches 88% of tasks instead of 38%. Without the cheap
  first step, every escalation is a handoff and most of them were unnecessary (19 wasted, precision
  30%).
- **Patch-mode consultations** (`joule-advice` is the old behaviour): with prose advice, 40% of
  consultations let the small model finish and 12 tasks still needed a handoff; with the advisor
  returning the edit, 83% of consultations finish the task and 4 handoffs remain. Cost drops from
  0.42 to 0.24 at the same success rate. This is the fix for the weak consult numbers on long tasks.
- **Deterministic verification** (`joule-no-verify`): the largest single effect. Without test and
  exit-code checks the policy sees almost no failures, escalates on 6% of tasks, and 8 runs finish
  "completed" with wrong code. Success falls from 98% to 80%.
- **Evidence instead of self-report** (`joule-self-conf`): the model's own confidence claim replaces
  the composite. The claim averaged 0.81, and in 72 of the 107 decisions where the verifier had just
  failed the model still claimed 0.8 or more. The hard triggers (repeat failures, verifier streaks)
  still fire, so success only dips to 96%, but escalations rise (46% of tasks, 6 wasted) and cost
  goes up 17%. The self-report adds noise, not information.
- **Static checks** (`joule-no-static`): a small effect on this slice (96% vs 98%, handoff success
  50% vs 75%); syntax slips are rarer on 3-line functions than on modules.

Spend for the run: about $0.30 on OpenRouter (Llama), the rest on Gemini Flash.

### 2026 model lineup: Qwen3.5 9B → GPT-5.6 Luna → Claude Sonnet 5 (2026-09-05)

40 unseen MBPP problems (offset 230), all three models through OpenRouter, billed cost taken from
the API response. Small = `qwen/qwen3.5-9b` (thinking off), middle = `openai/gpt-5.6-luna`
(reasoning effort minimal), top = `anthropic/claude-sonnet-5`. `joule-adaptive` is two-tier
(Qwen → Sonnet); `joule-ladder` is Qwen → Luna → Sonnet.

```
python benchmarks/harness/report.py --labels lineup
| strategy              | success | avg cost | cost / llm-only | LLM used | precision | recall | consult ok | handoff ok | latency |
|-----------------------|--------:|---------:|----------------:|---------:|----------:|-------:|-----------:|-----------:|--------:|
| llm-only (Sonnet 5)   |    100% |  $0.0524 |            1.00 |     100% |           |        |            |            |     13s |
| mid-only (Luna)       |     60% |  $0.0022 |            0.04 |     100% |           |        |            |            |     14s |
| slm-only (Qwen 9B)    |     79% |  $0.0021 |            0.04 |       0% |           |        |            |            |     24s |
| frugal-cascade        |    100% |  $0.0284 |            0.54 |      38% |       40% |    86% |            |            |     27s |
| joule-adaptive        |    100% |  $0.0081 |            0.15 |      22% |       56% |    71% |       100% |       100% |     25s |
| joule-ladder          |    100% |  $0.0041 |            0.08 |      22% |       78% |   100% |       100% |       100% |     20s |
```

Every escalating strategy reaches Sonnet's 100%. The ladder does it at 8% of Sonnet's cost, the
two-tier policy at 15%, the FrugalGPT-style cascade at 54%. The ladder used the middle rung on 6
tasks and Sonnet on 3, and every consultation and handoff succeeded. Two things worth knowing
about the models themselves: a 2026 9B model solves 79% of this slice alone (Llama 3.1 8B: 62%),
and GPT-5.6 Luna with reasoning set to minimal was the weakest executor here (60%), failing
mostly by giving up or producing unparseable actions; as a consultant and a rung above the 9B it
was still enough to lift the ladder to 100% without reaching Sonnet on most tasks. Spend: about
$3.50, most of it the Sonnet baseline.

### Long-horizon bundles: prose advice vs patch-mode consultations (2026-09-05)

The weak number in the first long-horizon run was consultation success (2 of 24). Patch-mode
consultations are the fix: the advisor sees the current file and may return the edit itself. To
measure it on long trajectories, 30 new bundles of four MBPP problems (problems 2 to 121, a
different slice from the run above), Llama 3.1 8B → Gemini 2.5 Flash, two slm-only runs per
bundle for the labels (the small model alone solves 12%; 24 of 30 bundles are "hard", pSlm < 0.5).
`joule-advice` is the prose-only behaviour, `joule-adaptive` the patch-mode default; same engine,
same static checks, same failure-counting rules.

```
| strategy       | success | avg cost | LLM used | escalated on hard bundles | consults | consult ok | handoffs | handoff ok | steps |
|----------------|--------:|---------:|---------:|--------------------------:|---------:|-----------:|---------:|-----------:|------:|
| slm-only (x2)  |     12% |  $0.0027 |       0% |                           |          |            |          |            |       |
| joule-advice   |     60% |  $0.0125 |      83% |                     21/24 |       41 |       3/24 |       20 |      10/20 |  12.1 |
| joule-adaptive |     67% |  $0.0097 |      73% |                     18/24 |       37 |       7/22 |       14 |       7/14 |  11.1 |
```

With the edit coming back instead of prose, the share of consultations that let the small model
finish rises from 13% to 32%, seven bundles are solved by consultation alone (three before), and
the number of handoffs falls from 20 to 14. Success is higher (67% vs 60%) and cost lower (22%
less) on the same bundles. Consultations still do not carry most of the load on long tasks;
handoffs do, and half of those succeed. Spend: about $1.20, nearly all Gemini Flash.

### Real repositories: SWE-bench Lite (2026-09-05)

Function-level problems say nothing about repository work, so the harness now runs SWE-bench
Lite instances in their official evaluation images (`benchmarks/harness/workloads/swebench.ts`).
The agent gets the issue text and three tools that execute inside the container (`repo_shell`,
`repo_read`, `repo_edit`/`repo_write`) plus the repository's own test command, and never sees the
hidden tests. Scoring is the SWE-bench criterion: the instance's test patch is applied over the
agent's changes and every FAIL_TO_PASS and PASS_TO_PASS test must pass, whether or not the agent
declared itself done. `swe-selftest.ts` checks the pipeline on every instance (base commit fails,
gold patch passes); 23 of the 25 pulled instances pass that check and the other two are excluded.
Slice: 10 Django 4.0, 4 pytest 5.4, 1 pylint 2.15 (sympy was dropped: one test file takes 15+
minutes to run in its 2017 environment). Per-task cost ceiling $0.20, 30 steps, 40 tool calls.

Small = Qwen3.5 9B (OpenRouter, thinking off), middle = Gemini 2.5 Flash. Two runs:

```
Run 1: top = Claude Sonnet 5, reasoning breakdowns skip straight to the top rung (the old rule)
| strategy      | resolved | avg cost | agent finished | notes                                            |
|---------------|---------:|---------:|---------------:|--------------------------------------------------|
| slm-only      |     2/15 |   $0.012 |           1/15 |                                                  |
| mid-only      |     6/15 |   $0.038 |          11/15 |                                                  |
| joule-ladder  |     8/15 |   $0.121 |           6/15 | middle rung used on 3, Sonnet on 11 (8 rung skips) |

Run 2: top = Gemini 2.5 Pro, breakdowns climb one rung (the new default), parser fix for early-closed JSON
| strategy      | resolved | avg cost | agent finished | notes                                            |
|---------------|---------:|---------:|---------------:|--------------------------------------------------|
| slm-only      |     2/15 |   $0.020 |           1/15 |                                                  |
| mid-only      |     2/15 |   $0.039 |           5/15 |                                                  |
| joule-ladder  |     7/15 |   $0.051 |          10/15 | middle rung used on 9, Pro on 5; 4 instances resolved that neither model resolved alone |
```

What the runs show:

- **On this slice the ladder resolves more than any single model in it** (the 95-instance run
  below does not reproduce this), in both runs: 8/15 and 7/15 against
  6/15 and 2/15 for the middle model alone and 2/15 for the small model. In run 2, four of the
  seven resolved instances were resolved by neither the 9B model nor Flash on their own; three
  were resolved by the 9B model without escalating at all, at 1 to 3 cents each.
- **Where the cost goes.** In run 1 the old rule sent every reasoning breakdown straight to Sonnet,
  which happened on 8 of 15 instances and made the ladder three times more expensive than Flash
  alone. Climbing one rung instead (run 2) halves the cost per task and changes the outcome on only
  one instance. This is why `breakdownSkipsToTop` now defaults to false.
- **The first run found real bugs.** Exit code 1 from `grep` was counted as a failed step (three
  searches with no match aborted the small model); whole-file rewrites of 600-line Django files
  exceeded the 4k-token output cap; the small model often closes the JSON object early and keeps
  writing; and an agent that finishes without changing any file was accepted. All four are fixed
  (`EXPLORATION` exit codes, `maxOutputTokens`, balanced-prefix parsing, `finalAnswerRequires`).
- **What the trajectories look like now.** Where the policy escalated, the reasons were what the
  design intends: three failures in the recent window, repeated unparseable output, a confidence
  drop below the handoff threshold. The remaining weakness is the opposite case: a small model
  that reads files for 30 steps without failing produces no evidence and hits the step limit
  (2 of the 8 unresolved instances in run 2). Time-based stall detection on unverified reads is the
  next rule to add.
- **Fifteen instances is a small sample.** Flash alone went from 6 to 2 resolved between runs with
  no code change that affects it; treat every number here as ±2 instances.

Spend: run 1 about $2.60 (Sonnet $1.60), run 2 about $1.60 (Gemini) plus $0.50 of Qwen.

A follow-up on the two instances that hit the step limit in run 2, after adding the
exploration-stall rule (`explorationStallSteps`, default 8): django-13925 resolved (2/2 hidden
tests) and pytest-7220 did not. Neither outcome is the rule's doing: in both runs the small model
escalated earlier through a breakdown or a give-up, and the stall rule never fired. Cost: 7 cents.
In the 95-instance run below it did not fire once either: there the 9B model fails by producing
malformed actions, not by reading aimlessly.

### The cheap 2026 stack, 100 problems (2026-09-06)

The same comparison on models a student can afford: small = Qwen3.5 9B (thinking off), middle =
DeepSeek V4 Flash, top = DeepSeek V4 Pro, all through OpenRouter at the billed price. 100 unseen
MBPP problems (offset 230), three small-model-only runs per problem for the labels.

```
python benchmarks/harness/report.py --labels lineup2
| strategy                  | success | avg cost | cost / Pro | LLM used | precision | recall | wasted | consult ok | handoff ok |
|---------------------------|--------:|---------:|-----------:|---------:|----------:|-------:|-------:|-----------:|-----------:|
| Qwen3.5 9B alone (x3)     |     79% |  $0.0022 |       0.19 |       0% |           |        |        |            |            |
| DeepSeek V4 Flash alone   |     97% |  $0.0015 |       0.13 |     100% |       18% |   100% |     67 |            |            |
| DeepSeek V4 Pro alone     |     98% |  $0.0114 |       1.00 |     100% |           |        |        |            |            |
| FrugalGPT-style cascade   |     98% |  $0.0068 |       0.59 |      54% |       24% |    72% |     32 |            |            |
| Joule two-tier (9B -> Pro)|     98% |  $0.0042 |       0.37 |      28% |       46% |    72% |      7 |        80% |        92% |
| Joule ladder              |     98% |  $0.0031 |       0.27 |      25% |       48% |    67% |      6 |        64% |        89% |
```

Every escalating strategy reaches the frontier model's 98%. The ladder does it at 27% of the
frontier's cost, the two-tier policy at 37%, the cascade at 59%. Two more seeds of both Joule
policies on the same problems (`report.py --labels lineup2,lineup2-s2,lineup2-s3 --seeds`) give
two-tier 98% ± 1.5 at 0.37 ± 0.00 and ladder 96% ± 2.0 at 0.27 ± 0.05, so the cost ratios are
stable and the ladder gives up about two points of success for a quarter less cost; the cascade escalates on 54 of
100 problems and 32 of those escalations go to problems the small model solves at least four
times in five. Only 18 of the 100 problems actually need escalation (the 9B model solves the rest
on its own most of the time), which is why every strategy's precision is lower here than on the
Llama runs: there is less to find.

How much of the top model's accuracy survives a handoff: the report's `handoff kept` column divides
success on handed-off problems by V4 Pro's success alone on the same problems (the "retention" that
cross-model KV-cache transfer work reports; Heo et al., arXiv:2608.03893, get 73–98% within one
model family). Over the three seeds the two-tier policy keeps 93% and the ladder 86%, so the
ladder's two lost points come from problems it hands off, partly because its first handoff lands
on V4 Flash rather than Pro. Earlier stacks keep 95–100% by the same measure.

The caveat from the Gemini runs holds with this stack too. DeepSeek V4 Flash alone is 97% at
$0.0015, cheaper than the 9B model, because it finishes in fewer steps. On problems this small a
capable cheap model needs no escalation, and the ladder pays for the small model's turns before
reaching it. Joule's case is the workload where no single cheap model suffices; the 95-instance
repository run below finds DeepSeek V4 Flash close to being that model there too. Spend: about
$3.60. Latency: the ladder averaged 31 s per problem against 15 s for Pro alone.

### Real repositories at scale: 95 SWE-bench Lite instances (2026-09-06)

The repository slice grown to 95 instances (83 Django, 8 pytest, 3 pylint, 1 Flask), same settings
as above (30 steps, 40 tool calls, per-task cost ceiling), on the cheap stack: Qwen3.5 9B →
DeepSeek V4 Flash → DeepSeek V4 Pro through OpenRouter. One seed; Pro alone was not run.

```
Label swe100
| strategy                | resolved | avg cost | agent finished | notes                                    |
|-------------------------|---------:|---------:|---------------:|------------------------------------------|
| Qwen3.5 9B alone        |    10/95 |  $0.0112 |          13/95 | 53 runs end on malformed actions         |
| DeepSeek V4 Flash alone |    44/95 |  $0.0105 |          53/95 |                                          |
| Joule ladder            |    37/95 |  $0.0259 |          59/95 | Flash used on 73, Pro on 38              |
```

What the run shows:

- **The ladder loses to its own middle rung.** Flash alone resolves 7 more instances at about 40%
  of the ladder's cost. On the same instances the ladder resolves 9 that Flash does not and misses
  16 that Flash resolves; 7 of its 37 come from the 9B model without escalating, and 7 were
  resolved by neither model on its own. This does not reproduce the 15-instance result above,
  where the middle model (Gemini 2.5 Flash) resolved 2 to 6 of 15 alone; DeepSeek V4 Flash
  resolves 46% on its own.
- **The 9B model cannot drive this agent.** 53 of its 95 solo runs end because it produced
  malformed actions twice in a row, and 51 of the ladder's 99 handoffs are for the same reason
  (43 more follow three failures). It spends 12.5M of the ladder's 18.5M tokens and, at $0.011 per
  task alone, is no cheaper than Flash, which finishes in fewer, better turns. The harness runs
  OpenRouter models without JSON mode.
- **Steps spent on the small model are not refunded.** The median handoff comes at step 8 of 30
  and the cap is shared across rungs (`rungLocalSteps` is off by default), so the stronger model
  inherits what is left: 24 ladder runs end on the step limit (Flash alone: 22), some after
  handoffs at steps 25 and 26.
- **Handoffs themselves mostly keep the stronger model's accuracy.** On the 69 instances the
  ladder handed off, it resolves 28 against 31 for Flash alone on the same instances (90%). The
  larger loss is on the 26 it never handed off: 9 against Flash's 13, the 9B model holding on too
  long.
- **Noise.** Two report files exist for this run (08:18 and 08:26 UTC); 51 of the 285 task
  records differ between them and 8 outcomes flip. The numbers above are from the later one;
  differences of a few instances are within noise.

Spend: about $4.50 (ladder $2.46, Flash $1.00, 9B $1.07). Latency per instance: Flash 103 s,
ladder 149 s.

The open question is no longer whether a 9B model can lead on repositories (with this pair it
cannot) but whether escalation beats the best cheap model on its own. The next run is Flash → Pro
with a fresh step allowance after a handoff (`joule-rung-local`) on the same 95 instances.

## Staged recovery

A crew that runs a reviewer and a tester after every implementer spends three agents on work one
agent often finished. Staged recovery runs the next agent only when an external check says the
previous one did not actually succeed. This section is the evidence for that design, including the
two measurement errors that had to be corrected before any of it meant anything.

### The earlier crew datasets are not evidence

Datasets E and E2 (crew widths 1–4 on MBPP) are kept for provenance only. Three defects make them
unusable for any claim about crew width:

- **Budget was confounded with width.** The crew budget was divided by `budgetShare`, so the
  implementer ran on ~100k tokens at width 1, ~50k at width 2 and ~33k at width 3 and 4. Five
  implementer failures sit at 34–37k tokens, right at that line. Width changed how many agents
  there were *and* how much the one writing the code could spend.
- **One agent failing removed every agent after it.** A failed agent wrote `undefined` to the
  blackboard, and the next agent's context builder called `JSON.stringify(undefined).slice(...)`.
  The `TypeError` was thrown while building the *next* agent's prompt, so it died before reaching a
  model — 15 downstream agents out of 15, which in the traces looked exactly like budget
  starvation.
- **Agents could not read any tool output.** Direct mode rendered tool results with `String(...)`,
  and every tool returns an object, so every file an agent read and every command it ran came back
  as the literal string `[object Object]`. A reviewer told to inspect the implementer's code was
  reading nothing. The finding that "specialists read a lot and never write" was a symptom of this,
  not a result about specialists.

All three are fixed (`budgetMode: 'fixed_per_agent'`, `proseOnly`, JSON tool-result rendering) and
covered by tests. Measurements taken before those fixes are not comparable with measurements taken
after.

### Unreadable tool calls were taken as answers (found 2026-10-01)

A fourth defect affects every crew dataset below up to and including `staged-replication-v2`. The
direct executor treated any reply it could not parse as the agent's final answer. DeepSeek V4 Flash
regularly writes slightly broken calls: `tool_name` for `toolName`, the tool name as a key
(`{"file_write": {...}}`, or `{"file_write": "a.py", "content": ...}`), a wrapper or object left
unclosed, a markdown list or `<toolName>` tags inside `<tool_calls>`, a reply cut off mid-value, or a
whitespace-only reply (which failed the run outright). Each ended the agent as "completed",
frequently with the fix it had just written never applied.

Re-reading the stored records — the lone implementer's failed cells, by how its run ended:

| dataset | failed | misread call | empty reply | other |
| --- | --- | --- | --- | --- |
| `specialist-value`, implementer alone (Dataset F) | 10 | 6 | 2 | 2 |
| `specialist-value-control`, second implementer seat | 11 | 10 | 1 | 0 |
| `staged-replication` (old parser) | 15 | 7 | 5 | 3 |
| `staged-replication-v2` (first parser fix) | 11 | 10 | 1 | 0 |
| `staged-replication-v3` (this fix) | 1 | 0 | 1 | 0 |

In Dataset F and the control, most misread calls were file reads and shell commands: the agents
were investigating, not "stopping voluntarily". The fix makes a reply that is visibly trying to call
a tool a *malformed* result, never an answer; the agent is told so and may retry twice in a row
before the run fails. It also reads the observed shapes, and closes containers left open — but
never a string left open, so a command cut off mid-value is not run. The verbatim replies are test
fixtures in `packages/core/tests/fixtures/unreadable-tool-calls.json`.

Withdrawn as a result: the "stopped voluntarily" reading of Dataset F, the role-framing conclusion
of the second-implementer control, and the `always-on → verified_full` quality effect. The
`verified_full` vs staged comparison was always made on one executor and still stands.

### Does a specialist add verified value? (`benchmarks/specialist-value`)

*Measured with the executor defect above; the interpretation in this section is withdrawn. The
counts are kept as recorded.*

Five authored repositories, one planted defect each, three repetitions, `deepseek-v4-flash`,
verified-edit gate on. The task says only that the suite fails; locating the defect is the work.

| arm | success | reviewer writes | notes |
| --- | --- | --- | --- |
| implementer alone | 5/15 | — | |
| + reviewer | 9/15 | 4 proposed, 3 accepted | |
| + reviewer + tester | 12/15 | | |
| + second implementer (control) | 4/15 | **0 proposed in 15 runs** | |

When the implementer left the repository failing, a specialist recovered it 11 times out of 20, and
in 9 of those the fixer also named the planted cause. When the implementer left it passing, all 10
runs stayed passing, with no rollbacks.

The control is the important row. Replacing the reviewer with a *second implementer* — same model,
same tools, same ceilings, same position, only the instructions differ — scores 4/15, at the level
of the implementer alone, and never attempts a single write. A copy of the primary inherits the
primary's belief that the work is finished. The uplift is the adversarial framing, not a fresh
context and not more compute: eight of ten lone-implementer failures stopped voluntarily after one
to five of sixteen allowed model calls without trying to write anything.

### Replication on fresh fixtures (`benchmarks/staged-replication`)

The first three tables below were measured with the executor defect described above. All four arms
were rerun on the fixed executor; that rerun is the current measurement and is reported
[at the end of this section](#rerun-on-the-fixed-executor-staged-replication-v3).

Ten new repositories, one per defect class (API contract, cross-file state, edge case, wrong
algorithm, numeric precision, import interaction, stale cache, boundary, data transformation, error
behaviour), three repetitions, 90 runs, $0.30. Each fixture is self-tested first: it must fail as
planted, leave at least one assertion passing, and pass with its reference fix.

| arm | success | cost | tokens | JCT | stages |
| --- | --- | --- | --- | --- | --- |
| implementer alone | 15/30 | $0.0021 | 16,282 | 36s | 1.00 |
| always-on crew | 27/30 | $0.0053 | 40,290 | 96s | 3.00 |
| staged recovery | 30/30 | $0.0027 | 20,348 | 46s | 1.53 |

Paired on all 30 cells: both pass 27, always-on only 0, staged only 3. Staged skipped 44 of the
always-on arm's 60 specialist stages — 19 runs where the primary passed (saving two stages each),
6 where the reviewer recovered (saving one), 5 where the tester was genuinely needed.

### Which half does the work? (`verified_full`)

Staged recovery changes two things at once: it gives recovery agents the verifier's evidence, and
it declines to run them when the check already passes. `verified_full` holds the first and drops
the second — every stage runs, every stage is still checked, every result is still handed on — so
the two effects can be attributed separately. The strategies share the whole path and differ in one
expression, whether a passing check ends the run.

| comparison | what differs | result |
| --- | --- | --- |
| always-on → `verified_full` | verifier evidence only | 27/30 → 30/30, and 14% cheaper |
| `verified_full` → staged | early stopping only | 30/30 → 30/30, 41% cheaper, 43% faster, 3.00 → 1.53 stages |

**Verifier evidence buys quality; conditional admission buys efficiency.** The decisive detail is
what always-on specialists did after a state that already verified PASS: 41 such stages ran, and
**41 of 41 wrote nothing** — no accepted edits, no rollbacks, no regressions. Always-on specialists
after a pass are pure cost and zero risk. That is exactly the work staged recovery declines.

Caveats: the quality effect rests on 3 discordant pairs (McNemar p = 0.25), so it is directional,
not significant; only the *equivalence* of `verified_full` and staged is firmly established (30/30
identical, p = 1.0). One model, one provider, fixtures we authored, n = 30 cells per arm.

### Rerun under the corrected parser (`staged-replication-v2`)

*Superseded by the next section: still measured with the unreadable-call defect.*

The same ten fixtures, the same three repetitions and the same model (`deepseek/deepseek-v4-flash`
on OpenRouter), run on 2026-09-30 with the corrected response parser, all four arms in one
invocation: 120 runs, $0.33 estimated. Data in `benchmarks/experiments/staged-replication-v2`.

| arm | success | cost | tokens | JCT | stages |
| --- | --- | --- | --- | --- | --- |
| implementer alone | 19/30 | $0.0014 | 10,482 | 52s | 1.00 |
| always-on crew | 27/30 | $0.0039 | 29,575 | 158s | 3.00 |
| `verified_full` | 30/30 | $0.0036 | 27,154 | 49s | 3.00 |
| staged recovery | 30/30 | $0.0020 | 15,235 | 27s | 1.30 |

| comparison | what differs | old parser | corrected parser |
| --- | --- | --- | --- |
| always-on → `verified_full` | verifier evidence only | 27/30 → 30/30, 14% cheaper | 27/30 → 30/30, 8% cheaper |
| `verified_full` → staged | early stopping only | 30/30 → 30/30, 41% cheaper | 30/30 → 30/30, 44% cheaper |

- Paired cells reproduce exactly. Always-on against `verified_full`: 27 both pass, 3 `verified_full`
  only (McNemar p = 0.25). `verified_full` against staged: 30 both pass, 0 discordant (p = 1.0).
- The implementer alone rose from 15/30 to 19/30. The arms are not paired across runs, so this
  is consistent with the parser fix no longer dropping the implementer's calls but does not
  establish it. Inside the staged arm the implementer passed 22/30, so fewer cells reached recovery:
  staged ran 9 specialist stages and skipped 51 of 60 (22 runs saved two stages, 7 reviewer
  recoveries saved one, 1 needed the tester).
- After a state that already verified PASS, `verified_full` entered 49 specialist stages; 49 of 49
  wrote nothing, with no rollbacks and no regressions.
- The arms ran sequentially, and provider latency drifted during the run: always-on runs took about
  2.3× their old-parser wall-clock while costing less. Cost and tokens are the reliable efficiency
  comparison; the JCT column is not controlled across arms.

At the time this read as confirming the old-parser conclusions. It did not: 10 of the 11
lone-implementer failures here ended on a misread call (see above).

### Rerun on the fixed executor (`staged-replication-v3`)

Same fixtures, repetitions, model and arms, run on 2026-10-01 with the unreadable-call fix: 120
runs, $0.39 estimated. Data in `benchmarks/experiments/staged-replication-v3`. These runs used the
provider's default output cap of 1024 tokens per reply; direct-mode agents now default to 4096
(`AgentDefinition.maxOutputTokens`), and these cells have not been rerun at that setting.

| arm | success | cost | tokens | stages |
| --- | --- | --- | --- | --- |
| implementer alone | 29/30 | $0.0020 | 14,783 | 1.00 |
| always-on crew | 30/30 | $0.0044 | 33,254 | 3.00 |
| `verified_full` | 30/30 | $0.0047 | 35,653 | 3.00 |
| staged recovery | 30/30 | $0.0019 | 14,630 | 1.03 |

- **No agent ended on a misread call.** The one lone-implementer failure ended on three empty
  replies in a row, which now fails the run explicitly.
- **Paired cells.** Always-on against `verified_full`: 30 both pass (p = 1.0) — the 27 → 30 effect
  is gone. `verified_full` against staged: 30 both pass (p = 1.0). Implementer alone against
  staged: 29 both pass, 1 staged only.
- **Staged costs what the implementer alone costs** ($0.0019 vs $0.0020): the implementer passed
  in 29 of 30 staged cells, the reviewer ran once and repaired that cell, and 59 of 60 specialist
  stages were skipped. Against `verified_full` that is 59% less cost and tokens; against always-on,
  56%.
- **After a state that already verified PASS, `verified_full` entered 60 specialist stages; 60 of
  60 wrote nothing**, with no rollbacks and no regressions.
- Wall-clock is omitted: a real-repository benchmark shared the provider during these runs.

What this supports is narrower than the earlier claims. Conditional admission is free when the
first agent succeeds and costs well under half of an always-on crew. Whether a verifier-informed
recovery stage improves outcomes cannot be read from a benchmark the first agent passes 29/30;
answering that needs harder tasks.

### Staged recovery on real repositories (`benchmarks/real-repo`)

The SWE-bench Lite harness uses locally available images, real issues, hidden tests, and the
official pass criterion. Its old-parser smoke and probe datasets are labelled in their manifests.
The preselected self-tested pool admitted 13 of 15 candidate issues.

The committed `agentResults[].tools` entries name the executed calls: none is `repo_write` or
`repo_edit` in the old smoke and probe runs. That is an observation from named tools, not an
inference from the host verified-edit gate's zero accepted writes; at the time, that gate did not
snapshot container-side edits. Several old final replies contain unexecuted calls: a tagged bare JSON
array, XML tags, or a nested wrapper. A mock-provider replay shows that the direct executor
treated the array and XML as final answers and dropped nested calls. Reviewers and testers also
hit the old 10-iteration limit while still inspecting pylint/pytest.

These old runs do not establish a model or navigation capability floor. The parser now handles the
recorded shapes. The recovery limit was raised to 16 iterations after these runs and is now 30 for
every agent (see the allowance history below). The first post-parser primary-only smoke run used
`gpt-4o-mini` on `pylint-dev__pylint-7114`. Its lifecycle records 14 model calls, 25 named tool
calls (10 `repo_read`, 14 `repo_edit`, 1 `repo_write`), and 15 write attempts. Eleven write calls
reported success; the container diff confirms `pylint/lint/expand_modules.py` changed. The run
ended at the token budget with an invalid Python edit, so hidden verification failed. Joule
estimated its cost at $0.0404. That run predates the larger `repo_read`/`repo_shell` result limits
and container-side Python syntax check with rollback for `repo_write`/`repo_edit`.

One bounded primary-only rerun with those safeguards made 18 named tool calls (6 `repo_read`,
3 `repo_edit`, 9 `repo_shell`), with three successful edits and no unidentified calls. Its Python
file compiled, but the hidden verifier reported F2P 0/1 and P2P 56/56. The agent edited
`get_python_path` with a condition equivalent to the original, then ended after acknowledging
remaining failures. The reference patch changes a branch in `expand_modules` instead. It used
10 of 16 available iterations and 79,637 of 100,000 budgeted tokens, so neither limit ended this
run. Joule estimated $0.0299 for the rerun; the provider-billed amount was not captured then
(records now carry it as `billedCostUsd`). The two
post-parser primary runs show that agents now reach real-repository writes, but neither solved this
issue.

**Full-pool primary baselines (2026-09-30/10-01, `deepseek/deepseek-v4-flash`, one run per issue).**

| run | executor | per-agent tokens | resolved | how the runs ended | edit calls |
| --- | --- | --- | --- | --- | --- |
| `real-repo-primary-baseline` | before the unreadable-call fix | 100k | 0/13 | 11 misread call, 1 empty reply, 1 budget | 0 |
| `real-repo-primary-baseline-v2` | fixed | 100k | 0/13 | 13 budget exhausted after 6–11 model calls | 0 |
| `real-repo-primary-baseline-400k` | fixed | 400k | 0/13 | 11 hit the 16-turn cap, 1 unreadable ×3, 1 network reset | 1 |
| `real-repo-primary-out12k-c` | + 12k output per reply, native formats | 400k | **4/13** | 6 hit the 16-turn cap, 2 answered but failed, 1 empty ×3 | 9 |
| `real-repo-primary-ladder-limits-b` | + escape repair, shell-block retry | 1.5M, 30 turns, 30 min | **6/13** | 6 hit the 30-turn cap, 1 answered but failed | 18 |

Every allowance change was decided after the run before it and before the run it governed; the
history is in the comment on `REAL_REPO_BUDGET` in `real-repo/crews.ts`.

**Why the crew loop solved nothing, and the ladder's loop did.** The same model resolved 44 of 95
SWE-bench Lite instances through the adaptive step agent
([above](#real-repositories-at-scale-95-swe-bench-lite-instances-2026-09-06)). Comparing the two
configurations side by side:

| | escalation harness (step agent) | crew (direct executor), before |
| --- | --- | --- |
| output tokens per reply | 12,000 | 1,024 — nothing was set, so the provider default applied |
| turns / time / tokens | 30 / 30 min / 1.5M | 16 / 10 min / 100k |
| task text | step-by-step, `repo_edit` for changes | one line, `repo_write` to change files |

The output cap was the blocker: an edit carries the file content in the reply, a whole-file
`repo_write` of any real source file exceeds 1,024 tokens, and DeepSeek's reasoning spends part of
the cap first. Direct-mode agents now default to 4,096 output tokens (`AgentDefinition.maxOutputTokens`;
the real-repo crews set 12,000), and a reply cut off at the limit is answered with a request for a
smaller edit. Raising the cap also surfaced the model's native call markup — `<｜DSML｜toolName>`
tags, `<｜DSML｜invoke name="...">` with `<｜DSML｜parameter>` children, `ll_func:` tags — and shell
backslashes (`grep "a\|b"`) that are invalid JSON escapes and made a whole call unreadable. All are
now read; the escape repair is in the JSON reader the step agent shares. The task text was not
changed in either run above, so the gap closed without porting the ladder's instructions.

With matching allowances the crew loop resolves 6 of 13. This is *not* comparable to the ladder's
44/95: these crew runs had hidden-test feedback (see the note below) and the ladder runs did not,
and the pools differ. One run per issue: `pylint-7993` passed at 16 turns and failed at 30,
`pytest-7373` the reverse.

**Every real-repository crew run in this section had hidden-test access (found 2026-10-01).** The
check that decided escalation was the SWE-bench checker in `real-repo/workload.ts`, and:

- `install()` copies the hidden test patch and the checker into the agent's container at
  `/tmp/test.patch` and `/tmp/check.py` for the whole run, despite the file's header comment
  saying the hidden tests are never left where an agent could read them. Stored final replies
  include `cat /tmp/test.patch` (staged pylint-7114 reviewer, staged pytest-8906 implementer) and
  `cat /tmp/check.py`; tool arguments were not recorded, so earlier reads cannot be counted.
- The verified-edit gate re-ran the checker after every write and appended the last 400 characters
  of its output — including `still failing: <hidden test names>` — to the agent's tool result.
- The staged-recovery handoff passed the checker's command and output to the next agent.
- Each check ran the hidden tests in place, leaving compiled copies (`tests/__pycache__/*.pyc`) in
  the container afterwards.

The checker no longer lives in the container: it is piped in on stdin for each check, writes no
bytecode, and removes the hidden test files it laid down (`real-repo/run-check.ts`,
`real-repo/workload.ts`); records now keep each tool call's arguments for audit. What still reaches
the agents is the check's *output* — that is an experiment-design choice for the next run, not a
leak to fix. No real-repository run has been made with these changes yet.

The escalation-ladder runs (`harness/workloads/swebench.ts`) pipe the test patch in only at final
scoring and are not affected. Both crew arms had identical access, so the staged-vs-`verified_full`
comparison below is internally fair; its absolute rates are oracle-assisted, not resolve rates.

**Staged against verified_full (`real-repo-staged-v1`, 2026-10-01).** Same 13 issues, same model,
same three agents and per-agent allowance as the ladder-limits run, one run per issue per arm:
26 runs, $1.77 estimated by Joule, about $0.70 billed by OpenRouter.

| arm | resolved | mean cost | mean tokens | mean stages |
| --- | --- | --- | --- | --- |
| `verified_full` | 9/13 | $0.077 | 579,513 | 3.00 |
| staged | 11/13 | $0.060 | 450,975 | 1.62 |

| issue | lone implementer (ladder-limits-b) | `verified_full` | staged | staged stages | staged solved by |
| --- | --- | --- | --- | --- | --- |
| flask-4045 | ✗ | ✓ | ✓ | 2 | reviewer |
| flask-5063 | ✗ | ✓ | ✓ | 2 | reviewer |
| pylint-7114 | ✗ | ✗ | ✗ | 3 | — |
| pylint-7228 | ✗ | ✓ | ✗ | 3 | — |
| pylint-7993 | ✗ | ✓ | ✓ | 1 | implementer |
| pytest-11143 | ✓ | ✓ | ✓ | 1 | implementer |
| pytest-11148 | ✓ | ✗ | ✓ | 2 | reviewer |
| pytest-7168 | ✓ | ✓ | ✓ | 1 | implementer |
| pytest-7220 | ✗ | ✗ | ✓ | 1 | implementer |
| pytest-7373 | ✓ | ✓ | ✓ | 1 | implementer |
| pytest-7432 | ✓ | ✓ | ✓ | 1 | implementer |
| pytest-8906 | ✗ | ✗ | ✓ | 2 | reviewer |
| pytest-9359 | ✓ | ✓ | ✓ | 1 | implementer |

- **Funnel (staged):** implementer 7/13; reviewer invoked 6 times, recovered 4; tester invoked
  twice, recovered none. 18 of 26 specialist stages skipped. Of the 6 implementer failures, 4 hit
  the 30-turn cap (flask-4045, flask-5063, pylint-7228, pytest-8906) and 2 answered while the check
  failed (pylint-7114, pytest-11148); the reviewer's 4 recoveries are 3 after a cap and 1
  (pytest-11148) after a wrong "done". Whether the cap recoveries come from the evidence or from
  30 more turns is untested.
- **Paired:** 8 both, 3 staged only, 1 `verified_full` only, 1 neither — McNemar exact p = 0.63.
  The difference is not significant; staging did not lose outcomes and cost 22% less per issue.
- **After a passing check**, `verified_full` entered 17 specialist stages: 16 made no edit; one —
  the tester on pytest-11148, after the reviewer's fix had passed — edited the repository and broke
  it. The verified-edit gate recorded the rollback but, in this run, could not restore
  container-side files (it snapshotted host paths), so the issue ended failed. First regression
  from an always-on specialist in any dataset here. The gate now snapshots and restores
  container files through a workspace that the real-repo harness supplies
  (`benchmarks/harness/workloads/repo-workspace.ts`). That is implemented and unit-tested, but
  has not yet been measured in a real-repository run. This result predates it.
- Each arm's implementer is a separate run, so per-issue outcomes also differ for reasons that
  have nothing to do with the policy: pytest-7220 was solved by the staged implementer alone and
  missed by `verified_full`'s.

### Pre-registration: real repositories without the oracle (draft, 2026-10-02)

Written before any run of the experiments below. The rules are also code
(`real-repo/prereg.ts`), so the analysis cannot drift from what is written here.

**Questions.** (G1) Does staged recovery help on real repositories when the check is one a user
could plausibly have, and the hidden SWE-bench tests are used only for final scoring? (G2) When a
recovery stage succeeds, is it the check's evidence that helped, or just another allowance of
turns? (G3) Does the result hold on issues it was not developed on?

**Pools.** The development pool is the existing 13 self-tested flask/pylint/pytest issues. The
held-out pool is fixed by `cli.ts pool --held-out`: the first 30 self-test-usable
`django__django` instances in instance-id order, excluding the 13 development ids. Only instances
whose SWE-bench image was already local were self-tested (none were pulled); self-test = the hidden
checker fails at the base commit and passes with the upstream fix
(`selftest.ts --django-local --out benchmarks/experiments/real-repo-heldout/selftest.json`).

**Check modes** (`--check`, `real-repo/checks.ts`). In every mode the verified-edit gate and the
escalation verifier run the same check, and its output is what agents see.

- `oracle` — the hidden SWE-bench checker is the check: the setting of every run above. Kept for
  comparison and labelled as an oracle in manifests.
- `repro` — a reproduction test written per issue by a separate agent that sees only the issue
  and the repository (`cli.ts repro-gen`, generated once per issue and reused across arms and
  seeds), stored on the host and piped in at check time, plus up to three existing
  `test_<module>.py` files for each non-test module changed since the base commit; an existing
  test counts as a regression only if it passed with those modules at their base versions.
  `cli.ts repro-fidelity` (no model) keeps a test only if it fails at the base commit and passes
  with the upstream fix; only faithful tests are used, and each run records `checkFaithful`.
- `visible-f2p` — the instance's FAIL_TO_PASS tests are applied from the start and named in the
  task; the check passes when they all pass.

**Scoring.** Outside `oracle`, every run is scored separately by the hidden tests (`hidden` in
each record) on its final state; staged arms are also scored after every executed stage
(`staged.stages[].observation.hidden`, and `stage1Hidden`) by a program that restores the
repository exactly. No hidden result is ever shown to an agent or read by the run.

**Decision rules.**

- **Repro fallback:** if 5 or fewer of the 13 development reproduction tests are faithful, the
  G1 and G2 runs use `visible-f2p` instead of `repro`.
- **G1 confirmed** if, in the staged arm, staged resolves (hidden) at least 2 more issues than its
  own paired stage-1 score, AND false passes (a stage whose check passed while the hidden tests
  failed) are under 25% of check passes.
- **G2 (evidence) confirmed** if, pooled over at least 15 branch points, the reviewer-with-evidence
  control R has a hidden recovery rate at least 20 points above C0 (implementer prompt, task
  only, same allowance) AND at least twice C0's. Fewer than 15 branch points: not decided. C1
  (implementer prompt + the same evidence) separates the evidence from the reviewer framing; it
  has no threshold of its own.
- **G3:** G1 and G2 are evaluated on the held-out pool exactly as on the development pool; a
  result that holds only on the development pool is reported as such.

**Branch points** (`cli.ts branch`). The implementer runs alone; when the check then fails, the
repository's diff from the base commit is saved. Each control replays that diff in a freshly reset
container and runs one agent with the same allowance as in the crews. R gets exactly the context
staged recovery builds for a recovery stage (`recoveryTask` in core), C0 the task alone, C1 the
implementer prompt plus R's context. Each is scored by the check and by the hidden tests.

Status: code and Docker checks in place; no model has been run under these rules yet. The Django
self-test covered the 88 instances with a local image: 86 usable (django-13551 and django-13590
fail with the upstream fix), so the held-out pool is django-10914 through django-12453, 30 issues
(`benchmarks/experiments/real-repo-heldout/pool.json`).
2026-10-02: reproduction-test generation ran on the 13 development issues and stored 11 tests over
two passes (8 with prompt v1, 3 more when the 5 missing were retried with prompt v2; about $0.254
billed including an aborted first invocation), `repro-fidelity` found 5 of the 13 faithful, so the
pre-registered fallback applies and
G1 and G2 run with `visible-f2p` (Amendment 1 below); repro-gen for the held-out pool was skipped.

#### Amendment 1 (2026-10-02, after commit ff01479, before any G1/G2 run)

Nothing here changes a threshold, a decision rule, or anything an agent sees (task text, check
labels, prompts, allowances and the recovery handoff are pinned by tests at their ff01479 values).
It records how the fallback was triggered, fixes the run counts, and adds reporting.

**(a) The repro fallback applied.** `repro-fidelity` finished at 10:43 on 2026-10-02: 5 of the 13
development issues have a faithful reproduction test (pallets__flask-4045, pytest-dev__pytest-11143,
pytest-11148, pytest-7432, pytest-8906). Two issues have no stored test, and all 6 unfaithful
tests fail both at the base commit and with the upstream fix. 5 is "5 or fewer", so G1 and G2 run
with `--check visible-f2p` on the development pool, and on the held-out pool too, for which
repro-gen was therefore skipped. Timeline: the "5 or fewer" rule was already in the draft
pre-registration when it was read at about 00:50 on 2026-10-02, before repro-gen started at 01:27;
the fidelity result (10:43) came before commit ff01479 (10:51), which committed the rule as
drafted. No G1 or G2 run has happened. (All times 2026-10-02, UTC−5, the commit's own zone.)

What repro-gen ran and cost, in full. A first invocation started at 01:27:57. It finished
pallets__flask-4045 with no test (the author agent failed after 4 model calls, about $0.0022
billed, and the record did not keep the agent's error), and was stopped at about 01:31 to add
error and tool-call recording; its output directory was deleted, and generation restarted from
scratch at 01:32 (flask-4045 was regenerated, and is one of the 5 faithful). Billed by OpenRouter:
about $0.0022 for the aborted invocation, $0.2213 for pass 1 (prompt v1, 13 issues, 8 stored) and
$0.0308 for the retry (prompt v2, the 5 missing, 3 stored) — about $0.254 in all, from the two
manifests plus the aborted run. An earlier figure of about $0.31 was an arithmetic error (it added
the retry pass's `repro.jsonl` total, which also counts the 8 records the retry kept from pass 1).
None of this changes a decision: even with flask-4045 not counted, 4 faithful is still "5 or
fewer".

**(b) What `visible-f2p` measures.** It is a test-given (TDD) setting: the visible tests are the
upstream fix's own FAIL_TO_PASS tests, with expectations specific to that fix's implementation.
G1 therefore answers "does staged recovery help when the user already has the right failing
tests?", not "does it help with a check a user would write". The visible FAIL_TO_PASS set is the
hidden FAIL_TO_PASS set, so, apart from flaky tests or timeouts, a false pass (check passes,
hidden tests fail) can only be a PASS_TO_PASS regression.

**(c) Run counts, fixed now.** G1: one staged run per issue per pool (13 development, 30
held-out). G2: 3 seeds per development issue, 1 per held-out issue. No further seeds are added
after any result has been seen. Fewer than 15 branch points is still "not decided". The constants
are `G1_RUNS_PER_ISSUE` and `G2_SEEDS` in `real-repo/prereg.ts`; `run` and `branch` record
`seedsMatchPrereg` in their manifests and warn on a mismatch.

**(d) Added reporting — no thresholds, no change to any decision.**
- G2 by how stage 1 ended (`answered`, `turn_cap`, `wall_clock`, `budget`, `unreadable`,
  `error`): branch points and R/C0/C1 recovery rates per stratum (`g2.json` `strata`).
- G1 recoveries by how the stage before the solving stage ended (`g1.json` `report`).
- Tokens, provider-billed cost and hidden recoveries per billed dollar, per control (`g2.json`
  `cost`, and billing per control in the branch manifest) and per arm (`analyze`). The direct
  executor now also records prompt, completion and cached prompt tokens; recording them changes
  no model request (a golden test pins the request sequence).
- A secondary regression score on every non-oracle run (`secondary`): the repository's own
  tests for the changed non-test modules, matched by file name only (`test_<stem>.py`,
  `<stem>_test.py`, `unittest_<stem>.py`, at most 5 files, test-patch files excluded), run now and
  with those modules at their base versions; a regression is a test that passed at base and fails
  now, or a test file that no longer collects (pytest's `ERROR <file>`, Django's `_FailedTest`)
  when tests from it passed at base. Name matching makes coverage partial, especially for Django,
  and `files: 0` is reported as "nothing matched", not read as clean. Staged arms score it after
  every stage whose check passed. Each of its two test runs is killed inside the container after
  420 s (its whole process session), the modules are always put back, and the host waits longer
  than both runs can take; a run that hit the bound is reported (`timedOut`).
- Extended false passes: check-passing stages where the hidden tests failed, or the secondary
  score found a regression, or the diff audit flagged the change.
- A diff audit on the same states (`audit`), read-only. It scans two things: the tracked files'
  diff from the base commit (`git diff --no-color -U0 <base>`), and the untracked files
  (`git ls-files --others --exclude-standard`), reading the first 64 KiB of up to 50 new non-test
  `.py` files. It flags changed test infrastructure (test directories, conftest.py, pytest.ini,
  tox.ini, setup.cfg, pyproject.toml, sitecustomize.py, usercustomize.py, `.pth` files, Django's
  runner files, test-named files, and test files deleted or renamed away — a removed test counts
  even if it is re-added elsewhere), and source lines (added lines of tracked files, every line of
  new source files) that name a FAIL_TO_PASS test or detect a test run (`PYTEST_CURRENT_TEST`,
  `'pytest' in sys.modules`, `sys.modules.get('pytest')`). New test files are listed, not flagged.
  In `visible-f2p` the test-patch files are left out, since the check lays them again.

None of these is shown to an agent; no rule reads them.

**(e) Interpretation notes.**
- Every control sees the check's output: the gate appends it to the agent's observation after a
  write that leaves the check failing, and the `visible-f2p` task names the failing tests. So G2
  compares evidence handed over (plus, for R, the reviewer framing) against evidence the agent
  finds for itself — not access to evidence against none.
- Contamination: DeepSeek V4 Flash has very likely seen these public SWE-bench issues and their
  fixes in training. The held-out pool is held out from Joule's development, not from the model's
  training data.
- The hidden tests are incomplete, so measured false passes are a lower bound.
- Timeouts. A host-side timeout ends only `docker exec`, not the program running in the
  container, and on the Python 3.6 images `subprocess.run(..., timeout=)` does not return until
  every grandchild holding its pipe has exited. The secondary score (new here) is bounded against
  both. The pre-registered check and hidden-scorer programs have the same weakness under
  timeouts and were deliberately left unchanged — byte-identical to ff01479 — so the
  pre-registered procedure is unaltered; any timeout that occurs in a check or a hidden score
  will be reported with the results.

**(f) Considered and not adopted.**
- A "resume the same implementer" control: it needs a transcript-resume hook in core and about
  30% more spend, and C0 already matches the allowance of turns.
- A placebo-evidence control: evidence cannot be withheld or replaced, because the gate echoes
  the check's output to every agent.
- Tagging branch points by evidence type: too few branch points to stratify further.
- Repro-gen v3 (pass-then-invert, candidate selection): the development pool's fidelity has
  already been seen, so tuning on it now would not be pre-registered; deferred to a separately
  pre-registered follow-up.

### Reproducing

```bash
npx tsx benchmarks/staged-replication/cli.ts selftest        # fixtures must fail as planted and pass with the reference fix
npx tsx benchmarks/staged-replication/cli.ts run --seeds 3 --arms primary,full,full_verify,staged \
  --out-dir benchmarks/experiments/staged-replication-v3    # 10 tasks x 4 arms x 3 reps
npx tsx benchmarks/staged-replication/cli.ts analyze --arms primary,full,full_verify,staged \
  --out-dir benchmarks/experiments/staged-replication-v3

npx tsx benchmarks/real-repo/selftest.ts <instanceId ...>    # decides the pool; calls no model
npx tsx benchmarks/real-repo/cli.ts pool
npx tsx benchmarks/real-repo/cli.ts run --arms primary --instances <id> --model <id>

# Without the oracle (pre-registration above)
npx tsx benchmarks/real-repo/selftest.ts --django-local --out benchmarks/experiments/real-repo-heldout/selftest.json --resume --cleanup
npx tsx benchmarks/real-repo/cli.ts pool --held-out
npx tsx benchmarks/real-repo/cli.ts repro-gen --pool dev --repro-dir <dir>          # model
npx tsx benchmarks/real-repo/cli.ts repro-fidelity --repro-dir <dir>                # Docker only
npx tsx benchmarks/real-repo/cli.ts run --check repro --repro-dir <dir> --arms staged --out-dir <out>
npx tsx benchmarks/real-repo/cli.ts analyze --arms staged --out-dir <out>           # writes g1.json
npx tsx benchmarks/real-repo/cli.ts branch --check repro --repro-dir <dir> --controls R,C0,C1 --out-dir <out>
npx tsx benchmarks/real-repo/cli.ts analyze-branch --out-dir <out>                  # writes g2.json
# As amended (Amendment 1): visible-f2p, G1 one staged run per issue, G2 3 seeds dev / 1 held-out
npx tsx benchmarks/real-repo/cli.ts run --check visible-f2p --arms staged --seeds 1 [--pool held-out] --out-dir <out>
npx tsx benchmarks/real-repo/cli.ts branch --check visible-f2p --controls R,C0,C1 --seeds 3 --out-dir <out>
npx tsx benchmarks/real-repo/cli.ts branch --check visible-f2p --controls R,C0,C1 --seeds 1 --pool held-out --out-dir <out>
```

Datasets land in `benchmarks/experiments/` and are gitignored; the code that produces them is not.
Every manifest records the runtime commit, whether the tree was dirty, the model, the selection
rule, the verification policy and the tool-loop semantics, because each of those has already
changed a result at least once in this project.
