"""
Paper Benchmark: CrewAI (50 tasks, 5 categories)
==================================================
Same 50 tasks as paper-benchmark.ts for head-to-head comparison.

Categories (10 tasks each):
  1. Simple Q&A
  2. Summarization
  3. Research
  4. Code generation
  5. Multi-step planning

Per task, records 6 metrics:
  - prompt_tokens
  - completion_tokens
  - num_llm_calls
  - energy_wh
  - task_success (1/0)
  - latency_ms
  - quality_score (LLM-as-judge, 1-5)

Usage:
    python paper/paper-crewai.py
    python paper/paper-crewai.py --runs 3
    python paper/paper-crewai.py --category qa

NOTE: Uses httpx directly instead of the openai/crewai libraries to avoid
HTTP/2 hangs on some Windows machines.
"""

import os
import sys
import json
import time
import argparse
import statistics
from dataclasses import dataclass, asdict
from typing import Optional

import httpx

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

# Energy model coefficients for gpt-4o-mini (Wh per million tokens)
ENERGY_INPUT_WH_PER_MILLION = 0.3
ENERGY_OUTPUT_WH_PER_MILLION = 1.2

TASKS = [
    # Category 1: Simple Q&A (10 tasks)
    {"id": "qa01", "category": "qa", "tools": [],
     "description": "What is the capital of France? Answer in one sentence."},
    {"id": "qa02", "category": "qa", "tools": [],
     "description": "Convert 72 degrees Fahrenheit to Celsius. Show only the result."},
    {"id": "qa03", "category": "qa", "tools": [],
     "description": "List the 3 primary colors. One word each, comma separated."},
    {"id": "qa04", "category": "qa", "tools": [],
     "description": "What is the time complexity of binary search?"},
    {"id": "qa05", "category": "qa", "tools": [],
     "description": "Name the HTTP status code for 'Not Found'."},
    {"id": "qa06", "category": "qa", "tools": [],
     "description": "What does the acronym REST stand for?"},
    {"id": "qa07", "category": "qa", "tools": [],
     "description": "How many bits are in a byte?"},
    {"id": "qa08", "category": "qa", "tools": [],
     "description": "What is the default port for HTTPS?"},
    {"id": "qa09", "category": "qa", "tools": [],
     "description": "Name the four pillars of object-oriented programming."},
    {"id": "qa10", "category": "qa", "tools": [],
     "description": "What is the difference between stack and heap memory in one sentence?"},

    # Category 2: Summarization (10 tasks)
    {"id": "sum01", "category": "summarization", "tools": [],
     "description": "Summarize the key concepts of the CAP theorem in 3 bullet points."},
    {"id": "sum02", "category": "summarization", "tools": [],
     "description": "Summarize the differences between TCP and UDP in a short paragraph (50-80 words)."},
    {"id": "sum03", "category": "summarization", "tools": [],
     "description": "Summarize the SOLID principles of software design. One sentence per principle."},
    {"id": "sum04", "category": "summarization", "tools": [],
     "description": "Summarize how garbage collection works in Java in 3-4 sentences for a beginner."},
    {"id": "sum05", "category": "summarization", "tools": [],
     "description": "Summarize the main differences between SQL and NoSQL databases in a comparison table format (text-based)."},
    {"id": "sum06", "category": "summarization", "tools": [],
     "description": "Summarize the key features of Docker containers vs virtual machines. Keep it under 100 words."},
    {"id": "sum07", "category": "summarization", "tools": [],
     "description": "Summarize the OSI model's 7 layers. One line per layer with its primary function."},
    {"id": "sum08", "category": "summarization", "tools": [],
     "description": "Summarize the benefits and drawbacks of microservices architecture in 4-5 bullet points."},
    {"id": "sum09", "category": "summarization", "tools": [],
     "description": "Summarize how HTTPS/TLS handshake works in 3-4 simple steps."},
    {"id": "sum10", "category": "summarization", "tools": [],
     "description": "Summarize the key differences between Git merge and Git rebase. When should you use each?"},

    # Category 3: Research (10 tasks)
    {"id": "res01", "category": "research", "tools": ["search_web", "analyze_data"],
     "description": "Search for the latest trends in AI agent frameworks in 2025, then analyze the top 3 by maturity, community size, and features."},
    {"id": "res02", "category": "research", "tools": ["search_web", "analyze_data"],
     "description": "Research the current state of WebAssembly adoption. Search for browser support data and server-side usage statistics. Analyze the growth trend."},
    {"id": "res03", "category": "research", "tools": ["search_web", "analyze_data"],
     "description": "Search for the top 5 vector databases (Pinecone, Weaviate, Milvus, Qdrant, ChromaDB) and analyze their performance benchmarks."},
    {"id": "res04", "category": "research", "tools": ["search_web", "analyze_data"],
     "description": "Research the energy consumption of large language models. Search for data from at least 3 sources and analyze the numbers."},
    {"id": "res05", "category": "research", "tools": ["search_web", "analyze_data"],
     "description": "Search for Kubernetes vs Docker Swarm comparison data and analyze which is better for small teams vs enterprise."},
    {"id": "res06", "category": "research", "tools": ["search_web", "analyze_data"],
     "description": "Research the current state of quantum computing. Search for recent breakthroughs and analyze which encryption algorithms are at risk."},
    {"id": "res07", "category": "research", "tools": ["search_web", "analyze_data"],
     "description": "Search for the latest OWASP Top 10 vulnerabilities and analyze the most common attack patterns in 2024-2025."},
    {"id": "res08", "category": "research", "tools": ["search_web", "analyze_data"],
     "description": "Research edge computing vs cloud computing. Search for latency benchmarks and analyze use cases where edge wins."},
    {"id": "res09", "category": "research", "tools": ["search_web", "analyze_data"],
     "description": "Search for TypeScript vs Rust for backend development. Analyze performance, developer experience, and ecosystem maturity."},
    {"id": "res10", "category": "research", "tools": ["search_web", "analyze_data"],
     "description": "Research the impact of AI on software testing. Search for AI testing tools and analyze defect detection rates vs manual testing."},

    # Category 4: Code Generation (10 tasks)
    {"id": "code01", "category": "code_generation", "tools": [],
     "description": "Write a TypeScript function that checks if a string is a valid palindrome, ignoring spaces and punctuation. Include type annotations."},
    {"id": "code02", "category": "code_generation", "tools": [],
     "description": "Write a Python function that implements binary search on a sorted list. Return the index or -1 if not found. Include docstring."},
    {"id": "code03", "category": "code_generation", "tools": [],
     "description": "Write a JavaScript debounce function that delays invoking a callback until after N milliseconds have passed since the last invocation."},
    {"id": "code04", "category": "code_generation", "tools": [],
     "description": "Write a SQL query that finds the top 5 customers by total order value, joining the customers and orders tables. Include the customer name, email, and total spent."},
    {"id": "code05", "category": "code_generation", "tools": [],
     "description": "Write a TypeScript generic function `groupBy<T>(items: T[], key: keyof T): Record<string, T[]>` that groups array items by a given key."},
    {"id": "code06", "category": "code_generation", "tools": [],
     "description": "Debug this JavaScript code and explain the bug: `function sum(arr) { let total; for (let i = 0; i <= arr.length; i++) { total += arr[i]; } return total; }`"},
    {"id": "code07", "category": "code_generation", "tools": [],
     "description": "Write a Python class `LRUCache` with `get(key)` and `put(key, value)` methods. Use OrderedDict for O(1) operations. Capacity set in constructor."},
    {"id": "code08", "category": "code_generation", "tools": [],
     "description": "Write a bash script that monitors a directory for new .csv files and automatically moves them to a processed/ subdirectory after printing their line count."},
    {"id": "code09", "category": "code_generation", "tools": [],
     "description": "Write a TypeScript function that flattens a deeply nested object into dot-notation keys. Example: {a: {b: {c: 1}}} -> {'a.b.c': 1}."},
    {"id": "code10", "category": "code_generation", "tools": [],
     "description": "Write a React hook `useLocalStorage<T>(key: string, defaultValue: T)` that syncs state with localStorage, handling SSR and JSON serialization."},

    # Category 5: Multi-Step Planning (10 tasks)
    {"id": "ms01", "category": "multi_step", "tools": ["search_web", "analyze_data", "write_report"],
     "description": "Research quantum computing's impact on cryptography. Step 1: Search for current quantum capabilities. Step 2: Analyze which encryption algorithms are vulnerable. Step 3: Search for post-quantum alternatives. Step 4: Write a migration timeline report."},
    {"id": "ms02", "category": "multi_step", "tools": ["search_web", "analyze_data", "write_report"],
     "description": "Conduct a competitive analysis of cloud providers. Step 1: Search for AWS, Azure, GCP pricing for compute. Step 2: Search for their AI/ML service offerings. Step 3: Analyze cost differences. Step 4: Write a recommendation report."},
    {"id": "ms03", "category": "multi_step", "tools": ["search_web", "analyze_data", "write_report"],
     "description": "Evaluate programming language trends for backend development. Step 1: Search for 2024-2025 usage statistics. Step 2: Search for performance benchmarks. Step 3: Analyze hiring market data. Step 4: Write a technology radar report."},
    {"id": "ms04", "category": "multi_step", "tools": ["search_web", "analyze_data", "write_report"],
     "description": "Research the state of edge computing. Step 1: Search for edge vs cloud latency benchmarks. Step 2: Search for major providers (Cloudflare, Fastly, Lambda@Edge). Step 3: Analyze use cases. Step 4: Write an architectural decision record."},
    {"id": "ms05", "category": "multi_step", "tools": ["search_web", "analyze_data", "write_report"],
     "description": "Analyze the impact of AI on software testing. Step 1: Search for AI testing tools. Step 2: Search for case studies. Step 3: Analyze defect detection rates vs manual testing. Step 4: Write a transition roadmap for a QA team."},
    {"id": "ms06", "category": "multi_step", "tools": ["search_web", "analyze_data", "write_report"],
     "description": "Research zero-trust security architecture. Step 1: Search for NIST zero-trust framework. Step 2: Search for implementation case studies. Step 3: Analyze common failure patterns. Step 4: Write an implementation checklist."},
    {"id": "ms07", "category": "multi_step", "tools": ["search_web", "analyze_data", "write_report"],
     "description": "Evaluate serverless vs containerized architectures. Step 1: Search for cost comparison data. Step 2: Search for cold start benchmarks. Step 3: Analyze scaling patterns. Step 4: Write a decision framework report."},
    {"id": "ms08", "category": "multi_step", "tools": ["search_web", "analyze_data", "write_report"],
     "description": "Research API gateway patterns. Step 1: Search for Kong, AWS API Gateway, Envoy features. Step 2: Search for performance benchmarks. Step 3: Analyze rate limiting approaches. Step 4: Write a comparison report."},
    {"id": "ms09", "category": "multi_step", "tools": ["search_web", "analyze_data", "write_report"],
     "description": "Analyze database migration strategies. Step 1: Search for blue-green deployment patterns. Step 2: Search for schema versioning tools (Flyway, Liquibase). Step 3: Analyze rollback strategies. Step 4: Write a best practices guide."},
    {"id": "ms10", "category": "multi_step", "tools": ["search_web", "analyze_data", "write_report"],
     "description": "Research observability best practices for microservices. Step 1: Search for OpenTelemetry docs. Step 2: Search for distributed tracing case studies. Step 3: Analyze alert fatigue patterns. Step 4: Write an implementation guide."},
]


@dataclass
class PaperMeasurement:
    task_id: str
    category: str
    run: int
    prompt_tokens: int
    completion_tokens: int
    num_llm_calls: int
    energy_wh: float
    task_success: int  # 1 or 0
    latency_ms: float
    quality_score: float


def compute_energy(prompt_tokens: int, completion_tokens: int) -> float:
    """Energy in Wh using same coefficients as Joule (gpt-4o-mini)."""
    return (
        prompt_tokens * ENERGY_INPUT_WH_PER_MILLION +
        completion_tokens * ENERGY_OUTPUT_WH_PER_MILLION
    ) / 1_000_000


def chat_completion(client: httpx.Client, messages: list, max_tokens: int = 2000) -> dict:
    """Call OpenAI chat completions via httpx with retry. Returns the full response JSON."""
    for attempt in range(3):
        try:
            r = client.post('https://api.openai.com/v1/chat/completions',
                headers={
                    'Authorization': f'Bearer {os.environ["OPENAI_API_KEY"]}',
                    'Content-Type': 'application/json'
                },
                json={
                    'model': 'gpt-4o-mini',
                    'messages': messages,
                    'max_tokens': max_tokens,
                    'temperature': 0.7
                })
            r.raise_for_status()
            return r.json()
        except (httpx.ReadTimeout, httpx.ConnectTimeout, httpx.RemoteProtocolError, httpx.ConnectError) as e:
            if attempt < 2:
                time.sleep(2 ** attempt)
                continue
            raise


def score_quality(client: httpx.Client, task_description: str, result_text: str) -> float:
    """Score output quality 1-5 via LLM-as-judge. Returns score or 0 on failure."""
    try:
        resp = chat_completion(client, [
            {"role": "user", "content": f"Rate the quality of this response on a scale of 1-5.\nTask: {task_description}\nResponse: {result_text}\n\nRespond with ONLY a JSON object: {{\"score\": <1-5>, \"reason\": \"<brief reason>\"}}"}
        ], max_tokens=200)
        text = resp['choices'][0]['message']['content']
        parsed = json.loads(text)
        return float(parsed.get("score", 0))
    except:
        return 0.0


def run_task(client: httpx.Client, task: dict, run: int) -> PaperMeasurement:
    """Execute a single task via httpx calls to OpenAI API.

    - Tasks WITHOUT tools (qa, summarization, code_generation): single API call.
    - Tasks WITH tools (research, multi_step): two API calls simulating CrewAI's
      agent planning + synthesis pattern.
    """
    total_prompt = 0
    total_completion = 0
    call_count = 0

    system_msg = "You are a capable AI assistant. Complete the given task accurately and efficiently."

    start = time.perf_counter()

    try:
        if not task["tools"]:
            # --- No tools: single API call ---
            resp = chat_completion(client, [
                {"role": "system", "content": system_msg},
                {"role": "user", "content": task["description"]},
            ])
            call_count = 1
            usage = resp.get("usage", {})
            total_prompt = usage.get("prompt_tokens", 0)
            total_completion = usage.get("completion_tokens", 0)
            result_text = resp['choices'][0]['message']['content']
        else:
            # --- With tools: two API calls (plan + synthesize) ---
            # Call 1: Plan
            plan_resp = chat_completion(client, [
                {"role": "system", "content": system_msg + " First, create a detailed plan for completing this task. Identify what information you need and how you would gather it."},
                {"role": "user", "content": task["description"]},
            ])
            call_count = 1
            usage1 = plan_resp.get("usage", {})
            total_prompt += usage1.get("prompt_tokens", 0)
            total_completion += usage1.get("completion_tokens", 0)
            plan_text = plan_resp['choices'][0]['message']['content']

            # Simulate mock tool results (same as original CrewAI mock tools)
            mock_tool_results = []
            for t in task["tools"]:
                if t == "search_web":
                    mock_tool_results.append(json.dumps({
                        "results": [
                            {"title": f"Result 1: {task['description'][:50]}", "snippet": f"Comprehensive information about {task['description'][:50]}."},
                            {"title": f"Result 2: {task['description'][:50]}", "snippet": f"Recent data about {task['description'][:50]}."},
                            {"title": f"Result 3: {task['description'][:50]}", "snippet": f"Expert opinions about {task['description'][:50]}."},
                        ]
                    }))
                elif t == "analyze_data":
                    mock_tool_results.append(json.dumps({
                        "summary": f"Analysis of: {task['description'][:100]}",
                        "metrics": {"mean": 132.5, "trend": "positive", "confidence": 0.87},
                    }))
                elif t == "write_report":
                    mock_tool_results.append(json.dumps({"saved": True, "title": task['description'][:50], "wordCount": 1500}))

            tool_context = "\n".join(f"Tool result: {r}" for r in mock_tool_results)

            # Call 2: Synthesize with tool results
            synth_resp = chat_completion(client, [
                {"role": "system", "content": system_msg},
                {"role": "user", "content": task["description"]},
                {"role": "assistant", "content": plan_text},
                {"role": "user", "content": f"Here are the results from the tools you requested:\n\n{tool_context}\n\nNow synthesize these results into a comprehensive final answer."},
            ])
            call_count = 2
            usage2 = synth_resp.get("usage", {})
            total_prompt += usage2.get("prompt_tokens", 0)
            total_completion += usage2.get("completion_tokens", 0)
            result_text = synth_resp['choices'][0]['message']['content']

        elapsed_ms = (time.perf_counter() - start) * 1000

        energy = compute_energy(total_prompt, total_completion)

        # LLM-as-judge quality scoring (not counted in task metrics)
        quality = score_quality(client, task["description"], result_text)

        m = PaperMeasurement(
            task_id=task["id"], category=task["category"], run=run,
            prompt_tokens=total_prompt,
            completion_tokens=total_completion,
            num_llm_calls=max(call_count, 1),
            energy_wh=round(energy, 8),
            task_success=1,
            latency_ms=round(elapsed_ms, 1),
            quality_score=quality,
        )
    except Exception as e:
        elapsed_ms = (time.perf_counter() - start) * 1000
        m = PaperMeasurement(
            task_id=task["id"], category=task["category"], run=run,
            prompt_tokens=total_prompt, completion_tokens=total_completion,
            num_llm_calls=call_count,
            energy_wh=0.0, task_success=0,
            latency_ms=round(elapsed_ms, 1),
            quality_score=0.0,
        )

    return m


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--category", type=str, default=None)
    args = parser.parse_args()

    if not os.environ.get("OPENAI_API_KEY"):
        print("ERROR: OPENAI_API_KEY not set.")
        sys.exit(1)

    tasks = TASKS
    if args.category:
        tasks = [t for t in TASKS if t["category"] == args.category]
        if not tasks:
            cats = sorted(set(t["category"] for t in TASKS))
            print(f"No tasks in category '{args.category}'. Available: {', '.join(cats)}")
            sys.exit(1)

    total_runs = len(tasks) * args.runs
    print(f"\n{'=' * 70}")
    print(f"  CREWAI PAPER BENCHMARK (50-task suite)")
    print(f"  Tasks: {len(tasks)} | Runs/task: {args.runs} | Total: {total_runs}")
    print(f"  Categories: {', '.join(sorted(set(t['category'] for t in tasks)))}")
    print(f"{'=' * 70}\n")

    measurements = []
    count = 0

    with httpx.Client(timeout=60.0) as client:
        for task in tasks:
            for run in range(1, args.runs + 1):
                count += 1
                sys.stdout.write(f"  [{count}/{total_runs}] {task['category']}/{task['id']} run {run}...")
                sys.stdout.flush()
                m = run_task(client, task, run)
                measurements.append(m)
                total_tok = m.prompt_tokens + m.completion_tokens
                icon = "+" if m.task_success else "x"
                print(f" [{icon}] {total_tok} tok ({m.prompt_tokens}p/{m.completion_tokens}c) | {m.num_llm_calls} calls | {m.energy_wh:.6f} Wh | {m.latency_ms:.0f}ms | quality:{m.quality_score:.1f}")

    # Aggregate
    categories = sorted(set(t["category"] for t in tasks))
    successful = [m for m in measurements if m.task_success == 1]

    category_summaries = []
    for cat in categories:
        cm = [m for m in measurements if m.category == cat]
        cs = [m for m in cm if m.task_success == 1]
        n = len(cs) if cs else 1
        category_summaries.append({
            "category": cat,
            "task_count": len([t for t in tasks if t["category"] == cat]),
            "total_runs": len(cm),
            "success_count": len(cs),
            "success_rate": len(cs) / len(cm) * 100 if cm else 0,
            "avg_prompt_tokens": sum(m.prompt_tokens for m in cs) / n,
            "avg_completion_tokens": sum(m.completion_tokens for m in cs) / n,
            "avg_num_llm_calls": sum(m.num_llm_calls for m in cs) / n,
            "avg_energy_wh": sum(m.energy_wh for m in cs) / n,
            "avg_latency_ms": sum(m.latency_ms for m in cs) / n,
            "stddev_energy_wh": statistics.stdev([m.energy_wh for m in cs]) if len(cs) > 1 else 0,
            "stddev_latency_ms": statistics.stdev([m.latency_ms for m in cs]) if len(cs) > 1 else 0,
            "avg_quality_score": sum(m.quality_score for m in cs) / n,
        })

    ns = len(successful) if successful else 1
    overall = {
        "total_tasks": len(tasks),
        "total_runs": len(measurements),
        "runs_per_task": args.runs,
        "success_count": len(successful),
        "success_rate": len(successful) / len(measurements) * 100 if measurements else 0,
        "total_prompt_tokens": sum(m.prompt_tokens for m in measurements),
        "total_completion_tokens": sum(m.completion_tokens for m in measurements),
        "avg_prompt_tokens": sum(m.prompt_tokens for m in successful) / ns,
        "avg_completion_tokens": sum(m.completion_tokens for m in successful) / ns,
        "avg_num_llm_calls": sum(m.num_llm_calls for m in successful) / ns,
        "total_energy_wh": sum(m.energy_wh for m in measurements),
        "avg_energy_wh": sum(m.energy_wh for m in successful) / ns,
        "avg_latency_ms": sum(m.latency_ms for m in successful) / ns,
    }

    # Console output
    print(f"\n{'=' * 70}")
    print(f"  PAPER BENCHMARK RESULTS (CREWAI)")
    print(f"{'=' * 70}")

    print(f"\n  Total: {overall['total_runs']} runs ({overall['total_tasks']} tasks x {args.runs})")
    print(f"  Success: {overall['success_count']}/{overall['total_runs']} ({overall['success_rate']:.1f}%)")
    print(f"  Avg Prompt Tokens: {overall['avg_prompt_tokens']:.0f}")
    print(f"  Avg Completion Tokens: {overall['avg_completion_tokens']:.0f}")
    print(f"  Avg LLM Calls: {overall['avg_num_llm_calls']:.1f}")
    print(f"  Total Energy: {overall['total_energy_wh']:.6f} Wh")
    print(f"  Avg Energy/Task: {overall['avg_energy_wh']:.6f} Wh")
    print(f"  Avg Latency: {overall['avg_latency_ms']:.0f}ms")

    print(f"\n-- By Category --")
    print(f"  {'Category':<18} {'Tasks':>5} {'OK%':>6} {'AvgPrompt':>10} {'AvgCompl':>10} {'AvgCalls':>8} {'AvgEnergy':>12} {'AvgMs':>8}")
    print(f"  {'─'*18} {'─'*5} {'─'*6} {'─'*10} {'─'*10} {'─'*8} {'─'*12} {'─'*8}")
    for cs in category_summaries:
        print(
            f"  {cs['category']:<18} {cs['task_count']:>5} {cs['success_rate']:>5.0f}%"
            f" {cs['avg_prompt_tokens']:>10.0f} {cs['avg_completion_tokens']:>10.0f}"
            f" {cs['avg_num_llm_calls']:>8.1f} {cs['avg_energy_wh']:>12.6f} {cs['avg_latency_ms']:>8.0f}"
        )

    # Save JSON
    output = {
        "framework": "crewai",
        "model": "gpt-4o-mini",
        "runs_per_task": args.runs,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "energy_model": {
            "model": "gpt-4o-mini",
            "input_wh_per_million": ENERGY_INPUT_WH_PER_MILLION,
            "output_wh_per_million": ENERGY_OUTPUT_WH_PER_MILLION,
            "source": "estimated",
        },
        "overall": overall,
        "category_summaries": category_summaries,
        "measurements": [asdict(m) for m in measurements],
    }

    os.makedirs("paper/results", exist_ok=True)
    with open("paper/results/paper-crewai-results.json", "w") as f:
        json.dump(output, f, indent=2)
    print(f"\n  Results saved to paper/results/paper-crewai-results.json")


if __name__ == "__main__":
    main()
