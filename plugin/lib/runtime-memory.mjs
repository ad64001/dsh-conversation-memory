import { createHash, randomUUID } from 'node:crypto';

export const MEMORY_SECTION = 'conversation-memory:evidence';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = code => Object.assign(new Error(`Conversation memory surface: ${code}`), { code });
const PREFIX = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n';
const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.';
export const renderRuntime = sections => sections.length ? PREFIX + sections.map(s => s.text).join('\n\n') : CLEARED;

/** Only named own-memory sections are owned. All other source metadata, sections
 * and their order stay exact. User originals and compact checkpoints never match. */
export async function memorySurface(session) {
  const events = Array.from(await session.snapshotEvents());
  const bySeq = new Map(events.map(event => [event.seq, event]));
  const nodes = [...session.surface.nodes];
  const runtimes = [];
  for (const seq of nodes) {
    const event = bySeq.get(seq);
    if (event?.type !== 'user/message' || event.data?.source?.kind !== 'runtime-context') continue;
    const message = event.data, sections = message.source.sections;
    if (!Array.isArray(sections) || sections.some(s => typeof s?.name !== 'string' || typeof s.text !== 'string')) continue;
    const owned = sections.filter(s => s.name === MEMORY_SECTION && s.text.length);
    if (owned.length > 1 || message.content.length !== 1 || message.content[0].type !== 'text'
      || message.content[0].text !== renderRuntime(sections)) {
      if (owned.length) throw failure('MEMORY_SURFACE_UNRECOGNIZED');
      continue;
    }
    runtimes.push({ seq, message, sections, owned: owned[0]?.text ?? '' });
  }
  return { events, nodes, runtimes, slots: runtimes.filter(n => n.owned),
    fingerprint: digest(nodes.map(seq => [seq, bySeq.get(seq)])) };
}

/** Strip the fixed plugin policy envelope, never semantic evidence. Legacy
 * snapshots have a documented evidence heading; unknown envelopes remain exact. */
export function evidenceBody(text, instructions) {
  if (text === instructions) return '';
  if (text.startsWith(instructions + '\n')) return text.slice(instructions.length + 1);
  // Unknown/older policy envelopes stay whole for the MODEL to assess. A marker
  // could occur inside a quoted user correction and is not a deletion boundary.
  return text;
}

function updatesFor(view, canonicalText) {
  const target = canonicalText ? view.runtimes.at(-1) : null;
  const updates = [];
  for (const runtime of view.runtimes) {
    if (!runtime.owned && runtime !== target) continue;
    let inserted = false;
    const sections = runtime.sections.flatMap(section => {
      if (section.name !== MEMORY_SECTION) return [{ ...section }];
      if (runtime === target && !inserted) { inserted = true; return [{ name: MEMORY_SECTION, text: canonicalText }]; }
      return [];
    });
    if (runtime === target && !inserted) sections.push({ name: MEMORY_SECTION, text: canonicalText });
    const text = renderRuntime(sections);
    if (text !== runtime.message.content[0].text || JSON.stringify(sections) !== JSON.stringify(runtime.sections)) updates.push({ runtime, sections, text });
  }
  if (!updates.length) return [];
  // RuntimeContextProjection treats the last runtime replacement as retained.
  // Always finish at the logically latest runtime, even when it had no own slot.
  const latest = view.runtimes.at(-1);
  const index = updates.findIndex(update => update.runtime === latest);
  if (index >= 0) updates.push(...updates.splice(index, 1));
  else if (latest) updates.push({ runtime: latest, sections: latest.sections.map(s => ({ ...s })), text: latest.message.content[0].text });
  return updates;
}

/** Apply only a MODEL-APPROVED relocation/consolidation. This helper makes no
 * content-selection decision. canonicalText='' moves the approved package out
 * just before native request admission; the unchanged provider supplies it once.
 * All old events remain append-only and sourceEventSeqs preserve provenance. */
export async function commitMemorySurface(session, view, canonicalText, { signal, approved = false, guard } = {}) {
  if (!approved) throw failure('MEMORY_DEDUP_APPROVAL_REQUIRED');
  if (typeof canonicalText !== 'string' || !canonicalText.isWellFormed()) throw failure('MEMORY_DEDUP_INVALID_CANONICAL');
  signal?.throwIfAborted();
  guard?.();
  const updates = updatesFor(view, canonicalText);
  if (!updates.length) return { replacements: [], canonicalStored: !!canonicalText, beforeSlots: view.slots.length };
  const current = await memorySurface(session);
  if (current.fingerprint !== view.fingerprint) throw failure('MEMORY_DEDUP_STALE');
  if (typeof session.constructor.create !== 'function') throw failure('MEMORY_SURFACE_PREVIEW_UNAVAILABLE');
  // A detached replay validates the whole plan before touching the live log.
  const preview = session.constructor.create(session.id, current.events, session.header,
    session.inheritedEventCount ?? 0, session.surface.projections ?? []);
  const operations = updates.map(({ runtime, sections, text }) => ({
    data: { ...runtime.message, id: randomUUID(), content: [{ type: 'text', text }],
      source: { ...runtime.message.source, sections } },
    intent: { surfaceOp: { op: 'replace', startSeq: runtime.seq, endSeq: runtime.seq }, sourceEventSeqs: [runtime.seq] },
    originalSeq: runtime.seq,
  }));
  for (const operation of operations) preview.append('user/message', operation.data, operation.intent);
  signal?.throwIfAborted();
  // No await after the final check. An unrelated surface update cannot interleave
  // with these commits, and native Session accepts the same validated operations.
  if (digest([...session.surface.nodes].map(seq => [seq, current.events.find(e => e.seq === seq)])) !== current.fingerprint) throw failure('MEMORY_DEDUP_STALE');
  guard?.();
  const replacements = [];
  for (const operation of operations) {
    const event = session.append('user/message', operation.data, operation.intent);
    replacements.push({ sourceSeq: operation.originalSeq, seq: event.seq });
  }
  return { replacements, canonicalStored: !!canonicalText, beforeSlots: view.slots.length };
}
