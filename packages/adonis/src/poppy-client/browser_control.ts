/**
 * The Browser Control extension, version 1 (Personal Agent side), for the browser this agent drives
 * on a Company's website (section 6). The Company marks steps it wants the User to take with
 * `data-poppy-user-step`; this agent leaves them to the User, offers the User control of the
 * browser, and tells the page who controls it through `navigator.poppy.controller`.
 *
 * It works with any driver that can run a script in every new document and evaluate one in the
 * current page, such as Playwright (`page.addInitScript`, `page.evaluate`) or the DevTools protocol
 * (`Page.addScriptToEvaluateOnNewDocument`, `Runtime.evaluate`). Marks are signals, not locks: the
 * Company's servers still decide (8.1).
 */
import type { CompanyClient } from './company.js';
import { PoppyError } from './errors.js';
import { randomId } from './util.js';

export const BROWSER_CONTROL_EXTENSION = 'browser-control';
export const BROWSER_CONTROL_VERSION = '1';
export const USER_STEP_ATTRIBUTE = 'data-poppy-user-step';

/** A browser this agent controls (never the User's own browser). */
export interface ControlledBrowser {
  /** Runs `source` in every new document, before the page's own scripts. */
  addInitScript(source: string): Promise<unknown>;
  /** Evaluates the expression `source` in the current page. */
  evaluate(source: string): Promise<unknown>;
}

/** The kind of browser action the agent's model wants to take. */
export type BrowserAction =
  /** Change a control's value: type, select, check. */
  | 'fill'
  /** Click or otherwise activate an element. */
  | 'activate'
  /** Submit a form, by any means (a submit button, Enter in a field, `form.submit()`). */
  | 'submit';

/** What the page says about the element an action targets (computed by `STEP_PROBE_SOURCE`). */
export interface StepProbe {
  /** `data-poppy-user-step` on the element or an element around it other than a form. */
  elementMark: string | null;
  /** `data-poppy-user-step` on the element's form owner (the form itself for a form). */
  formMark: string | null;
  kind: 'field' | 'submit' | 'button' | 'form' | 'other';
}

export type UserStepKind = 'interaction' | 'submission';

/**
 * In-page probe, as a function expression taking the target element. It finds the element an action
 * really reaches (a button around a span), the marks on it and around it, and its form owner,
 * including a control outside the form that names it in its `form` attribute (section 4).
 */
export const STEP_PROBE_SOURCE = `(el) => {
  const MARK = ${JSON.stringify(USER_STEP_ATTRIBUTE)};
  if (!el || el.nodeType !== 1) return { elementMark: null, formMark: null, kind: 'other' };
  const target = (el.closest && el.closest('button, input, select, textarea, option, a, form, [role=button], [contenteditable]')) || el;
  const isForm = target.tagName === 'FORM';
  let elementMark = null;
  for (let n = target; n && n.nodeType === 1; n = n.parentElement) {
    if (n.tagName === 'FORM') continue;
    if (n.hasAttribute(MARK)) { elementMark = n.getAttribute(MARK); break; }
  }
  const form = isForm ? target : (target.form || (target.closest ? target.closest('form') : null));
  const formMark = form && form.hasAttribute(MARK) ? form.getAttribute(MARK) : null;
  const tag = target.tagName;
  const type = (target.getAttribute('type') || '').toLowerCase();
  let kind = 'other';
  if (isForm) kind = 'form';
  else if ((tag === 'BUTTON' && (type === '' || type === 'submit')) || (tag === 'INPUT' && (type === 'submit' || type === 'image'))) kind = 'submit';
  else if (tag === 'BUTTON' || (tag === 'INPUT' && (type === 'button' || type === 'reset'))) kind = 'button';
  else if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'OPTION' || target.isContentEditable) kind = 'field';
  return { elementMark, formMark, kind };
}`;

/** The probe as a function, for a DOM in this process (jsdom, tests). */
export const stepProbe = new Function(`return ${STEP_PROBE_SOURCE}`)() as (
  el: unknown,
) => StepProbe;

/**
 * Whether the agent may take `action` (section 4): a marked control is the User's to change or
 * activate; a form marked `interaction` leaves its controls and its submission to the User; a form
 * marked `submission` lets the agent fill its controls but leaves submitting it to the User. A value
 * other than `interaction` or `submission`, or `submission` on anything but a form, is
 * `interaction`.
 */
export function userStepFor(probe: StepProbe, action: BrowserAction): UserStepKind | null {
  if (probe.elementMark !== null && probe.kind !== 'form') return 'interaction';
  if (probe.formMark === null) return null;
  if (probe.formMark !== 'submission') return 'interaction';
  if (action === 'submit' || probe.kind === 'form' || probe.kind === 'submit') return 'submission';
  // A submission form: its fields can be filled (clicking a checkbox is filling it); other buttons
  // may submit it from a script, so they are left to the User too.
  if (probe.kind === 'field' && (action === 'fill' || action === 'activate')) return null;
  return 'submission';
}

/** A browser action the agent's model must not take (section 5). */
export class BrowserControlError extends PoppyError {
  constructor(
    code: 'user_step' | 'held_by_user',
    message: string,
    readonly step?: UserStepKind | undefined,
  ) {
    super(code, message);
    this.name = 'BrowserControlError';
  }
}

/** `navigator.poppy`, only on the hosts of `organization.domain` and its subdomains (section 6). */
function controllerScript(domain: string, setter: string): string {
  const host = domain.toLowerCase().replace(/:\d+$/, '');
  return `(() => {
  const home = ${JSON.stringify(host)};
  const host = location.hostname.toLowerCase();
  if (host !== home && !host.endsWith('.' + home)) return;
  if (Object.prototype.hasOwnProperty.call(window, ${JSON.stringify(setter)})) return;
  let controller = 'agent';
  const poppy = Object.freeze(Object.create(Object.prototype, {
    controller: { get: () => controller, enumerable: true },
  }));
  Object.defineProperty(navigator, 'poppy', { get: () => poppy, enumerable: false, configurable: false });
  Object.defineProperty(window, ${JSON.stringify(setter)}, {
    value: (v) => { if (v === 'user' || v === 'agent') controller = v; },
    enumerable: false, configurable: false, writable: false,
  });
})();`;
}

function setterCall(setter: string, controller: 'user' | 'agent'): string {
  return `(() => { const f = window[${JSON.stringify(setter)}]; if (typeof f === 'function') f(${JSON.stringify(controller)}); })()`;
}

/**
 * Browser Control for one browser joined to a Session at one Company. Attach it before browsing;
 * call `guard` before every browser action the model asks for.
 *
 * ```ts
 * const control = new BrowserControl(company, {
 *   addInitScript: (s) => page.addInitScript(s),
 *   evaluate: (s) => page.evaluate(s),
 * }, { onUserStep: (step) => tellTheUser(step) });
 * await control.attach();
 * await control.guard({ evaluate: (src) => page.locator('#check-in').evaluate(new Function(`return ${src}`)()) }, 'activate');
 * ```
 */
export class BrowserControl {
  #controller: 'agent' | 'user' = 'agent';
  /** The page can't guess the setter's name; the value still isn't a guarantee (8.2). */
  readonly #setter = `__poppy_controller_${randomId('', 12).replace(/-/g, '_')}`;
  #attached = false;

  constructor(
    readonly company: CompanyClient,
    readonly browser: ControlledBrowser,
    readonly options: {
      /** Called when a marked step is the User's: tell them, and offer them control (section 5). */
      onUserStep?: ((step: { kind: UserStepKind; action: BrowserAction }) => void) | undefined;
    } = {},
  ) {}

  /** Whether this agent declares Browser Control version 1 to the Company (section 3). */
  get declared(): boolean {
    return this.company.declaredExtensions[BROWSER_CONTROL_EXTENSION] === BROWSER_CONTROL_VERSION;
  }

  /** `user` while the User holds control, `agent` otherwise (section 6). */
  get controller(): 'agent' | 'user' {
    return this.#controller;
  }

  /**
   * Provides `navigator.poppy.controller` in the browser, on the Company's hosts only, when the
   * Session declares this extension (section 6). Without it, `navigator.poppy` stays undefined.
   */
  async attach(): Promise<void> {
    if (this.#attached || !this.declared) return;
    this.#attached = true;
    const script = controllerScript(this.company.document.organization.domain, this.#setter);
    await this.browser.addInitScript(script);
    await this.browser.evaluate(script).catch(() => {});
  }

  async #set(controller: 'agent' | 'user') {
    this.#controller = controller;
    if (!this.#attached) return;
    // A script added later runs later in every new document: the latest value wins there too.
    const call = setterCall(this.#setter, controller);
    await this.browser.addInitScript(call);
    await this.browser.evaluate(call).catch(() => {});
  }

  /**
   * Hands control to the User (section 5). Until they hand it back, `guard` refuses every action of
   * the model; this agent's own requests and its conversation with the User go on meanwhile.
   */
  async handToUser(): Promise<void> {
    await this.#set('user');
  }

  /**
   * The User hands control back (or cancels). Wire it ONLY to the User's own action: no timeout, page
   * change or anything the Company sends ends their control. Look at the page again before going on.
   */
  async userHandsBack(): Promise<void> {
    await this.#set('agent');
  }

  /**
   * Checks an action the model wants to take on an element. `target.evaluate(source)` runs the probe
   * function expression on that element (Playwright: `locator.evaluate(new Function(...))`), or pass
   * a `StepProbe` you computed. Throws `held_by_user` while the User holds control and `user_step`
   * when a mark leaves the step to the User, after telling `onUserStep`.
   */
  async guard(
    target: StepProbe | { evaluate(source: string): Promise<unknown> },
    action: BrowserAction,
  ): Promise<void> {
    if (this.#controller === 'user') {
      throw new BrowserControlError(
        'held_by_user',
        'the User holds control of the browser: wait until they hand it back',
      );
    }
    const probe =
      'evaluate' in target ? ((await target.evaluate(STEP_PROBE_SOURCE)) as StepProbe) : target;
    const step = userStepFor(probe, action);
    if (step === null) return;
    this.options.onUserStep?.({ kind: step, action });
    throw new BrowserControlError(
      'user_step',
      step === 'submission'
        ? 'the Company asks the User to submit this form: offer them control of the browser'
        : 'the Company asks the User to take this step: offer them control of the browser',
      step,
    );
  }
}
