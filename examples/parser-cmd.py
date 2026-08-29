#!/usr/bin/env python3
"""examples/parser-cmd.py — an external parser program for `nat --parser-cmd`.

A declarative pack (examples/parsers.json) covers field and row extraction. When
a device needs real logic — stateful blocks, cross-line arithmetic, a lookup
table — nat hands the job to a program instead, in whatever language suits:

    nat run leaf1 -c "show interface counters" \\
        --parser-cmd ./examples/parser-cmd.py --json

The contract is one JSON object in, one JSON value out:

    stdin   {"host": "...", "command": "...", "driver": "...", "raw": "..."}
    stdout  any JSON value — it becomes the command's `.parsed`

A non-zero exit or non-JSON output is recorded as `{"parseError": "..."}` on
that command; it never fails the run that collected the output.

This example parses `show interface counters`-style tables and adds a computed
error rate per port, which is the kind of derivation a regex rule cannot do.
"""

import json
import re
import sys

ROW = re.compile(r"^\s*(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$")


def parse(raw: str) -> dict:
    ports = []
    for line in raw.splitlines():
        match = ROW.match(line)
        if match is None:
            continue
        name, rx_ok, rx_err, tx_ok, tx_err = match.groups()
        rx_ok, rx_err, tx_ok, tx_err = int(rx_ok), int(rx_err), int(tx_ok), int(tx_err)
        total = rx_ok + rx_err + tx_ok + tx_err
        ports.append(
            {
                "name": name,
                "rxOk": rx_ok,
                "rxErr": rx_err,
                "txOk": tx_ok,
                "txErr": tx_err,
                # The reason this is a program and not a regex rule.
                "errorRate": round((rx_err + tx_err) / total, 6) if total else 0.0,
                "degraded": total > 0 and (rx_err + tx_err) / total > 0.001,
            }
        )
    return {"kind": "example.interfaceCounters", "ports": ports, "count": len(ports)}


def main() -> int:
    request = json.load(sys.stdin)
    json.dump(parse(request.get("raw", "")), sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
