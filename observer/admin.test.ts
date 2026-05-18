import assert from "node:assert/strict";
import {
  capAdminOutput,
  formatAdminTimestamp,
  getArchiveFilenameForObserverUrl,
  isAdminRequesterAllowed,
  isValidAdminProcessName,
  normalizeRemoteAddress,
  parseObserverUrlInfos,
  resolvePm2ProcessNameFromSet,
  runSoftwareUpdate,
  sanitizeArchiveFilenamePart,
  SOFTWARE_UPDATE_BRANCH,
  SOFTWARE_UPDATE_REMOTE,
  SOFTWARE_UPDATE_COMMANDS,
} from "./admin";

function testNormalizeRemoteAddress(): void {
  assert.equal(normalizeRemoteAddress("::ffff:203.0.113.3"), "203.0.113.3");
  assert.equal(normalizeRemoteAddress("::1"), "::1");
  assert.equal(normalizeRemoteAddress("203.0.113.3"), "203.0.113.3");
}

function testAdminAllowlistIpLiterals(): void {
  const observerUrls = [
    "http://203.0.113.1:8101",
    "http://observer.example.com:8102",
    "http://[2001:db8::1]:8103",
  ];
  const observerInfos = parseObserverUrlInfos(observerUrls);

  assert.deepEqual(isAdminRequesterAllowed("::ffff:203.0.113.1", observerInfos, true), {
    allowed: true,
    matchedObserverUrl: "http://203.0.113.1:8101",
    ignoredDnsHosts: [],
  });
  assert.equal(isAdminRequesterAllowed("observer.example.com", observerInfos, true).allowed, false);
  assert.equal(isAdminRequesterAllowed("2001:db8::1", observerInfos, true).allowed, true);
}

function testAdminAllowlistLocalhostMode(): void {
  assert.equal(isAdminRequesterAllowed("127.0.0.1", [], false).allowed, true);
  assert.equal(isAdminRequesterAllowed("::1", [], false).allowed, true);
  assert.equal(isAdminRequesterAllowed("127.0.0.1", [], true).allowed, false);
}

function testProcessNameValidation(): void {
  assert.equal(isValidAdminProcessName("observer"), true);
  assert.equal(isValidAdminProcessName("tss-party"), true);
  assert.equal(isValidAdminProcessName("pm2"), false);
  assert.equal(isValidAdminProcessName("observer-1"), false);
  assert.equal(isValidAdminProcessName("tss-party-99"), false);
  assert.equal(isValidAdminProcessName("tss-party-a"), false);
}

function testPm2NameResolutionFromSet(): void {
  assert.equal(resolvePm2ProcessNameFromSet("tss-party", 3, new Set(["tss-party"])), "tss-party");
  assert.equal(resolvePm2ProcessNameFromSet("tss-party", 3, new Set(["tss-party-3"])), "tss-party-3");
  assert.throws(() => resolvePm2ProcessNameFromSet("tss-party-4", 3, new Set(["tss-party-4"])), /Invalid/);
  assert.throws(() => resolvePm2ProcessNameFromSet("observer", 2, new Set(["tss-party-2"])), /not found/);
}

function testFilenameHelpers(): void {
  assert.equal(formatAdminTimestamp(new Date(2026, 4, 14, 18, 30, 0)), "2026-05-14-18-30-00");
  assert.equal(sanitizeArchiveFilenamePart("2001:db8::1"), "2001_db8__1");
  assert.equal(getArchiveFilenameForObserverUrl("http://203.0.113.3:8103"), "203.0.113.3-8103.tar.gz");
  assert.equal(getArchiveFilenameForObserverUrl("http://[2001:db8::1]:8103"), "2001_db8__1-8103.tar.gz");
}

async function testSoftwareUpdateDirtyWorktree(): Promise<void> {
  const calls: string[] = [];
  const result = await runSoftwareUpdate("/repo", async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    return { code: 0, stdout: " M observer/admin.ts\n", stderr: "" };
  });

  assert.equal(result.Ok, undefined);
  assert.equal(result.Err, "Worktree is dirty; software update aborted");
  assert.equal(result.compileOk, false);
  assert.deepEqual(calls, ["git status --porcelain --untracked-files=no"]);
}

async function testSoftwareUpdateStatusFailure(): Promise<void> {
  const result = await runSoftwareUpdate("/repo", async () => ({
    code: 128,
    stdout: "",
    stderr: "not a git repository\n",
  }));

  assert.equal(result.Ok, undefined);
  assert.equal(result.Err, "git status failed with code 128");
  assert.equal(result.compileOk, false);
  assert.match(result.stderr, /not a git repository/);
}

async function testSoftwareUpdateCommandSequenceNoop(): Promise<void> {
  const calls: string[] = [];
  const responses = [
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "abc123\n", stderr: "" },
    { code: 0, stdout: "fetch ok\n", stderr: "" },
    { code: 0, stdout: "Already up to date.\n", stderr: "" },
    { code: 0, stdout: "abc123\n", stderr: "" },
    { code: 0, stdout: "compile ok\n", stderr: "" },
  ];

  const result = await runSoftwareUpdate("/repo", async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    return responses.shift()!;
  });

  assert.equal(result.Ok, "software_update_completed");
  assert.equal(result.beforeCommit, "abc123");
  assert.equal(result.afterCommit, "abc123");
  assert.equal(result.updated, false);
  assert.equal(result.compileOk, true);
  assert.deepEqual(calls, SOFTWARE_UPDATE_COMMANDS.map((entry) => `${entry.command} ${entry.args.join(" ")}`));
}

async function testSoftwareUpdateAllowsUntrackedFiles(): Promise<void> {
  const calls: string[] = [];
  const responses = [
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "abc123\n", stderr: "" },
    { code: 0, stdout: "fetch ok\n", stderr: "" },
    { code: 0, stdout: "Already up to date.\n", stderr: "" },
    { code: 0, stdout: "abc123\n", stderr: "" },
    { code: 0, stdout: "compile ok\n", stderr: "" },
  ];

  const result = await runSoftwareUpdate("/repo", async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    return responses.shift()!;
  });

  assert.equal(calls[0], "git status --porcelain --untracked-files=no");
  assert.equal(result.Ok, "software_update_completed");
}

async function testSoftwareUpdateFetchFailure(): Promise<void> {
  const calls: string[] = [];
  const responses = [
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "abc123\n", stderr: "" },
    { code: 1, stdout: "", stderr: "fetch failed\n" },
  ];

  const result = await runSoftwareUpdate("/repo", async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    return responses.shift()!;
  });

  assert.equal(result.Ok, undefined);
  assert.equal(result.Err, `git fetch ${SOFTWARE_UPDATE_REMOTE} ${SOFTWARE_UPDATE_BRANCH} failed with code 1`);
  assert.equal(result.beforeCommit, "abc123");
  assert.equal(result.afterCommit, undefined);
  assert.equal(result.updated, false);
  assert.equal(result.compileOk, false);
  assert.match(result.stderr, /fetch failed/);
  assert.deepEqual(calls, [
    "git status --porcelain --untracked-files=no",
    "git rev-parse HEAD",
    `git fetch ${SOFTWARE_UPDATE_REMOTE} ${SOFTWARE_UPDATE_BRANCH}`,
  ]);
}

async function testSoftwareUpdateMergeThrowsUnknownUpdated(): Promise<void> {
  const calls: string[] = [];
  const responses = [
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "abc123\n", stderr: "" },
    { code: 0, stdout: "fetch ok\n", stderr: "" },
  ];

  const result = await runSoftwareUpdate("/repo", async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "git" && args.join(" ") === `merge --ff-only ${SOFTWARE_UPDATE_REMOTE}/${SOFTWARE_UPDATE_BRANCH}`) {
      throw new Error("merge process failed");
    }
    return responses.shift()!;
  });

  assert.equal(result.Ok, undefined);
  assert.equal(result.Err, "merge process failed");
  assert.equal(result.beforeCommit, "abc123");
  assert.equal(result.afterCommit, undefined);
  assert.equal(result.updated, undefined);
  assert.equal(result.compileOk, false);
  assert.deepEqual(calls, [
    "git status --porcelain --untracked-files=no",
    "git rev-parse HEAD",
    `git fetch ${SOFTWARE_UPDATE_REMOTE} ${SOFTWARE_UPDATE_BRANCH}`,
    `git merge --ff-only ${SOFTWARE_UPDATE_REMOTE}/${SOFTWARE_UPDATE_BRANCH}`,
  ]);
}

async function testSoftwareUpdateChangedAndCompileFailed(): Promise<void> {
  const responses = [
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "abc123\n", stderr: "" },
    { code: 0, stdout: "fetch ok\n", stderr: "" },
    { code: 0, stdout: "Fast-forward\n", stderr: "" },
    { code: 0, stdout: "def456\n", stderr: "" },
    { code: 1, stdout: "", stderr: "compile failed\n" },
  ];

  const result = await runSoftwareUpdate("/repo", async () => responses.shift()!);
  assert.equal(result.Ok, undefined);
  assert.equal(result.Err, "npm run compile failed with code 1");
  assert.equal(result.beforeCommit, "abc123");
  assert.equal(result.afterCommit, "def456");
  assert.equal(result.updated, true);
  assert.equal(result.compileOk, false);
}

function testSoftwareUpdateOutputCapping(): void {
  assert.equal(capAdminOutput("abcdef", 3), "abc\n...[truncated 3 chars]");
}

async function main(): Promise<void> {
  testNormalizeRemoteAddress();
  testAdminAllowlistIpLiterals();
  testAdminAllowlistLocalhostMode();
  testProcessNameValidation();
  testPm2NameResolutionFromSet();
  testFilenameHelpers();
  await testSoftwareUpdateDirtyWorktree();
  await testSoftwareUpdateStatusFailure();
  await testSoftwareUpdateCommandSequenceNoop();
  await testSoftwareUpdateAllowsUntrackedFiles();
  await testSoftwareUpdateFetchFailure();
  await testSoftwareUpdateMergeThrowsUnknownUpdated();
  await testSoftwareUpdateChangedAndCompileFailed();
  testSoftwareUpdateOutputCapping();
  console.log("observer admin tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
