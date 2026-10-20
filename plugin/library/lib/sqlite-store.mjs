/** Per-conversation exact-evidence store, with no model or DSH dependency.
 * node:sqlite is experimental in Node 22.20; feature-test the deployment runtime.
 * DatabaseSync is synchronous: production callers should isolate it in a worker.
 * Offsets are Unicode code points, half-open [start,end), never UTF-16 indexes.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const CHUNK_CHARS = 2048;
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const points = text => Array.from(text);
const now = () => new Date().toISOString();
const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a nonempty string`);
  return value;
};
const limitOf = (value, fallback) => {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('limit must be 1..1000');
  return limit;
};
function json(value, label) {
  const normalize = item => {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]));
    }
    throw new TypeError(`${label} must contain only JSON values`);
  };
  return JSON.stringify(normalize(value));
}

/** Safe FTS terms: encoded ASCII identifiers plus encoded CJK bigrams.
 * Literal instr() recall supplements FTS for punctuation and short queries.
 */
function tokensFor(text) {
  const terms = new Set();
  for (const match of text.matchAll(/[A-Za-z0-9_]+/g)) {
    terms.add('a' + Buffer.from(match[0].toLowerCase()).toString('hex'));
  }
  for (const match of text.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu)) {
    const chars = points(match[0]);
    for (let index = 0; index + 1 < chars.length; index += 1) {
      terms.add('c' + Buffer.from(chars[index] + chars[index + 1]).toString('hex'));
    }
  }
  return [...terms];
}

export class ConversationStore {
  #db;
  #closed = false;

  constructor({ rootDir, conversationId } = {}) {
    required(rootDir, 'rootDir');
    required(conversationId, 'conversationId');
    this.conversationId = conversationId;
    this.directory = path.join(path.resolve(rootDir), hash(conversationId));
    this.dbPath = path.join(this.directory, 'memory.sqlite');
    mkdirSync(this.directory, { recursive: true });
    const existing = existsSync(this.dbPath) && statSync(this.dbPath).size > 0;
    this.#db = new DatabaseSync(this.dbPath, { timeout: 1000, allowExtension: false });
    try {
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;');
      const tables = this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (existing && tables.length && !tables.some(row => row.name === 'meta')) {
        throw new Error('Refusing to adopt an unrelated existing database');
      }
      if (tables.some(row => row.name === 'meta')) {
        const metadata = Object.fromEntries(this.#db.prepare('SELECT key,value FROM meta').all().map(row => [row.key, row.value]));
        if (metadata.conversationId !== conversationId) throw new Error('Conversation identity mismatch');
        if (metadata.schemaVersion !== String(SCHEMA_VERSION)) throw new Error('Unsupported memory schema version');
      }
      this.#transaction(() => {
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS messages(
            seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
            sourceKey TEXT NOT NULL UNIQUE,role TEXT NOT NULL,text TEXT NOT NULL,
            hash TEXT NOT NULL,createdAt TEXT NOT NULL,metadata TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS chunks(
            id INTEGER PRIMARY KEY AUTOINCREMENT,messageId TEXT NOT NULL REFERENCES messages(id),
            start INTEGER NOT NULL,end INTEGER NOT NULL,hash TEXT NOT NULL,
            UNIQUE(messageId,start,end));
          CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(tokens,content='');
          CREATE TABLE IF NOT EXISTS citations(
            ref INTEGER PRIMARY KEY AUTOINCREMENT,messageId TEXT NOT NULL REFERENCES messages(id),
            start INTEGER NOT NULL,end INTEGER NOT NULL,hash TEXT NOT NULL,
            UNIQUE(messageId,start,end));
          CREATE TABLE IF NOT EXISTS memories(
            ref INTEGER PRIMARY KEY REFERENCES citations(ref),kind TEXT NOT NULL,key TEXT,
            origin TEXT NOT NULL,pinned INTEGER NOT NULL CHECK(pinned IN(0,1)),
            scope TEXT NOT NULL,quote TEXT NOT NULL,createdAt TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS memory_revisions(
            id INTEGER PRIMARY KEY AUTOINCREMENT,ref INTEGER NOT NULL REFERENCES memories(ref),
            kind TEXT NOT NULL,key TEXT,origin TEXT NOT NULL,pinned INTEGER NOT NULL,
            scope TEXT NOT NULL,beforeJson TEXT NOT NULL,afterJson TEXT NOT NULL,createdAt TEXT NOT NULL);
          CREATE VIEW IF NOT EXISTS memory_current AS
            SELECT m.ref,m.quote,m.createdAt,
              CASE WHEN r.id IS NULL THEN m.kind ELSE r.kind END AS kind,
              CASE WHEN r.id IS NULL THEN m.key ELSE r.key END AS key,
              CASE WHEN r.id IS NULL THEN m.origin ELSE r.origin END AS origin,
              CASE WHEN r.id IS NULL THEN m.pinned ELSE r.pinned END AS pinned,
              CASE WHEN r.id IS NULL THEN m.scope ELSE r.scope END AS scope,
              r.createdAt AS confirmedAt
            FROM memories m LEFT JOIN memory_revisions r ON r.id=(SELECT MAX(x.id) FROM memory_revisions x WHERE x.ref=m.ref);
          CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(tokens,content='');
          CREATE TABLE IF NOT EXISTS relations(
            id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL CHECK(type IN('supersede','retract','resolve')),
            oldRef INTEGER NOT NULL REFERENCES memories(ref),newRef INTEGER REFERENCES memories(ref),createdAt TEXT NOT NULL);
          CREATE UNIQUE INDEX IF NOT EXISTS relation_identity ON relations(type,oldRef,COALESCE(newRef,0));
          CREATE INDEX IF NOT EXISTS chunks_message ON chunks(messageId,start);
          CREATE INDEX IF NOT EXISTS relations_old ON relations(oldRef);
          CREATE INDEX IF NOT EXISTS revisions_ref ON memory_revisions(ref,id);
          CREATE TABLE IF NOT EXISTS tool_events(
            messageId TEXT PRIMARY KEY REFERENCES messages(id),callId TEXT NOT NULL,
            callEventSeq INTEGER NOT NULL,eventSeq INTEGER NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN('tool-call','tool-result')),toolName TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS tool_events_call ON tool_events(callEventSeq,eventSeq);
        `);
        const insert = this.#db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)');
        insert.run('conversationId', conversationId);
        insert.run('schemaVersion', String(SCHEMA_VERSION));
        // API and SQL-level append-only protection; updates are new facts/relations.
        for (const table of ['meta', 'messages', 'chunks', 'citations', 'memories', 'memory_revisions', 'relations', 'tool_events']) {
          for (const action of ['UPDATE', 'DELETE']) {
            this.#db.exec(`CREATE TRIGGER IF NOT EXISTS immutable_${table}_${action.toLowerCase()}
              BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'append-only table'); END;`);
          }
        }
      });
    } catch (error) {
      this.#db.close();
      this.#closed = true;
      throw error;
    }
  }

  #open() { if (this.#closed) throw new Error('ConversationStore is closed'); }
  #transaction(work) {
    this.#open();
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  #message(row) {
    if (!row) return null;
    if (hash(row.text) !== row.hash) throw new Error(`Message hash mismatch: ${row.id}`);
    return { ...row, metadata: JSON.parse(row.metadata) };
  }

  append({ id = randomUUID(), sourceKey = randomUUID(), role, text, createdAt = now(), metadata = {} } = {}) {
    required(id, 'id'); required(sourceKey, 'sourceKey'); required(role, 'role'); required(createdAt, 'createdAt');
    if (typeof text !== 'string' || !text.isWellFormed()) throw new TypeError('text must be a well-formed Unicode string');
    const metadataJson = json(metadata, 'metadata');
    return this.#transaction(() => {
      const old = this.#db.prepare('SELECT * FROM messages WHERE sourceKey=?').get(sourceKey);
      if (old) {
        if (old.hash !== hash(text) || old.text !== text || old.role !== role) throw new Error('sourceKey conflict: existing content differs');
        return this.#message(old);
      }
      this.#db.prepare('INSERT INTO messages(id,sourceKey,role,text,hash,createdAt,metadata) VALUES (?,?,?,?,?,?,?)')
        .run(id, sourceKey, role, text, hash(text), createdAt, metadataJson);
      const chars = points(text);
      for (let start = 0; start < chars.length; start += CHUNK_CHARS) {
        const end = Math.min(chars.length, start + CHUNK_CHARS);
        const chunk = chars.slice(start, end).join('');
        const inserted = this.#db.prepare('INSERT INTO chunks(messageId,start,end,hash) VALUES (?,?,?,?)').run(id, start, end, hash(chunk));
        this.#db.prepare('INSERT INTO chunk_fts(rowid,tokens) VALUES (?,?)').run(inserted.lastInsertRowid, tokensFor(chunk).join(' '));
      }
      return this.getMessage(id);
    });
  }

  getMessage(id) { this.#open(); return this.#message(this.#db.prepare('SELECT * FROM messages WHERE id=?').get(required(id, 'messageId'))); }
  /** Additive provenance migration: old message bytes and citations never change. */
  linkToolEvent({ messageId, callId, callEventSeq, eventSeq, kind, toolName }) {
    const message = this.getMessage(messageId);
    required(callId, 'callId'); required(toolName, 'toolName');
    if (!message || !Number.isSafeInteger(callEventSeq) || callEventSeq < 0 || !Number.isSafeInteger(eventSeq)
      || eventSeq < callEventSeq || eventSeq !== message.metadata.seq
      || !['tool-call','tool-result'].includes(kind) || message.role !== (kind === 'tool-call' ? 'assistant' : 'tool')
      || kind === 'tool-call' && callEventSeq !== eventSeq) throw new TypeError('Invalid tool provenance');
    const values = { messageId, callId, callEventSeq, eventSeq, kind, toolName };
    return this.#transaction(() => {
      const previous = this.toolEvent(messageId);
      if (previous) {
        if (Object.keys(values).some(key => previous[key] !== values[key])) throw new Error('Tool provenance conflict');
        return previous;
      }
      this.#db.prepare('INSERT INTO tool_events(messageId,callId,callEventSeq,eventSeq,kind,toolName) VALUES (?,?,?,?,?,?)')
        .run(messageId, callId, callEventSeq, eventSeq, kind, toolName);
      return values;
    });
  }
  toolEvent(messageId) { this.#open(); return this.#db.prepare('SELECT * FROM tool_events WHERE messageId=?').get(required(messageId, 'messageId')) ?? null; }
  relatedToolEvents(messageId, limit = 8) {
    const source = this.toolEvent(messageId);
    return source ? this.#db.prepare('SELECT * FROM tool_events WHERE callEventSeq=? AND callId=? AND messageId<>? ORDER BY eventSeq LIMIT ?')
      .all(source.callEventSeq, source.callId, messageId, limitOf(limit, 8)) : [];
  }
  listMessages({ afterSeq = 0, limit = 100 } = {}) {
    this.#open();
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new RangeError('afterSeq must be nonnegative');
    return this.#db.prepare('SELECT * FROM messages WHERE seq>? ORDER BY seq LIMIT ?').all(afterSeq, limitOf(limit, 100)).map(row => this.#message(row));
  }
  recentMessages(options = {}) {
    this.#open();
    const limit = limitOf(typeof options === 'number' ? options : options.limit, 20);
    return this.#db.prepare('SELECT * FROM messages ORDER BY seq DESC LIMIT ?').all(limit).reverse().map(row => this.#message(row));
  }

  #span(messageId, start, end) {
    const message = this.getMessage(messageId);
    if (!message) throw new Error('Unknown source message');
    const chars = points(message.text);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > chars.length) {
      throw new RangeError('Invalid code-point source span');
    }
    return { message, text: chars.slice(start, end).join('') };
  }
  #cite({ messageId, start, end }) {
    const span = this.#span(messageId, start, end);
    const old = this.#db.prepare('SELECT ref FROM citations WHERE messageId=? AND start=? AND end=?').get(messageId, start, end);
    if (old) return this.readCitation(old.ref);
    const inserted = this.#db.prepare('INSERT INTO citations(messageId,start,end,hash) VALUES (?,?,?,?)').run(messageId, start, end, hash(span.text));
    return this.readCitation(Number(inserted.lastInsertRowid));
  }
  cite(input) { return this.#transaction(() => this.#cite(input)); }
  readCitation(ref) {
    this.#open();
    if (!Number.isSafeInteger(ref) || ref < 1) throw new RangeError('ref must be a positive integer');
    const row = this.#db.prepare('SELECT * FROM citations WHERE ref=?').get(ref);
    if (!row) return null;
    const span = this.#span(row.messageId, row.start, row.end);
    if (hash(span.text) !== row.hash) throw new Error(`Citation hash mismatch: ${ref}`);
    return { ...row, text: span.text, sourceSeq: span.message.seq, sourceHash: span.message.hash,
      sourceRole: span.message.role, sourceMetadata: span.message.metadata };
  }

  /** Explicit raw-evidence reads stay available while carrying current relation
   * state. includeInactive:false suppresses any span overlapping inactive memory.
   */
  sourceEvidence(ref, { includeInactive = true } = {}) {
    const citation = this.readCitation(ref);
    return citation === null ? null : this.#sourceResult(citation, 0, includeInactive);
  }

  addMemory({ kind, messageId, start, end, key = null, origin = 'manual', pinned = false, scope = {} } = {}) {
    required(kind, 'kind');
    if (kind === 'source') throw new TypeError('source is reserved for raw evidence chunks');
    if (key !== null) required(key, 'key');
    if (!['manual', 'user', 'model'].includes(origin)) throw new TypeError('Invalid memory origin');
    if (typeof pinned !== 'boolean') throw new TypeError('pinned must be boolean');
    if (pinned && origin === 'model') throw new Error('Model-origin memories cannot be pinned');
    const scopeJson = json(scope, 'scope');
    return this.#transaction(() => {
      const citation = this.#cite({ messageId, start, end });
      const old = this.#db.prepare('SELECT * FROM memories WHERE ref=?').get(citation.ref);
      if (old) {
        if (old.kind !== kind || old.key !== key || old.origin !== origin || old.pinned !== Number(pinned) || old.scope !== scopeJson) {
          throw new Error('Memory span conflict: existing memory attributes differ');
        }
        return this.getMemory(citation.ref);
      }
      this.#db.prepare('INSERT INTO memories(ref,kind,key,origin,pinned,scope,quote,createdAt) VALUES (?,?,?,?,?,?,?,?)')
        .run(citation.ref, kind, key, origin, Number(pinned), scopeJson, citation.text, now());
      this.#db.prepare('INSERT INTO memory_fts(rowid,tokens) VALUES (?,?)').run(citation.ref, tokensFor(citation.text).join(' '));
      return this.getMemory(citation.ref);
    });
  }

  getMemory(ref) {
    this.#open();
    if (!Number.isSafeInteger(ref) || ref < 1) throw new RangeError('ref must be a positive integer');
    const row = this.#db.prepare('SELECT *,NOT EXISTS(SELECT 1 FROM relations r WHERE r.oldRef=memory_current.ref) AS active FROM memory_current WHERE ref=?').get(ref);
    if (!row) return null;
    const citation = this.readCitation(ref);
    if (row.quote !== citation.text) throw new Error(`Memory quote mismatch: ${ref}`);
    return { ...row, active: Boolean(row.active), pinned: Boolean(row.pinned), scope: JSON.parse(row.scope),
      messageId: citation.messageId, start: citation.start, end: citation.end,
      text: citation.text, quote: citation.text, sourceSeq: citation.sourceSeq,
      sourceRole: citation.sourceRole, sourceMetadata: citation.sourceMetadata,
      relations: this.#db.prepare('SELECT * FROM relations WHERE oldRef=? ORDER BY id').all(ref), citation };
  }

  #memoryRows({ kinds, includeInactive = false, limit = 100, pinnedOnly = false } = {}) {
    const values = [];
    let where = includeInactive ? '1' : 'NOT EXISTS(SELECT 1 FROM relations r WHERE r.oldRef=m.ref)';
    if (pinnedOnly) where += ' AND m.pinned=1';
    if (kinds !== undefined) {
      if (!Array.isArray(kinds) || kinds.some(kind => typeof kind !== 'string' || !kind)) throw new TypeError('kinds must be an array of strings');
      if (!kinds.length) return [];
      where += ` AND m.kind IN (${kinds.map(() => '?').join(',')})`;
      values.push(...kinds);
    }
    return this.#db.prepare(`SELECT m.ref FROM memory_current m WHERE ${where} ORDER BY m.ref LIMIT ?`).all(...values, limitOf(limit, 100));
  }
  listMemories(options = {}) { this.#open(); return this.#memoryRows(options).map(row => this.getMemory(row.ref)); }
  pinnedMemories(options = {}) { this.#open(); return this.#memoryRows({ ...options, pinnedOnly: true }).map(row => this.getMemory(row.ref)); }

  /** Trusted caller only: confirm exact evidence; never exposed to model extraction.
   * The original memory row remains untouched. Effective attributes are the last
   * append-only audit revision; confirming does not reactivate an inactive item.
   */
  confirm(ref, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('confirm options must be an object');
    for (const key of Object.keys(options)) if (!['kind', 'key', 'scope', 'pinned'].includes(key)) throw new TypeError(`Unknown confirmation setting: ${key}`);
    return this.#transaction(() => {
      const old = this.getMemory(ref);
      if (!old) throw new Error('Unknown memory reference');
      const effective = { kind: options.kind ?? old.kind,
        key: Object.hasOwn(options, 'key') ? options.key : old.key,
        scope: Object.hasOwn(options, 'scope') ? options.scope : old.scope,
        origin: 'manual', pinned: options.pinned ?? true };
      required(effective.kind, 'kind');
      if (effective.kind === 'source') throw new TypeError('source is reserved for raw evidence chunks');
      if (effective.key !== null) required(effective.key, 'key');
      if (typeof effective.pinned !== 'boolean') throw new TypeError('pinned must be boolean');
      const before = { kind: old.kind, key: old.key, scope: old.scope, origin: old.origin, pinned: old.pinned };
      const beforeJson = json(before, 'before'), afterJson = json(effective, 'after');
      if (beforeJson !== afterJson) {
        this.#db.prepare('INSERT INTO memory_revisions(ref,kind,key,origin,pinned,scope,beforeJson,afterJson,createdAt) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(ref, effective.kind, effective.key, effective.origin, Number(effective.pinned), json(effective.scope, 'scope'), beforeJson, afterJson, now());
      }
      return this.getMemory(ref);
    });
  }

  #relate(type, oldRef, newRef = null) {
    return this.#transaction(() => {
      const old = this.getMemory(oldRef);
      if (!old) throw new Error('Unknown old memory reference');
      const existing = this.#db.prepare('SELECT * FROM relations WHERE type=? AND oldRef=? AND newRef IS ?').get(type, oldRef, newRef);
      if (existing) return { ...existing, active: false };
      if (newRef !== null) {
        const replacement = this.getMemory(newRef);
        if (!replacement) throw new Error('Unknown replacement memory reference');
        if (!old.active || !replacement.active) throw new Error('Supersede requires active old and new memories');
        if (!(replacement.sourceSeq > old.sourceSeq || (replacement.sourceSeq === old.sourceSeq && replacement.start > old.start))) {
          throw new Error('Superseding source must be strictly later than the old source position');
        }
      }
      this.#db.prepare('INSERT OR IGNORE INTO relations(type,oldRef,newRef,createdAt) VALUES (?,?,?,?)').run(type, oldRef, newRef, now());
      const relation = this.#db.prepare('SELECT * FROM relations WHERE type=? AND oldRef=? AND newRef IS ?').get(type, oldRef, newRef);
      return { ...relation, active: false };
    });
  }
  supersede(oldRef, newRef) {
    if (!Number.isSafeInteger(newRef) || newRef < 1) throw new RangeError('newRef must be a positive integer');
    return this.#relate('supersede', oldRef, newRef);
  }
  retract(ref) { return this.#relate('retract', ref); }
  resolve(ref) { return this.#relate('resolve', ref); }

  #hasInactiveOverlap({ messageId, start, end }) {
    return Boolean(this.#db.prepare(`SELECT 1 FROM memories m JOIN citations c ON c.ref=m.ref
      WHERE c.messageId=? AND c.start<? AND c.end>?
      AND EXISTS(SELECT 1 FROM relations r WHERE r.oldRef=m.ref) LIMIT 1`).get(messageId, end, start));
  }

  #sourceResult(citation, score, includeInactive) {
    const related = this.#db.prepare(`SELECT m.ref,NOT EXISTS(SELECT 1 FROM relations r WHERE r.oldRef=m.ref) AS active
      FROM memories m JOIN citations c ON c.ref=m.ref
      WHERE c.messageId=? AND c.start<? AND c.end>? ORDER BY m.ref`).all(citation.messageId, citation.end, citation.start);
    const inactive = related.filter(row => !row.active).map(row => row.ref);
    // Raw evidence remains readable by citation, but must not resurrect a
    // superseded/retracted/resolved constraint as apparently current context.
    if (inactive.length && !includeInactive) return null;
    const relations = inactive.length ? this.#db.prepare(`SELECT r.* FROM relations r JOIN citations c ON c.ref=r.oldRef
      WHERE c.messageId=? AND c.start<? AND c.end>? ORDER BY r.id`).all(citation.messageId, citation.end, citation.start) : [];
    return { ...citation, kind: 'source', score, active: inactive.length === 0,
      pinned: false, scope: {}, origin: 'source', key: null,
      relatedMemoryRefs: related.map(row => row.ref), relatedInactiveMemoryRefs: inactive, relations };
  }

  search(query, { limit = 10, kinds, includeInactive = false } = {}) {
    this.#open();
    if (typeof query !== 'string') throw new TypeError('query must be a string');
    query = query.trim();
    if (!query) return [];
    if (points(query).length > 1000) throw new RangeError('query exceeds 1000 code points');
    limit = limitOf(limit, 10);
    if (kinds !== undefined && (!Array.isArray(kinds) || kinds.some(kind => typeof kind !== 'string' || !kind))) throw new TypeError('kinds must be strings');
    if (kinds?.length === 0) return [];
    return this.#transaction(() => {
      const terms = tokensFor(query);
      const match = terms.join(' AND ');
      const sourceIds = new Map();
      const literalSources = [];
      const memoryRefs = new Map();
      if (!kinds || kinds.includes('source')) {
        if (match) {
          const activeFilter = includeInactive ? '1' : `NOT EXISTS(SELECT 1 FROM memories m JOIN citations c ON c.ref=m.ref
            WHERE c.messageId=ch.messageId AND c.start<ch.end AND c.end>ch.start
            AND EXISTS(SELECT 1 FROM relations r WHERE r.oldRef=m.ref))`;
          for (const row of this.#db.prepare(`SELECT chunk_fts.rowid,-bm25(chunk_fts) AS score
            FROM chunk_fts JOIN chunks ch ON ch.id=chunk_fts.rowid
            WHERE chunk_fts MATCH ? AND ${activeFilter} ORDER BY rank LIMIT ?`).all(match, limit)) sourceIds.set(row.rowid, row.score);
        }
        // Literal recall is bounded in returned rows and does not expose SQL/FTS syntax.
        for (const row of this.#db.prepare('SELECT id,text FROM messages WHERE instr(text,?)>0 ORDER BY seq DESC').iterate(query)) {
          const hit = points(row.text.slice(0, row.text.indexOf(query))).length;
          const start = Math.max(0, hit - 512), end = Math.min(points(row.text).length, start + CHUNK_CHARS);
          const span = { messageId: row.id, start, end };
          if (!includeInactive && this.#hasInactiveOverlap(span)) continue;
          literalSources.push(span);
          if (literalSources.length >= limit) break;
        }
      }
      const memoryKinds = kinds?.filter(kind => kind !== 'source');
      if (!kinds || memoryKinds.length) {
        const filterValues = [];
        let filter = includeInactive ? '1' : 'NOT EXISTS(SELECT 1 FROM relations r WHERE r.oldRef=m.ref)';
        if (memoryKinds) {
          filter += ` AND m.kind IN (${memoryKinds.map(() => '?').join(',')})`;
          filterValues.push(...memoryKinds);
        }
        if (match) {
          for (const row of this.#db.prepare(`SELECT memory_fts.rowid,-bm25(memory_fts) AS score
            FROM memory_fts JOIN memory_current m ON m.ref=memory_fts.rowid
            WHERE memory_fts MATCH ? AND ${filter} ORDER BY rank LIMIT ?`).all(match, ...filterValues, limit)) memoryRefs.set(row.rowid, row.score + 0.1);
        }
        for (const row of this.#db.prepare(`SELECT m.ref FROM memory_current m WHERE ${filter} AND instr(m.quote,?)>0 ORDER BY m.ref DESC LIMIT ?`).all(...filterValues, query, limit)) memoryRefs.set(row.ref, 2.1);
      }
      const output = [];
      for (const [id, score] of sourceIds) {
        const chunk = this.#db.prepare('SELECT * FROM chunks WHERE id=?').get(id);
        const citation = this.#cite(chunk);
        if (citation.hash !== chunk.hash) throw new Error('Chunk hash mismatch');
        const result = this.#sourceResult(citation, score, includeInactive);
        if (result) output.push(result);
      }
      for (const span of literalSources) {
        const citation = this.#cite(span);
        const duplicate = output.find(item => item.kind === 'source' && item.ref === citation.ref);
        if (duplicate) duplicate.score = 2;
        else {
          const result = this.#sourceResult(citation, 2, includeInactive);
          if (result) output.push(result);
        }
      }
      for (const [ref, score] of memoryRefs) {
        const memory = this.getMemory(ref);
        output.push({ ...memory, score: score + (memory.pinned ? 0.05 : 0) });
      }
      return output.sort((left, right) => right.score - left.score || right.sourceSeq - left.sourceSeq || left.start - right.start).slice(0, limit);
    });
  }

  stats() {
    this.#open();
    const counts = {};
    for (const table of ['messages', 'chunks', 'citations', 'memories', 'relations']) counts[table] = this.#db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    counts.activeMemories = this.#db.prepare('SELECT count(*) AS n FROM memories m WHERE NOT EXISTS(SELECT 1 FROM relations r WHERE r.oldRef=m.ref)').get().n;
    counts.confirmations = this.#db.prepare('SELECT count(*) AS n FROM memory_revisions').get().n;
    return { conversationId: this.conversationId, schemaVersion: SCHEMA_VERSION,
      directory: this.directory, dbPath: this.dbPath, ...counts };
  }
  close() { if (!this.#closed) { this.#db.close(); this.#closed = true; } }
}
