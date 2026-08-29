import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { stripCommandEcho, trimTrailingNewlines } from "../src/output.ts";

/**
 * `stripCommandEcho` removes the echoed command and trailing prompt from an
 * INTERACTIVE SESSION transcript. It is applied exactly once, in the runner —
 * the only layer that knows a session was used. These tests pin both halves of
 * that contract: it cleans a real transcript, and it is not safe to apply twice.
 */
describe("stripCommandEcho", () => {
  test("removes a bare echoed command", () => {
    assert.equal(stripCommandEcho("show version", "show version\nVersion 1.2.3"), "Version 1.2.3");
  });

  test("removes a prompt-prefixed echo and the trailing prompt", () => {
    const transcript = ["leaf1# show version", "Version 1.2.3", "Uptime 4 days", "leaf1#"].join("\n");
    assert.equal(stripCommandEcho("show version", transcript), "Version 1.2.3\nUptime 4 days");
  });

  test("removes a known shell prompt even when it contains spaces", () => {
    assert.equal(
      stripCommandEcho("uptime", "uptime\r\nup 3 days\r\n[admin@host ~]$ ", "[admin@host ~]$"),
      "up 3 days",
    );
  });

  test("cleans each echo and intermediate prompt from a multiline CLI block", () => {
    const command = "configure terminal\ninterface GigabitEthernet1\ndescription uplink\nend";
    const transcript = [
      "configure terminal",
      "Router(config)#",
      "interface GigabitEthernet1",
      "Router(config-if)#",
      "description uplink",
      "description accepted",
      "Router(config-if)#",
      "end",
      "Router#",
    ].join("\r\n");
    assert.equal(stripCommandEcho(command, transcript, "Router#"), "description accepted");
  });

  test("preserves interior blank lines but trims the edges", () => {
    assert.equal(stripCommandEcho("uptime", "\n$ uptime\n\nload 0.1\n\n\n"), "load 0.1");
  });

  test("handles CRLF transcripts", () => {
    assert.equal(stripCommandEcho("uptime", "uptime\r\nload 0.1\r\n"), "load 0.1");
  });

  test("leaves output alone when there is no echo to strip", () => {
    assert.equal(stripCommandEcho("uptime", "load 0.1\nload 0.2"), "load 0.1\nload 0.2");
  });

  test("keeps output when the command never appears", () => {
    assert.equal(stripCommandEcho("show version", "Version 1.2.3"), "Version 1.2.3");
  });

  /**
   * REGRESSION — a render layer that strips a second time deletes the only line
   * that said what went wrong: a shell error names the command it could not run,
   * so the second pass matches it as an "echo".
   */
  test("a single pass keeps a shell error that names the command", () => {
    const transcript = [
      "host$ definitely-not-a-command",
      "zsh:1: command not found: definitely-not-a-command",
    ].join("\n");
    assert.equal(stripCommandEcho("definitely-not-a-command", transcript), "zsh:1: command not found: definitely-not-a-command");
  });

  test("a second pass would destroy that error — why only the runner strips", () => {
    const cleaned = "zsh:1: command not found: definitely-not-a-command";
    assert.equal(stripCommandEcho("definitely-not-a-command", cleaned), "");
  });

  test("the match needs the command as a contiguous substring", () => {
    const line = "docker: 'compose' is not a docker command.";
    assert.equal(stripCommandEcho("docker compose", line), line);
  });

  test("a second pass eats any line quoting the command back", () => {
    const cleaned = "sudo: a password is required to run: virsh list --all";
    assert.equal(stripCommandEcho("virsh list --all", cleaned), "");
  });

  test("gives up looking for the echo after three content lines", () => {
    const transcript = ["one", "two", "three", "four mentions uptime here"].join("\n");
    assert.equal(stripCommandEcho("uptime", transcript), transcript);
  });
});

describe("trimTrailingNewlines", () => {
  test("removes only trailing newlines", () => {
    assert.equal(trimTrailingNewlines("a\nb\r\n\n"), "a\nb");
    assert.equal(trimTrailingNewlines("\na"), "\na");
  });
});
