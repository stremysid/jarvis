# Home node service

This runbook installs the existing Python memory agent as one foreground Linux
process supervised by systemd. It opens the archive and memory stores, pulls
cloud events with the enrolled Ed25519 identity, submits distillation requests,
and serves `status`, `run-once`, and `stop` on a private Unix socket.

## Prepare the account and files

Install the local-agent checkout at `/opt/jarvis/local-agent`, create its locked
environment, and install the console command:

Install a supported Python 3.12-3.14 interpreter at `/usr/bin/python3`. The
service sandbox cannot use a uv-managed interpreter under an operator's home
because `ProtectHome=true` hides that path.

```sh
getent passwd jarvis >/dev/null || sudo useradd --system --user-group --home /var/lib/jarvis --shell /usr/sbin/nologin jarvis
cd /opt/jarvis/local-agent
uv sync --locked --python /usr/bin/python3 --no-managed-python
sudo install -d -o jarvis -g jarvis -m 0700 /var/lib/jarvis
sudo install -d -o root -g jarvis -m 0750 /etc/jarvis
sudo touch /etc/jarvis/node.env
sudo chown root:jarvis /etc/jarvis/node.env
sudo chmod 0640 /etc/jarvis/node.env
```

Put these names in `/etc/jarvis/node.env`. Every path must be an absolute Linux
path. The archive and memory paths must resolve to different files.

```dotenv
JARVIS_CLOUD_BASE_URL=https://your-gateway.example
JARVIS_DEVICE_ID=
JARVIS_PRINCIPAL_ID=
JARVIS_DEVICE_KEY_PATH=/var/lib/jarvis/device.key
JARVIS_ARCHIVE_PATH=/var/lib/jarvis/archive.sqlite3
JARVIS_MEMORY_PATH=/var/lib/jarvis/memory.sqlite3
JARVIS_CONTROL_SOCKET=/run/jarvis/control.sock
```

Create and enroll the identity once, as the service account. `jarvis node`
will refuse a missing key rather than silently creating a new identity.

```sh
sudo -u jarvis sh -c 'set -a; . /etc/jarvis/node.env; set +a; /opt/jarvis/local-agent/.venv/bin/jarvis enroll'
```

Register the printed public enrollment material through the existing cloud
device-enrollment process before starting the node. Keep both `device.key` and
`device.key.seal-key`; the first cannot be decrypted without the second.

## Install and operate the service

```sh
sudo install -o root -g root -m 0644 systemd/jarvis-node.service /etc/systemd/system/jarvis-node.service
sudo systemctl daemon-reload
```

Before enabling the service, inspect the effective sandbox on the target host:

```sh
sudo systemd-analyze security jarvis-node.service
```

This is a local systemd configuration analysis. It does not prove that the node
is running or that the cloud has accepted it.

```sh
sudo systemctl enable --now jarvis-node.service
```

Control commands must run as `jarvis`, because both the socket mode and Linux
peer credentials reject other users:

```sh
sudo -u jarvis env JARVIS_CONTROL_SOCKET=/run/jarvis/control.sock /opt/jarvis/local-agent/.venv/bin/jarvis status
sudo -u jarvis env JARVIS_CONTROL_SOCKET=/run/jarvis/control.sock /opt/jarvis/local-agent/.venv/bin/jarvis run-once
sudo -u jarvis env JARVIS_CONTROL_SOCKET=/run/jarvis/control.sock /opt/jarvis/local-agent/.venv/bin/jarvis stop
```

Exit status 3 means configuration needs correction. Exit status 5 means the
device identity, enrollment, or signed-request clock needs attention; systemd
does not restart either failure in a loop. `SIGTERM` requests a graceful stop
after the active cycle: close both stores, remove only this process's socket,
and exit. Each HTTP operation has a 30-second socket timeout. An expired ACK
recovery can make three sync requests before the next stage, with stop checks
between requests, so the unit allows 180 seconds for shutdown before systemd
escalates the stop.

The current node stores each new pending sync acknowledgement with its snapshot
boundary and gateway, device, and principal owner. If an archive upgraded from
an older version already has a `pending_sync_ack` row without that metadata,
the node fails closed because it cannot reconstruct a safe signed ACK. Stop and
obtain owner-directed repair; do not delete the owed row, reset the cursor, or
claim the archive is synchronized.

After startup, the owner smoke is a successful `status` as `jarvis`. A status
attempt as another ordinary account must be refused by the socket permissions
or the kernel peer-UID check.

The node never deletes a pre-existing socket at startup. If it reports an
existing endpoint, first confirm the unit is inactive, then inspect the exact
entry without following links:

```sh
sudo systemctl is-active jarvis-node.service
sudo stat -c '%U %a %F' /run/jarvis/control.sock
```

Remove that path only after confirming the service is inactive, no foreground
`jarvis node` process is using it, and `stat` reports an owner of `jarvis`,
mode `600`, and type `socket`. Any other owner, mode, type,
or a symbolic link is an incident to investigate rather than a stale endpoint.
