/**
 * Replication fixtures: ten fresh repositories, one per defect class.
 *
 * None of these are the five that motivated staged recovery. Dataset F chose
 * the policy; this set exists to find out whether the policy survives contact
 * with repositories it was not designed against, so nothing here is reused.
 *
 * Each defect needs the same shape of work: read the source, run the suite,
 * read the failure, change the right file, run it again. None is a syntax
 * error, and no task text names the cause.
 */

import type { Fixture } from '../specialist-value/fixtures.js';

const INIT = '';

/** A consumer iterates a mapping as if it were the records that built it. */
const apiContract: Fixture = {
  id: 'r-api-contract',
  files: {
    'pkg/__init__.py': INIT,
    'pkg/index.py': [
      'def build_index(records):',
      '    """Map each record\'s id to the record itself."""',
      '    return {record["id"]: record for record in records}',
      '',
    ].join('\n'),
    'pkg/lookup.py': [
      'from pkg.index import build_index',
      '',
      '',
      'def ids_in(records):',
      '    """Every id present, sorted."""',
      '    index = build_index(records)',
      '    return sorted(record["id"] for record in index)',
      '',
    ].join('\n'),
  },
  testImports: ['from pkg.lookup import ids_in', 'from pkg.index import build_index'],
  tests: [
    'assert ids_in([]) == []',
    'assert build_index([{"id": "a"}])["a"] == {"id": "a"}',
    'assert ids_in([{"id": "b"}, {"id": "a"}]) == ["a", "b"]',
  ],
  defect: {
    type: 'api-contract',
    files: ['pkg/lookup.py'],
    summary: 'ids_in iterates build_index\'s mapping, which yields id strings, and then subscripts each one as if it were a record.',
    keywords: ['key', 'dict', 'iterat', 'values()', 'string'],
  },
  referenceFix: {
    'pkg/lookup.py': [
      'from pkg.index import build_index',
      '',
      '',
      'def ids_in(records):',
      '    """Every id present, sorted."""',
      '    index = build_index(records)',
      '    return sorted(index)',
      '',
    ].join('\n'),
  },
};

/** A module copies shared configuration at import time and never sees updates. */
const crossFileState: Fixture = {
  id: 'r-cross-file-state',
  files: {
    'pkg/__init__.py': INIT,
    'pkg/settings.py': [
      'DEFAULTS = {"retries": 1}',
      '',
      '',
      'def configure(**kwargs):',
      '    """Change settings for the rest of the process."""',
      '    DEFAULTS.update(kwargs)',
      '',
      '',
      'def get(name):',
      '    return DEFAULTS.get(name)',
      '',
    ].join('\n'),
    'pkg/client.py': [
      'from pkg.settings import DEFAULTS',
      '',
      '_SETTINGS = dict(DEFAULTS)',
      '',
      '',
      'def retries():',
      '    """How many times the client should retry."""',
      '    return _SETTINGS.get("retries")',
      '',
    ].join('\n'),
  },
  testImports: ['from pkg import settings', 'from pkg.client import retries'],
  testPrelude: [
    'BEFORE = retries()',
    'settings.configure(retries=5)',
    'AFTER = retries()',
  ],
  tests: [
    'assert BEFORE == 1',
    'assert settings.get("retries") == 5',
    'assert AFTER == 5',
  ],
  defect: {
    type: 'cross-file-state',
    files: ['pkg/client.py'],
    summary: 'client copies DEFAULTS into _SETTINGS when it is imported, so later configure() calls never reach it.',
    keywords: ['copy', 'import', 'snapshot', 'dict(', '_SETTINGS'],
  },
  referenceFix: {
    'pkg/client.py': [
      'from pkg import settings',
      '',
      '',
      'def retries():',
      '    """How many times the client should retry."""',
      '    return settings.get("retries")',
      '',
    ].join('\n'),
  },
};

/** Normalization divides by a total that can legitimately be zero. */
const edgeCase: Fixture = {
  id: 'r-edge-case',
  files: {
    'pkg/__init__.py': INIT,
    'pkg/weights.py': [
      'def normalize(values):',
      '    """Scale values so they sum to 1. Values that are all zero stay as they are."""',
      '    total = sum(values)',
      '    return [value / total for value in values]',
      '',
    ].join('\n'),
    'pkg/report.py': [
      'from pkg.weights import normalize',
      '',
      '',
      'def share(values, position):',
      '    """The normalized share held at `position`."""',
      '    return normalize(values)[position]',
      '',
    ].join('\n'),
  },
  testImports: ['from pkg.weights import normalize', 'from pkg.report import share'],
  tests: [
    'assert normalize([1, 1]) == [0.5, 0.5]',
    'assert normalize([]) == []',
    'assert share([1, 3], 1) == 0.75',
    'assert normalize([0, 0]) == [0, 0]',
  ],
  defect: {
    type: 'edge-case',
    files: ['pkg/weights.py'],
    summary: 'normalize divides by the sum without handling a total of zero, so all-zero input raises ZeroDivisionError.',
    keywords: ['zero', 'total', 'divis', 'sum', 'guard'],
  },
  referenceFix: {
    'pkg/weights.py': [
      'def normalize(values):',
      '    """Scale values so they sum to 1. Values that are all zero stay as they are."""',
      '    total = sum(values)',
      '    if total == 0:',
      '        return list(values)',
      '    return [value / total for value in values]',
      '',
    ].join('\n'),
  },
};

/** A binary search returns the first equal position where the last is specified. */
const wrongAlgorithm: Fixture = {
  id: 'r-wrong-algorithm',
  files: {
    'pkg/__init__.py': INIT,
    'pkg/search.py': [
      'def insert_position(sorted_items, value):',
      '    """Index at which to insert `value` so the list stays sorted, placing it',
      '    after any items equal to it."""',
      '    low, high = 0, len(sorted_items)',
      '    while low < high:',
      '        mid = (low + high) // 2',
      '        if sorted_items[mid] < value:',
      '            low = mid + 1',
      '        else:',
      '            high = mid',
      '    return low',
      '',
    ].join('\n'),
    'pkg/timeline.py': [
      'from pkg.search import insert_position',
      '',
      '',
      'def add(events, event):',
      '    """Insert an event, keeping the timeline sorted and stable."""',
      '    out = list(events)',
      '    out.insert(insert_position(out, event), event)',
      '    return out',
      '',
    ].join('\n'),
  },
  testImports: ['from pkg.search import insert_position', 'from pkg.timeline import add'],
  tests: [
    'assert insert_position([1, 3, 5], 4) == 2',
    'assert insert_position([], 1) == 0',
    'assert insert_position([1, 2, 2, 3], 2) == 3',
    'assert add([1, 2, 2], 2) == [1, 2, 2, 2]',
  ],
  defect: {
    type: 'wrong-algorithm',
    files: ['pkg/search.py'],
    summary: 'insert_position compares with < and so returns the first equal position, while the contract asks for the position after equal items.',
    keywords: ['<=', 'equal', 'left', 'right', 'bisect'],
  },
  referenceFix: {
    'pkg/search.py': [
      'def insert_position(sorted_items, value):',
      '    """Index at which to insert `value` so the list stays sorted, placing it',
      '    after any items equal to it."""',
      '    low, high = 0, len(sorted_items)',
      '    while low < high:',
      '        mid = (low + high) // 2',
      '        if sorted_items[mid] <= value:',
      '            low = mid + 1',
      '        else:',
      '            high = mid',
      '    return low',
      '',
    ].join('\n'),
  },
};

/** Integer division loses the remainder, so the shares do not add up. */
const numericPrecision: Fixture = {
  id: 'r-numeric-precision',
  files: {
    'pkg/__init__.py': INIT,
    'pkg/split.py': [
      'def split(total_cents, people):',
      '    """Split a total into whole-cent shares that add back up to the total.',
      '    Earlier shares absorb any remainder."""',
      '    share = total_cents // people',
      '    return [share] * people',
      '',
    ].join('\n'),
    'pkg/invoice.py': [
      'from pkg.split import split',
      '',
      '',
      'def settle(total_cents, people):',
      '    """Per-person amounts owed, largest first."""',
      '    return sorted(split(total_cents, people), reverse=True)',
      '',
    ].join('\n'),
  },
  testImports: ['from pkg.split import split', 'from pkg.invoice import settle'],
  tests: [
    'assert split(100, 4) == [25, 25, 25, 25]',
    'assert split(0, 2) == [0, 0]',
    'assert sum(split(100, 3)) == 100',
    'assert settle(100, 3) == [34, 33, 33]',
  ],
  defect: {
    type: 'numeric-precision',
    files: ['pkg/split.py'],
    summary: 'split uses floor division and repeats one share, discarding the remainder so the parts no longer sum to the total.',
    keywords: ['remainder', 'modulo', '%', 'floor', 'sum'],
  },
  referenceFix: {
    'pkg/split.py': [
      'def split(total_cents, people):',
      '    """Split a total into whole-cent shares that add back up to the total.',
      '    Earlier shares absorb any remainder."""',
      '    share = total_cents // people',
      '    remainder = total_cents % people',
      '    return [share + (1 if i < remainder else 0) for i in range(people)]',
      '',
    ].join('\n'),
  },
};

/** A star-import silently omits a name because of an incomplete __all__. */
const importInteraction: Fixture = {
  id: 'r-import-interaction',
  files: {
    'pkg/__init__.py': INIT,
    'pkg/shapes.py': [
      'import math',
      '',
      '__all__ = ["area_square"]',
      '',
      '',
      'def area_square(side):',
      '    return side * side',
      '',
      '',
      'def area_circle(radius):',
      '    return math.pi * radius * radius',
      '',
    ].join('\n'),
    'pkg/render.py': [
      'from pkg.shapes import *',
      '',
      '',
      'def describe(kind, size):',
      '    """Area of the named shape."""',
      '    if kind == "square":',
      '        return area_square(size)',
      '    return area_circle(size)',
      '',
    ].join('\n'),
  },
  testImports: ['from pkg.shapes import area_square', 'from pkg.render import describe'],
  tests: [
    'assert area_square(2) == 4',
    'assert describe("square", 3) == 9',
    'assert round(describe("circle", 1), 2) == 3.14',
  ],
  defect: {
    type: 'import-interaction',
    files: ['pkg/shapes.py'],
    summary: '__all__ lists only area_square, so render\'s star-import never binds area_circle and calling it raises NameError.',
    keywords: ['__all__', 'import *', 'export', 'NameError', 'area_circle'],
  },
  referenceFix: {
    'pkg/shapes.py': [
      'import math',
      '',
      '__all__ = ["area_square", "area_circle"]',
      '',
      '',
      'def area_square(side):',
      '    return side * side',
      '',
      '',
      'def area_circle(radius):',
      '    return math.pi * radius * radius',
      '',
    ].join('\n'),
  },
};

/** A memo keys on one argument, so a second argument never varies the result. */
const staleCache: Fixture = {
  id: 'r-stale-cache',
  files: {
    'pkg/__init__.py': INIT,
    'pkg/cache.py': [
      '_CACHE = {}',
      '',
      '',
      'def memoize(fn):',
      '    """Cache a function\'s result for each distinct set of arguments."""',
      '    def wrapper(*args):',
      '        key = args[0]',
      '        if key not in _CACHE:',
      '            _CACHE[key] = fn(*args)',
      '        return _CACHE[key]',
      '    return wrapper',
      '',
    ].join('\n'),
    'pkg/pricing.py': [
      'from pkg.cache import memoize',
      '',
      '',
      '@memoize',
      'def price(item, currency):',
      '    """A quote for an item in a currency."""',
      '    return item + ":" + currency',
      '',
    ].join('\n'),
  },
  testImports: ['from pkg.pricing import price'],
  tests: [
    'assert price("book", "usd") == "book:usd"',
    'assert price("pen", "eur") == "pen:eur"',
    'assert price("book", "eur") == "book:eur"',
  ],
  defect: {
    type: 'stale-cache',
    files: ['pkg/cache.py'],
    summary: 'memoize keys the cache on args[0] only, so a call differing in a later argument returns the first cached result.',
    keywords: ['key', 'args', 'cache', 'first argument', 'tuple'],
  },
  referenceFix: {
    'pkg/cache.py': [
      '_CACHE = {}',
      '',
      '',
      'def memoize(fn):',
      '    """Cache a function\'s result for each distinct set of arguments."""',
      '    def wrapper(*args):',
      '        key = args',
      '        if key not in _CACHE:',
      '            _CACHE[key] = fn(*args)',
      '        return _CACHE[key]',
      '    return wrapper',
      '',
    ].join('\n'),
  },
};

/** Slicing a page stops one item early. */
const boundary: Fixture = {
  id: 'r-boundary',
  files: {
    'pkg/__init__.py': INIT,
    'pkg/paging.py': [
      'def page(items, number, size):',
      '    """Page `number`, counting from 1, holding up to `size` items."""',
      '    start = (number - 1) * size',
      '    return items[start:start + size - 1]',
      '',
    ].join('\n'),
    'pkg/feed.py': [
      'from pkg.paging import page',
      '',
      '',
      'def pages(items, size):',
      '    """Every page, in order."""',
      '    count = (len(items) + size - 1) // size',
      '    return [page(items, n, size) for n in range(1, count + 1)]',
      '',
    ].join('\n'),
  },
  testImports: ['from pkg.paging import page', 'from pkg.feed import pages'],
  tests: [
    'assert page([], 1, 3) == []',
    'assert page([1, 2, 3, 4, 5], 1, 3) == [1, 2, 3]',
    'assert page([1, 2, 3, 4, 5], 2, 3) == [4, 5]',
    'assert pages([1, 2, 3, 4], 2) == [[1, 2], [3, 4]]',
  ],
  defect: {
    type: 'boundary',
    files: ['pkg/paging.py'],
    summary: 'page slices to start + size - 1, which drops the last item of every page.',
    keywords: ['slice', 'off-by-one', 'size - 1', 'end', 'last'],
  },
  referenceFix: {
    'pkg/paging.py': [
      'def page(items, number, size):',
      '    """Page `number`, counting from 1, holding up to `size` items."""',
      '    start = (number - 1) * size',
      '    return items[start:start + size]',
      '',
    ].join('\n'),
  },
};

/** Grouping overwrites each bucket instead of collecting into it. */
const dataTransformation: Fixture = {
  id: 'r-data-transformation',
  files: {
    'pkg/__init__.py': INIT,
    'pkg/group.py': [
      'def group_by(records, key):',
      '    """Collect records into {value: [records]} by the given key."""',
      '    out = {}',
      '    for record in records:',
      '        out[record[key]] = record',
      '    return out',
      '',
    ].join('\n'),
    'pkg/stats.py': [
      'from pkg.group import group_by',
      '',
      '',
      'def counts(records, key):',
      '    """How many records fall into each group."""',
      '    return {value: len(group) for value, group in group_by(records, key).items()}',
      '',
    ].join('\n'),
  },
  testImports: ['from pkg.group import group_by', 'from pkg.stats import counts'],
  tests: [
    'assert group_by([], "k") == {}',
    'assert group_by([{"k": "a", "v": 1}], "k") == {"a": [{"k": "a", "v": 1}]}',
    'assert counts([{"k": "a"}, {"k": "a"}, {"k": "b"}], "k") == {"a": 2, "b": 1}',
  ],
  defect: {
    type: 'data-transformation',
    files: ['pkg/group.py'],
    summary: 'group_by assigns each record to its bucket, so every group holds the last record instead of a list of them.',
    keywords: ['append', 'setdefault', 'list', 'overwrit', 'bucket'],
  },
  referenceFix: {
    'pkg/group.py': [
      'def group_by(records, key):',
      '    """Collect records into {value: [records]} by the given key."""',
      '    out = {}',
      '    for record in records:',
      '        out.setdefault(record[key], []).append(record)',
      '    return out',
      '',
    ].join('\n'),
  },
};

/** A blanket except swallows the error the contract promises to raise. */
const errorBehavior: Fixture = {
  id: 'r-error-behavior',
  files: {
    'pkg/__init__.py': INIT,
    'pkg/parsing.py': [
      'def parse_port(text):',
      '    """Return the port as an int, or raise ValueError if it is not a usable port."""',
      '    try:',
      '        value = int(text)',
      '        if value < 1 or value > 65535:',
      '            raise ValueError("port out of range: " + str(value))',
      '        return value',
      '    except Exception:',
      '        return None',
      '',
    ].join('\n'),
    'pkg/config.py': [
      'from pkg.parsing import parse_port',
      '',
      '',
      'def endpoint(host, port_text):',
      '    """A host:port endpoint string."""',
      '    return host + ":" + str(parse_port(port_text))',
      '',
    ].join('\n'),
  },
  testImports: ['from pkg.parsing import parse_port', 'from pkg.config import endpoint'],
  testPrelude: [
    'def raised(fn, *args):',
    '    try:',
    '        fn(*args)',
    '        return None',
    '    except Exception as exc:',
    '        return type(exc).__name__',
  ],
  tests: [
    'assert parse_port("8080") == 8080',
    'assert endpoint("localhost", "80") == "localhost:80"',
    'assert raised(parse_port, "abc") == "ValueError"',
    'assert raised(parse_port, "70000") == "ValueError"',
  ],
  defect: {
    type: 'error-behavior',
    files: ['pkg/parsing.py'],
    summary: 'parse_port wraps its body in a blanket except that swallows both the int() failure and its own range ValueError, returning None instead of raising.',
    keywords: ['except', 'raise', 'swallow', 'None', 'ValueError'],
  },
  referenceFix: {
    'pkg/parsing.py': [
      'def parse_port(text):',
      '    """Return the port as an int, or raise ValueError if it is not a usable port."""',
      '    value = int(text)',
      '    if value < 1 or value > 65535:',
      '        raise ValueError("port out of range: " + str(value))',
      '    return value',
      '',
    ].join('\n'),
  },
};

export const REPLICATION_FIXTURES: Fixture[] = [
  apiContract,
  crossFileState,
  edgeCase,
  wrongAlgorithm,
  numericPrecision,
  importInteraction,
  staleCache,
  boundary,
  dataTransformation,
  errorBehavior,
];

export function replicationFixtureById(id: string): Fixture | undefined {
  return REPLICATION_FIXTURES.find(f => f.id === id);
}
