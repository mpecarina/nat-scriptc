/**
 * Which toolchain a host build uses.
 *
 * scriptc's default is the host's clang against the host's libc. A Linux host
 * can lack either half: no clang on PATH, or a glibc older than 2.36, which has
 * no `arc4random_buf` for the runtime to call. No compiler can link against
 * that libc, and a binary built for a newer glibc will not start there. Such a
 * host builds through zig's bundled clang and musl sysroot instead: a static
 * executable that runs on the machine that built it.
 */

import { spawnSync } from "node:child_process";
import { arch, platform } from "node:os";

/** The SCRIPTC_TARGET a host build needs, or "" when the host's own clang and libc will do. */
export function hostTarget() {
  if (platform() !== "linux") return "";
  // Prints "glibc 2.35"; fails on a musl host, which takes the zig lane too.
  const probe = spawnSync("getconf", ["GNU_LIBC_VERSION"], { encoding: "utf8" });
  const glibc = /^glibc (\d+)\.(\d+)/.exec(probe.stdout ?? "");
  const hasArc4random = glibc !== null && (Number(glibc[1]) > 2 || Number(glibc[2]) >= 36);
  const hasClang = spawnSync("clang", ["--version"], { stdio: "ignore" }).status === 0;
  if (hasArc4random && hasClang) return "";
  return `${arch() === "arm64" ? "aarch64" : "x86_64"}-linux-musl`;
}

/** The environment for a host scriptc build: untouched, or pointed at zig. An explicit SCRIPTC_CC wins. */
export function hostEnv() {
  const target = hostTarget();
  if (target === "" || process.env.SCRIPTC_CC !== undefined) return process.env;
  if (spawnSync("zig", ["version"], { stdio: "ignore" }).status !== 0) {
    console.error(`nat: no host clang with glibc 2.36+, so this host builds ${target} through zig: https://ziglang.org/download`);
    process.exit(1);
  }
  return { ...process.env, SCRIPTC_CC: "zigcc", SCRIPTC_TARGET: target };
}
