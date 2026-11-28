# Independent continuity monitoring on the office iMac — install package

Prepared 2026-11-28 for the owner's approval of 2026-11-27. Every command runs as the logged-in
user. **Nothing here needs `sudo`**, and nothing here touches the existing worker, its identity, its
credentials, the Keychain, FileVault or its LaunchAgent.

## What this monitors, and what it does not

It samples `GET <dev api>/health` at a fixed interval and appends one JSON line per reading to a
local file, recording the interval actually achieved. Because it runs on a different machine from
the system under test, a gap in its own records is distinguishable from a quiet period — which is
the only way a gap can be measured at all.

**It cannot tell you the office did anything.** Scheduler heartbeat age, run terminality, alert
lifecycle and cost exposure are not published on the health endpoint. The richer monitor,
`scripts/office-reliability-sampler.js`, reads all four — but it needs `DATABASE_URL`, and the
development database is reachable only on Railway's project-private DNS (measured: the internal host
does not resolve from outside the project, and the Postgres service has no TCP proxy). Running it
from the iMac would need either a public address on the development database — refused — or
`DATABASE_URL` copied to the iMac, which the same directive that approved this monitoring forbade.

So a gap-free 72-hour window from this sampler establishes **that the application stayed up**. It
does not establish that consecutive cycles ran. Those are different claims and must not be reported
as one.

## Step 1 — a separate clone, so the worker's tree is not touched

The existing worker runs from its own checkout. Updating that checkout would change the code the
worker loads on its next restart, which is exactly what "do not modify the existing worker" rules
out. So the monitor gets its own clone and the worker's is left alone.

```sh
mkdir -p ~/playnexa-monitor
git clone --branch feat/m7-mac-mini-worker --single-branch \
  https://github.com/narenghub/playbookos.git ~/playnexa-monitor-src
cd ~/playnexa-monitor-src && git rev-parse --short HEAD
```

**No `npm install` is required.** The sampler requires only `node:fs`, `node:path` and `node:os`,
asserted by `scripts/imac-sampler-is-credential-free.test.js`, so it runs against a bare clone.

## Step 2 — find node's absolute path

`launchd` does not inherit your shell's `PATH`, so the plist must name node absolutely. A plist that
says `node` fails silently with a spawn error and looks like a monitor that simply never ran.

```sh
which -a node
node -v        # must be >= 18 for global fetch
```

Use that absolute path in Step 3 where it says `__NODE__`.

## Step 3 — check the label is free, then install the LaunchAgent

First confirm the label does not collide with the worker's. A collision would have `launchctl`
replace the worker's own agent, which is the single worst outcome available here:

```sh
ls ~/Library/LaunchAgents/
launchctl list | grep -i -E 'playnexa|worker|m7'
```

If anything already uses `com.playnexa.m7dev.continuity-monitor`, **stop** and report it rather than
overwriting. Otherwise:

```sh
cat > ~/Library/LaunchAgents/com.playnexa.m7dev.continuity-monitor.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.playnexa.m7dev.continuity-monitor</string>
  <key>ProgramArguments</key>
  <array>
    <string>__NODE__</string>
    <string>__HOME__/playnexa-monitor-src/scripts/imac-continuity-sampler.js</string>
    <string>--api</string>
    <string>https://m7-dev-worker-api-production.up.railway.app</string>
    <string>--interval-seconds</string>
    <string>60</string>
    <string>--duration-hours</string>
    <string>72</string>
    <string>--out</string>
    <string>__HOME__/playnexa-monitor/continuity.jsonl</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>__HOME__/playnexa-monitor/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>__HOME__/playnexa-monitor/stderr.log</string>
</dict>
</plist>
PLIST

# substitute the two placeholders
python3 - <<'PY'
import os, pathlib, subprocess
p = pathlib.Path.home() / "Library/LaunchAgents/com.playnexa.m7dev.continuity-monitor.plist"
node = subprocess.run(["bash","-lc","command -v node"], capture_output=True, text=True).stdout.strip()
assert node, "node not found on PATH"
t = p.read_text().replace("__NODE__", node).replace("__HOME__", str(pathlib.Path.home()))
p.write_text(t)
print("node:", node)
PY

mkdir -p ~/playnexa-monitor
plutil -lint ~/Library/LaunchAgents/com.playnexa.m7dev.continuity-monitor.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.playnexa.m7dev.continuity-monitor.plist
launchctl print gui/$(id -u)/com.playnexa.m7dev.continuity-monitor | head -20
```

`KeepAlive { SuccessfulExit false }` is the deliberate choice, and it is the same reasoning
`src/worker-client/run.js` records for the worker: a clean exit means the 72-hour window completed,
so it must **not** be relaunched; a crash exits non-zero and is relaunched. A relaunch starts a new
window and writes a fresh `started` record, so the outage is visible in the timestamps either side
of it rather than being papered over.

## Step 4 — verify it is actually sampling

```sh
sleep 150
tail -3 ~/playnexa-monitor/continuity.jsonl
```

Expect `sinceLastMs` near 60000. A value far above that is a **monitoring** gap, not an application
outage; the summary line says so explicitly, and the two must not be conflated in any report.

## Step 5 — verify automatic recovery, which the owner required

```sh
pgrep -u "$(id -u)" -f imac-continuity-sampler.js          # note the pid
kill "$(pgrep -u "$(id -u)" -f imac-continuity-sampler.js | head -1)"
sleep 20
pgrep -u "$(id -u)" -f imac-continuity-sampler.js          # a DIFFERENT pid = recovery works
tail -2 ~/playnexa-monitor/continuity.jsonl
```

A new pid and a new `started` record is the recovery evidence. Confirm the worker is untouched:

```sh
pgrep -u "$(id -u)" -f worker-client/run.js                 # unchanged pid
```

The monitor's path deliberately does not contain `worker-client/run.js`, which is the substring the
worker's own liveness check greps for — so the worker cannot count the monitor as a worker, and this
is asserted by a test rather than left to the filename.

## Limitations after reboot or logout — required disclosure

- This is a **user LaunchAgent**, not a system daemon, precisely so it needs no administrator
  privileges. It therefore runs **only while the user is logged in to a GUI session**. Log out and
  monitoring stops.
- After a **reboot**, nothing runs until someone logs in. With **FileVault enabled**, the disk must
  be unlocked at the login window first, so an unattended reboot leaves the monitor down
  indefinitely — and the gap appears in `continuity.jsonl` as a long `sinceLastMs` after the next
  `started` record.
- **Sleep** suspends sampling. macOS may sleep the machine on idle even while logged in; `caffeinate`
  or a Energy Saver change would prevent it, and both are changes to the machine's settings that the
  owner has not authorized here, so neither is applied. Without one, a 72-hour window on a machine
  that sleeps will contain gaps that are the machine's, not the application's.
- A system daemon in `/Library/LaunchDaemons` would survive logout, but needs `sudo` and runs as
  root. That is excluded by the owner's conditions and is not proposed.

## Uninstall

```sh
launchctl bootout gui/$(id -u)/com.playnexa.m7dev.continuity-monitor
rm ~/Library/LaunchAgents/com.playnexa.m7dev.continuity-monitor.plist
# records are deliberately left in place: ~/playnexa-monitor/continuity.jsonl is the evidence
```
