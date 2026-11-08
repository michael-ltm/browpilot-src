// Element-level helpers for the ref-based tools. Elements are reached the way a
// pointer reaches them: scrolled into view, given time to stop moving, and
// hit-tested so a click never silently lands on an overlay. Form controls the
// pointer and keyboard cannot drive (native <select> popups, date pickers) are
// set the way Playwright does it, through the native value setter so React's and
// Vue's value tracking still sees the change.
import { ErrorCode } from '@browpilot/shared';
import { execCdp } from './types.js';
import type { ToolContext } from '../context.js';

export class ActionError extends Error {}

export class RefError extends Error {
  code = ErrorCode.STALE_REF;
}

/** What a node is, as far as filling and clicking care. */
export interface ElementInfo {
  /** text: typeable; toggle: checkbox/radio; select / option: native select;
   *  value: date-like/color/range input; file: file input; other: anything else. */
  kind: 'text' | 'toggle' | 'select' | 'option' | 'value' | 'file' | 'other';
  tag: string;
  type: string;
  multiline: boolean;
  readOnly: boolean;
  disabled: boolean;
  checked: boolean;
}

export interface Point {
  x: number;
  y: number;
}

type CallArg = { value: unknown } | { objectId: string };

interface CallResult<R> {
  result?: { value?: R; objectId?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/** Resolve a snapshot ref to its backendDOMNodeId or throw a stale-ref error. */
export function resolveRef(ctx: ToolContext, ref: string): number {
  const id = ctx.refs.get(ref);
  if (id === undefined) {
    throw new RefError(`stale or unknown ref "${ref}" — re-run browser_snapshot`);
  }
  return id;
}

/** A JS handle for a backend node, in the node's own frame. */
export async function resolveObject(ctx: ToolContext, tabId: number, backendNodeId: number): Promise<string> {
  let out: { object?: { objectId?: string } } | undefined;
  try {
    out = await execCdp(ctx, tabId, { method: 'DOM.resolveNode', params: { backendNodeId } });
  } catch {
    out = undefined;
  }
  const objectId = out?.object?.objectId;
  if (!objectId) throw new RefError('element is no longer in the page — re-run browser_snapshot');
  return objectId;
}

/** Runtime.callFunctionOn with `this` = objectId; returns the value (or a handle when byRef). */
export async function callOn<R>(
  ctx: ToolContext,
  tabId: number,
  objectId: string,
  functionDeclaration: string,
  args: CallArg[] = [],
  byRef = false,
): Promise<R> {
  const out = await execCdp<CallResult<R>>(ctx, tabId, {
    method: 'Runtime.callFunctionOn',
    params: { objectId, functionDeclaration, arguments: args, returnByValue: !byRef, awaitPromise: true },
  });
  if (out?.exceptionDetails) {
    const { exception, text } = out.exceptionDetails;
    // First line of "Error: message\n    at ..." is the message.
    const message = (exception?.description ?? text ?? 'page function threw').split('\n')[0] ?? '';
    throw new ActionError(message.replace(/^Error: /, ''));
  }
  return (byRef ? out?.result?.objectId : out?.result?.value) as R;
}

const INSPECT_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return { kind: 'other', tag: '', type: '', multiline: false, readOnly: false, disabled: false, checked: false };
  const tag = el.localName;
  const type = tag === 'input' ? (el.type || 'text') : '';
  let kind = 'other';
  if (tag === 'select') kind = 'select';
  else if (tag === 'option') kind = 'option';
  else if (tag === 'textarea') kind = 'text';
  else if (tag === 'input') {
    if (type === 'checkbox' || type === 'radio') kind = 'toggle';
    else if (type === 'file') kind = 'file';
    else if (['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(type)) kind = 'value';
    else if (!['button', 'submit', 'reset', 'image', 'hidden'].includes(type)) kind = 'text';
  } else if (el.isContentEditable) kind = 'text';
  // A wrapper around a text control (custom components): click it, type into what gets focus.
  else if (el.querySelector('textarea, [contenteditable=""], [contenteditable="true"], ' +
    'input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image])')) kind = 'text';
  return {
    kind, tag, type,
    multiline: tag === 'textarea' || el.isContentEditable,
    readOnly: !!el.readOnly,
    disabled: !!(el.matches && el.matches(':disabled')),
    checked: !!el.checked,
  };
}`;

export function inspect(ctx: ToolContext, tabId: number, objectId: string): Promise<ElementInfo> {
  return callOn<ElementInfo>(ctx, tabId, objectId, INSPECT_FN);
}

/**
 * Scroll the element into view if it is not fully visible and wait until its box
 * stops moving (transitions, smooth scrolling). Returns the element to aim at: the
 * element itself, the parent of a text node, or — for a control with no box of its
 * own, like a visually hidden custom checkbox input — its <label>.
 */
const PREPARE_FN = `async function () {
  let el = this.nodeType === 1 ? this : this.parentElement;
  if (!el || !el.isConnected) throw new Error('element is no longer in the page');
  const box = el.getBoundingClientRect();
  if ((box.width === 0 || box.height === 0) && el.labels && el.labels.length) el = el.labels[0];
  const r0 = el.getBoundingClientRect();
  if (r0.top < 0 || r0.left < 0 || r0.bottom > innerHeight || r0.right > innerWidth) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  }
  // requestAnimationFrame does not run in background tabs, so race it with a timer.
  const frame = () => new Promise((r) => { requestAnimationFrame(r); setTimeout(r, 50); });
  let last = '';
  for (let i = 0; i < 20; i++) {
    await frame();
    const r = el.getBoundingClientRect();
    const key = [r.x, r.y, r.width, r.height].join();
    if (key === last) break;
    last = key;
  }
  return el;
}`;

/** null when a click at the hit node reaches `this` (or one of its labels), else a description of the blocker. */
const HIT_FN = `function (hit) {
  const owners = [this, ...(this.labels || [])];
  for (let n = hit; n; n = n.parentNode || n.host || (n.defaultView && n.defaultView.frameElement)) {
    if (owners.includes(n)) return null;
  }
  if (hit.nodeType !== 1) return hit.nodeName;
  const cls = typeof hit.className === 'string' && hit.className.trim()
    ? '.' + hit.className.trim().split(/\\s+/).slice(0, 3).join('.') : '';
  return '<' + hit.localName + (hit.id ? '#' + hit.id : '') + cls + '>';
}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** First quad with real area -> its center. */
function quadCenter(quads: number[][] | undefined): Point | null {
  for (const q of quads ?? []) {
    if (q.length !== 8) continue;
    /* eslint-disable @typescript-eslint/no-non-null-assertion */
    const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
    const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
    /* eslint-enable @typescript-eslint/no-non-null-assertion */
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    if (w < 1 || h < 1) continue;
    return { x: xs.reduce((a, b) => a + b) / 4, y: ys.reduce((a, b) => a + b) / 4 };
  }
  return null;
}

/**
 * Where a real pointer would click the element. Retries for up to `timeoutMs`
 * while the element is invisible or covered (a dialog fading out, a spinner).
 * When it stays covered: throws, unless `force`, which aims at it anyway.
 */
export async function locate(
  ctx: ToolContext,
  tabId: number,
  objectId: string,
  backendNodeId: number,
  opts: { force?: boolean; timeoutMs?: number } = {},
): Promise<Point> {
  const deadline = Date.now() + (opts.timeoutMs ?? 2000);
  for (;;) {
    const target = await callOn<string>(ctx, tabId, objectId, PREPARE_FN, [], true);
    const quads = await execCdp<{ quads?: number[][] }>(ctx, tabId, {
      method: 'DOM.getContentQuads',
      params: { objectId: target },
    });
    const point = quadCenter(quads?.quads);
    let problem = 'is not visible (zero size, hidden, or display:none)';
    if (point) {
      const blocker = await blockerAt(ctx, tabId, target, backendNodeId, point);
      if (blocker === null || opts.force) return point;
      problem = `is covered by ${blocker} at (${Math.round(point.x)}, ${Math.round(point.y)})`;
    }
    if (Date.now() >= deadline) {
      throw new ActionError(
        `element ${problem}` + (point ? ' — close the overlay first, or pass force:true to click it anyway' : ''),
      );
    }
    await sleep(100);
  }
}

/** Hit-test the point: null when it reaches the target, else what is on top. */
async function blockerAt(
  ctx: ToolContext,
  tabId: number,
  target: string,
  backendNodeId: number,
  { x, y }: Point,
): Promise<string | null> {
  let hit: { backendNodeId?: number } | undefined;
  try {
    hit = await execCdp(ctx, tabId, {
      method: 'DOM.getNodeForLocation',
      params: { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false },
    });
  } catch {
    return null; // nothing hit-testable (e.g. a cross-process frame): don't block the click
  }
  if (!hit?.backendNodeId || hit.backendNodeId === backendNodeId) return null;
  try {
    const hitObject = await resolveObject(ctx, tabId, hit.backendNodeId);
    return await callOn<string | null>(ctx, tabId, target, HIT_FN, [{ objectId: hitObject }]);
  } catch {
    return null; // hit node lives in another frame's JS world; can't compare, assume reachable
  }
}

/** The deepest focused element (through shadow roots) and its editable content. */
const FOCUS_STATE_FN = `function () {
  let a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  const el = this.nodeType === 1 ? this : this.parentElement;
  const textual = (n) => n && (n.isContentEditable || n.localName === 'textarea' ||
    (n.localName === 'input' && !['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image', 'hidden', 'range', 'color'].includes(n.type)));
  const inside = !!a && !!el && (a === el || el.contains(a) || (el.labels && [...el.labels].includes(a)));
  return {
    focused: inside,
    editable: inside && textual(a),
    readOnly: !!(a && a.readOnly),
    value: !a ? '' : a.isContentEditable ? a.innerText : (a.value ?? ''),
  };
}`;

export interface FocusState {
  focused: boolean;
  editable: boolean;
  readOnly: boolean;
  value: string;
}

export function focusState(ctx: ToolContext, tabId: number, objectId: string): Promise<FocusState> {
  return callOn<FocusState>(ctx, tabId, objectId, FOCUS_STATE_FN);
}

/**
 * Choose an option of a native <select> (or the <select> owning an <option>):
 * match by value, then visible label, then a case-insensitive label substring.
 * The popup is browser UI that page input cannot reach, so like Playwright's
 * selectOption this sets the selection and fires input + change, which is what
 * React's onChange and Vue's v-model listen to.
 */
const SELECT_FN = `function (wanted) {
  const sel = this.localName === 'option' ? this.closest('select') : this;
  if (!sel) throw new Error('option is not inside a <select>');
  const opts = [...sel.options];
  const w = String(wanted ?? this.value).trim();
  const match = opts.find((o) => o.value === w) ||
    opts.find((o) => o.label.trim() === w) ||
    opts.find((o) => o.label.trim().toLowerCase().includes(w.toLowerCase()));
  if (!match) throw new Error('no option matching "' + w + '"; options: ' + opts.map((o) => o.label.trim()).join(' | '));
  if (match.disabled) throw new Error('option "' + match.label.trim() + '" is disabled');
  sel.focus();
  for (const o of opts) o.selected = o === match;
  sel.dispatchEvent(new Event('input', { bubbles: true }));
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return match.label.trim() + (match.value !== match.label.trim() ? ' (value "' + match.value + '")' : '');
}`;

export function selectOption(ctx: ToolContext, tabId: number, objectId: string, value?: string): Promise<string> {
  return callOn<string>(ctx, tabId, objectId, SELECT_FN, [{ value: value ?? null }]);
}

/**
 * Set a date/time/month/week/color/range input through HTMLInputElement's native
 * value setter (React tracks values by shadowing the instance property, so going
 * through the prototype lets onChange fire), then fire input + change.
 */
const NATIVE_VALUE_FN = `function (v) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  this.focus();
  setter.call(this, v);
  if (this.type !== 'range' && v !== '' && this.value !== v) {
    throw new Error('"' + v + '" is not a valid value for <input type=' + this.type + '>' +
      ({ date: ' (use YYYY-MM-DD)', time: ' (use HH:MM)', 'datetime-local': ' (use YYYY-MM-DDTHH:MM)',
         month: ' (use YYYY-MM)', week: ' (use YYYY-Www)', color: ' (use #rrggbb)' }[this.type] || ''));
  }
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return this.value;
}`;

export function setNativeValue(ctx: ToolContext, tabId: number, objectId: string, value: string): Promise<string> {
  return callOn<string>(ctx, tabId, objectId, NATIVE_VALUE_FN, [{ value }]);
}
