import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const installer = fileURLToPath(new URL("../install.sh", import.meta.url));
const template = fileURLToPath(new URL("../telegram.example.yml", import.meta.url));
const yamlPackage = fileURLToPath(new URL("../node_modules/yaml", import.meta.url));
const dockerPath = spawnSync("bash", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim();
const compose = dockerPath && spawnSync(dockerPath, ["compose", "version"], { encoding: "utf8" });
const requiresCompose = { skip: !compose || compose.status !== 0 ? "Docker Compose is required for configuration parsing" : false };
const apiID = "12345";
const apiHash = "0123456789abcdef0123456789abcdef";
const botImage = `sha256:${"a".repeat(64)}`;
type Call = { command: string; args: string[] };

// Use the real Compose parser, while simulating every Engine and systemd action.
const commandProbe = `#!${process.execPath}
const { appendFileSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.CLI_CALLS, JSON.stringify({ command, args }) + "\\n");
if (command === "rm") {
  if (args.every(arg => arg.startsWith("-") || arg === process.env.CLI_FIXTURE || arg.startsWith(process.env.CLI_FIXTURE + "/"))) {
    if (process.env.CLI_DELETE_FAIL && args.includes(process.env.CLI_DELETE_FAIL)) process.exit(27);
    process.exit(spawnSync("/bin/rm", args, { stdio: "inherit" }).status ?? 1);
  }
  if (args.length === 2 && args[1] === "/etc/systemd/system/91-native-test.service") process.exit(0);
  process.stderr.write("Unexpected deletion outside fixture");
  process.exit(97);
}
if (command !== "docker") process.exit(0);
const fail = process.env.CLI_DOCKER_FAIL;
if (args[0] === "info") {
  if (fail === "info") process.exit(1);
  process.stdout.write("Debian GNU/Linux 12\\n");
} else if (args[0] === "context") {
  process.stdout.write("unix:///var/run/docker.sock\\n");
} else if (args[0] === "inspect") {
  process.stdout.write(JSON.stringify([{
    Image: process.env.CLI_BOT_IMAGE,
    Config: { Labels: {
      "com.docker.compose.project": process.env.CLI_BOT_PROJECT || "video-site-telegram",
      "com.docker.compose.service": "telegram-bot-api",
      "com.docker.compose.project.working_dir": process.env.INSTALL_PATH,
      "com.docker.compose.project.config_files": process.env.CLI_FOREIGN_BOT ? "/other/telegram.yml" : join(process.env.INSTALL_PATH, "telegram.yml"),
    } },
  }]));
} else if (args[0] === "network") {
  if (args[1] === "ls") process.stdout.write("bot-network\\n");
  else if (args[1] === "inspect") process.stdout.write(process.env.CLI_SHARED_NETWORK ? "1\\n" : "0\\n");
  else if (args[1] === "rm") process.exit(fail === "network" ? 1 : 0);
  else process.exit(2);
} else if (args[0] === "volume") {
  if (args[1] === "ls") process.stdout.write(process.env.CLI_BOT_VOLUMES || "");
  else if (args[1] === "rm") process.exit(fail === "volume" ? 1 : 0);
  else process.exit(2);
} else if (args[0] === "ps") {
  if ((process.env.CLI_SHARED_IMAGE && args.some(arg => arg.startsWith("ancestor="))) ||
      (process.env.CLI_SHARED_VOLUME && args.some(arg => arg.startsWith("volume=")))) process.stdout.write("other-container\\n");
} else if (args[0] === "image" && args[1] === "rm") {
  process.exit(fail === "image" ? 1 : 0);
} else if (["stop", "rm"].includes(args[0])) {
  process.exit(fail === args[0] ? 23 : 0);
} else if (args[0] === "compose") {
  if (args[1] === "version") process.exit(fail === "version" ? 1 : 0);
  const index = args.findIndex(arg => ["config", "up", "ps", "rm"].includes(arg));
  if (index < 0) process.exit(2);
  if (args[index] === "ps") {
    if (!process.env.CLI_NO_BOT) process.stdout.write("native-bot-container\\n");
    process.exit(0);
  }
  if (args[index] === "rm") process.exit(fail === "rm" ? 23 : 0);
  const filename = args[args.indexOf("-f") + 1];
  if (args[index] === "config") {
    if (fail === "candidate" && filename.endsWith("proposed.json")) process.exit(1);
    const result = spawnSync(process.env.CLI_REAL_DOCKER, args, { stdio: "inherit" });
    if (process.env.CLI_CONCURRENT_EDIT && filename.endsWith("proposed.json")) {
      writeFileSync(join(process.env.INSTALL_PATH, "telegram.yml"), "# concurrent edit\\n");
    }
    process.exit(result.status ?? 1);
  }
  const result = spawnSync(process.env.CLI_REAL_DOCKER,
    [...args.slice(0, index), "config", "--format", "json"], { encoding: "utf8" });
  if (result.status) { process.stderr.write(result.stderr); process.exit(result.status); }
  writeFileSync(join(process.env.INSTALL_PATH, "started.json"), result.stdout);
  process.exit(fail === "up" ? 1 : 0);
} else process.exit(2);
`;

function fixture(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), "91-native-telegram-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "site");
  const bin = join(base, "bin");
  const composeFile = join(root, "telegram.yml");
  mkdirSync(root);
  mkdirSync(bin);
  for (const name of ["docker", "systemctl", "journalctl", "curl", "rm"]) {
    writeFileSync(join(bin, name), commandProbe, { mode: 0o755 });
  }
  copyFileSync(template, join(root, "telegram.example.yml"));
  const siteConfig = "server:\n  listen: '0.0.0.0:19191'\ntelegram:\n  enabled: false\n  bot_token: existing-token\n";
  writeFileSync(join(root, "config.yaml"), siteConfig);
  writeFileSync(join(root, "server"), `#!${process.execPath}
const { readFileSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { parse } = require(${JSON.stringify(yamlPackage)});
if (process.argv[2] !== "storage-paths" || process.env.CLI_STORAGE_FAIL) process.exit(23);
const config = parse(readFileSync(process.argv[process.argv.indexOf("--config") + 1], "utf8"));
const storage = config.storage || {};
const data = resolve(storage.data_dir || "data");
console.log(JSON.stringify({ data_dir: data, db_path: join(resolve(storage.db_dir || data), "video-site.db") }));
`, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CLI_CALLS: join(base, "calls.jsonl"),
    CLI_FIXTURE: base,
    TMPDIR: base,
    CLI_BOT_IMAGE: botImage,
    CLI_REAL_DOCKER: dockerPath,
    CLI_INSTALLER: installer,
    INSTALL_PATH: root,
    SERVICE_NAME: "91-native-test",
    FRONTEND_PORT: "19191",
    SERVICE_READY_TIMEOUT: "1",
    TELEGRAM_API_ID: apiID,
    TELEGRAM_API_HASH: apiHash,
    DOCKER_HOST: "",
    DOCKER_CONTEXT: "",
    TERM: "dumb",
  };
  return {
    base, root, composeFile, env, siteConfig,
    calls(): Call[] {
      return existsSync(env.CLI_CALLS)
        ? readFileSync(env.CLI_CALLS, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
        : [];
    },
    run(overrides: Record<string, string> = {}) {
      return spawnSync("bash", ["-c", 'source "$1" help >/dev/null; need_root() { :; }; main telegram', "bash", installer], {
        encoding: "utf8", cwd: tmpdir(), env: { ...env, ...overrides }, timeout: 10_000,
      });
    },
    uninstall(overrides: Record<string, string> = {}) {
      return spawnSync("bash", ["-c", `
        source "$1" help >/dev/null
        need_root() { :; }
        COMMAND_LINK="$INSTALL_PATH/91"
        APP_COMMAND_LINK="$INSTALL_PATH/video-site-91"
        MANAGER_PATH="$INSTALL_PATH/manager"
        main uninstall
      `, "bash", installer], {
        encoding: "utf8", cwd: tmpdir(), env: { ...env, UNINSTALL_DELETE_FILES: "0", ...overrides }, timeout: 10_000,
      });
    },
  };
}

test("native Telegram setup configures only the Bot API and then restarts the native service", requiresCompose, (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const saved = parse(readFileSync(f.composeFile, "utf8"));
  const bot = saved.services["telegram-bot-api"];
  assert.equal(bot.environment.TELEGRAM_API_ID, apiID);
  assert.equal(bot.environment.TELEGRAM_API_HASH, apiHash);
  assert.equal(bot.environment.TELEGRAM_LOCAL, "1");
  assert.equal(bot.volumes[0].source, join(f.root, "data", "telegram"));
  assert.equal(bot.ports[0].host_ip, "127.0.0.1");
  assert.equal(statSync(f.composeFile).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(f.root, "config.yaml"), "utf8"), f.siteConfig);
  const calls = f.calls();
  const upIndex = calls.findIndex(call => call.command === "docker" && call.args.includes("up"));
  assert.ok(upIndex >= 0);
  assert.deepEqual(calls[upIndex].args, [
    "compose", "--project-directory", f.root, "-f", f.composeFile, "up", "-d", "--no-deps", "--no-build", "--pull", "missing",
    "--wait", "--wait-timeout", "1", "telegram-bot-api",
  ]);
  assert.deepEqual(calls.filter(call => call.command === "systemctl"), [
    { command: "systemctl", args: ["restart", "91-native-test.service"] },
  ]);
  assert.ok(calls.findIndex(call => call.command === "systemctl") > upIndex);
  assert.ok(!JSON.stringify(calls).includes(apiHash));
  assert.ok(!result.stdout.includes(apiHash));
  assert.ok(!result.stderr.includes(apiHash));
  assert.match(result.stdout, /Bot Token and allowed user IDs/);
  assert.ok(!readdirSync(f.root).some(name => name.startsWith(".telegram-setup.")));
});

test("native Telegram setup reuses existing credentials and preserves custom deployment settings", requiresCompose, (t) => {
  const f = fixture(t);
  const original = parse(readFileSync(template, "utf8"));
  original.name = "custom-telegram";
  const bot = original.services["telegram-bot-api"];
  bot.image = "example.invalid/telegram:pinned";
  bot.environment = [
    `TELEGRAM_API_ID=${apiID}`, `TELEGRAM_API_HASH=${apiHash}`, "TELEGRAM_LOCAL=1", "TELEGRAM_HTTP_PORT=9000",
  ];
  bot.ports = ["127.0.0.1:8888:9000"];
  bot.volumes = ["./custom-data:/var/lib/telegram-bot-api"];
  const originalText = stringify(original);
  writeFileSync(f.composeFile, originalText);
  const result = f.run({ TELEGRAM_API_ID: "", TELEGRAM_API_HASH: "" });
  assert.equal(result.status, 0, result.stderr);
  const saved = parse(readFileSync(f.composeFile, "utf8"));
  assert.equal(saved.name, "custom-telegram");
  const savedBot = saved.services["telegram-bot-api"];
  assert.equal(savedBot.image, bot.image);
  assert.equal(savedBot.environment.TELEGRAM_API_HASH, apiHash);
  assert.equal(savedBot.environment.TELEGRAM_HTTP_PORT, "9000");
  assert.equal(savedBot.ports[0].published, "8888");
  assert.equal(savedBot.volumes[0].source, join(f.root, "custom-data"));
  const backups = readdirSync(f.root).filter(name => name.startsWith("telegram.yml.bak-"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(f.root, backups[0]), "utf8"), originalText);
  assert.equal(statSync(join(f.root, backups[0])).mode & 0o777, 0o600);
});

test("native Telegram setup rejects missing or invalid credentials without modifying deployment files", requiresCompose, (t) => {
  for (const overrides of [
    { TELEGRAM_API_ID: "", TELEGRAM_API_HASH: "" },
    { TELEGRAM_API_ID: "0", TELEGRAM_API_HASH: apiHash },
    { TELEGRAM_API_ID: apiID, TELEGRAM_API_HASH: "invalid" },
  ]) {
    const f = fixture(t);
    copyFileSync(template, f.composeFile);
    const result = f.run(overrides);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /is missing or invalid/);
    assert.equal(readFileSync(f.composeFile, "utf8"), readFileSync(template, "utf8"));
    assert.ok(!f.calls().some(call => call.command === "systemctl" || call.args.includes("up")));
    assert.ok(!readdirSync(f.root).some(name => name.startsWith("telegram.yml.bak-") || name.startsWith(".telegram-setup.")));
  }
});

test("native Telegram setup rejects unavailable Compose, a stopped Engine and a remote Engine before changes", requiresCompose, (t) => {
  for (const overrides of [
    { CLI_DOCKER_FAIL: "version" },
    { CLI_DOCKER_FAIL: "info" },
    { DOCKER_HOST: "tcp://remote.example:2376" },
  ]) {
    const f = fixture(t);
    const result = f.run(overrides);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(f.composeFile), false);
    assert.ok(!f.calls().some(call => call.command === "systemctl" || call.args.includes("up") || call.args.includes("config")));
  }
});

test("native Telegram setup rejects Docker website configurations and unsupported native mounts", requiresCompose, (t) => {
  for (const invalid of ["website", "named-volume", "custom-command", "no-host-port", "malformed"]) {
    const f = fixture(t);
    const document = parse(readFileSync(template, "utf8"));
    const bot = document.services["telegram-bot-api"];
    if (invalid === "website") document.services["video-site-91"] = { image: "example.invalid/91:test" };
    if (invalid === "named-volume") {
      bot.volumes = ["telegram-data:/var/lib/telegram-bot-api"];
      document.volumes = { "telegram-data": {} };
    }
    if (invalid === "custom-command") bot.command = ["custom-server"];
    if (invalid === "no-host-port") delete bot.ports;
    const text = invalid === "malformed" ? "services: [" : stringify(document);
    writeFileSync(f.composeFile, text);
    const result = f.run();
    assert.notEqual(result.status, 0, invalid);
    assert.equal(readFileSync(f.composeFile, "utf8"), text);
    assert.ok(!f.calls().some(call => call.command === "systemctl" || call.args.includes("up")));
  }
});

test("native Telegram setup keeps configuration for retry and does not restart 91 if Bot API startup fails", requiresCompose, (t) => {
  const f = fixture(t);
  const result = f.run({ CLI_DOCKER_FAIL: "up" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Native 91 was not restarted/);
  assert.equal(parse(readFileSync(f.composeFile, "utf8")).services["telegram-bot-api"].environment.TELEGRAM_API_HASH, apiHash);
  assert.ok(!f.calls().some(call => call.command === "systemctl"));
  assert.equal(f.run({ TELEGRAM_API_ID: "", TELEGRAM_API_HASH: "" }).status, 0);
  assert.ok(!readdirSync(f.root).some(name => name.startsWith("telegram.yml.bak-") || name.startsWith(".telegram-setup.")));
});

test("native Telegram setup does not publish invalid candidates or overwrite concurrent edits", requiresCompose, (t) => {
  for (const overrides of [{ CLI_DOCKER_FAIL: "candidate" }, { CLI_CONCURRENT_EDIT: "1" }]) {
    const f = fixture(t);
    copyFileSync(template, f.composeFile);
    const result = f.run(overrides);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(f.composeFile, "utf8"), overrides.CLI_CONCURRENT_EDIT ? "# concurrent edit\n" : readFileSync(template, "utf8"));
    assert.ok(!f.calls().some(call => call.command === "systemctl" || call.args.includes("up")));
  }
});

test("native Telegram setup prompts interactively with visible application credentials", requiresCompose, async (t) => {
  const f = fixture(t);
  const child = spawn("script", ["-q", "-e", "-c", 'bash -c \'source "$CLI_INSTALLER" help >/dev/null; need_root() { :; }; main telegram\'', "/dev/null"], {
    env: { ...f.env, TELEGRAM_API_ID: "", TELEGRAM_API_HASH: "" },
  });
  let output = "", sentID = false, sentHash = false;
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  t.after(() => { clearTimeout(timeout); child.kill(); });
  child.stdout.on("data", (data) => {
    output += data.toString();
    if (!sentID && output.includes("TELEGRAM_API_ID (from my.telegram.org):")) {
      sentID = true;
      child.stdin.write(`${apiID}\n`);
    }
    if (!sentHash && output.includes("TELEGRAM_API_HASH (from my.telegram.org):")) {
      sentHash = true;
      child.stdin.write(`${apiHash}\n`);
    }
  });
  child.stderr.on("data", (data) => { output += data.toString(); });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(status, 0, output);
  assert.ok(sentID && sentHash);
  assert.ok(output.includes(apiHash));
  assert.equal(parse(readFileSync(f.composeFile, "utf8")).services["telegram-bot-api"].environment.TELEGRAM_API_HASH, apiHash);
});

test("native uninstall removes the configured Bot API, resources, installed files and data", requiresCompose, (t) => {
  const f = fixture(t);
  copyFileSync(template, f.composeFile);
  mkdirSync(join(f.root, "data", "telegram"), { recursive: true });
  writeFileSync(join(f.root, "data", "telegram", "video.mp4"), "video");
  const result = f.uninstall();
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  assert.deepEqual(calls.find(call => call.command === "docker" && call.args[0] === "stop")?.args,
    ["stop", "native-bot-container"]);
  assert.deepEqual(calls.find(call => call.command === "docker" && call.args[0] === "rm")?.args,
    ["rm", "--volumes", "native-bot-container"]);
  assert.ok(calls.some(call => call.command === "docker" && call.args.join(" ") === "network rm bot-network"));
  assert.ok(calls.some(call => call.command === "docker" && call.args.join(" ") === `image rm ${botImage}`));
  assert.ok(calls.findIndex(call => call.command === "systemctl") > calls.findIndex(call => call.args[0] === "rm"));
  assert.ok(!calls.some(call => call.args.includes("down") || call.args.includes("--remove-orphans")));
  assert.equal(existsSync(f.root), false);
});

test("native uninstall preserves other services and shared or external Docker resources", requiresCompose, (t) => {
  const f = fixture(t);
  const document = parse(readFileSync(template, "utf8"));
  document.services.metrics = { image: "example.invalid/metrics:test" };
  document.services["telegram-bot-api"].networks = ["default", "external"];
  document.networks = { default: {}, external: { external: true, name: "shared-external" } };
  writeFileSync(f.composeFile, stringify(document));
  const result = f.uninstall({ CLI_SHARED_NETWORK: "1", CLI_SHARED_IMAGE: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Keeping shared Bot API network/);
  assert.match(result.stdout, /Keeping shared Bot API image/);
  assert.ok(!f.calls().some(call => call.command === "docker" && ["network rm", "image rm"].includes(call.args.slice(0, 2).join(" "))));
  assert.ok(!f.calls().some(call => call.args.includes("metrics") || call.args.includes("label=com.docker.compose.network=external")));
});

test("native uninstall refuses a Bot API container owned by another deployment", requiresCompose, (t) => {
  const f = fixture(t);
  copyFileSync(template, f.composeFile);
  const result = f.uninstall({ CLI_FOREIGN_BOT: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /belongs to another deployment/);
  assert.ok(!f.calls().some(call => call.command === "systemctl" || (call.command === "docker" && call.args.includes("rm"))));
  assert.ok(existsSync(f.composeFile));
});

test("native uninstall keeps management files if Bot API container or network cleanup fails", requiresCompose, (t) => {
  for (const failure of ["stop", "rm", "network"]) {
    const f = fixture(t);
    copyFileSync(template, f.composeFile);
    for (const file of ["91", "video-site-91", "manager"]) writeFileSync(join(f.root, file), "manager");
    const result = f.uninstall({ CLI_DOCKER_FAIL: failure, UNINSTALL_DELETE_FILES: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /installation kept for retry/);
    assert.ok(!f.calls().some(call => call.command === "systemctl"));
    for (const file of ["telegram.yml", "91", "video-site-91", "manager"]) assert.ok(existsSync(join(f.root, file)), file);
  }
});

test("native uninstall keeps an image that Docker cannot remove and completes service cleanup", requiresCompose, (t) => {
  const f = fixture(t);
  copyFileSync(template, f.composeFile);
  const result = f.uninstall({ CLI_DOCKER_FAIL: "image" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /keeping the image cache/);
  assert.ok(f.calls().some(call => call.command === "systemctl"));
});

test("native uninstall deletes custom Bot API data outside the installation", requiresCompose, (t) => {
  const f = fixture(t);
  const externalData = join(f.base, "bot-data");
  mkdirSync(externalData);
  writeFileSync(join(externalData, "video.mp4"), "external video");
  const document = parse(readFileSync(template, "utf8"));
  document.services["telegram-bot-api"].volumes = [`${externalData}:/var/lib/telegram-bot-api`];
  writeFileSync(f.composeFile, stringify(document));
  const result = f.uninstall({ UNINSTALL_DELETE_FILES: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(f.root), false);
  assert.equal(existsSync(externalData), false);
  assert.ok(f.calls().some(call => call.command === "docker" && call.args[0] === "stop"));
});

test("native uninstall skips unavailable Docker only for the untouched Telegram template", requiresCompose, (t) => {
  const f = fixture(t);
  copyFileSync(template, f.composeFile);
  assert.equal(f.uninstall({ CLI_DOCKER_FAIL: "info" }).status, 0);
  assert.ok(f.calls().some(call => call.command === "systemctl"));
  const configured = fixture(t);
  const document = parse(readFileSync(template, "utf8"));
  document.services["telegram-bot-api"].environment.TELEGRAM_API_ID = apiID;
  document.services["telegram-bot-api"].environment.TELEGRAM_API_HASH = apiHash;
  writeFileSync(configured.composeFile, stringify(document));
  const result = configured.uninstall({ CLI_DOCKER_FAIL: "info" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot connect to Docker/);
  assert.ok(!configured.calls().some(call => call.command === "systemctl"));
});

test("native uninstall rejects a Docker website configuration before removing resources", requiresCompose, (t) => {
  const f = fixture(t);
  const document = parse(readFileSync(template, "utf8"));
  document.services["video-site-91"] = { image: "example.invalid/91:test" };
  writeFileSync(f.composeFile, stringify(document));
  const result = f.uninstall();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /native Bot API deployment/);
  assert.ok(!f.calls().some(call => call.command === "systemctl" || (call.command === "docker" && call.args.includes("rm"))));
});

test("native uninstall respects a custom Bot API project name", requiresCompose, (t) => {
  const f = fixture(t);
  const document = parse(readFileSync(template, "utf8"));
  document.name = "custom-native-bot";
  writeFileSync(f.composeFile, stringify(document));
  const result = f.uninstall({ CLI_BOT_PROJECT: "custom-native-bot" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(f.calls().some(call => call.args.includes("label=com.docker.compose.project=custom-native-bot")));
});

test("native uninstall cleans leftover networks when the Bot API container is already absent", requiresCompose, (t) => {
  const f = fixture(t);
  copyFileSync(template, f.composeFile);
  const result = f.uninstall({ CLI_NO_BOT: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!f.calls().some(call => call.command === "docker" && ["stop", "rm", "inspect", "image"].includes(call.args[0])));
  assert.ok(f.calls().some(call => call.args.join(" ") === "network rm bot-network"));
});

test("native uninstall deletes custom application data and only this database's files", requiresCompose, (t) => {
  const f = fixture(t);
  const data = join(f.base, "custom data");
  const databaseDir = join(f.base, "shared-databases");
  mkdirSync(data);
  mkdirSync(databaseDir);
  writeFileSync(join(data, "log.txt"), "application log");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) writeFileSync(join(databaseDir, `video-site.db${suffix}`), "database data");
  writeFileSync(join(databaseDir, "another-app.db"), "unrelated database");
  writeFileSync(join(f.root, "config.yaml"), stringify({ storage: { data_dir: data, db_dir: databaseDir } }));
  const result = f.uninstall();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(data), false);
  assert.equal(existsSync(f.root), false);
  for (const suffix of ["", "-wal", "-shm", "-journal"]) assert.equal(existsSync(join(databaseDir, `video-site.db${suffix}`)), false);
  assert.equal(readFileSync(join(databaseDir, "another-app.db"), "utf8"), "unrelated database");
});

test("native uninstall deletes Telegram data behind a symlink and removes the link", requiresCompose, (t) => {
  const f = fixture(t);
  const target = join(f.base, "telegram-storage");
  const link = join(f.base, "telegram-link");
  mkdirSync(target);
  writeFileSync(join(target, "video.mp4"), "owned Telegram video");
  symlinkSync(target, link, "dir");
  const document = parse(readFileSync(template, "utf8"));
  document.services["telegram-bot-api"].volumes = [`${link}:/var/lib/telegram-bot-api`];
  writeFileSync(f.composeFile, stringify(document));
  const result = f.uninstall();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(target), false);
  assert.ok(!readdirSync(f.base).includes("telegram-link"));
});

test("native uninstall rejects unsafe native and Telegram data paths before stopping services", requiresCompose, (t) => {
  for (const unsafe of ["/", "/opt", "installation-parent", "symlink", "telegram"]) {
    const f = fixture(t);
    let directory = unsafe === "installation-parent" ? f.base : unsafe;
    if (unsafe === "symlink") {
      directory = join(f.base, "unsafe-link");
      symlinkSync("/", directory, "dir");
    }
    if (unsafe === "telegram") {
      const document = parse(readFileSync(template, "utf8"));
      document.services["telegram-bot-api"].volumes = ["/:/var/lib/telegram-bot-api"];
      writeFileSync(f.composeFile, stringify(document));
    } else {
      writeFileSync(join(f.root, "config.yaml"), stringify({ storage: { data_dir: directory } }));
    }
    const result = f.uninstall();
    assert.notEqual(result.status, 0, unsafe);
    assert.match(result.stderr, /unsafe application data path/);
    assert.ok(!f.calls().some(call => call.command === "systemctl" || (call.command === "docker" && ["stop", "rm"].includes(call.args[0]))));
    assert.ok(existsSync(join(f.root, "config.yaml")));
  }
});

test("native uninstall keeps configuration and management commands if deleting custom data fails", requiresCompose, (t) => {
  const f = fixture(t);
  const data = join(f.base, "custom-data");
  mkdirSync(data);
  writeFileSync(join(data, "video.mp4"), "data");
  for (const file of ["91", "video-site-91", "manager"]) writeFileSync(join(f.root, file), "manager");
  writeFileSync(join(f.root, "config.yaml"), stringify({ storage: { data_dir: data } }));
  const result = f.uninstall({ CLI_DELETE_FAIL: data });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Data cleanup failed.*management commands kept for retry/);
  assert.doesNotMatch(result.stdout, /Uninstall complete/);
  for (const file of ["config.yaml", "91", "video-site-91", "manager"]) assert.ok(existsSync(join(f.root, file)), file);
  assert.ok(!f.calls().some(call => call.command === "systemctl" && call.args.includes("daemon-reload")));
});

test("native uninstall removes owned Bot API volumes and preserves unrelated or shared volumes", requiresCompose, (t) => {
  for (const mode of ["owned", "shared", "external", "failure"]) {
    const f = fixture(t);
    const document = parse(readFileSync(template, "utf8"));
    document.services["telegram-bot-api"].volumes.push("bot-cache:/cache");
    document.volumes = { "bot-cache": { name: "owned-bot-cache", ...(mode === "external" ? { external: true } : {}) } };
    writeFileSync(f.composeFile, stringify(document));
    const result = f.uninstall({
      CLI_BOT_VOLUMES: "owned-bot-cache\nunrelated-volume\n",
      CLI_SHARED_VOLUME: mode === "shared" ? "1" : "",
      CLI_DOCKER_FAIL: mode === "failure" ? "volume" : "",
    });
    assert.equal(result.status === 0, mode !== "failure", result.stderr);
    const removed = f.calls().filter(call => call.command === "docker" && call.args.slice(0, 2).join(" ") === "volume rm");
    assert.deepEqual(removed.map(call => call.args[2]), mode === "owned" || mode === "failure" ? ["owned-bot-cache"] : []);
    if (mode === "failure") assert.ok(existsSync(f.composeFile));
  }
});

test("native uninstall aborts before resource removal if the server cannot report storage paths", requiresCompose, (t) => {
  const f = fixture(t);
  copyFileSync(template, f.composeFile);
  const result = f.uninstall({ CLI_STORAGE_FAIL: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not resolve storage paths/);
  assert.ok(!f.calls().some(call => call.command === "systemctl" || call.command === "docker"));
  assert.ok(existsSync(f.composeFile));
});
