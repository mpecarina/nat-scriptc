/**
 * src/usage.ts — the help text.
 */

export const VERSION = "0.1.0";

export const USAGE = `nat ${VERSION} — Network Automation Toolkit

Usage:
  nat inventory list
  nat inventory show <host>
  nat run <host|glob...> | --all [-- CMD...] [--command CMD]... [--file FILE] [options]
  nat parse --command CMD [--input FILE] [--driver OS] [--parsers PACK]... [--json]
  nat watch <run-id> [--json]
  nat results <run-id> [--json]
  nat runs [--host <alias>] [--limit N]
  nat cred set <host> [--user USER] [--kind password|passphrase]
  nat cred get <host> [--user USER] [--kind password|passphrase]
  nat cred delete <host> [--user USER] [--kind password|passphrase]
  nat doctor

Global options:
  --ssh-config <path>   Use an alternate SSH config file
  -v, --version         Print version
  -h, --help            Show this help

Run options:
  CMD...                Commands given inline after \`--\` (one per argument)
  --command, -c CMD     Command to run (repeatable)
  --file, -f FILE       Read commands from a file (\`-\` reads stdin)
  --all                 Target every host alias in the ssh config
  --ask-pass            Prompt once for an SSH password (used for all hosts)
  --jump HOST           Jump host (overrides ProxyJump)
  --jump-shell          Tunnel via the jump host's interactive shell
  --inventory FILE      Use a JSON lab inventory instead of the ssh config
                        (carries per-host driver + management IP; passwords too
                        when the export included them)
  --enter-sonic-cli     Enter SONiC sonic-cli before running commands (all hosts)
  --no-sonic-cli        Never auto-enter sonic-cli (overrides per-host driver)
  --no-ios-shell        Never use the interactive IOS session (use exec channels;
                        overrides the ios-driver default — note IOS-XE cannot apply
                        multi-line config over exec)
  --connect-timeout N   Connection timeout seconds (default 20)
  --command-timeout N   Per-command timeout seconds (default 30)
  --workers N           Max concurrent hosts (default 5)
  --watch               Stream events live while running, instead of printing
                        the output once the run finishes
  --parse               Parse command output into structured objects
  --parsers PACK        Declarative parser pack (JSON file; repeatable, later wins)
  --parser-cmd PROG     Parse with an external program: it receives
                        {host,command,driver,raw} as JSON on stdin and prints
                        one JSON value on stdout
  --driver OS           Override the target OS / driver for all hosts
  --user, -u USER       Override the SSH login user for all hosts (e.g. test a
                        different AAA/TACACS login without editing the inventory)
  --json                Emit results as JSON (includes parsed objects)
  --raw                 Keep raw transcripts: skip the echo/prompt cleanup applied
                        to interactive-session output. Affects what is collected and
                        stored, so every view of the run shows the same text.
  --quiet, -q           Print only the per-host status line, not the output
                        (command output is shown by default)
  --no-store            Skip run-history persistence entirely

SSH transport options (nat drives the system ssh client):
  --ssh-bin PATH        ssh executable to use (default: ssh; \$NAT_SSH_BIN)
  --no-multiplex        Disable the per-host ControlMaster. Exec commands open
                        separate connections; interactive drivers keep one shell.
  --host-key-checking M yes | no | accept-new (default) | ask
  --ssh-option K=V      Extra \`-o\` setting passed to ssh (repeatable)
  -V, --verbose         Print each ssh invocation to stderr

Parse options (offline; parse saved/piped output without SSH):
  --command, -c CMD     Command the output belongs to (selects the parser)
  --input, -i FILE      Read output from FILE (default: stdin)
  --driver OS           Driver / target OS to scope parsers (default generic)
  --parsers PACK        Declarative parser pack (repeatable)
  --parser-cmd PROG     Parse with an external program
  --json                Emit only the parsed object as one JSON line
`;

export const HELP_RUN = `nat run — run commands across one or more hosts

Usage:
  nat run <host|glob...> | --all [-- CMD...] [--command CMD]... [--file FILE] [options]

Hosts may be given as explicit aliases, shell-style globs matched against the
ssh config (quote them: \`'leaf*'\`), or \`--all\` for every alias. Commands may
be given three ways (combined in this order): inline after \`--\`, repeated
--command/-c flags, then lines from --file. Examples:

  nat run web1 web2 -- "uptime" "df -h"
  nat run 'leaf*' -c "show version"
  nat run web1 -c "show version" --parse --json
  nat run web1 --ask-pass -c "show version"
  cat cmds.txt | nat run web1 --file -
  nat run sonic1 --user neteng --ask-pass -c "show version"

--user/-u USER overrides the ssh-config/inventory login user for every host
(e.g. to test a different AAA/TACACS login without editing the inventory).

Command output is printed when the run finishes. Use --watch to stream it live
instead, --json for the machine-readable envelope, or --quiet/-q for status
lines only. Every run is stored under a run_id, so \`nat results <run-id>\`
reprints it later.

Options: see \`nat --help\` (Run options).`;

export const HELP_PARSE = `nat parse — run the parser chain on saved/piped output (no SSH)

Usage:
  nat parse --command CMD [--input FILE] [--driver OS] [--parsers PACK]... [--json]

Reads from --input/-i FILE or stdin. Examples:

  ssh host df -h | nat parse -c "df -h" --driver linux --json
  nat parse -c "ip -br addr" -i fixture.txt --parsers ./parsers.json`;

export const HELP_WATCH = `nat watch — replay/stream a run's events

Usage:
  nat watch <run-id> [--json]

Prints the output exactly as the run collected it. Cleanup is decided at run time
(see \`nat run --raw\`), so there is only one stored copy to show.`;

export const HELP_RESULTS = `nat results — print stored command output for a run

Usage:
  nat results <run-id> [--json]

Prints the output exactly as the run collected it. Cleanup is decided at run time
(see \`nat run --raw\`), so there is only one stored copy to show.`;

export const HELP_RUNS = `nat runs — list recent runs

Usage:
  nat runs [--host <alias>] [--limit N]`;

export const HELP_INVENTORY = `nat inventory — inspect ssh-config hosts

Usage:
  nat inventory list
  nat inventory show <host>

A host's driver comes from a comment keyword in its ssh-config block, so the
file stays valid for the ssh client:

  Host leaf1
      HostName 10.0.0.1
      #nat-driver sonic`;

export const HELP_CRED = `nat cred — manage secrets in the OS keychain

Usage:
  nat cred set <host> [--user USER] [--kind password|passphrase]
  nat cred get <host> [--user USER] [--kind password|passphrase]
  nat cred delete <host> [--user USER] [--kind password|passphrase]

Secrets live in the macOS keychain (\`security\`) or libsecret
(\`secret-tool\`); without either, in a 0600 file under nat's config directory.
\`nat doctor\` reports which one this host uses.`;

export const HELP_DOCTOR = `nat doctor — report the environment nat is running in

Usage:
  nat doctor

Prints the ssh client it will drive, the secret store it will use, and where run
history is kept.`;
