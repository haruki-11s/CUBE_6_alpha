import { sound } from './sound';
import { icon } from './icons';

export interface ModalAction {
  label: string;
  kind?: 'primary' | 'ok' | 'danger' | 'ghost';
  /** Return false to keep the modal open. */
  onClick?: () => void | boolean;
  autofocus?: boolean;
}

export interface ModalOptions {
  title?: string;
  /** Small English label after the title ("SETTINGS"), as on the title menu. */
  subtitle?: string;
  content: string | HTMLElement;
  actions?: ModalAction[];
  /** A second, smaller window shown under the dialog (same backdrop, closes with it). */
  aside?: string | HTMLElement;
  closable?: boolean;
  className?: string;
  onClose?: () => void;
}

export interface ModalHandle {
  el: HTMLElement;
  /** The `aside` window, when there is one. */
  aside: HTMLElement | null;
  close: () => void;
}

let openCount = 0;
export function isModalOpen(): boolean { return openCount > 0; }

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])';

export function openModal(o: ModalOptions): ModalHandle {
  const closable = o.closable ?? true;
  const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  const dlg = document.createElement('div');
  dlg.className = `modal${o.className ? ` ${o.className}` : ''}`;
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');

  if (o.title) {
    const id = `modal-${Math.random().toString(36).slice(2, 9)}`;
    const h = document.createElement('h2');
    h.className = 'modal-title';
    h.id = id;
    h.textContent = o.title;
    if (o.subtitle) {
      const sub = document.createElement('small');
      sub.className = 'modal-sub';
      sub.textContent = o.subtitle;
      h.appendChild(sub);
    }
    dlg.appendChild(h);
    dlg.setAttribute('aria-labelledby', id);
  }
  if (closable) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'modal-x';
    x.setAttribute('aria-label', '閉じる');
    x.innerHTML = icon('close');
    x.addEventListener('click', () => close());
    dlg.appendChild(x);
  }

  const body = document.createElement('div');
  body.className = 'modal-body';
  if (typeof o.content === 'string') body.innerHTML = o.content;
  else body.appendChild(o.content);
  dlg.appendChild(body);

  let focusTarget: HTMLElement | null = null;
  if (o.actions?.length) {
    const row = document.createElement('div');
    row.className = 'modal-actions';
    for (const a of o.actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn ${a.kind ?? 'ghost'}`;
      b.textContent = a.label;
      b.addEventListener('click', () => {
        sound.click();
        if (a.onClick?.() === false) return;
        close();
      });
      if (a.autofocus || (!focusTarget && a.kind === 'primary')) focusTarget = b;
      row.appendChild(b);
    }
    dlg.appendChild(row);
  }

  // with an aside, both windows sit in one column and Tab cycles through both
  let trap: HTMLElement = dlg;
  let side: HTMLElement | null = null;
  if (o.aside) {
    side = document.createElement('div');
    side.className = 'modal modal-aside';
    if (typeof o.aside === 'string') side.innerHTML = o.aside;
    else side.appendChild(o.aside);
    const stack = document.createElement('div');
    stack.className = 'modal-stack';
    stack.append(dlg, side);
    back.appendChild(stack);
    trap = stack;
  } else {
    back.appendChild(dlg);
  }
  document.body.appendChild(back);
  openCount++;
  requestAnimationFrame(() => back.classList.add('show'));
  sound.open();

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    openCount = Math.max(0, openCount - 1);
    document.removeEventListener('keydown', onKey, true);
    back.classList.remove('show');
    back.classList.add('closing');
    setTimeout(() => back.remove(), 220);
    sound.close();
    o.onClose?.();
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && closable) {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
      return;
    }
    if (e.key === 'Tab') {
      const items = [...trap.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener('keydown', onKey, true);
  // the empty space around the window(s) acts as the backdrop
  back.addEventListener('pointerdown', e => { if ((e.target === back || (side && e.target === trap)) && closable) close(); });

  const f: HTMLElement | null = focusTarget ?? dlg.querySelector<HTMLElement>(FOCUSABLE);
  setTimeout(() => f?.focus({ preventScroll: true }), 30);

  return { el: dlg, aside: side, close };
}
