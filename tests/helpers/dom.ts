import "./dom-environment";
import { afterEach } from "node:test";
import { cleanup } from "@testing-library/react/pure";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.hidden = false;
  document.visibilityState = "visible";
  window.localStorage.clear();
  window.sessionStorage.clear();
});

export { act, fireEvent, render, screen, within } from "@testing-library/react/pure";
