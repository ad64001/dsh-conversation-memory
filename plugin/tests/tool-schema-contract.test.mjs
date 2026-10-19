import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationMemoryBridge, toolDefinitions } from '../lib/index.mjs';

// Keep the production bridge validators and tool execute wrappers. Replace only
// worker transport so a schema contract test cannot start workers or models.
function fixture() {
  const bridge = new ConversationMemoryBridge({});
  const forwarded = [];
  bridge.flush = async () => {};
  bridge.ensure = async () => ({});
  bridge.rpc = async (_entry, operation, args) => {
    forwarded.push({ operation, args });
    return operation === 'index'
      ? { calls: 0, added: [], existing: [], rejected: [], pending: [], sourceRefs: [], coverage: [], status: {} }
      : { text: 'transport reached' };
  };
  return { definitions: new Map(toolDefinitions(bridge).map(definition => [definition.name, definition])), forwarded,
    exec: { agent: { session: { id: 'schema-contract' } }, signal: new AbortController().signal } };
}

test('published numeric schema boundaries and defaults reach the real executor validators', async () => {
  const { definitions, forwarded, exec } = fixture();
  const fields = [
    ['memory_search', { query: 'checkpoint_nonce' }, 'limit'],
    ['memory_search', { query: 'checkpoint_nonce' }, 'maxChars'],
    ['memory_read', { ref: 1 }, 'ref'],
    ['memory_read', { ref: 1 }, 'start'],
    ['memory_read', { ref: 1 }, 'maxChars'],
    ['memory_index', {}, 'maxCalls'],
  ];
  for (const [name, base, field] of fields) {
    const definition = definitions.get(name), schema = definition.parameters.properties[field];
    assert.equal(schema.type, 'integer');
    assert.ok(Number.isSafeInteger(schema.minimum), `${name}.${field} must publish its lower bound`);
    assert.ok(Number.isSafeInteger(schema.maximum), `${name}.${field} must publish its upper bound`);
    const values = [...new Set([schema.minimum, schema.maximum, ...(schema.default === undefined ? [] : [schema.default])])];
    for (const value of values) {
      const before = forwarded.length;
      await definition.execute({ ...base, [field]: value }, exec);
      assert.equal(forwarded.length, before + 1, `${name}.${field}=${value} must pass execution validation`);
      assert.equal(forwarded.at(-1).args[field], value);
    }
    if (schema.default !== undefined) {
      await definition.execute(base, exec);
      assert.equal(forwarded.at(-1).args[field], schema.default, `${name}.${field} default must match execution`);
    }
    for (const invalid of [schema.minimum - 1, schema.maximum + 1]) {
      const before = forwarded.length;
      await assert.rejects(definition.execute({ ...base, [field]: invalid }, exec), { code: 'INVALID_ARGUMENT' });
      assert.equal(forwarded.length, before, 'invalid parameters must not reach transport');
    }
  }
});

test('memory_read advertises the observed 6000-character rejection and preserves omitted-start semantics', async () => {
  const { definitions, forwarded, exec } = fixture();
  const read = definitions.get('memory_read'), schema = read.parameters.properties;
  assert.ok(6000 > schema.maxChars.maximum, 'the real failure must be excluded by the advertised schema');
  await assert.rejects(read.execute({ ref: 1, maxChars: 6000 }, exec), { code: 'INVALID_ARGUMENT' });
  assert.equal(Object.hasOwn(schema.start, 'default'), false, 'omitted start follows the cited fragment, not offset zero');
  await read.execute({ ref: 1 }, exec);
  assert.equal(forwarded.at(-1).args.start, undefined);
});

test('query schema admits valid Unicode limits and excludes the queries rejected before transport', async () => {
  const { definitions, forwarded, exec } = fixture();
  for (const name of ['memory_search', 'memory_index']) {
    const definition = definitions.get(name), schema = definition.parameters.properties.query;
    assert.equal(schema.type, 'string');
    assert.ok(Number.isSafeInteger(schema.minLength) && Number.isSafeInteger(schema.maxLength));
    const pattern = new RegExp(schema.pattern, 'u');
    for (const query of ['x'.repeat(schema.minLength), '😀'.repeat(schema.maxLength)]) {
      assert.match(query, pattern);
      const before = forwarded.length;
      await definition.execute({ query }, exec);
      assert.equal(forwarded.length, before + 1);
    }
    for (const query of ['', ' \t\n', '😀'.repeat(schema.maxLength + 1)]) {
      const schemaRejects = Array.from(query).length < schema.minLength || Array.from(query).length > schema.maxLength || !pattern.test(query);
      assert.equal(schemaRejects, true);
      const before = forwarded.length;
      await assert.rejects(definition.execute({ query }, exec), { code: 'INVALID_QUERY' });
      assert.equal(forwarded.length, before);
    }
  }
});
