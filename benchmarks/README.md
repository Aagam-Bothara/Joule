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
├── workloads/     mock scenarios, 8 live tasks, and MBPP (427 Python problems, tests as the verifier)
├── strategies/    slm-only, llm-only, static-router, naive-cascade, frugal-cascade, automix, pre-router, joule-adaptive
├── evaluators/    success (deterministic vs status-judged), cost, latency, escalation
├── runners/       mock runner, live runner
└── index.ts       entry point; writes benchmarks/reports/harness-*.json
```

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
