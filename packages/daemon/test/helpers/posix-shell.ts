import { existsSync } from "node:fs";
import path from "node:path";

const gitBashCandidates = [
  process.env["CLAUDE_CODE_GIT_BASH_PATH"],
  ...[process.env["ProgramFiles"], process.env["ProgramW6432"], "C:\\Program Files"]
    .map((root) => root && path.win32.join(root, "Git", "bin", "bash.exe")),
].filter((candidate): candidate is string => Boolean(candidate));

/**
 * A POSIX shell for running command text OpenRig writes in POSIX shell syntax (`<shell> -c <text>`).
 * On Windows this is Git Bash, which is also what Claude Code runs shell-form hook and status line
 * commands through (https://code.claude.com/docs/en/hooks). A bare `bash` on Windows can resolve to
 * the WSL launcher, so this looks for Git Bash where Claude Code is told it is, then in a machine-wide
 * Git for Windows install. /bin/sh elsewhere.
 */
export const posixShell = process.platform === "win32"
  ? gitBashCandidates.find((candidate) => existsSync(candidate)) ?? gitBashCandidates.at(-1)!
  : "/bin/sh";
