/** Minimal shape of an Accessibility.getFullAXTree node we care about. */
interface AxNode {
  backendDOMNodeId?: number;
  role?: { value?: string };
  name?: { value?: string };
  ignored?: boolean;
}

export interface AxTree {
  nodes: AxNode[];
}

export interface CompactSnapshot {
  /** ref string -> backendDOMNodeId */
  refs: Map<string, number>;
  /** Human-readable outline with [refN] role "name" lines. */
  outline: string;
}

/**
 * Compacts an AX tree to a ref list. Skips ignored nodes and nodes lacking a
 * backendDOMNodeId. Refs are sequential: ref1, ref2, ...
 */
export function compactAxTree(tree: AxTree): CompactSnapshot {
  const refs = new Map<string, number>();
  const lines: string[] = [];
  let n = 0;
  for (const node of tree.nodes ?? []) {
    if (node.ignored) continue;
    if (typeof node.backendDOMNodeId !== 'number') continue;
    const role = node.role?.value ?? 'unknown';
    const name = node.name?.value ?? '';
    n++;
    const ref = `ref${n}`;
    refs.set(ref, node.backendDOMNodeId);
    lines.push(`[${ref}] ${role} ${JSON.stringify(name)}`);
  }
  return { refs, outline: lines.join('\n') };
}
