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
```

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

- **The ladder resolves more than any single model in it**, in both runs: 8/15 and 7/15 against
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
escalated earlier through a breakdown or a give-up, and the stall rule never fired. It stays
implemented and unit-tested but unmeasured; a proper test needs the full slice. Cost: 7 cents.

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
reaching it. Joule's case is the workload where no single cheap model suffices, which is the
repository slice below, not three-line functions. Spend: about $3.60. Latency: the ladder averaged
31 s per problem against 15 s for Pro alone.
