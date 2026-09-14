"""
Merge harness reports and summarise them the way the README tables need:
per-strategy success, cost, cost ratio vs llm-only, escalation precision /
recall against counterfactual labels, and mean +/- sd across seeds.

"handoff kept" is success on handed-off tasks divided by llm-only's success on
the same tasks: how much of the top model's accuracy survives the switch.
"cached input" is the share of Joule's input tokens served from provider
prompt caches (reports written before that was recorded show n/a).

    python benchmarks/harness/report.py --labels abl            # one run
    python benchmarks/harness/report.py --labels ladder-v2,ladder-s2,ladder-s3 --seeds
    python benchmarks/harness/report.py --labels abl --workload mbpp --json out.json

Labels select report files benchmarks/reports/harness-live-<workload>-<label>-*.json
(newest per label). Counterfactual labels (pSlm from every slm-only run and
llm-only success) are pooled across all selected reports, so a seed run that
only contains Joule strategies borrows its labels from the run that has them.
"""
import glob, json, math, os, sys
from collections import defaultdict

REPORTS = os.path.join(os.path.dirname(__file__), '..', 'reports')


def arg(name, default=None):
    if name in sys.argv:
        return sys.argv[sys.argv.index(name) + 1]
    return default


def load(labels, workload):
    out = []
    for label in labels:
        # The timestamp follows the label directly, so 'lineup2' does not also match 'lineup2-s2'.
        files = sorted(glob.glob(os.path.join(REPORTS, f'harness-live-{workload}-{label}-20[0-9][0-9]-*.json')))
        if not files:
            print(f'no report for label {label}', file=sys.stderr)
            continue
        with open(files[-1], encoding='utf-8') as f:
            r = json.load(f)
        r['_label'] = label
        r['_file'] = os.path.basename(files[-1])
        out.append(r)
    return out


def mean_sd(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None, None
    m = sum(xs) / len(xs)
    sd = math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1)) if len(xs) > 1 else 0.0
    return m, sd


def summarise(reports, per_seed=False):
    tasks = [t for r in reports for t in r['tasks']]
    # Labels pooled across reports.
    slm_runs = defaultdict(list)
    llm = {}
    for t in tasks:
        if t['strategy'] == 'slm-only':
            slm_runs[t['workloadId']].append(1 if t['success'] else 0)
        elif t['strategy'] == 'llm-only':
            llm[t['workloadId']] = t
    p_slm = {k: sum(v) / len(v) for k, v in slm_runs.items()}

    def one(runs):
        """Metrics for one strategy's runs (one run per task)."""
        n = len(runs)
        ok = sum(1 for t in runs if t['success'])
        cost = sum(t['cost'] for t in runs)
        llm_cost = sum(llm[t['workloadId']]['cost'] for t in runs if t['workloadId'] in llm)
        escalated = needed = tp = wasted = 0
        consulted = consult_ok = handed = hand_ok = hand_top = 0
        for t in runs:
            p = p_slm.get(t['workloadId'])
            l = llm.get(t['workloadId'])
            if p is None or l is None:
                continue
            was_needed = p < 0.5 and l['success']
            needed += was_needed
            if t['llmUsed']:
                escalated += 1
                tp += was_needed
                wasted += p >= 0.8
            if t['consultations'] > 0:
                consulted += 1
                consult_ok += t['success'] and t['handoffs'] == 0
            if t['handoffs'] > 0:
                handed += 1
                hand_ok += t['success']
                hand_top += l['success']
        rate = lambda a, b: a / b if b else None
        prompt = sum(t.get('promptTokens') or 0 for t in runs)
        cached = sum(t.get('cachedPromptTokens') or 0 for t in runs)
        baseline = runs and runs[0]['strategy'] in ('slm-only', 'llm-only', 'mid-only')
        if baseline:
            escalated = needed = tp = wasted = 0
        return {
            'tasks': n, 'success': ok / n if n else None, 'avgCost': cost / n if n else None,
            'costRatio': cost / llm_cost if llm_cost else None, 'llmUsed': sum(1 for t in runs if t['llmUsed']) / n if n else None,
            'precision': None if baseline else rate(tp, escalated), 'recall': None if baseline else rate(tp, needed), 'wasted': None if baseline else wasted, 'escalated': escalated, 'needed': needed,
            'consultOk': rate(consult_ok, consulted), 'handoffOk': rate(hand_ok, handed), 'consults': consulted, 'handoffs': handed,
            'handoffKept': rate(hand_ok, hand_top), 'cachedShare': rate(cached, prompt),
        }

    strategies = sorted({t['strategy'] for t in tasks}, key=lambda s: (s not in ('slm-only', 'llm-only', 'mid-only'), s))
    out = {}
    for s in strategies:
        if per_seed:
            seeds = [[t for t in r['tasks'] if t['strategy'] == s and (s == 'slm-only' or t.get('repeat') is None)] for r in reports]
            seeds = [runs for runs in seeds if runs]
            metrics = [one(runs) for runs in seeds]
            if not metrics:
                continue
            merged = {}
            for k in metrics[0]:
                m, sd = mean_sd([mm[k] for mm in metrics])
                merged[k] = m
                merged[k + 'Sd'] = sd
            merged['seeds'] = len(metrics)
            out[s] = merged
        else:
            runs = [t for t in tasks if t['strategy'] == s and t.get('repeat') is None]
            if s == 'slm-only':
                runs = [t for t in tasks if t['strategy'] == s]
            out[s] = one(runs)
    return out, len(p_slm), len(llm)


def fmt(v, kind='pct', sd=None):
    if v is None:
        return 'n/a'
    if kind == 'pct':
        s = f'{v * 100:.0f}%'
        if sd is not None and sd > 0:
            s += f' ±{sd * 100:.1f}'
        return s
    if kind == 'usd':
        return f'${v:.4f}'
    if kind == 'ratio':
        s = f'{v:.2f}'
        if sd is not None and sd > 0:
            s += f' ±{sd:.2f}'
        return s
    return str(v)


def main():
    labels = (arg('--labels') or '').split(',')
    workload = arg('--workload', 'mbpp')
    per_seed = '--seeds' in sys.argv
    reports = load([l for l in labels if l], workload)
    if not reports:
        sys.exit('no reports')
    summary, n_labels, n_llm = summarise(reports, per_seed)
    print(f'reports: {", ".join(r["_file"] for r in reports)}')
    print(f'labels: pSlm for {n_labels} tasks, llm-only for {n_llm} tasks' + (f'; per-seed mean ± sd over {max(v.get("seeds", 1) for v in summary.values())} seeds' if per_seed else ''))
    print('| strategy | tasks | success | avg cost | cost / llm-only | LLM used | precision | recall | wasted | consult ok | handoff ok | handoff kept | cached input |')
    print('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
    for s, m in summary.items():
        sd = (lambda k: m.get(k + 'Sd')) if per_seed else (lambda k: None)
        print(f"| {s} | {int(m['tasks'])} | {fmt(m['success'], 'pct', sd('success'))} | {fmt(m['avgCost'], 'usd')} | {fmt(m['costRatio'], 'ratio', sd('costRatio'))} | {fmt(m['llmUsed'])} | {fmt(m['precision'], 'pct', sd('precision'))} | {fmt(m['recall'], 'pct', sd('recall'))} | {m['wasted'] if m['wasted'] is None else round(m['wasted'], 1)} | {fmt(m['consultOk'])} | {fmt(m['handoffOk'])} | {fmt(m['handoffKept'])} | {fmt(m['cachedShare'])} |")
    out = arg('--json')
    if out:
        with open(out, 'w', encoding='utf-8') as f:
            json.dump(summary, f, indent=2)


if __name__ == '__main__':
    main()
