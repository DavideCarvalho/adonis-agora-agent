// `@types/jsdom` pulls the whole DOM lib into the project, which retypes Node's `fetch` for every
// other spec. The React specs use this much of it.
declare module 'jsdom' {
  export interface PageElement {
    setAttribute(name: string, value: string): void;
    remove(): void;
  }
  export interface PageDocument {
    cookie: string;
    head: { appendChild(element: PageElement): void };
    createElement(tag: string): PageElement;
  }
  export class JSDOM {
    constructor(html?: string, options?: { url?: string; pretendToBeVisual?: boolean });
    readonly window: { document: PageDocument };
  }
}
