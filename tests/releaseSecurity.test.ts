import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as {
  allowScripts?: Record<string, boolean>;
  engines?: Record<string, string>;
  packageManager?: string;
  scripts?: Record<string, string>;
};
const nodeVersion = readFileSync(
  new URL("../.nvmrc", import.meta.url),
  "utf8"
).trim();
const dockerfile = readFileSync(
  new URL("../Dockerfile", import.meta.url),
  "utf8"
);
const dockerWorkflow = readFileSync(
  new URL("../.github/workflows/docker-build.yml", import.meta.url),
  "utf8"
);
const releaseWorkflow = readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8"
);
const releaseScript = readFileSync(
  new URL("../scripts/build-release.sh", import.meta.url),
  "utf8"
);

test("frontend verification rejects every npm audit finding before release", () => {
  assert.deepEqual(packageJson.allowScripts, {
    "esbuild@0.28.1": true,
    "fsevents@2.3.3": true,
  });
  assert.equal(packageJson.scripts?.audit, "npm audit --audit-level=info");
  assert.equal(
    packageJson.scripts?.check,
    "npm run audit && npm run lint && npm test"
  );
  assert.equal(packageJson.scripts?.verify, "npm run check && npm run build");
  assert.match(
    releaseScript,
    /npm --prefix "\$ROOT_DIR" run verify/
  );
});

test("container and release builds use supported Node and run checks", () => {
  assert.match(nodeVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(packageJson.engines?.node, `^${nodeVersion}`);
  assert.match(packageJson.packageManager ?? "", /^npm@\d+\.\d+\.\d+$/);
  assert.equal(packageJson.engines?.npm, `^${packageJson.packageManager!.slice(4)}`);
  assert.ok(dockerfile.includes(`FROM node:${nodeVersion}-slim AS frontend\n`));
  assert.match(dockerfile, /^COPY package\.json package-lock\.json \.npmrc \.\/$/m);
  assert.match(dockerWorkflow, /node-version-file: \.nvmrc/);
  assert.match(releaseWorkflow, /node-version-file: \.nvmrc/);
  const jobs = parse(dockerWorkflow).jobs;
  assert.ok(jobs.prepare.steps.some((step: { run?: string }) => step.run === "npm run check"));
  assert.equal(jobs.build.needs, "prepare", "Image builds must wait for frontend checks");
  assert.deepEqual(jobs.publish.needs, ["prepare", "build"], "Publishing must wait for both architectures");
});
