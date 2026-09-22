/**
 * Dataset F fixtures: small repositories with one planted defect each.
 *
 * Dataset E asked crews to write a missing function, which gives a reviewer
 * nothing to review: the implementer either produced working code or did not.
 * These tasks start from code that already exists and already fails, so there
 * is something to diagnose — and the diagnosis needs more than one file, which
 * is the part a second agent could plausibly be better at.
 *
 * Every fixture carries the defect it plants, so "did the specialist find the
 * defect?" is checked against ground truth rather than guessed at. The
 * reference fix is used only by the self-test, never shown to an agent.
 *
 * Fixtures are deliberately small and deterministic: the experiment repeats
 * each task three times across three crew arms, so a task that takes minutes
 * or flakes would cost more than it tells us.
 */

/** What kind of mistake was planted. Grouping the results by this is the point. */
export type DefectType =
  | 'api-contract'
  | 'edge-case'
  | 'cross-module-state'
  | 'wrong-algorithm'
  | 'numeric-precision';

export interface PlantedDefect {
  type: DefectType;
  /** Files a correct fix has to touch */
  files: string[];
  /** Ground truth, for scoring what a specialist reported */
  summary: string;
  /** Words that indicate the agent actually named the cause */
  keywords: string[];
}

export interface Fixture {
  id: string;
  /** Files as the agent first sees them: working code plus one planted defect */
  files: Record<string, string>;
  /** Import lines the test file needs */
  testImports: string[];
  /**
   * Statements run once before the asserts, for scenarios that need a sequence
   * of calls. Keeping them out of `tests` means the pass count stays a count of
   * assertions rather than of setup lines.
   */
  testPrelude?: string[];
  /**
   * Assert statements. At least one passes with the defect in place, so a
   * failing suite is a signal about the defect and not about everything.
   */
  tests: string[];
  defect: PlantedDefect;
  /** Files replaced to repair the defect. Self-test only. */
  referenceFix: Record<string, string>;
}

const INIT = '';

/**
 * A consumer unpacks a producer's return value as a tuple, but the producer
 * returns a dict. The traceback points at the consumer; the contract lives in
 * the producer.
 */
const apiContract: Fixture = {
  id: 'f-api-contract',
  files: {
    'pkg/__init__.py': INIT,
    'pkg/parser.py': [
      'def parse_record(line):',
      '    """Parse "id,qty" into a record."""',
      '    parts = line.split(",")',
      '    return {"id": parts[0].strip(), "qty": int(parts[1])}',
      '',
    ].join('\n'),
    'pkg/report.py': [
      'from pkg.parser import parse_record',
      '',
      '',
      'def summarize(lines):',
      '    """Total the quantities and collect the ids, in order."""',
      '    ids = []',
      '    total = 0',
      '    for line in lines:',
      '        record = parse_record(line)',
      '        rid, qty = record',
      '        ids.append(rid)',
      '        total += int(qty)',
      '    return {"ids": ids, "total": total}',
      '',
    ].join('\n'),
  },
  testImports: ['from pkg.report import summarize'],
  tests: [
    'assert summarize([]) == {"ids": [], "total": 0}',
    'assert summarize(["a, 2"]) == {"ids": ["a"], "total": 2}',
    'assert summarize(["a, 2", "b, 3"]) == {"ids": ["a", "b"], "total": 5}',
  ],
  defect: {
    type: 'api-contract',
    files: ['pkg/report.py'],
    summary: 'summarize() unpacks parse_record()\'s dict as a tuple, so it binds the keys "id" and "qty" instead of the values.',
    keywords: ['dict', 'unpack', 'parse_record', 'tuple', 'key'],
  },
  referenceFix: {
    'pkg/report.py': [
      'from pkg.parser import parse_record',
      '',
      '',
      'def summarize(lines):',
      '    """Total the quantities and collect the ids, in order."""',
      '    ids = []',
      '    total = 0',
      '    for line in lines:',
      '        record = parse_record(line)',
      '        ids.append(record["id"])',
      '        total += int(record["qty"])',
      '    return {"ids": ids, "total": total}',
      '',
    ].join('\n'),
  },
};

/**
 * Chunking drops the final partial chunk. Exact multiples pass, so the suite
 * fails in a way that looks like a data problem rather than a loop bound.
 */
const edgeCase: Fixture = {
  id: 'f-edge-case',
  files: {
    'pkg/__init__.py': INIT,
    'pkg/batch.py': [
      'def chunk(items, size):',
      '    """Split items into consecutive chunks of at most `size`."""',
      '    if size <= 0:',
      '        raise ValueError("size must be positive")',
      '    out = []',
      '    for i in range(0, len(items) - size + 1, size):',
      '        out.append(items[i:i + size])',
      '    return out',
      '',
    ].join('\n'),
    'pkg/pipeline.py': [
      'from pkg.batch import chunk',
      '',
      '',
      'def process(items, size):',
      '    """Sum each batch of items."""',
      '    return [sum(part) for part in chunk(items, size)]',
      '',
    ].join('\n'),
  },
  testImports: ['from pkg.pipeline import process', 'from pkg.batch import chunk'],
  tests: [
    'assert process([1, 2, 3, 4], 2) == [3, 7]',
    'assert process([1, 2, 3, 4, 5], 2) == [3, 7, 5]',
    'assert chunk([1, 2, 3], 5) == [[1, 2, 3]]',
  ],
  defect: {
    type: 'edge-case',
    files: ['pkg/batch.py'],
    summary: 'chunk() stops at len(items) - size + 1, so any trailing items that do not fill a whole chunk are dropped.',
    keywords: ['range', 'partial', 'remainder', 'last chunk', 'off-by-one'],
  },
  referenceFix: {
    'pkg/batch.py': [
      'def chunk(items, size):',
      '    """Split items into consecutive chunks of at most `size`."""',
      '    if size <= 0:',
      '        raise ValueError("size must be positive")',
      '    out = []',
      '    for i in range(0, len(items), size):',
      '        out.append(items[i:i + size])',
      '    return out',
      '',
    ].join('\n'),
  },
};

/**
 * One module imports another's dict by name, so a later rebinding of that dict
 * leaves the importer reading the old object. Both files look correct alone.
 */
const crossModuleState: Fixture = {
  id: 'f-cross-module-state',
  files: {
    'pkg/__init__.py': INIT,
    'pkg/store.py': [
      '_ENTRIES = {}',
      '',
      '',
      'def put(key, value):',
      '    _ENTRIES[key] = value',
      '',
      '',
      'def get(key):',
      '    return _ENTRIES.get(key)',
      '',
      '',
      'def reset():',
      '    """Drop every entry."""',
      '    global _ENTRIES',
      '    _ENTRIES = {}',
      '',
    ].join('\n'),
    'pkg/registry.py': [
      'from pkg.store import _ENTRIES, put',
      '',
      '',
      'def register(name, handler):',
      '    put(name, handler)',
      '',
      '',
      'def names():',
      '    """Every registered name, sorted."""',
      '    return sorted(_ENTRIES)',
      '',
    ].join('\n'),
  },
  testImports: ['from pkg import store', 'from pkg.registry import register, names'],
  testPrelude: [
    'register("alpha", 1)',
    'FIRST = names()',
    'store.reset()',
    'register("beta", 2)',
    'SECOND = names()',
  ],
  tests: [
    'assert FIRST == ["alpha"]',
    'assert SECOND == ["beta"]',
    'assert store.get("beta") == 2',
  ],
  defect: {
    type: 'cross-module-state',
    files: ['pkg/registry.py'],
    summary: 'registry imports the _ENTRIES dict object itself, so store.reset() rebinds store._ENTRIES while registry keeps reading the original dict.',
    keywords: ['rebind', 'import', '_ENTRIES', 'reset', 'module'],
  },
  referenceFix: {
    'pkg/registry.py': [
      'from pkg import store',
      '',
      '',
      'def register(name, handler):',
      '    store.put(name, handler)',
      '',
      '',
      'def names():',
      '    """Every registered name, sorted."""',
      '    return sorted(store._ENTRIES)',
      '',
    ].join('\n'),
  },
};

/**
 * Interval merging that overwrites the end instead of extending it. Overlapping
 * intervals merge correctly; a nested one silently shrinks the result.
 */
const wrongAlgorithm: Fixture = {
  id: 'f-wrong-algorithm',
  files: {
    'pkg/__init__.py': INIT,
    'pkg/intervals.py': [
      'def merge(intervals):',
      '    """Merge overlapping intervals, returning them sorted."""',
      '    if not intervals:',
      '        return []',
      '    items = sorted(intervals)',
      '    out = [list(items[0])]',
      '    for start, end in items[1:]:',
      '        last = out[-1]',
      '        if start <= last[1]:',
      '            last[1] = end',
      '        else:',
      '            out.append([start, end])',
      '    return [tuple(part) for part in out]',
      '',
    ].join('\n'),
    'pkg/schedule.py': [
      'from pkg.intervals import merge',
      '',
      '',
      'def busy_time(intervals):',
      '    """Total time covered, counting overlaps once."""',
      '    return sum(end - start for start, end in merge(intervals))',
      '',
    ].join('\n'),
  },
  testImports: ['from pkg.intervals import merge', 'from pkg.schedule import busy_time'],
  tests: [
    'assert merge([(1, 3), (2, 5)]) == [(1, 5)]',
    'assert merge([(1, 10), (2, 3), (11, 12)]) == [(1, 10), (11, 12)]',
    'assert busy_time([(0, 10), (1, 2)]) == 10',
  ],
  defect: {
    type: 'wrong-algorithm',
    files: ['pkg/intervals.py'],
    summary: 'merge() assigns last[1] = end rather than max(last[1], end), so an interval nested inside the previous one truncates it.',
    keywords: ['max', 'nested', 'end', 'merge', 'shrink'],
  },
  referenceFix: {
    'pkg/intervals.py': [
      'def merge(intervals):',
      '    """Merge overlapping intervals, returning them sorted."""',
      '    if not intervals:',
      '        return []',
      '    items = sorted(intervals)',
      '    out = [list(items[0])]',
      '    for start, end in items[1:]:',
      '        last = out[-1]',
      '        if start <= last[1]:',
      '            last[1] = max(last[1], end)',
      '        else:',
      '            out.append([start, end])',
      '    return [tuple(part) for part in out]',
      '',
    ].join('\n'),
  },
};

/**
 * Money converted with int() instead of round(). Whole units are exact, so the
 * suite fails by a single cent on some inputs and not others.
 */
const numericPrecision: Fixture = {
  id: 'f-numeric-precision',
  files: {
    'pkg/__init__.py': INIT,
    'pkg/prices.py': [
      'def to_cents(amount):',
      '    """Convert an amount in units to whole cents."""',
      '    return int(amount * 100)',
      '',
    ].join('\n'),
    'pkg/invoice.py': [
      'from pkg.prices import to_cents',
      '',
      '',
      'def total(amounts):',
      '    """Invoice total, in cents."""',
      '    return sum(to_cents(amount) for amount in amounts)',
      '',
    ].join('\n'),
  },
  testImports: ['from pkg.invoice import total', 'from pkg.prices import to_cents'],
  tests: [
    'assert total([1.0, 2.0]) == 300',
    'assert to_cents(1.15) == 115',
    'assert total([1.15, 2.30]) == 345',
  ],
  defect: {
    type: 'numeric-precision',
    files: ['pkg/prices.py'],
    summary: 'to_cents() truncates with int(), and 1.15 * 100 is 114.999... in binary floating point, so some amounts lose a cent.',
    keywords: ['round', 'float', 'truncat', 'int(', 'precision'],
  },
  referenceFix: {
    'pkg/prices.py': [
      'def to_cents(amount):',
      '    """Convert an amount in units to whole cents."""',
      '    return round(amount * 100)',
      '',
    ].join('\n'),
  },
};

export const FIXTURES: Fixture[] = [
  apiContract,
  edgeCase,
  crossModuleState,
  wrongAlgorithm,
  numericPrecision,
];

export function fixtureById(id: string): Fixture | undefined {
  return FIXTURES.find(f => f.id === id);
}
