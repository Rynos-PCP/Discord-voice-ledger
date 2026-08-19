# Security policy

## What there is to attack

Discord Voice Ledger is a Node script and a static HTML file. There is no
server, no account, no database, no telemetry, and no third-party code — not at
build time and not in the dashboard. Nothing listens on a port and nothing
phones home.

That removes most of the usual attack surface and leaves a narrower, more
interesting one: this tool reads the most sensitive export Discord will give
you and writes a file you are likely to keep. The failures worth reporting are
about **disclosure** and **integrity of that file**.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: the **Security** tab →
**Report a vulnerability**. That keeps the report out of public view until
there is a fix.

**Please do not open a public issue for a security problem.** The issue tracker
is public and permanent.

Expect a first reply within a week. This is a spare-time project, so a fix may
take longer than the reply — you will hear where it stands either way.

## What counts as a vulnerability here

These are real, and reports about them are welcome:

- **Script execution from package content.** Every string that comes out of the
  data package — server names, channel names, contact names, build warnings —
  is written to the DOM through `esc()` or `textContent`, never as raw HTML. If
  you find a path where a crafted name reaches the page unescaped, that is a
  vulnerability: a name is attacker-controlled if someone can get you into a
  server or a group chat.
- **The build writing more than it documents.** The output deliberately omits
  your user ID, your display name and the path to your package
  ([docs/METHOD.md](docs/METHOD.md#5-what-comes-out) lists what it does contain).
  If something else from `user.json` or elsewhere in the package ends up in
  `data.json` or the dashboard, that is a leak, and a serious one — the
  dashboard is built to be moved around.
- **Reading or writing outside the given folders.** Path traversal via crafted
  file or folder names in the package, or the build touching anything outside
  `--package` and `--out`.
- **Any network traffic at all.** The tool claims to make none. A request from
  either `build.mjs` or the dashboard — including one triggered by package
  content — contradicts the central promise and counts as a vulnerability.
- **Silent corruption of the numbers.** A crafted package that makes the build
  attribute time to the wrong channel or person without any warning. The
  dashboard is a record people may act on; quietly wrong is worse than loudly
  broken.

## What does not count

- Someone with access to your machine or your unlocked session reading your
  dashboard. There is no protection against that and none is claimed.
- Your dashboard being readable by others when you serve it over a network or
  put it in shared storage. That is your choice of transport. The file contains
  your contacts' names — treat it accordingly.
- The dashboard showing your own data to you.
- Findings from an automated scanner with no described impact. There are no
  dependencies, so dependency alerts do not apply here.

## Never include in a report

Not in the private report either:

- your data package, or any file out of it
- your `data.json` or your built dashboard
- screenshots showing real server names, contact names or user IDs

A crafted **minimal** package that triggers the problem is the ideal
reproduction, and `tools/make-sample-package.mjs` is a starting point for
building one. If you cannot reproduce it without real data, describe the shape
of the input instead — which field, which value, which structure — and we will
work it out from there.

## Supported versions

The latest commit on `main`. This project is not versioned or released; fixes
land there and you get them by pulling.
