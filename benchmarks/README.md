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
