import { describe, it, expect, beforeEach } from 'vitest';
import { SemanticIndex } from '../src/memory/semantic-index.js';

describe('SemanticIndex', () => {
  let index: SemanticIndex;

  beforeEach(() => {
    index = new SemanticIndex();
  });

  it('adds and searches documents', () => {
    index.add('1', 'how to deploy a nodejs application to production');
    index.add('2', 'best practices for react component testing');
    index.add('3', 'deploying microservices with kubernetes');
    index.add('4', 'python machine learning tutorial');

    const results = index.search('deploy node app');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('1');
  });

  it('returns empty for empty index', () => {
    const results = index.search('anything');
    expect(results).toEqual([]);
  });

  it('removes documents', () => {
    index.add('1', 'hello world');
    index.add('2', 'goodbye world');

    expect(index.size).toBe(2);
    index.remove('1');
    expect(index.size).toBe(1);
  });

  it('updates documents', () => {
    index.add('1', 'javascript tutorial');
    index.update('1', 'typescript tutorial');

    const results = index.search('typescript');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('1');
  });

  it('ranks by relevance', () => {
    index.add('a', 'react hooks useState useEffect component');
    index.add('b', 'vue composition api reactivity');
    index.add('c', 'react native mobile development ios android');

    const results = index.search('react hooks');
    expect(results.length).toBeGreaterThan(0);
    // 'a' should rank highest — both "react" and "hooks" match
    expect(results[0].id).toBe('a');
  });

  it('filters by minimum score', () => {
    index.add('1', 'completely unrelated document about cooking pasta');
    index.add('2', 'quantum physics and string theory');

    const results = index.search('deploy kubernetes', 10, 0.1);
    // Neither document should match at 0.1 threshold
    expect(results.length).toBe(0);
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 20; i++) {
      index.add(`doc-${i}`, `document number ${i} about software engineering`);
    }

    const results = index.search('software engineering', 5);
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it('serializes and loads', () => {
    index.add('1', 'first document');
    index.add('2', 'second document');

    const serialized = index.serialize();
    expect(serialized.documents).toHaveLength(2);

    const newIndex = new SemanticIndex();
    newIndex.load(serialized);
    expect(newIndex.size).toBe(2);

    const results = newIndex.search('first');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('1');
  });

  it('handles special characters in text', () => {
    index.add('1', 'error: ENOENT file not found /usr/local/bin');
    index.add('2', 'warning: deprecated API v2.0');

    const results = index.search('error file not found');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('1');
  });

  it('clears all data', () => {
    index.add('1', 'test doc');
    index.add('2', 'another doc');
    index.clear();

    expect(index.size).toBe(0);
    expect(index.vocabularySize).toBe(0);
  });

  it('gets embedding vector', () => {
    index.add('1', 'machine learning deep neural network');
    const embedding = index.getEmbedding('neural network');

    expect(Array.isArray(embedding)).toBe(true);
    expect(embedding.length).toBeGreaterThan(0);
  });

  it('handles duplicate document IDs', () => {
    index.add('1', 'original text');
    index.add('1', 'overwritten text');

    expect(index.size).toBe(1);
    const results = index.search('overwritten');
    expect(results.length).toBe(1);
  });

  it('handles single-word queries', () => {
    index.add('1', 'kubernetes container orchestration');
    index.add('2', 'docker container runtime');

    const results = index.search('container');
    expect(results.length).toBe(2);
  });
});
