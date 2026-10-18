import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { ShortsVolumeControl } from "../src/shorts/ShortsVolumeControl";

function setup(t: TestContext) {
  let muted = false;
  let keyboardFocus = false;
  let renderer: ReturnType<typeof create>;
  const wrapper = () => renderer.root.findByProps({ className: "shorts-volume-control" });
  const trigger = {
    matches: () => keyboardFocus,
    focus() { wrapper().props.onFocus({ target: trigger }); },
  };
  const slider = { matches: () => true };
  const container = { contains: (target: unknown) => target === trigger || target === slider };
  const render = () => createElement(ShortsVolumeControl, {
    muted,
    volume: 1,
    onToggleMute() { muted = !muted; renderer.update(render()); },
    onVolumeChange() {},
  });
  act(() => {
    renderer = create(render(), { createNodeMock: element => element.type === "button" ? trigger : null });
  });
  t.after(() => act(() => renderer.unmount()));
  return {
    get open() { return !renderer.root.findByProps({ className: "shorts-volume-control__panel" }).props.hidden; },
    get label() { return renderer.root.findByType("button").props["aria-label"]; },
    enter() { act(() => wrapper().props.onPointerEnter({ pointerType: "mouse" })); },
    leave() { act(() => wrapper().props.onPointerLeave({ pointerType: "mouse" })); },
    focus(keyboard: boolean) {
      keyboardFocus = keyboard;
      act(() => trigger.focus());
    },
    focusSlider() { act(() => wrapper().props.onFocus({ target: slider })); },
    blur(inside = false) {
      act(() => wrapper().props.onBlur({ currentTarget: container, relatedTarget: inside ? slider : null }));
    },
    click() { act(() => renderer.root.findByType("button").props.onClick({ preventDefault() {} })); },
    escape() { act(() => wrapper().props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} })); },
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
