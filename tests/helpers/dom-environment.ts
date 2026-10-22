import { after } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

for (const name of [
  "window", "document", "navigator", "Node", "HTMLElement", "HTMLButtonElement",
  "HTMLInputElement", "HTMLVideoElement", "Event", "EventTarget", "MouseEvent",
  "KeyboardEvent", "FocusEvent", "CustomEvent", "MutationObserver", "DOMException",
] as const) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: dom.window[name],
    writable: true,
  });
}

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
  writable: true,
});
Object.defineProperties(dom.window.document, {
  hidden: { configurable: true, value: false, writable: true },
  visibilityState: { configurable: true, value: "visible", writable: true },
});
dom.window.matchMedia = (query: string) => Object.assign(new dom.window.EventTarget(), {
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
});

after(() => dom.window.close());
