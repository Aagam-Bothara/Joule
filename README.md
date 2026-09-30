<div align="center">

# Joule

### The agent says it is done. The tests still fail. Joule checks before it believes.

Joule is a verification-driven agent runtime. It never treats an agent's own report of success as
evidence: after a stage finishes, Joule runs the task's real check — your test command, an exit
code, a compile — and continues only when that check disagrees with the agent. When it escalates,
it hands the next agent the actual failure output, and it stops the moment the check passes.

[Quickstart](#quickstart) · [How it works](#how-it-works) · [Results](#results) · [Limitations](#limitations) · [Benchmarks](benchmarks/README.md)

![CI](https://github.com/Aagam-Bothara/Joule/actions/workflows/test.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Tests](https://img.shields.io/badge/tests-1426%20passing-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

</div>

---

```typescript
import { Joule } from '@joule/core';

// Small model does the work; a large model is consulted only when needed.
const joule = new Joule({ providers: { google: { enabled: true }, anthropic: { enabled: true } } });
const result = await joule.execute({
  description: "Find the failing test in this repo and fix it",
  budget: 'medium',        // hard caps on tokens, cost, tool calls, time, escalations
});

console.log(result.result);
console.log(result.trajectory);   // every step, every escalation decision, SLM vs LLM tokens
```

```
$ joule run "Write comb_sort and make the tests pass" --trajectory

SLM start
│
├─ 1 Create a basic comb_sort function       CONTINUE  conf 0.90 verify=pass
├─ 2 Implement comb_sort with gap shrink     CONTINUE  conf 0.42 verify=fail
├─ 3 Try to debug comb_sort                  CONSULT   conf 0.39 verify=fail
│     → CONSULT gemini-2.5-flash  2,405 tok  $0.0011
│       q: While working on "Write a Python function named `comb_sort`…
├─ 4 Implement comb_sort with the advice     CONTINUE  conf 0.85 verify=pass
├─ 5 Run the tests                           CONTINUE  conf 0.87 verify=pass
└─ Complete

SLM tokens:          32,900      (Llama 3.1 8B)
LLM tokens:           2,405      (Gemini 2.5 Flash, one consultation)
Total cost:          $0.0018
Estimated LLM-only:  $0.0163
```

That trajectory is a real run from the benchmark below: the 8B model wrote the function, the
tests failed twice, one question to the large model unblocked it, and the small model finished.

---

## Why Joule

An agent reports that the task is complete. The tests still fail.

Most runtimes respond in one of three ways: trust the report, retry blindly, or run a whole crew
of specialists on every task whether or not the first agent already succeeded. The first is wrong
whenever the agent is wrong. The second throws away what the failure actually said. The third pays
for reviewers and testers on the majority of tasks that never needed them.

Joule checks the work against reality and escalates only when that check disagrees with the agent.
This is not a hypothetical failure mode. On our authored debugging benchmark, **eight of ten
lone-agent failures stopped voluntarily** — believing they were finished, with most of their turn
budget unused and no write attempted. An agent's own account of its work is not evidence.

---

## How it works

Two escalations, both triggered by evidence rather than by a model's self-assessment.

**Across agents — staged recovery** (`strategy: 'staged_recovery'`). The next specialist runs only
if the external check says the previous one did not actually succeed:

```
Task
 ↓
Implementer ──► external check ──► PASS ──► finish          (1 stage)
                     │
                    FAIL
                     ▼
             Reviewer + failure evidence ──► check ──► PASS ──► finish   (2 stages)
                     │
                    FAIL
                     ▼
             Tester + failure evidence ──► check ──► finish              (3 stages)
```

Two distinct mechanisms are at work, and we measured them separately:

| mechanism | what it does | what it buys |
|---|---|---|
| **failure evidence** | the recovery agent receives the check's command and real output, not a summary | recovery quality |
| **conditional admission** | a stage that is not needed is never started — no context built, no model called | efficiency |

**Inside one task — the escalation ladder.** A small model executes, every step is verified, and a
larger model is consulted or handed off only when the evidence says the small model is stuck. That
mechanism and its benchmarks are [further down](#escalating-inside-one-task).

---

## Results

**Authored repository-debugging benchmark: 10 repositories with one planted defect each, 3
repetitions, 30 cells per arm, `deepseek-v4-flash`, verified-edit gate on.** Each task gives the
agent a failing suite and nothing about where the defect is. All four arms share the same agents,
prompts, tools, budgets and verifier — only the execution policy differs. These are the 120 runs
made on 2026-09-30 under the corrected response parser; the earlier old-parser run reached the same
outcomes in every arm but `PRIMARY` (see [benchmarks/README.md](benchmarks/README.md)).

| arm | success | mean cost | mean tokens | mean JCT | mean stages |
|---|---:|---:|---:|---:|---:|
| `PRIMARY` — implementer alone | 19/30 | $0.0014 | 10,482 | 52s | 1.00 |
| `FULL` — all three, every time | 27/30 | $0.0039 | 29,575 | 158s | 3.00 |
| `FULL_VERIFY` — all three, verified between stages | 30/30 | $0.0036 | 27,154 | 49s | 3.00 |
| `STAGED` — escalate only on failure | 30/30 | $0.0020 | 15,235 | 27s | 1.30 |

The two middle rows are the ablation that separates the mechanisms:

```
FULL → FULL_VERIFY      same 3 stages; difference is verifier evidence
                        27/30 → 30/30

FULL_VERIFY → STAGED    same verifier-informed specialists; difference is stopping on PASS
                        30/30 → 30/30,  cost −44%,  tokens −44%,  JCT −45%
```

Read carefully:

- `FULL_VERIFY` and `STAGED` **matched on all 30 paired cells** — 30 both-pass, 0 either-only. The
  efficiency was not bought with quality on this benchmark.
- `30/30` against `FULL`'s `27/30` rests on 3 discordant pairs, McNemar exact **p = 0.25**. That is
  directional, not statistically significant, and it is not proof of general reliability.
- `STAGED` does not "beat" `FULL_VERIFY`. It matches it for less work.
- The arms ran one after another, and provider latency drifted: `FULL`'s runs took over twice as
  long as in the old-parser run while costing less. Cost and tokens are the reliable efficiency
  measures; wall-clock comparisons between arms are weaker.

Scoped claim: *on a 30-cell authored repository-debugging benchmark with DeepSeek V4 Flash, STAGED
matched FULL_VERIFY's 30/30 outcomes while reducing mean cost and tokens by 44%.* It is not a claim
about your repository, your model, or agents in general.

---

## Why not just run another agent?

The gain is not "a second attempt". We ran the control that separates those, on a 15-cell authored
benchmark — same model, same tools, same ceilings, same position in the pipeline, **only the second
agent's instructions differ**:

| second seat | success | write attempts |
|---|---:|---:|
| none (implementer alone) | 5/15 | — |
| **reviewer** — told to assume a defect exists and fix it | **9/15** | 4 proposed, 3 accepted |
| **a second implementer** — same prompt as the first | 4/15 | **0 in 15 runs** |

A copy of the primary inherits the primary's belief that the work is finished. It reads the code,
sees something that looks complete, and never edits anything. The measured benefit came from a
differently framed recovery role explicitly tasked with finding and fixing a defect — not from
handing the task to another fresh context, and not from more compute.

Tested on one model and one authored workload; we have not shown this holds for other models or
for real repositories.

---

## Recovery funnel

Across the 30 `STAGED` cells:

```
30 runs
├── 22  solved by the implementer            → 73% stop after one agent
└──  8  failed verification
     ├──  7  recovered by the reviewer       → 27% reach the reviewer
     └──  1  still failing
          └── 1  recovered by the tester     →  3% reach the tester

final: 30/30
```

This is the resource mechanism made concrete: the majority of tasks never pay for a specialist, and
the ones that do pay only for as many as the evidence demands.

---

## What happens after the check already passes

`FULL_VERIFY` exists partly to answer this. It deliberately runs specialists on repositories that
have **already passed** verification:

```
49  specialist stages entered after a passing check
49  made no edit at all
 0  accepted improvements
 0  rollbacks
 0  regressions
```

On this workload and model, once external verification passed, continuing to run specialists
produced no measured benefit — and no measured harm either. It was simply cost. That is the direct
empirical justification for conditional admission, and the reason `STAGED` can skip 51 of
`FULL_VERIFY`'s 60 specialist stages without losing a single outcome.

We do not generalize this to all agents, models or tasks. A more eager specialist would turn that
pure cost into real regression risk — which is what the gate below is for.

---

## Safety: verified edits

`VerifiedEditGate` protects work that is already known to be good:

```
No passing state yet   →  agents edit freely (they are still working toward the first success)
A passing state exists →  a later edit is checked
                          PASS → keep it
                          FAIL → restore the previously verified state
```

It was added after wider crews were observed destroying solutions that earlier agents had already
gotten working. It is a narrow safety net — a check-and-restore around writes, not a general
transactional store. It does no patch merging, no conflict resolution and no branching. Across the
runs above it recorded zero rollbacks, which is consistent with specialists that abstain rather
than meddle.

---

## Observability

Every run records, per agent:

```
lifecycle states and timings      model calls          tool calls and tool identities
write attempts                    accepted writes      rolled-back writes
verification result after stage   cost and tokens      failure reason and stage reached
which stage solved the task       stages skipped, and why
```

The point of recording tool *identity* and *accepted* writes, rather than counts alone, is to tell
"the agent was busy" apart from "the agent made a verified contribution". Two of this project's
conclusions had to be thrown out because the earlier instrumentation could not make that
distinction — see [benchmarks/README.md](benchmarks/README.md).

---

## Escalating inside one task

```
Task
 ↓
Step agent on the small model  →  execute tool  →  observe  →  verify (tests, exit codes, compile checks, patterns)
 ↓
Confidence from evidence only (tool result, verifier, progress, repeated failures, budget)
 ↓
Escalation policy
 ├── CONTINUE → the small model keeps working
 ├── CONSULT  → one focused question to the large model; the answer comes back to the small model
 ├── HANDOFF  → the large model takes over from the current state (never restarts the task)
 └── ABORT    → budget exhausted, safety rule, or impossible tool requirement
```

- **Trajectory-level, not task-level.** Cascades and routers (FrugalGPT, RouteLLM, AutoMix) decide once per request. Joule decides after every step, from what actually happened.
- **No self-reported confidence.** The policy never asks the model how sure it is. It reads tool results, deterministic verification, repeated failure signatures, and budget headroom.
- **Consult before handoff.** Most small-model failures are one wrong decision. A consultation costs one question; a handoff bills the rest of the task at large-model prices. The consultant sees the files involved and can hand back the edit itself, so the small model verifies instead of transcribing.
- **Budget is part of the decision.** Seven-dimensional envelopes (tokens, cost, time, tool calls, escalations, energy, carbon) gate every escalation and stop every run.
- **Five modes, one engine.** `adaptive` (default), `slm-only`, `mid-only`, `llm-only`, and `static-router` share the same tools and prompts, so comparisons are fair. Every design choice has a switch that removes it, so it can be measured.

---

## Results: the escalation ladder

**MBPP, 200 unseen problems, Llama 3.1 8B as the small model, Gemini 2.5 Flash as the large one.**
The small-model-only baseline ran three times per problem to label which problems actually need
escalation; Joule and the FrugalGPT-style cascade ran three independent times. Every strategy
uses the same engine, tools and prompts.

| strategy | success | cost vs LLM-only | LLM used on | precision | recall |
|---|---:|---:|---:|---:|---:|
| small model only (Llama 8B) | 55% | 0.07 | 0% | | |
| large model only (Flash) | 97% | 1.00 | 100% | | |
| static router (old Joule pipeline) | 57% | 0.14 | 0% | | 0% |
| naive cascade (EcoAssistant-style) | 95% | 0.53 | 42% | 76% | 78% |
| FrugalGPT-style cascade | 96% ± 0.5 | 0.60 | 50% | 66% | 81% |
| AutoMix-style self-verification | 97% | 0.66 | 55% | 65% | 88% |
| pre-router (RouteLLM-style) | 55% | 0.07 | 0% | | 0% |
| **Joule adaptive** | **96% ± 1.0** | **0.39** | 51% | 68% | 85% |

Joule matches the best success rate within noise at 0.39 of large-model cost, against 0.53 to
0.66 for the cascades. Of the problems where Joule involved the large model, 89% of handoffs
succeeded and 40% of consultations let the small model finish on its own (83% with the current
patch-mode consultations, measured on a further 50 problems below). With GPT-4o as the
large model on a 20-problem spot check, Joule matched its 95% at 27% of its cost. Precision and recall are
measured against counterfactual labels, so "precision 68%" means roughly one escalation in three
went to a problem the small model would probably have solved anyway.

With a weaker large model (GPT-4o-mini, 84% alone), Joule is the cheapest strategy at 46% of
LLM-only cost and 83% success, one point below LLM-only and three below the FrugalGPT-style
cascade, which spends 48% more. Nine small models from 3B to 70B all reach 90 to 100% under
adaptive escalation; the 7B to 8B open models finish 100% of a 20-problem slice at about
$0.003 per problem.


**HumanEval, all 164 problems, same pair.** A harder workload for an 8B model: alone it solves
34%, the large model 96%.

| strategy | success | cost vs LLM-only | LLM used on | precision | recall |
|---|---:|---:|---:|---:|---:|
| small model only | 34% | 0.06 | 0% | | |
| large model only | 96% | 1.00 | 100% | | |
| FrugalGPT-style cascade | 93% | 0.72 | 63% | 79% | 74% |
| **Joule adaptive** | **96%** | **0.64** | 79% | 72% | 84% |

Joule matches the large model exactly at 64% of its cost; the cascade gives up three points to
save less. When the small model is this weak, handoffs carry the result (94% of them succeed)
and consultations rarely suffice (22%), which is the expected shape: consult pays off when the
small model is close, handoff when it is not.

**The longer the task, the bigger the gap.** Thirty tasks of four functions each, built
incrementally in one module with all tests required to pass (8 to 15 steps per task, up to 40):

| strategy | success | cost per task | cost vs Flash alone |
|---|---:|---:|---:|
| small model alone | 20% | $0.0023 | 0.08 |
| Flash alone | 53% | $0.0286 | 1.00 |
| FrugalGPT-style cascade | 57% | $0.0217 | 0.76 |
| **Joule adaptive** | **67%** | **$0.0136** | **0.47** |

On long trajectories Joule is the best strategy on both axes. The small model's partial work is
kept: it hands over a half-built module with passing tests, and the large model finishes rather
than restarts. This is where request-level cascades lose most, because they rerun the whole task.

**Three rungs beat two.** With an efficient model as a middle rung (Llama 8B → Gemini Flash →
GPT-4o, 50 further problems), escalation climbs one rung at a time and only reaches the frontier
model when the middle one fails too.

| strategy | success | cost per task | cost vs GPT-4o alone |
|---|---:|---:|---:|
| small model alone | 62% | $0.0004 | 0.01 |
| Flash alone | 96% | $0.0061 | 0.13 |
| GPT-4o alone | 90% | $0.0482 | 1.00 |
| Joule, two tiers (small → GPT-4o) | 86% | $0.0190 | 0.39 |
| **Joule, ladder (small → Flash → GPT-4o)** | **94%** | **$0.0070** | **0.15** |

The ladder touched the frontier model on 6 of 50 problems. 80% of its handoffs succeeded,
against 46% when the small model handed straight to GPT-4o: the middle rung is both cheaper
and a better first responder.

**Each design choice, measured.** Same 50 problems, Llama 8B → Flash, one choice removed per row:

| variant | success | cost vs Flash | LLM used on | consultations that finished the task |
|---|---:|---:|---:|---:|
| **Joule, full policy** | **98%** | **0.24** | 38% | 83% |
| no consultations (handoff only) | 98% | 0.40 | 88% | |
| prose-only consultations (old behaviour) | 98% | 0.42 | 40% | 40% |
| no static checks | 96% | 0.26 | 38% | 79% |
| self-reported confidence instead of evidence | 96% | 0.28 | 46% | 74% |
| no step verification | 80% | 0.21 | 6% | |

Verification is what makes the policy work: without it 8 of 50 runs finish "completed" on wrong
code. Self-reported confidence is noise: in 72 of 107 decisions right after a failed test run, the
model still claimed 0.8 or more. Consultations that return the edit doubled the share that let
the small model finish (40% to 83%) and cut handoffs from 12 to 4; on 30 long four-function tasks
the same change lifted consultation success from 13% to 32% and success from 60% to 67% at 22%
less cost.

**Current models.** Qwen3.5 9B → GPT-5.6 Luna → Claude Sonnet 5, 40 problems, all billed at
OpenRouter's reported cost:

| strategy | success | cost per task | cost vs Sonnet alone |
|---|---:|---:|---:|
| Qwen3.5 9B alone | 79% | $0.0021 | 0.04 |
| Sonnet 5 alone | 100% | $0.0524 | 1.00 |
| FrugalGPT-style cascade (Qwen → Sonnet) | 100% | $0.0284 | 0.54 |
| Joule, two tiers (Qwen → Sonnet) | 100% | $0.0081 | 0.15 |
| **Joule, ladder (Qwen → Luna → Sonnet)** | **100%** | **$0.0041** | **0.08** |

On a stack a student can afford (Qwen3.5 9B → DeepSeek V4 Flash → DeepSeek V4 Pro, 100 problems),
the ladder reaches 96% ± 2 at 27% of DeepSeek Pro's cost and the two-tier policy 98% ± 1.5 at 37%
(three seeds); the cascade needs 59% for 98%. DeepSeek Flash alone
is 97% for even less, which is the honest limit of small-model-first on three-line functions: when a
cheap model needs no help, there is nothing to escalate.

**Real repositories.** SWE-bench Lite instances in their official docker images, scored by the
hidden tests. On a first 15-instance slice (Qwen3.5 9B → Gemini Flash → Gemini Pro) the ladder
resolved 7, against 2 for each model alone. On 95 instances with the cheap stack that result does
not hold: DeepSeek V4 Flash alone resolves 44 at $0.011 per task, the ladder 37 at $0.026, the 9B
model alone 10. The 9B model fails to produce a valid action on more than half of the instances,
spends two thirds of the ladder's tokens while costing as much per task as Flash, and the steps it
uses are not refunded after a handoff. Where the ladder does hand off it keeps 90% of Flash's
success on the same instances, so the loss is the small rung, not the handoff. A Flash → Pro run
with a fresh step allowance after a handoff is the next experiment (both repository runs in
[benchmarks/README.md](benchmarks/README.md)).

Reproduce with `benchmarks/harness` (see [benchmarks/README.md](benchmarks/README.md)): same
engine, same tools, same prompts; only the routing strategy changes. Success on coding tasks is
decided by re-running the tests, never by the agent's own claim.

---

## Everything else Joule ships

Joule started as a governed runtime and keeps those pieces. They are documented in [docs/](docs/)
and stay out of the way unless you enable them.

| Capability | What it gives you |
|---|---|
| **Budget envelopes** | Hard caps on tokens, cost, time, tool calls, escalations, energy and carbon per task; `BudgetExhaustedError` instead of a surprise bill |
| **Constitution and governance** | Runtime rules that block tool calls before they run; trust tiers, approvals, an audit chain |
| **Tracing** | Per-step traces with model, tier, cost and escalation decisions; Gantt dashboard; Langfuse and OTLP export; `joule trace <id>` |
| **Crews** | Sequential, parallel, hierarchical and debate orchestration with per-agent budgets |
| **Providers** | Ollama, Anthropic, OpenAI, Google, and any OpenAI-compatible endpoint (OpenRouter, vLLM) |
| **Integrations** | Slack, Discord, Telegram, WhatsApp, Signal, Teams, email, Matrix, IRC, SMS, webhooks; voice; desktop automation; MCP tools |

---
## Quickstart

### Option 1: Zero-config (programmatic)

```bash
npm install @joule/core
```

```typescript
import { Joule } from '@joule/core';

// Auto-detects JOULE_ANTHROPIC_API_KEY, JOULE_OPENAI_API_KEY, or local Ollama
const result = await Joule.simple("What are the key trends in AI agents?");
console.log(result);
```

### Option 2: Full setup (CLI)

```bash
git clone https://github.com/Aagam-Bothara/Joule.git
cd joule && pnpm install && pnpm build

# Interactive setup — 3 questions, generates joule.config.yaml
pnpm joule init

# Run a task
pnpm joule run "Summarize the top HN stories" --budget medium

# Or chat interactively
pnpm joule chat
```

### Option 3: Docker

```bash
docker build -t joule .
docker run -p 3927:3927 \
  -e OLLAMA_BASE_URL=http://host.docker.internal:11434 \
  joule
```

### Environment variables

| Variable | Description |
|----------|-------------|
| `JOULE_ANTHROPIC_API_KEY` | Anthropic API key |
| `JOULE_OPENAI_API_KEY` | OpenAI API key |
| `JOULE_GOOGLE_API_KEY` | Google AI API key |
| `JOULE_DEFAULT_BUDGET` | Budget preset: `low` / `medium` / `high` / `unlimited` |
| `JOULE_SERVER_PORT` | HTTP server port (default: 3927) |

---

## Core Concepts

### Budget Enforcement

Every task is tracked across 7 dimensions. When any limit is hit, the agent stops — no surprise bills.

| Dimension | What it limits |
|-----------|----------------|
| **Tokens** | Total LLM tokens consumed |
| **Cost (USD)** | Dollar spend on API calls |
| **Latency** | Wall clock time |
| **Tool calls** | Number of tool invocations |
| **Escalations** | Model tier upgrades (local → cloud) |
| **Energy (Wh)** | Estimated compute energy |
| **Carbon (gCO₂)** | Estimated carbon emissions |

The model router always picks the smallest model that can handle the current step. It only escalates to a bigger model if the budget allows it. For simple tasks, the planner uses a slim prompt that omits tool descriptions entirely — cutting system prompt tokens from ~2900 to ~50.

### Guardrails

Define what your agents can and can't do. Joule enforces it at runtime.

```yaml
governance:
  constitution: default          # blocks prompt injection, data exfiltration
  requireApproval:
    - shell_exec                 # human-in-the-loop for shell commands
    - file_delete                # prevent accidental data loss
  budget:
    maxCostUsd: 1.00             # hard stop at $1
```

No agent runs without limits. No tool executes without permission. No budget overruns.

The constitution has three tiers:
- **Hard boundaries** — never violated, no override possible. *"Never expose PII."*
- **Soft boundaries** — can be overridden with authority + audit trail. *"Prefer local models."*
- **Aspirational principles** — guide behavior, don't block execution. *"Minimize token usage."*

### Trust Scoring

Agents earn autonomy through clean behavior:

```
New agent (trust: 0.50) → every action monitored
  → 20 clean tasks → trust 0.65 → spot-checked every 5th task
  → 50 clean tasks → trust 0.80 → minimal oversight, more tools unlocked
  → 100 clean tasks → trust 0.90 → can delegate, can approve others
  → Violation at any point → demoted, must earn it back
```

Good behavior unlocks tools, budget, and autonomy. Violations restrict access, increase oversight, or quarantine the agent. The governance system itself learns — spotting patterns across agents and adapting policies automatically.

### Multi-Agent Crews

Set up teams of agents with different roles:

```bash
joule crew run research-team "Analyze the competitive landscape"
```

Strategies:
- **`staged_recovery`** — verify after each agent; run the next one only if the check fails
- **`verified_full`** — run every agent, but still verify between stages and hand the result on
  (the control arm used in [Results](#results))
- **Sequential** — agents run in order, each builds on previous output
- **Parallel** — everyone runs at once, results get merged
- **Hierarchical** — manager delegates subtasks to workers
- **Graph** — a DAG with conditional edges

Every agent in the crew gets its own budget slice. With `budgetMode: 'fixed_per_agent'` each agent
instead receives the full per-agent ceiling, so adding a recovery stage does not shrink the budget
of the agent doing the primary work — the configuration used for every benchmark above.

### Model Routing

Joule prefers cheap local models (Ollama) and only escalates to expensive cloud calls when the task genuinely needs it:

```
Simple task → Ollama (free, fast, private)
Complex task → Anthropic/OpenAI/Google (powerful, costs money)
Provider down → Circuit breaker → automatic failover to next provider
```

Supports 4 providers: **Ollama**, **Anthropic**, **OpenAI**, **Google** — all with vision support.

---

## Examples

### Zero-config task

```typescript
const answer = await Joule.simple("Summarize this document", {
  budget: 'low',            // cap spending
  provider: 'anthropic',    // or 'openai', 'google', 'ollama'
});
```

### Budget-constrained research

```typescript
const joule = new Joule();
await joule.initialize();

const result = await joule.execute({
  description: "Research the top 5 competitors and summarize their pricing",
  budget: 'medium',  // 50K tokens, $0.50 max
});

console.log(result.result);
console.log(`Spent: $${result.budgetUsed.costUsd.toFixed(4)} of $0.50 budget`);
console.log(`Tokens: ${result.budgetUsed.tokensUsed}`);
console.log(`Energy: ${result.budgetUsed.energyWh.toFixed(4)} Wh`);
```

### Staged recovery

The verification command lives on the **task**, not the crew — it is a property of the work, and
the same crew can be pointed at any repository that knows how to check itself. Its exit code is
the only thing that decides whether the next agent runs.

```typescript
import { Joule } from '@joule/core';
import type { AgentDefinition, CrewDefinition, Task } from '@joule/shared';

const joule = new Joule();
await joule.initialize();

const tools = ['file_read', 'file_write', 'shell_exec'];

const implementer: AgentDefinition = {
  id: 'implementer', role: 'Implementer', allowedTools: tools, maxIterations: 16,
  instructions: 'Fix the repository so its tests pass. Read what you need, correct the source, then run the tests.',
};
const reviewer: AgentDefinition = {
  id: 'reviewer', role: 'Reviewer', allowedTools: tools, maxIterations: 10,
  instructions:
    'The previous agent believes the task is complete, but verification shows the repository is still failing. '
    + 'Assume a concrete defect exists: find the specific cause and fix it rather than describing it.',
};
const tester: AgentDefinition = {
  id: 'tester', role: 'Tester', allowedTools: tools, maxIterations: 10,
  instructions: 'Both earlier attempts failed verification. Use the failing evidence to isolate and repair the remaining defect.',
};

const crew: CrewDefinition = {
  name: 'staged-debug',
  strategy: 'staged_recovery',   // 'verified_full' runs every stage but still verifies between them
  agents: [implementer, reviewer, tester],
  budget: 'high',
  budgetMode: 'fixed_per_agent', // a recovery stage does not shrink the primary's budget
};

const task: Task = {
  id: 'fix-failing-suite',
  description: 'The test suite in this repository fails. Find the cause and fix it.',
  createdAt: new Date().toISOString(),
  // The external check. Exit code 0 means done; anything else escalates.
  verifiedEdit: { command: 'npm test', cwd: '/path/to/repo', timeoutMs: 120_000 },
};

const result = await joule.executeCrew(crew, task);

console.log(result.staged?.stagesExecuted); // 1 when the implementer's work already passes
console.log(result.staged?.solvedAtStage);  // which stage the check first accepted
console.log(result.staged?.solvedByRole);   // e.g. 'Implementer'
console.log(result.status);                 // decided by the verifier, not by the agents
```

If the implementer's work passes the check, the reviewer and tester are **never instantiated** — no
context is built, no envelope is drawn, no model is called. They appear in `result.staged.stages`
marked `executed: false` with `skipReason: 'verification_already_passed'`, so a skipped stage is
never confused with an agent that ran and did nothing.

`staged_recovery` and `verified_full` require `task.verifiedEdit`. Without it the run fails with an
explicit error rather than guessing — escalation has to be decided by something outside the agent.

### Multi-agent crew (template)

```typescript
import { Joule, CODE_REVIEW_CREW } from '@joule/core';

const joule = new Joule();
await joule.initialize();

const result = await joule.executeCrew(CODE_REVIEW_CREW, {
  id: 'review-auth',
  description: 'Review the authentication module for security issues',
  createdAt: new Date().toISOString(),
  budget: 'high',
});

for (const agent of result.agentResults) {
  console.log(`[${agent.role}] ${agent.taskResult.status}`);
}
```

### Desktop automation

```bash
# COM automation for Office — way faster than screenshot + click
joule do "Create a 5-slide presentation about AI and save as AI.pptx"
joule do "Build an Excel spreadsheet with Q4 sales data"
joule do "Open Notepad and write a meeting agenda"
```

### API server with SSE streaming

```bash
joule serve  # starts on http://localhost:3927

# Submit a task
curl -X POST http://localhost:3927/tasks \
  -H "Content-Type: application/json" \
  -d '{"description": "Summarize the latest AI news", "budget": "low"}'

# Stream execution via SSE
curl -X POST http://localhost:3927/tasks/stream \
  -H "Content-Type: application/json" \
  -d '{"description": "Analyze this dataset", "budget": "medium"}'
```

See [`examples/`](examples/) for more runnable scripts.

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `joule init` | Interactive setup — generates `joule.config.yaml` |
| `joule run <task>` | One-shot task with budget; `--mode adaptive --trajectory` shows the escalation tree |
| `joule chat` | Interactive chat with session history |
| `joule do <task>` | Computer agent — controls your desktop |
| `joule crew run <name> <task>` | Multi-agent orchestration |
| `joule serve` | HTTP API server with SSE streaming |
| `joule replay <task-id>` | Re-run a task with different params, diff the output |
| `joule doctor` | System diagnostics and health check |
| `joule trace <id>` | Inspect a persisted trace as an escalation trajectory (or `--format json`) |
| `joule voice` | Voice mode (wake word + STT/TTS) |
| `joule schedule add/list` | Cron scheduling |
| `joule channels status` | Messaging channel status |
| `joule tools list` | List available tools |
| `joule skills list/install` | Skill marketplace |

---

## Tracing and metrics

Joule includes a React dashboard and built-in tracing:

- **Task list** — all executions with status, cost, duration
- **Trace timeline** — Gantt-chart visualization of every span (model calls, tool calls, governance checks)
- **Span detail** — click any span to see tokens, cost, latency, input/output
- **Live budget gauge** — real-time cost tracking during streaming execution
- **Prometheus metrics** — plug into Grafana, Datadog, or any monitoring stack
- **OTLP / Langfuse export** — send traces to your existing observability platform

```yaml
# joule.config.yaml
traceExport:
  langfuse:
    publicKey: "pk-lf-..."
    secretKey: "sk-lf-..."
  # or OTLP:
  otlp:
    endpoint: "http://localhost:4318/v1/traces"
```

---

## Architecture

Joule is a TypeScript monorepo with 9 packages:

```
@joule/cli        — CLI commands (run, chat, do, crew, serve, ...)
@joule/core       — Engine, budget, routing, crews, governance, memory, RAG, tracing
@joule/models     — Ollama, Anthropic, OpenAI, Google (all with vision)
@joule/tools      — Shell, OS automation, browser, MQTT, MCP, plugins
@joule/store      — SQLite (WAL mode), migrations, vector index, pgvector, Chroma
@joule/shared     — Types, Zod schemas, budget presets, energy math
@joule/server     — Hono REST API, JWT auth, SSE streaming, rate limiting
@joule/channels   — Slack, Discord, Telegram, WhatsApp, Signal, Teams, Email + more
@joule/dashboard  — React + Vite monitoring UI
```

The staged-recovery path runs entirely inside `@joule/core`:

```
Joule runtime
├── crew orchestrator      stage loop; one strategy decides whether a passing check ends the run
├── external verifier      runs the task's check command; its exit code is the only signal
├── recovery handoff       previous agent's prose + the check's command and real output
├── VerifiedEditGate       check-and-restore around writes once a passing state exists
├── budget manager         per-agent envelopes (shared slice, or fixed per agent)
├── lifecycle + tracing    per-agent states, tool identities, writes, cost
├── tools                  what agents may call, filtered per agent
└── model/provider adapters
```

Execution is `agent → tools → workspace → verifier → stage policy`. The policy is the only
difference between `staged_recovery` and `verified_full`; everything else on that path is shared,
which is what made the ablation in [Results](#results) a single-variable comparison. The code is in
[`crew-orchestrator.ts`](packages/core/src/crew-orchestrator.ts) (stage loop and handoff) and
[`verified-edit.ts`](packages/core/src/verified-edit.ts) (verifier and gate).

For detailed architecture diagrams and data flow, see [`docs/architecture.md`](docs/architecture.md).

---

## Governance Deep Dive

<details>
<summary>Click to expand — how the governance system works internally</summary>

### Architecture

```
┌──────────────────────────────────────────────────┐
│              CONSTITUTION                         │
│   Hard boundaries, soft boundaries, principles    │
├──────────────────────────────────────────────────┤
│              POLICY ENGINE                        │
│   Compiled rules, conflict resolution, scoping    │
├──────────────────────────────────────────────────┤
│            GOVERNOR AGENT                         │
│   Pre-flight checks │ Runtime monitoring │ Post-eval│
│          ↕            ↕            ↕              │
│   ┌──────────────────────────────────────┐       │
│   │        AGENT TRUST PROFILES          │       │
│   │  scores, history, streaks, tier      │       │
│   └──────────────────────────────────────┘       │
├──────────────────────────────────────────────────┤
│   SME AGENTS (bounded by trust profiles)          │
├──────────────────────────────────────────────────┤
│   VAULT — JIT credentials, scoped tokens, expiry │
├──────────────────────────────────────────────────┤
│   ACCOUNTABILITY CHAIN — full provenance trail    │
└──────────────────────────────────────────────────┘
```

### Policy Engine

Policies are derived from the constitution and enforce granular runtime constraints:

```yaml
policy: data-access
derived_from: constitution.hard.no-pii-exposure
rules:
  - agent_role: analyst
    can_access: [aggregated_metrics, anonymized_logs]
    cannot_access: [raw_user_data, credentials]
    requires_approval: [financial_records]
```

When policies conflict, the one closer to a hard constitutional boundary wins. If ambiguous, it escalates to the Governor, then to a human.

### Trust Scoring

After every task, the Governor evaluates agent performance:

| Tier | Example violation | Impact |
|------|-------------------|--------|
| **Warning** | Exceeded token budget | Trust -0.05, logged |
| **Strike** | Accessed data outside scope | Trust -0.15, increased oversight |
| **Suspension** | Attempted policy bypass | Trust -0.40, agent quarantined |
| **Termination** | Repeated Tier 3 violations | Trust → 0, permanently deactivated |

### Consensus Mechanism

For high-stakes actions, multiple agents must agree:

```yaml
consensus:
  - action: deploy_to_production
    requires: [code-reviewer, security-auditor, test-runner]
    quorum: 3/3   # unanimous
```

### System-Level Learning

The Governor spots patterns across all agents and adapts:

```yaml
system_insights:
  - pattern: "agents exceed token budget on refactoring tasks"
    frequency: 12/100
    response: "increased default budget for refactoring by 30%"
```

</details>

---

## Documentation

| Document | Description |
|----------|-------------|
| [`docs/architecture.md`](docs/architecture.md) | Package dependencies, data flow, internal design |
| [`docs/channels.md`](docs/channels.md) | Setup guides for all 11 messaging platforms |
| [`docs/api.md`](docs/api.md) | HTTP API reference (endpoints, auth, SSE) |
| [`docs/configuration.md`](docs/configuration.md) | Full `joule.config.yaml` reference |
| [`examples/`](examples/) | Runnable TypeScript examples |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Development setup, coding standards, PR process |

---

## Limitations

What the staged-recovery evidence does **not** cover:

- **Staged recovery on real repositories remains unvalidated.** Every staged-recovery number above
  comes from authored repositories. The old SWE-bench Lite smoke and probe artifacts had zero
  observed `repo_write`/`repo_edit` calls, but several agents ended with unexecuted calls that the
  old parser missed. Those runs do **not** establish a model capability floor. Two post-parser
  primary-only runs on `pylint-dev__pylint-7114` with `gpt-4o-mini` reached writes. The first,
  before the larger read limit and Python syntax guard, exhausted its budget with invalid source.
  In the second, the agent made three syntactically valid edits but the required issue test still
  failed (0/1); all 56 pass-to-pass checks passed. Its edit did not change the condition's behavior,
  and it stopped after reporting remaining failures. These runs show that the parser fix reached
  real-repository writes, while the current primary still failed this issue. They do not measure
  staged recovery or establish a real-repository success rate.
- **One model, one provider.** Everything is DeepSeek V4 Flash on OpenRouter. No multi-model
  generalization has been shown.
- **Small samples.** 30 cells per arm on 10 authored fixtures; the earlier control is 15 cells. The
  quality effect (`FULL` → `FULL_VERIFY`) is directional at p = 0.25, not significant.
- **The verifier is as good as your check.** Joule's guarantee is only ever "this command exited
  0". A weak test suite gives a weak signal, and the gate inherits that.
- **The gate is narrow.** Check-and-restore around writes — no patch merging, no conflict
  resolution, no branching.
- **Not production-hardened.** This is a research prototype.

For the full experimental history — including invalidated datasets, the harness bugs that
invalidated them, the controls, and the negative results — see
[benchmarks/README.md](benchmarks/README.md). Two earlier conclusions in this project were wrong
and are documented as wrong rather than deleted.

---

## Current Status

**Research prototype / experimental runtime.** 1426 tests passing across 108 files. Active
development — expect API refinements.

Supported by authored-fixture evidence:
- verifier-informed recovery handoff improves specialist recovery
- verification-triggered staging avoids specialist work that measurably contributes nothing
- the benefit comes from the recovery role's framing, not from a second attempt

Not established:
- broad real-repository generalization
- multi-model generalization
- production reliability

What's solid:
- Core runtime (task execution, budget, routing, crews, governance)
- Adaptive prompt optimization (slim prompts, direct answers, unified planning)
- 4 model providers with vision support
- 47 built-in tools
- 11 messaging channels
- SQLite persistence with WAL mode
- React dashboard with trace visualization
- Prometheus metrics + OTLP export
- Benchmarked against CrewAI (30 tasks, 5 categories)

Known limitations:
- Computer agent handles Office well but struggles with complex browser workflows
- No mobile apps
- Small community — actively growing
- Hash-based embeddings are the default (model-based via Ollama available in config)
- Governance layer is implemented but still maturing

---

## Roadmap

<details>
<summary>Click to expand</summary>

### Completed

- **v0.6** — `joule init`, hot reload, skill registry, better errors, OpenAPI spec
- **v0.7** — Real embeddings, long-term memory, adaptive routing, crew templates, streaming RAG
- **v0.8** — Tiered constitution, policy engine, governor agent, trust scoring, reward/punishment, vault, accountability chain, consensus, system-level learning

### Next

- **v0.9** — Distributed task queue, persistent state, circuit breakers, horizontal scaling, RBAC, SSO, compliance mode, multi-tenant isolation
- **v1.0** — Feature freeze, audit logging, published benchmarks, security audit, migration guides, documentation site

</details>

---

## Development

```bash
pnpm install       # install dependencies
pnpm build         # build all 9 packages
pnpm test          # 1426 tests across 108 files
pnpm dev           # watch mode
```

---

## When to Use Something Else

| You want... | Use |
|-------------|-----|
| Personal AI butler on WhatsApp | **OpenClaw** |
| Managed browser agent, zero setup | **OpenAI Operator** |
| Pure web scraping / automation | **Browser-Use** or **Skyvern** |
| Coding agents / repo-level tasks | **OpenHands** |
| Python ecosystem + mature RAG | **LangChain** |
| Maximum reliability, no LLM | **Playwright** |

---

## License

[MIT](LICENSE)
