"""
Extended CrewAI Benchmark (30 tasks, 3 runs each)
===================================================
Same 30 tasks as extended-benchmark.ts for head-to-head comparison.

Usage:
    python paper/extended-crewai.py
    python paper/extended-crewai.py --runs 1        # Quick run
    python paper/extended-crewai.py --category tools # Single category
    python paper/extended-crewai.py --json
"""

import os
import sys
import json
import time
import argparse
import statistics
from dataclasses import dataclass, asdict
from typing import Optional

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

os.environ['CREWAI_TRACING_ENABLED'] = 'false'

TASKS = [
    # Category 1: Simple Knowledge
    {"id": "k1", "description": "What is the capital of France? Answer in one sentence.", "complexity": "low", "category": "knowledge", "tools": []},
    {"id": "k2", "description": "Convert 72 degrees Fahrenheit to Celsius. Show only the result.", "complexity": "low", "category": "knowledge", "tools": []},
    {"id": "k3", "description": "List the 3 primary colors. One word each, comma separated.", "complexity": "low", "category": "knowledge", "tools": []},
    {"id": "k4", "description": "What is the time complexity of binary search?", "complexity": "low", "category": "knowledge", "tools": []},
    {"id": "k5", "description": "Name the HTTP status code for 'Not Found'.", "complexity": "low", "category": "knowledge", "tools": []},

    # Category 2: Reasoning
    {"id": "r1", "description": "Explain the difference between TCP and UDP networking protocols. Include 2-3 practical use cases for each.", "complexity": "medium", "category": "reasoning", "tools": []},
    {"id": "r2", "description": "Compare REST vs GraphQL APIs across 5 dimensions: flexibility, caching, versioning, learning curve, and tooling.", "complexity": "medium", "category": "reasoning", "tools": []},
    {"id": "r3", "description": "Explain the CAP theorem. For each pair (CP, AP, CA), give a real-world database example and explain the trade-off.", "complexity": "medium", "category": "reasoning", "tools": []},
    {"id": "r4", "description": "Compare event-driven architecture vs request-response architecture. When should you use each? Give 3 examples per pattern.", "complexity": "medium", "category": "reasoning", "tools": []},
    {"id": "r5", "description": "Explain how consistent hashing works. Why is it better than modulo hashing for distributed systems? Include a concrete example with 5 nodes.", "complexity": "medium", "category": "reasoning", "tools": []},

    # Category 3: Tool-Heavy
    {"id": "t1", "description": "Search the web for the latest trends in AI agent frameworks in 2025, then analyze the top 3 by maturity, community size, and features.", "complexity": "medium", "category": "tools", "tools": ["search_web", "analyze_data"]},
    {"id": "t2", "description": "Analyze this sales data: Q1=$120K, Q2=$145K, Q3=$98K, Q4=$167K. Calculate growth rates, identify the worst quarter, and predict Q1 next year using linear regression.", "complexity": "medium", "category": "tools", "tools": ["analyze_data"]},
    {"id": "t3", "description": "Search for information about Kubernetes vs Docker Swarm, analyze the comparison data, and write a decision framework report for a startup choosing between them.", "complexity": "high", "category": "tools", "tools": ["search_web", "analyze_data", "write_report"]},
    {"id": "t4", "description": "Research the top 5 vector databases (Pinecone, Weaviate, Milvus, Qdrant, ChromaDB). For each, search for benchmarks, analyze performance data, and write a comparative report.", "complexity": "high", "category": "tools", "tools": ["search_web", "analyze_data", "write_report"]},
    {"id": "t5", "description": "Search for recent developments in WebAssembly (WASM). Analyze adoption metrics across browsers and server runtimes. Write a report with timeline and recommendations.", "complexity": "high", "category": "tools", "tools": ["search_web", "analyze_data", "write_report"]},
    {"id": "t6", "description": "Research the energy consumption of large language models. Search for data from at least 3 sources, analyze the numbers, and write a sustainability report.", "complexity": "high", "category": "tools", "tools": ["search_web", "analyze_data", "write_report"]},
    {"id": "t7", "description": "Search for the latest OWASP Top 10 vulnerabilities. For each vulnerability, search for a real-world example, analyze the attack pattern, and compile into a security brief.", "complexity": "high", "category": "tools", "tools": ["search_web", "analyze_data", "write_report"]},
    {"id": "t8", "description": "Research microservices observability best practices. Search for OpenTelemetry, Jaeger, and Grafana docs. Analyze trace-based debugging approaches. Write an implementation guide.", "complexity": "high", "category": "tools", "tools": ["search_web", "analyze_data", "write_report"]},

    # Category 4: Long-Form Generation
    {"id": "g1", "description": "Write a comprehensive technical design document for a distributed rate limiter that works across 3 data centers. Include: architecture diagram description, algorithm choices (token bucket vs sliding window), consistency model, failure handling, and API design.", "complexity": "high", "category": "generation", "tools": []},
    {"id": "g2", "description": "Compare and contrast microservices vs monolithic architectures across 8 dimensions: scalability, deployment complexity, development speed, debugging difficulty, cost, team structure requirements, data consistency, and technology lock-in. Provide a decision framework with specific thresholds.", "complexity": "high", "category": "generation", "tools": []},
    {"id": "g3", "description": "Write a complete technical RFC for adding real-time collaboration to a document editor. Cover: conflict resolution (CRDTs vs OT), network protocol, offline support, cursor presence, and undo/redo across users.", "complexity": "high", "category": "generation", "tools": []},
    {"id": "g4", "description": "Design a complete CI/CD pipeline for a monorepo with 5 services (2 Python, 2 Node.js, 1 Go). Include: build optimization, test parallelization, canary deployments, rollback strategy, and secret management.", "complexity": "high", "category": "generation", "tools": []},
    {"id": "g5", "description": "Write a comprehensive guide to database indexing strategies. Cover: B-tree, hash, GIN, GiST, BRIN indexes. For each: when to use, performance characteristics, storage overhead, and a concrete PostgreSQL example.", "complexity": "high", "category": "generation", "tools": []},
    {"id": "g6", "description": "Design an authentication and authorization system for a multi-tenant SaaS platform. Cover: OAuth 2.0 + OIDC flows, RBAC vs ABAC, token management, session handling, and audit logging. Include sequence diagrams described in text.", "complexity": "high", "category": "generation", "tools": []},

    # Category 5: Multi-Step Analysis
    {"id": "m1", "description": "Research quantum computing's impact on cryptography. Step 1: Search for current quantum capabilities. Step 2: Analyze which encryption algorithms are vulnerable. Step 3: Search for post-quantum alternatives. Step 4: Write a migration timeline report.", "complexity": "high", "category": "multi-step", "tools": ["search_web", "analyze_data", "write_report"]},
    {"id": "m2", "description": "Conduct a competitive analysis of cloud providers. Step 1: Search for AWS, Azure, GCP pricing for compute. Step 2: Search for their AI/ML service offerings. Step 3: Analyze cost differences. Step 4: Write a recommendation report for a mid-size company.", "complexity": "high", "category": "multi-step", "tools": ["search_web", "analyze_data", "write_report"]},
    {"id": "m3", "description": "Evaluate programming language trends for backend development. Step 1: Search for 2024-2025 usage statistics. Step 2: Search for performance benchmarks. Step 3: Analyze hiring market data. Step 4: Write a technology radar report.", "complexity": "high", "category": "multi-step", "tools": ["search_web", "analyze_data", "write_report"]},
    {"id": "m4", "description": "Research the state of edge computing. Step 1: Search for edge vs cloud latency benchmarks. Step 2: Search for major providers (Cloudflare, Fastly, AWS Lambda@Edge). Step 3: Analyze use cases where edge wins. Step 4: Write an architectural decision record.", "complexity": "high", "category": "multi-step", "tools": ["search_web", "analyze_data", "write_report"]},
    {"id": "m5", "description": "Analyze the impact of AI on software testing. Step 1: Search for AI testing tools. Step 2: Search for case studies of AI-assisted testing. Step 3: Analyze defect detection rates vs manual testing. Step 4: Write a transition roadmap for a QA team.", "complexity": "high", "category": "multi-step", "tools": ["search_web", "analyze_data", "write_report"]},
    {"id": "m6", "description": "Research zero-trust security architecture. Step 1: Search for NIST zero-trust framework. Step 2: Search for implementation case studies at large companies. Step 3: Analyze common failure patterns. Step 4: Write an implementation checklist for a Fortune 500 company.", "complexity": "high", "category": "multi-step", "tools": ["search_web", "analyze_data", "write_report"]},
]


@dataclass
class TaskMeasurement:
    task_id: str
    category: str
    complexity: str
    run: int
    status: str
    duration_ms: float
    tokens_total: int
    cost_usd: float
    tool_calls: int
    steps: int
    error: Optional[str] = None


def run_task(task: dict, run: int) -> TaskMeasurement:
    from crewai import Agent, Task, Crew, Process
    from crewai.tools import tool

    @tool("search_web")
    def search_web(query: str) -> str:
        """Search the web for information on a given query."""
        return json.dumps({
            "results": [
                {"title": f"Result 1: {query}", "snippet": f"Comprehensive information about {query}."},
                {"title": f"Result 2: {query}", "snippet": f"Recent data and benchmarks regarding {query}."},
                {"title": f"Result 3: {query}", "snippet": f"Expert opinions about {query}."},
            ]
        })

    @tool("analyze_data")
    def analyze_data(data: str) -> str:
        """Analyze a dataset and compute key metrics."""
        return json.dumps({
            "summary": f"Analysis of: {data[:100]}",
            "metrics": {"mean": 132.5, "trend": "positive", "confidence": 0.87},
        })

    @tool("write_report")
    def write_report(title: str) -> str:
        """Write and save a structured report."""
        return json.dumps({"saved": True, "title": title, "wordCount": 1500})

    tool_map = {"search_web": search_web, "analyze_data": analyze_data, "write_report": write_report}
    task_tools = [tool_map[t] for t in task["tools"] if t in tool_map]

    agent = Agent(
        role="General Purpose Assistant",
        goal="Complete the given task accurately and efficiently",
        backstory="You are a capable AI assistant.",
        tools=task_tools,
        verbose=False,
        allow_delegation=False,
    )

    crew_task = Task(
        description=task["description"],
        expected_output="A clear, complete response.",
        agent=agent,
    )

    crew = Crew(agents=[agent], tasks=[crew_task], process=Process.sequential, verbose=False)

    start = time.perf_counter()
    tokens_total = 0
    cost = 0.0
    tool_call_count = 0

    try:
        result = crew.kickoff()
        elapsed_ms = (time.perf_counter() - start) * 1000

        if hasattr(result, 'token_usage') and result.token_usage:
            u = result.token_usage
            tokens_total = getattr(u, 'total_tokens', 0) or (getattr(u, 'prompt_tokens', 0) + getattr(u, 'completion_tokens', 0))
            cost = getattr(u, 'total_cost', 0.0) or 0.0

        if hasattr(result, 'tasks_output') and result.tasks_output:
            for to in result.tasks_output:
                if hasattr(to, 'token_usage') and to.token_usage:
                    tu = to.token_usage
                    tokens_total += getattr(tu, 'prompt_tokens', 0) + getattr(tu, 'completion_tokens', 0)

        if cost == 0.0 and tokens_total > 0:
            cost = (tokens_total * 0.3 / 1_000_000)  # Rough estimate

        return TaskMeasurement(
            task_id=task["id"], category=task["category"], complexity=task["complexity"],
            run=run, status="completed", duration_ms=round(elapsed_ms, 1),
            tokens_total=tokens_total, cost_usd=round(cost, 6),
            tool_calls=tool_call_count, steps=1,
        )
    except Exception as e:
        return TaskMeasurement(
            task_id=task["id"], category=task["category"], complexity=task["complexity"],
            run=run, status="error", duration_ms=round((time.perf_counter() - start) * 1000, 1),
            tokens_total=0, cost_usd=0, tool_calls=0, steps=0, error=str(e)[:200],
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--category", type=str, default=None)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    if not os.environ.get("OPENAI_API_KEY"):
        print("ERROR: OPENAI_API_KEY not set.")
        sys.exit(1)

    tasks = TASKS
    if args.category:
        tasks = [t for t in TASKS if t["category"] == args.category]

    total_runs = len(tasks) * args.runs
    print(f"\n{'=' * 70}")
    print(f"  CREWAI EXTENDED BENCHMARK")
    print(f"  Tasks: {len(tasks)} | Runs/task: {args.runs} | Total: {total_runs}")
    print(f"  Categories: {', '.join(sorted(set(t['category'] for t in tasks)))}")
    print(f"{'=' * 70}\n")

    measurements = []
    count = 0

    for task in tasks:
        for run in range(1, args.runs + 1):
            count += 1
            sys.stdout.write(f"  [{count}/{total_runs}] {task['category']}/{task['id']} run {run}...")
            sys.stdout.flush()
            m = run_task(task, run)
            measurements.append(m)
            icon = "+" if m.status == "completed" else "x"
            print(f" [{icon}] {m.status} ${m.cost_usd:.4f} / {m.tokens_total} tok / {m.duration_ms:.0f}ms")

    # Aggregate
    completed = [m for m in measurements if m.status == "completed"]
    n = len(measurements)
    nc = len(completed)

    overall = {
        "total_tasks": len(tasks),
        "total_runs": n,
        "runs_per_task": args.runs,
        "completed": nc,
        "failed": n - nc,
        "success_rate": round(nc / n * 100, 1) if n > 0 else 0,
        "total_cost": round(sum(m.cost_usd for m in completed), 6),
        "avg_cost_per_task": round(sum(m.cost_usd for m in completed) / nc, 6) if nc > 0 else 0,
        "total_tokens": sum(m.tokens_total for m in completed),
        "avg_tokens_per_task": round(sum(m.tokens_total for m in completed) / nc, 1) if nc > 0 else 0,
        "avg_duration_ms": round(sum(m.duration_ms for m in completed) / nc, 1) if nc > 0 else 0,
    }

    if not args.json:
        print(f"\n{'=' * 70}")
        print(f"  CREWAI EXTENDED RESULTS")
        print(f"{'=' * 70}")
        print(f"\n  Total Runs: {overall['total_runs']}")
        print(f"  Completed: {overall['completed']} ({overall['success_rate']}%)")
        print(f"  Total Cost: ${overall['total_cost']:.4f}")
        print(f"  Avg Cost/Task: ${overall['avg_cost_per_task']:.6f}")
        print(f"  Total Tokens: {overall['total_tokens']}")
        print(f"  Avg Tokens/Task: {overall['avg_tokens_per_task']:.0f}")
        print(f"  Avg Duration: {overall['avg_duration_ms']:.0f}ms")

        # By category
        cats = sorted(set(t["category"] for t in tasks))
        print(f"\n  {'Category':<14} {'Runs':>5} {'OK%':>6} {'AvgCost':>10} {'AvgTok':>8} {'AvgMs':>8}")
        print(f"  {'─'*14} {'─'*5} {'─'*6} {'─'*10} {'─'*8} {'─'*8}")
        for cat in cats:
            cm = [m for m in completed if m.category == cat]
            am = [m for m in measurements if m.category == cat]
            sr = len(cm) / len(am) * 100 if am else 0
            ac = sum(m.cost_usd for m in cm) / len(cm) if cm else 0
            at = sum(m.tokens_total for m in cm) / len(cm) if cm else 0
            ad = sum(m.duration_ms for m in cm) / len(cm) if cm else 0
            print(f"  {cat:<14} {len(am):>5} {sr:>5.0f}% ${ac:>8.4f} {at:>8.0f} {ad:>8.0f}")

    output = {
        "framework": "crewai",
        "model": "gpt-4o-mini",
        "runs_per_task": args.runs,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "overall": overall,
        "measurements": [asdict(m) for m in measurements],
    }

    os.makedirs("paper/results", exist_ok=True)
    with open("paper/results/extended-crewai-results.json", "w") as f:
        json.dump(output, f, indent=2)
    print(f"\n  Results saved to paper/results/extended-crewai-results.json")


if __name__ == "__main__":
    main()
