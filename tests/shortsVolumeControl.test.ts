import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createElement } from "react";
import { act, fireEvent, render } from "./helpers/dom";
import { ShortsVolumeControl } from "../src/shorts/ShortsVolumeControl";

function setup(t: TestContext) {
  let muted = false;
  let keyboardFocus = false;
  const tree = () => createElement(ShortsVolumeControl, {
    muted,
    volume: 1,
    onToggleMute() { muted = !muted; view.rerender(tree()); },
    onVolumeChange() {},
  });
  const view = render(tree());
  const wrapper = view.container.querySelector<HTMLElement>(".shorts-volume-control")!;
  const trigger = view.getByRole("button");
  const slider = view.container.querySelector<HTMLInputElement>('input[type="range"]')!;
  const matches = trigger.matches.bind(trigger);
  t.mock.method(trigger, "matches", (selector: string) => selector === ":focus-visible" ? keyboardFocus : matches(selector));
  const sliderMatches = slider.matches.bind(slider);
  t.mock.method(slider, "matches", (selector: string) => selector === ":focus-visible" || sliderMatches(selector));
  t.after(() => view.unmount());
  return {
    get open() { return !view.container.querySelector<HTMLElement>(".shorts-volume-control__panel")!.hidden; },
    get label() { return trigger.getAttribute("aria-label"); },
    enter() { fireEvent(wrapper, Object.assign(new Event("pointerover", { bubbles: true }), { pointerType: "mouse" })); },
    leave() { fireEvent(wrapper, Object.assign(new Event("pointerout", { bubbles: true }), { pointerType: "mouse" })); },
    focus(keyboard: boolean) { keyboardFocus = keyboard; act(() => trigger.focus()); },
    focusSlider() { act(() => slider.focus()); },
    blur(inside = false) {
      act(() => inside ? slider.focus() : (document.activeElement as HTMLElement).blur());
    },
    click() { fireEvent.click(trigger); },
    escape() { fireEvent.keyDown(wrapper, { key: "Escape" }); },
  };
}

test("returning to a pointer-focused mute button keeps the volume panel closed in either sound state", t => {
  const h = setup(t);
  for (const label of ["开启视频声音", "关闭视频声音"]) {
    h.enter();
    h.focus(false);
    h.click();
    assert.equal(h.label, label);
    h.leave();
    assert.equal(h.open, false);
    h.blur();
    h.focus(false);
    assert.equal(h.open, false, "restoring window focus must not reopen the panel");
  }
});

test("keyboard focus opens the panel and moving into the slider keeps it open", t => {
  const h = setup(t);
  h.focus(true);
  assert.equal(h.open, true);
  h.leave();
  assert.equal(h.open, true);
  h.blur(true);
  h.focusSlider();
  assert.equal(h.open, true);
  h.blur();
  assert.equal(h.open, false);
});

test("Escape closes the panel while a fresh mouse hover can open it again", t => {
  const h = setup(t);
  h.focus(true);
  h.escape();
  assert.equal(h.open, false);
  h.focus(false);
  assert.equal(h.open, false);
  h.enter();
  assert.equal(h.open, true);
  h.leave();
  assert.equal(h.open, false);
});
