import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createContext, createElement, useCallback, useContext, useEffect, type Dispatch, type SetStateAction } from "react";
import { act, create } from "react-test-renderer";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router";
import { AdminRouteCache, useAdminRouteActive } from "../src/admin/AdminRouteCache";
import { useAdminPaginationSync } from "../src/admin/useAdminPaginationSync";
import { readAdminVideosPage, withAdminVideosPage } from "../src/admin/videosSearchParams";

type PaginationData = { pageSize: number; totalPages: number; settled: boolean };
const PaginationContext = createContext<PaginationData>({ pageSize: 16, totalPages: 10, settled: true });

function harness(t: TestContext, initialPath: string, initialData: Partial<PaginationData> = {}) {
  let data = { pageSize: 16, totalPages: 10, settled: true, ...initialData };
  let location!: ReturnType<typeof useLocation>;
  let navigate!: ReturnType<typeof useNavigate>;
  let cachedPage = 0;
  let mounts = 0;
  const writes: number[] = [];

  function Videos() {
    const active = useAdminRouteActive();
    const pagination = useContext(PaginationContext);
    const [params, setParams] = useSearchParams();
    const page = readAdminVideosPage(params);
    cachedPage = page;
    const setPage = useCallback<Dispatch<SetStateAction<number>>>((value) => {
      setParams((previous) => {
        const currentPage = readAdminVideosPage(previous);
        const nextPage = typeof value === "function" ? value(currentPage) : value;
        writes.push(nextPage);
        return withAdminVideosPage(previous, nextPage);
      }, { replace: true });
    }, [setParams]);
    useAdminPaginationSync({ active, page, ...pagination, setPage });
    useEffect(() => { mounts += 1; }, []);
    return null;
  }

  function App() {
    location = useLocation();
    navigate = useNavigate();
    return createElement(Routes, null,
      createElement(Route, { path: "/admin", element: createElement(AdminRouteCache) },
        createElement(Route, { path: "videos", element: createElement(Videos) }),
        ...["logs", "tags", "users"].map(path => createElement(Route, { key: path, path, element: createElement("div", null, path) })),
      ),
    );
  }

  const tree = () => createElement(PaginationContext.Provider, { value: data },
    createElement(MemoryRouter, { initialEntries: [initialPath] }, createElement(App)),
  );
  let renderer!: ReturnType<typeof create>;
  act(() => { renderer = create(tree()); });
  t.after(() => { act(() => renderer.unmount()); });
  return {
    get path() { return location.pathname + location.search; },
    get cachedPage() { return cachedPage; },
    get mounts() { return mounts; },
    writes,
    navigate(path: string) { act(() => navigate(path)); },
    update(next: Partial<PaginationData>) {
      data = { ...data, ...next };
      act(() => renderer.update(tree()));
    },
  };
}

for (const path of ["/admin/logs", "/admin/tags", "/admin/users"]) {
  for (const [from, to] of [[16, 10], [10, 16]]) {
    test(`resizing a retained video page from ${from} to ${to} leaves ${path} active`, (t) => {
      const env = harness(t, "/admin/videos?source=drive%3Acloud&page=3", { pageSize: from });
      env.navigate(path);
      env.update({ pageSize: to });
      assert.equal(env.path, path);
      assert.equal(env.cachedPage, 3);
      assert.deepEqual(env.writes, []);

      env.navigate("/admin/videos?source=drive%3Acloud&page=3");
      assert.equal(env.path, "/admin/videos?source=drive%3Acloud");
      assert.equal(env.cachedPage, 1);
      assert.equal(env.mounts, 1, "the video page remains cached");
      assert.deepEqual(env.writes, [1]);
    });
  }
}

test("resizing a hidden first page does not write the current route", (t) => {
  const env = harness(t, "/admin/videos");
  env.navigate("/admin/logs");
  env.update({ pageSize: 10 });
  assert.equal(env.path, "/admin/logs");
  env.navigate("/admin/videos");
  assert.deepEqual(env.writes, []);
});

test("active video pagination resets on a capacity change and preserves its source", (t) => {
  const env = harness(t, "/admin/videos?source=telegram&page=4");
  env.update({ pageSize: 10 });
  assert.equal(env.path, "/admin/videos?source=telegram");
  assert.deepEqual(env.writes, [1]);
  env.update({ pageSize: 16 });
  assert.deepEqual(env.writes, [1], "an existing first page needs no URL replacement");
});

test("a retained blacklist preserves its page when its capacity is unchanged", (t) => {
  const path = "/admin/videos?tab=blacklist&page=3";
  const env = harness(t, path, { pageSize: 20 });
  env.navigate("/admin/logs");
  env.update({ pageSize: 20 });
  env.navigate(path);
  assert.equal(env.path, path);
  assert.deepEqual(env.writes, []);
});

test("out-of-range pagination waits for settled data and an active route", (t) => {
  const path = "/admin/videos?tab=blacklist&page=8";
  const env = harness(t, path, { pageSize: 20, totalPages: 1, settled: false });
  assert.equal(env.path, path);
  env.navigate("/admin/users");
  env.update({ totalPages: 3, settled: true });
  assert.equal(env.path, "/admin/users");
  assert.deepEqual(env.writes, []);

  env.navigate(path);
  assert.equal(env.path, "/admin/videos?tab=blacklist&page=3");
  assert.deepEqual(env.writes, [3]);
});

test("a capacity reset takes precedence over clamping an outdated page", (t) => {
  const env = harness(t, "/admin/videos?page=8");
  env.navigate("/admin/logs");
  env.update({ pageSize: 10, totalPages: 3 });
  assert.equal(env.path, "/admin/logs");
  env.navigate("/admin/videos?page=8");
  assert.equal(env.path, "/admin/videos");
  assert.deepEqual(env.writes, [1]);
});
