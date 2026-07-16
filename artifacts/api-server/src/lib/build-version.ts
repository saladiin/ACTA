import { execFileSync } from "node:child_process";
import path from "node:path";

function shortBuildSha(): string {
  const raw =
    process.env.B5_BUILD_SHA ||
    process.env.RENDER_GIT_COMMIT ||
    process.env.RENDER_GIT_COMMIT_SHA ||
    process.env.COMMIT_SHA ||
    process.env.GIT_COMMIT;
  if (raw) return raw.trim().slice(0, 7);

  try {
    return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: path.resolve(process.cwd()),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "dev";
  }
}

export const APP_BUILD_SHA = shortBuildSha();

