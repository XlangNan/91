import assert from "node:assert/strict";
import test from "node:test";

import {
  changedCredentialValues,
  driveCredentialError,
  driveCredentialsForForm,
  newDriveCredentialError,
} from "../src/admin/drive/credentials.ts";

test("local storage has no extra credential rules", () => {
  assert.equal(driveCredentialError("localstorage", { path: "/media" }, true), "");
  assert.equal(newDriveCredentialError("localstorage", { path: "/media" }), "");
  assert.deepEqual(driveCredentialsForForm("localstorage", { path: "/media" }), { path: "/media" });
});

test("credential edit payload contains only changed editable values", () => {
  const initial = {
    username: "old-user",
    password: "old-password",
    refresh_token: "old-refresh",
    access_token: "runtime-access",
    captcha_token: "runtime-captcha",
    device_id: "runtime-device",
  };
  const current = {
    ...initial,
    username: "new-user",
    access_token: "newer-runtime-access",
  };

  assert.deepEqual(
    changedCredentialValues(current, initial, [
      "refresh_token",
      "username",
      "password",
    ]),
    { username: "new-user" }
  );
});

test("unchanged credentials produce an empty edit patch", () => {
  const credentials = {
    refresh_token: "refresh",
    access_token: "access",
    captcha_token: "captcha",
    device_id: "device",
  };
  assert.deepEqual(
    changedCredentialValues(credentials, credentials, [
      "refresh_token",
      "username",
      "password",
    ]),
    {}
  );
});
