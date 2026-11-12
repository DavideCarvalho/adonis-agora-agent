/**
 * The authkit account console extension contract (version 1), declared STRUCTURALLY here: the agent
 * never imports `@adonis-agora/authkit-server`. authkit binds a registry at
 * `'authkit.accountExtensions'`; the agent registers its pages into it when it is there.
 *
 * Only the members the agent uses are declared; authkit's own types are a superset.
 */

/** The container binding authkit's registry lives at. */
export const ACCOUNT_EXTENSIONS_BINDING = 'authkit.accountExtensions';

/** A message key (looked up in the merged catalog) or literal text. Always escaped by authkit. */
export type Text = string | { key: string; params?: Record<string, string | number> };

export interface AccountExtension {
  readonly id: string;
  readonly contract: 1;
  messages?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  pages: readonly AccountPage[];
}

export interface AccountPage {
  id: string;
  segment: string;
  title: Text;
  nav?: { label?: Text; order?: number; group?: 'account' | 'billing' | 'ai' | 'content' } | false;
  visible?(ctx: AccountExtensionContext): boolean | Promise<boolean>;
  load(ctx: AccountExtensionContext): Promise<AccountPageView>;
  actions?: Readonly<Record<string, AccountAction>>;
}

export interface AccountExtensionContext {
  account: { id: string; email: string | null; name: string | null; roles: readonly string[] };
  activeOrg: { id: string; slug: string; role: string } | null;
  impersonatedBy: string | null;
  locale: string;
  query: { cursor?: string; tab?: string };
  url(pageId: string, query?: Record<string, string>): string;
  make(binding: string): Promise<unknown>;
  now(): Date;
  /**
   * The app user authkit's account mapping hook resolved for this account, when the host configured
   * one. Optional: an older authkit does not send it.
   */
  subject?: { id: string; type?: string } | null;
}

export interface AccountPageView {
  blocks: readonly Block[];
  tabs?: ReadonlyArray<{ id: string; label: Text }>;
}

export type Value =
  | { type: 'text'; text: Text }
  | { type: 'money'; amount: number; currency: string }
  | { type: 'date'; at: Date | string; style?: 'date' | 'datetime' | 'relative' }
  | { type: 'badge'; text: Text; tone?: 'neutral' | 'success' | 'warning' | 'danger' }
  | { type: 'number'; value: number; unit?: Text };

export type Block =
  | { kind: 'notice'; tone: 'info' | 'success' | 'warning' | 'danger'; text: Text }
  | {
      kind: 'keyValue';
      title?: Text;
      rows: ReadonlyArray<{ label: Text; value: Value }>;
      actions?: ActionRef[];
    }
  | {
      kind: 'list';
      title?: Text;
      empty: Text;
      items: ReadonlyArray<ListItem>;
      nextCursor?: string | null;
    }
  | {
      kind: 'meter';
      label: Text;
      used: number;
      limit: number | null;
      unit?: Text;
      resetsAt?: Date | string;
    }
  | { kind: 'actions'; items: ActionRef[] }
  | { kind: 'link'; label: Text; href: string; external?: boolean };

export interface ListItem {
  title: Text;
  subtitle?: Text;
  meta?: Value[];
  badge?: Value;
  href?: string;
  external?: boolean;
  actions?: ActionRef[];
}

export interface ActionRef {
  action: string;
  target?: string;
}

export interface AccountAction {
  label: Text;
  tone?: 'default' | 'danger';
  confirm?: Text;
  sudo?: boolean;
  fields?: ReadonlyArray<{
    name: string;
    label: Text;
    kind: 'text' | 'select' | 'textarea';
    required?: boolean;
    maxLength?: number;
  }>;
  handle(
    ctx: AccountExtensionContext,
    input: { target: string | null; fields: Record<string, string> },
  ): Promise<AccountActionResult>;
}

export type AccountActionResult =
  | { ok: true; flash?: Text; redirectTo?: { page: string } | { external: string } }
  | { ok: false; error: Text; status?: 400 | 403 | 404 | 409 };

/** The registry authkit binds. */
export interface AccountExtensionRegistry {
  readonly contract: number;
  readonly blockKinds?: readonly string[];
  register(extension: AccountExtension): void;
}
