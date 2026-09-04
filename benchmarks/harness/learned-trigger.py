"""
Learned escalation trigger — offline study on logged trajectories.

Question: at a given step, can the confidence signals predict whether the
small model will still solve the task on its own? If so, "escalate when
P(success) < theta" is a trigger that can be compared with the rules.

Data: every slm-only trajectory in benchmarks/reports (no escalation ever
happens in those runs, so the run outcome is a clean label for every step).
Features per decision point: the ConfidenceEngine signals + step index +
failure count so far. Model: logistic regression, trained with plain
gradient descent (no dependencies), evaluated on held-out tasks.

Then: replay the trigger on the same trajectories to estimate escalation
precision/recall against P(SLM) labels, and compare with the rule-based
policy's actual escalations from the joule-adaptive runs.

    python benchmarks/harness/learned-trigger.py [--theta 0.5] [--labels main-a,main-b]
"""
import glob, json, math, os, random, sys

REPORTS = os.path.join(os.path.dirname(__file__), '..', 'reports')
FEATURES = ['composite', 'toolSuccess', 'verification', 'progress', 'repeatedFailure', 'contradiction', 'budgetHeadroom', 'stepFrac', 'failuresSoFar', 'verifyFailStreak']


def arg(name, default=None):
    if name in sys.argv:
        return sys.argv[sys.argv.index(name) + 1]
    return default


def load_reports(labels):
    reports = []
    for f in sorted(glob.glob(os.path.join(REPORTS, 'harness-live-*.json'))):
        base = os.path.basename(f)
        if labels and not any(f'-{l}-' in base for l in labels):
            continue
        try:
            reports.append(json.load(open(f, encoding='utf-8')))
        except Exception as e:  # noqa
            print('skip', base, e)
    return reports


def rows_from_trajectory(t, label):
    """One row per decision point; label = run outcome (1 success)."""
    rows = []
    steps = t.get('steps') or []
    decisions = t.get('decisions') or []
    n = max(1, len(decisions))
    failures = 0
    streak = 0
    for i, d in enumerate(decisions):
        c = d.get('confidence') or {}
        s = steps[i] if i < len(steps) else {}
        if s and (s.get('success') is False or s.get('verified') is False):
            failures += 1
        if s and s.get('verified') is False:
            streak += 1
        elif s:
            streak = 0
        # Absolute step index, not fraction of the trajectory: the fraction leaks the run's
        # final length (failing runs are longer), which is not known at decision time.
        x = [c.get('composite', 0.5), c.get('toolSuccess', 0.5), c.get('verification', 0.5), c.get('progress', 0.5),
             c.get('repeatedFailure', 0), c.get('contradiction', 0), c.get('budgetHeadroom', 1), min(i, 10) / 10, min(failures, 6) / 6, min(streak, 4) / 4]
        rows.append((x, label, i))
    return rows


def sigmoid(z):
    return 1 / (1 + math.exp(-max(-30, min(30, z))))


def train(rows, epochs=400, lr=0.3, l2=1e-3):
    k = len(FEATURES)
    w = [0.0] * k
    b = 0.0
    n = len(rows)
    for _ in range(epochs):
        gw = [0.0] * k
        gb = 0.0
        for x, y, _i in rows:
            p = sigmoid(sum(wi * xi for wi, xi in zip(w, x)) + b)
            e = p - y
            for j in range(k):
                gw[j] += e * x[j]
            gb += e
        for j in range(k):
            w[j] -= lr * (gw[j] / n + l2 * w[j])
        b -= lr * gb / n
    return w, b


def predict(model, x):
    w, b = model
    return sigmoid(sum(wi * xi for wi, xi in zip(w, x)) + b)


def auc(pairs):
    pos = [p for p, y in pairs if y == 1]
    neg = [p for p, y in pairs if y == 0]
    if not pos or not neg:
        return float('nan')
    wins = 0.0
    for p in pos:
        for q in neg:
            wins += 1 if p > q else 0.5 if p == q else 0
    return wins / (len(pos) * len(neg))


def main():
    theta = float(arg('--theta', 0.5))
    labels = (arg('--labels') or '').split(',') if arg('--labels') else None
    reports = load_reports(labels)
    print(f'reports: {len(reports)}')

    # Task-level labels: P(SLM) from slm-only repeats; LLM success from llm-only.
    p_slm, llm_ok = {}, {}
    traj_by_task = {}
    for r in reports:
        for t in r['tasks']:
            if t['strategy'] == 'slm-only':
                p_slm.setdefault(t['workloadId'], []).append(1 if t['success'] else 0)
                if t.get('trajectory'):
                    traj_by_task.setdefault(t['workloadId'], []).append(t)
            elif t['strategy'] == 'llm-only':
                llm_ok[t['workloadId']] = t['success']
    p_slm = {k: sum(v) / len(v) for k, v in p_slm.items()}
    tasks = sorted(traj_by_task)
    print(f'slm-only trajectories: {sum(len(v) for v in traj_by_task.values())} over {len(tasks)} tasks')

    random.seed(7)
    random.shuffle(tasks)
    cut = int(len(tasks) * 0.7)
    train_tasks, test_tasks = set(tasks[:cut]), set(tasks[cut:])

    train_rows, test_rows = [], []
    for task in tasks:
        for t in traj_by_task[task]:
            rows = rows_from_trajectory(t['trajectory'], 1 if t['success'] else 0)
            (train_rows if task in train_tasks else test_rows).extend(rows)
    print(f'rows: train {len(train_rows)}  test {len(test_rows)}')
    if not train_rows or not test_rows:
        print('not enough data'); return

    model = train(train_rows)
    print('weights:', {f: round(w, 2) for f, w in zip(FEATURES, model[0])}, 'bias', round(model[1], 2))
    pairs = [(predict(model, x), y) for x, y, _ in test_rows]
    print(f'held-out AUC (per decision point, predicting eventual SLM success): {auc(pairs):.3f}')
    # Late decision points are easy (failure is already obvious); the useful question is how
    # much the signals know early. Report AUC restricted to the first and second decision.
    for k in (0, 1):
        early = [(predict(model, x), y) for x, y, i in test_rows if i == k]
        print(f'held-out AUC at decision {k + 1} only: {auc(early):.3f}  (n={len(early)})')

    # Replay: on each held-out slm-only trajectory, escalate at the first step with P < theta.
    # Precision/recall against task labels (needed = pSlm < 0.5 and LLM ok).
    def replay(th, min_failures=0):
        esc = need = tp = wasted = 0
        first_esc_steps = []
        for task in test_tasks:
            for t in traj_by_task[task]:
                rows = rows_from_trajectory(t['trajectory'], 0)
                p = p_slm.get(task, 0.5)
                needed = p < 0.5 and llm_ok.get(task, True)
                if needed: need += 1
                # Evidence gate: like the rules, only consider escalating once something has failed.
                step = next((i for x, _y, i in rows if x[8] * 6 >= min_failures and predict(model, x) < th), None)
                if step is not None:
                    esc += 1
                    first_esc_steps.append(step)
                    if needed: tp += 1
                    if p >= 0.8: wasted += 1
        n = sum(len(traj_by_task[t]) for t in test_tasks)
        return dict(theta=th, runs=n, escalated=esc, needed=need, precision=(tp / esc if esc else float('nan')), recall=(tp / need if need else float('nan')), wasted=wasted,
                    avg_first_step=(sum(first_esc_steps) / len(first_esc_steps) if first_esc_steps else float('nan')))

    print('\nLearned trigger replayed on held-out slm-only trajectories (escalate at first step with P(success) < theta):')
    print('| theta | escalated | needed | precision | recall | wasted | avg first escalation step |')
    print('|------:|----------:|-------:|----------:|-------:|-------:|--------------------------:|')
    for th in [0.3, 0.4, 0.5, 0.6, 0.7]:
        m = replay(th)
        print(f"| {th:.1f} | {m['escalated']}/{m['runs']} | {m['needed']} | {m['precision']*100:.0f}% | {m['recall']*100:.0f}% | {m['wasted']} | {m['avg_first_step']:.1f} |")
    print('\nSame, with an evidence gate (at least one failure before the trigger may fire):')
    print('| theta | escalated | needed | precision | recall | wasted | avg first escalation step |')
    print('|------:|----------:|-------:|----------:|-------:|-------:|--------------------------:|')
    for th in [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]:
        m = replay(th, min_failures=1)
        print(f"| {th:.1f} | {m['escalated']}/{m['runs']} | {m['needed']} | {m['precision']*100:.0f}% | {m['recall']*100:.0f}% | {m['wasted']} | {m['avg_first_step']:.1f} |")

    # Rule-based policy, for reference: joule-adaptive escalations on the same held-out tasks.
    esc = need = tp = wasted = 0
    n = 0
    for r in reports:
        for t in r['tasks']:
            if t['strategy'] != 'joule-adaptive' or t['workloadId'] not in test_tasks or t.get('repeat') is not None:
                continue
            n += 1
            p = p_slm.get(t['workloadId'], 0.5)
            needed = p < 0.5 and llm_ok.get(t['workloadId'], True)
            if needed: need += 1
            if t['llmUsed']:
                esc += 1
                if needed: tp += 1
                if p >= 0.8: wasted += 1
    if n:
        print(f"\nRule-based policy on the same held-out tasks: escalated {esc}/{n}, needed {need}, precision {tp / esc * 100 if esc else float('nan'):.0f}%, recall {tp / need * 100 if need else float('nan'):.0f}%, wasted {wasted}")


if __name__ == '__main__':
    main()
