/**
 * TF-IDF Semantic Search Engine — Zero External Dependencies
 *
 * Provides lightweight vector similarity search over text documents.
 * Uses Term Frequency-Inverse Document Frequency with cosine similarity.
 * Outperforms keyword search while requiring no ML models or vector DBs.
 *
 * Design beats OpenClaw which has zero semantic search capability.
 */

export interface IndexedDocument {
  id: string;
  text: string;
  vector: number[];
}

// Stop words to ignore during tokenization
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and', 'or',
  'if', 'while', 'about', 'up', 'down', 'it', 'its', 'this', 'that',
  'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he',
  'him', 'his', 'she', 'her', 'they', 'them', 'their', 'what', 'which',
]);

export class SemanticIndex {
  private documents = new Map<string, IndexedDocument>();
  private vocabulary = new Map<string, number>(); // term → index
  private documentFrequency = new Map<string, number>(); // term → # docs containing it
  private dirty = false; // needs recomputation

  /** Tokenize text into normalized terms */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && !STOP_WORDS.has(t));
  }

  /** Compute term frequency for a document */
  private computeTF(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    // Normalize by document length
    const len = tokens.length || 1;
    for (const [term, count] of tf) {
      tf.set(term, count / len);
    }
    return tf;
  }

  /** Rebuild the full vocabulary and IDF from all documents */
  private rebuildIndex(): void {
    if (!this.dirty) return;

    this.vocabulary.clear();
    this.documentFrequency.clear();

    // Collect all unique terms and document frequencies
    const allTermSets: Map<string, Set<string>> = new Map(); // term → set of doc IDs

    for (const [docId, doc] of this.documents) {
      const tokens = this.tokenize(doc.text);
      const uniqueTerms = new Set(tokens);
      for (const term of uniqueTerms) {
        if (!allTermSets.has(term)) {
          allTermSets.set(term, new Set());
        }
        allTermSets.get(term)!.add(docId);
      }
    }

    // Build vocabulary with index positions
    let idx = 0;
    for (const [term, docSet] of allTermSets) {
      this.vocabulary.set(term, idx++);
      this.documentFrequency.set(term, docSet.size);
    }

    // Recompute all document vectors
    const n = this.documents.size || 1;
    for (const [, doc] of this.documents) {
      doc.vector = this.computeVector(doc.text, n);
    }

    this.dirty = false;
  }

  /** Compute TF-IDF vector for a text */
  private computeVector(text: string, totalDocs: number): number[] {
    const tokens = this.tokenize(text);
    const tf = this.computeTF(tokens);
    const vector = new Array(this.vocabulary.size).fill(0);

    for (const [term, tfVal] of tf) {
      const idx = this.vocabulary.get(term);
      if (idx === undefined) continue;
      const df = this.documentFrequency.get(term) ?? 1;
      const idf = Math.log(1 + totalDocs / df); // smoothed IDF
      vector[idx] = tfVal * idf;
    }

    return vector;
  }

  /** Compute cosine similarity between two vectors */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /** Add a document to the index */
  add(id: string, text: string): void {
    this.documents.set(id, { id, text, vector: [] });
    this.dirty = true;
  }

  /** Remove a document from the index */
  remove(id: string): boolean {
    const removed = this.documents.delete(id);
    if (removed) this.dirty = true;
    return removed;
  }

  /** Update a document's text */
  update(id: string, text: string): void {
    this.documents.set(id, { id, text, vector: [] });
    this.dirty = true;
  }

  /** Search for documents similar to a query text */
  search(query: string, limit = 10, minScore = 0.05): Array<{ id: string; score: number }> {
    this.rebuildIndex();

    if (this.documents.size === 0 || this.vocabulary.size === 0) {
      return [];
    }

    const queryVector = this.computeVector(query, this.documents.size);

    const results: Array<{ id: string; score: number }> = [];

    for (const [id, doc] of this.documents) {
      const score = this.cosineSimilarity(queryVector, doc.vector);
      if (score >= minScore) {
        results.push({ id, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /** Get the embedding vector for a text (for storage) */
  getEmbedding(text: string): number[] {
    this.rebuildIndex();
    return this.computeVector(text, this.documents.size || 1);
  }

  /** Get document count */
  get size(): number {
    return this.documents.size;
  }

  /** Get vocabulary size */
  get vocabularySize(): number {
    this.rebuildIndex();
    return this.vocabulary.size;
  }

  /** Clear all documents */
  clear(): void {
    this.documents.clear();
    this.vocabulary.clear();
    this.documentFrequency.clear();
    this.dirty = false;
  }

  /** Serialize the index for persistence */
  serialize(): { documents: Array<{ id: string; text: string }>; } {
    return {
      documents: Array.from(this.documents.values()).map(d => ({ id: d.id, text: d.text })),
    };
  }

  /** Load from serialized data */
  load(data: { documents: Array<{ id: string; text: string }> }): void {
    this.clear();
    for (const doc of data.documents) {
      this.documents.set(doc.id, { id: doc.id, text: doc.text, vector: [] });
    }
    this.dirty = true;
  }
}
