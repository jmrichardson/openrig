import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

// npm is npm.cmd on Windows, which Node starts only through a shell: run npm's own CLI script with this Node.
const npm = (args, options) => process.platform === "win32"
  ? execFileSync(process.execPath, [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), ...args], options)
  : execFileSync("npm", args, options);

test("the CLI build carries the unchanged repository LICENSE and README into npm pack", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-license-"));
  try {
    const cli = join(root, "packages/cli");
    const bin = join(root, "bin");
    for (const dir of [cli, bin, join(cli, "src/schemas"), join(cli, "src/lib/scope-templates")]) mkdirSync(dir, { recursive: true });
    copyFileSync("LICENSE", join(root, "LICENSE"));
    copyFileSync("README.md", join(root, "README.md"));
    copyFileSync("packages/cli/package.json", join(cli, "package.json"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync("scripts/prepare-workspace-build.mjs", join(root, "scripts/prepare-workspace-build.mjs"));
    writeFileSync(join(cli, "src/schemas/fixture.json"), "{}\n");
    writeFileSync(join(cli, "src/lib/scope-templates/fixture.md"), "fixture\n");
    // Compilation is outside this packaging regression. Run the actual build
    // script with its expected compiler output, then npm's real file selection.
    if (process.platform === "win32") {
      // npm runs package scripts through cmd.exe on Windows, which finds tsc by PATHEXT.
      writeFileSync(join(bin, "tsc.cmd"), "@mkdir dist 2>nul\r\n@echo // compiler fixture> dist\\bin-wrapper.js\r\n");
    } else {
      writeFileSync(join(bin, "tsc"), "#!/bin/sh\nmkdir -p dist\nprintf '%s\\n' '// compiler fixture' > dist/bin-wrapper.js\n");
      chmodSync(join(bin, "tsc"), 0o755);
    }
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
    npm(["run", "build"], { cwd: cli, env, stdio: "pipe" });
    const source = readFileSync(join(root, "LICENSE"));
    assert.deepEqual(readFileSync(join(cli, "LICENSE")), source, "build must stage the repository license verbatim");
    const packed = JSON.parse(npm(["pack", "--ignore-scripts", "--json"], { cwd: cli, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }));
    assert.ok(packed[0].files.some((file) => file.path === "LICENSE"), "npm archive must include LICENSE");
    // The archive is named relative to the package: Git for Windows' GNU tar reads "C:..." as a remote host.
    const bytes = execFileSync("tar", ["-xOf", packed[0].filename, "package/LICENSE"], { cwd: cli });
    assert.deepEqual(bytes, source, "packed license must equal the existing root bytes");
    // npm shows the package-root README on the registry page; without it the page reads "No README data found".
    const readme = readFileSync(join(root, "README.md"));
    assert.ok(packed[0].files.some((file) => file.path === "README.md"), "npm archive must include README.md");
    const readmeBytes = execFileSync("tar", ["-xOf", packed[0].filename, "package/README.md"], { cwd: cli });
    assert.deepEqual(readmeBytes, readme, "packed README must equal the existing root bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
