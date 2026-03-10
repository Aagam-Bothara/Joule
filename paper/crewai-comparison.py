"""
CrewAI vs Joule Head-to-Head Comparison
========================================
Runs the same 8 tasks through CrewAI with equivalent tool registrations,
measuring cost, tokens, latency, and completion rate.

Usage:
    python paper/crewai-comparison.py
    python paper/crewai-comparison.py --json
    python paper/crewai-comparison.py --tasks 3  # subset

Requires: OPENAI_API_KEY set (CrewAI uses OpenAI by default)
"""

import os
import sys
import json
import time
import argparse

# Fix Windows console encoding for Unicode characters
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
from dataclasses import dataclass, asdict
from typing import Optional

# ── Task Definitions (identical to benchmarks/live.ts) ──────────────────────

TASKS = [
    # Low complexity
    {"description": "What is the capital of France? Answer in one sentence.", "complexity": "low", "tools": []},
    {"description": "Convert 72 degrees Fahrenheit to Celsius. Show only the result.", "complexity": "low", "tools": []},
    {"description": "List the 3 primary colors. One word each, comma separated.", "complexity": "low", "tools": []},
    # Medium complexity
    {"description": "Explain the difference between TCP and UDP networking protocols. Include 2-3 practical use cases for each.", "complexity": "medium", "tools": []},
    {"description": "Search the web for recent AI agent frameworks, then write a brief comparison of the top 3.", "complexity": "medium", "tools": ["search_web"]},
    {"description": "Analyze the following dataset and compute key metrics: 'Sales Q1: 120K, Q2: 145K, Q3: 98K, Q4: 167K. Expenses Q1: 80K, Q2: 92K, Q3: 75K, Q4: 110K.'", "complexity": "medium", "tools": ["analyze_data"]},
    # High complexity
    {"description": "Research the current state of quantum computing, analyze its potential impact on cryptography and cybersecurity, and write a comprehensive report with sections on: current capabilities, timeline predictions, recommended actions for organizations, and risks.", "complexity": "high", "tools": ["search_web", "analyze_data", "write_report"]},
    {"description": "Compare and contrast microservices vs monolithic architectures across 8 dimensions: scalability, deployment complexity, development speed, debugging difficulty, cost, team structure requirements, data consistency, and technology lock-in. Provide a decision framework with specific thresholds.", "complexity": "high", "tools": []},
]


@dataclass
class TaskMeasurement:
    task_description: str
    complexity: str
    status: str  # completed, error, timeout
    duration_ms: float
    tokens_input: int
    tokens_output: int
    tokens_total: int
    cost_usd: float
    tool_calls: int
    steps: int
    error: Optional[str] = None


def run_crewai_task(task: dict, timeout_s: int = 120) -> TaskMeasurement:
    """Run a single task through CrewAI and measure everything."""
    from crewai import Agent, Task, Crew, Process
    from crewai.tools import tool

    # ── Define tools matching Joule's benchmark tools ──
    @tool("search_web")
    def search_web(query: str) -> str:
        """Search the web for information on a given query."""
        return json.dumps({
            "results": [
                {"title": f"Result 1 for: {query}", "snippet": f"Comprehensive information about {query} from authoritative sources."},
                {"title": f"Result 2 for: {query}", "snippet": f"Recent developments and analysis regarding {query}."},
                {"title": f"Result 3 for: {query}", "snippet": f"Expert opinions and data about {query}."},
            ]
        })

    @tool("analyze_data")
    def analyze_data(data: str) -> str:
        """Analyze a dataset and compute key metrics."""
        return json.dumps({
            "summary": f"Analysis of provided data: {data[:100]}",
            "metrics": {"mean": 132.5, "median": 132.5, "std_dev": 25.3, "trend": "positive"},
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ")
        })

    @tool("write_report")
    def write_report(title: str) -> str:
        """Write and save a structured report."""
        return json.dumps({
            "saved": True,
            "title": title,
            "sectionCount": 4,
            "wordCount": 1500
        })

    # Map task tools to actual tool objects
    tool_map = {
        "search_web": search_web,
        "analyze_data": analyze_data,
        "write_report": write_report,
    }
    task_tools = [tool_map[t] for t in task["tools"] if t in tool_map]

    # ── Create CrewAI agent ──
    agent = Agent(
        role="General Purpose Assistant",
        goal="Complete the given task accurately and efficiently",
        backstory="You are a capable AI assistant that completes tasks directly.",
        tools=task_tools,
        verbose=False,
        allow_delegation=False,
    )

    # ── Create task ──
    crew_task = Task(
        description=task["description"],
        expected_output="A clear, complete response to the task.",
        agent=agent,
    )

    # ── Create crew ──
    crew = Crew(
        agents=[agent],
        tasks=[crew_task],
        process=Process.sequential,
        verbose=False,
    )

    # ── Execute and measure ──
    start = time.perf_counter()
    status = "completed"
    error_msg = None
    result = None
    tokens_input = 0
    tokens_output = 0
    cost = 0.0
    tool_call_count = 0
    step_count = 0

    try:
        result = crew.kickoff()
        elapsed_ms = (time.perf_counter() - start) * 1000

        # Extract token usage from CrewAI's usage metrics
        if hasattr(result, 'token_usage') and result.token_usage:
            usage = result.token_usage
            tokens_input = getattr(usage, 'prompt_tokens', 0) or getattr(usage, 'total_tokens', 0) // 2
            tokens_output = getattr(usage, 'completion_tokens', 0) or getattr(usage, 'total_tokens', 0) // 2
            cost = getattr(usage, 'total_cost', 0.0) or 0.0

        # Try to get usage from tasks_output
        if hasattr(result, 'tasks_output') and result.tasks_output:
            for to in result.tasks_output:
                if hasattr(to, 'token_usage') and to.token_usage:
                    tu = to.token_usage
                    tokens_input += getattr(tu, 'prompt_tokens', 0) or 0
                    tokens_output += getattr(tu, 'completion_tokens', 0) or 0

        # Count tool calls from result
        if hasattr(result, 'tasks_output') and result.tasks_output:
            for to in result.tasks_output:
                if hasattr(to, 'tool_calls'):
                    tool_call_count += len(to.tool_calls) if to.tool_calls else 0

        step_count = 1  # CrewAI single-agent = 1 step minimum

    except Exception as e:
        elapsed_ms = (time.perf_counter() - start) * 1000
        status = "error"
        error_msg = str(e)[:200]

    # Estimate cost from tokens if not provided
    if cost == 0.0 and (tokens_input + tokens_output) > 0:
        # gpt-4o-mini pricing: $0.15/$0.60 per M tokens
        cost = (tokens_input * 0.15 / 1_000_000) + (tokens_output * 0.60 / 1_000_000)

    return TaskMeasurement(
        task_description=task["description"][:80],
        complexity=task["complexity"],
        status=status,
        duration_ms=round(elapsed_ms, 1),
        tokens_input=tokens_input,
        tokens_output=tokens_output,
        tokens_total=tokens_input + tokens_output,
        cost_usd=round(cost, 6),
        tool_calls=tool_call_count,
        steps=step_count,
        error=error_msg,
    )


def aggregate(measurements: list[TaskMeasurement]) -> dict:
    """Aggregate measurements into summary statistics."""
    completed = [m for m in measurements if m.status == "completed"]
    n = len(measurements)
    nc = len(completed)
    return {
        "total_runs": n,
        "completed": nc,
        "success_rate_pct": round(nc / n * 100, 1) if n > 0 else 0,
        "total_cost_usd": round(sum(m.cost_usd for m in completed), 6),
        "avg_cost_usd": round(sum(m.cost_usd for m in completed) / nc, 6) if nc > 0 else 0,
        "total_tokens": sum(m.tokens_total for m in completed),
        "avg_tokens": round(sum(m.tokens_total for m in completed) / nc, 1) if nc > 0 else 0,
        "avg_duration_ms": round(sum(m.duration_ms for m in completed) / nc, 1) if nc > 0 else 0,
        "total_tool_calls": sum(m.tool_calls for m in completed),
        "avg_steps": round(sum(m.steps for m in completed) / nc, 2) if nc > 0 else 0,
        "failed": n - nc,
    }


def print_results(measurements: list[TaskMeasurement], summary: dict):
    """Print formatted results to terminal."""
    print("\n" + "=" * 70)
    print("  CREWAI BENCHMARK RESULTS")
    print("  Model: gpt-4o-mini (CrewAI default)")
    print("=" * 70)

    print(f"\n  Total Runs: {summary['total_runs']}")
    print(f"  Completed: {summary['completed']}")
    print(f"  Success Rate: {summary['success_rate_pct']}%")
    print(f"  Total Cost: ${summary['total_cost_usd']:.4f}")
    print(f"  Avg Cost: ${summary['avg_cost_usd']:.6f}")
    print(f"  Total Tokens: {summary['total_tokens']}")
    print(f"  Avg Tokens: {summary['avg_tokens']}")
    print(f"  Avg Duration: {summary['avg_duration_ms']:.0f}ms")
    print(f"  Total Tool Calls: {summary['total_tool_calls']}")

    print(f"\n  {'Complex':<8} {'Status':<12} {'Duration':>10} {'Tokens':>8} {'Cost':>10} {'Tools':>6}")
    print(f"  {'─' * 8} {'─' * 12} {'─' * 10} {'─' * 8} {'─' * 10} {'─' * 6}")
    for m in measurements:
        print(f"  {m.complexity:<8} {m.status:<12} {m.duration_ms:>8.0f}ms {m.tokens_total:>8} ${m.cost_usd:>8.4f} {m.tool_calls:>6}")
        if m.error:
            print(f"           ERROR: {m.error[:60]}")

    print()


def main():
    parser = argparse.ArgumentParser(description="CrewAI vs Joule benchmark comparison")
    parser.add_argument("--json", action="store_true", help="Output JSON")
    parser.add_argument("--tasks", type=int, default=8, help="Number of tasks to run (1-8)")
    parser.add_argument("--model", type=str, default=None, help="Override LLM model")
    args = parser.parse_args()

    # Check for API key
    if not os.environ.get("OPENAI_API_KEY"):
        print("ERROR: OPENAI_API_KEY not set. CrewAI requires OpenAI by default.")
        sys.exit(1)

    tasks = TASKS[:args.tasks]

    print("\n" + "━" * 70)
    print("  CREWAI BENCHMARK")
    print(f"  Running {len(tasks)} tasks through CrewAI")
    print(f"  Model: {args.model or 'gpt-4o-mini (default)'}")
    print("  WARNING: This will make real API calls and incur real costs.")
    print("━" * 70 + "\n")

    if args.model:
        os.environ["OPENAI_MODEL_NAME"] = args.model

    measurements = []
    for i, task in enumerate(tasks):
        print(f"  [{i+1}/{len(tasks)}] {task['complexity']}: {task['description'][:60]}...")
        m = run_crewai_task(task)
        measurements.append(m)
        status_icon = "✓" if m.status == "completed" else "✗"
        print(f"    [{status_icon}] {m.status} — ${m.cost_usd:.4f} / {m.tokens_total} tok / {m.duration_ms:.0f}ms")

    summary = aggregate(measurements)

    if args.json:
        output = {
            "framework": "crewai",
            "model": args.model or "gpt-4o-mini",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "summary": summary,
            "measurements": [asdict(m) for m in measurements],
        }
        print(json.dumps(output, indent=2))
    else:
        print_results(measurements, summary)

    # Save results to file
    output = {
        "framework": "crewai",
        "model": args.model or "gpt-4o-mini",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "summary": summary,
        "measurements": [asdict(m) for m in measurements],
    }
    os.makedirs("paper/results", exist_ok=True)
    with open("paper/results/crewai-results.json", "w") as f:
        json.dump(output, f, indent=2)
    print(f"  Results saved to paper/results/crewai-results.json")


if __name__ == "__main__":
    main()
