// jsdom ships no types and @types/jsdom is not installed; only what the tests and fixture tools use.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string);
    window: { DOMParser: typeof DOMParser };
  }
}
