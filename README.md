# Qurp

A Linux extension for **GNOME Shell**, built into the Quick Settings panel and powered by
[sing-box](https://sing-box.sagernet.org/). Add a subscription, pick a server, connect.

> English | [Persian](README.fa.md)


![Qurp panel, overview](<Screenshot From 2026-10-11 06-39-31.png>)
![Qurp panel, one subscription open](<Screenshot From 2026-10-11 06-37-13.png>)
![When the qurp connected! ](<Screenshot From 2026-10-11 06-39-12.png>)
## Features

- **Protocols:** VLESS (TCP, WebSocket, gRPC, HTTP/2, HTTPUpgrade; TLS and Reality), VMess, Trojan,
  Shadowsocks, Hysteria2.
- **Subscriptions:** link lists, base64 (also URL-safe) and sing-box JSON; automatic updates; traffic and
  expiry shown when the provider sends them; bulk add.
- **Two modes:** system proxy (GNOME proxy settings) or **TUN** (all traffic).
- **Kill switch** (nftables): blocks everything outside the tunnel; fail-closed.
- **Routing:** direct / block lists for domains, IP ranges and applications, and an `ir-bypass` preset.
- **Server tests:** TCP connect or real delay through sing-box; connect to the fastest server; pin favourites.
- **Reliability:** auto-connect at login, automatic reconnect (core exit, dead tunnel, network change).
- **Privacy options:** DNS leak protection (always on in TUN mode), custom DNS servers, optional TLS
  fragmentation, exit-IP check. Destination domains are **not** written to the log unless you ask for it.
- **Panel:** lives in Quick Settings; choose where its tile sits (below Wi-Fi by default, or any slot) in
  *Settings → General*. Subscriptions open one at a time and the server list fits your screen.
- **Updates:** a version chip in the panel turns red when a newer release is on GitHub (checked about twice a day).
- **Languages:** English, Persian (right-to-left layout) and Chinese.

## Requirements

| What | Needed for |
|---|---|
| GNOME Shell 46 – 50 (49 and 50: see [Compatibility](#compatibility)) | everything |
| [sing-box](https://sing-box.sagernet.org/installation/) **1.12 or newer**, in your `PATH` (the installer can fetch it) | everything |
| `nftables` and `polkit` (`pkexec`) | kill switch |
| `libcap` tools (`setcap`, `getcap`) | TUN mode |

Qurp does **not** bundle sing-box. The easiest way is to let the installer download the official release
for you (`./install.sh --install-core`, see [Installation](#installation)). You can also install it from
your distribution's repository or by hand; check with `sing-box version`.

### Installing sing-box by hand (any distribution, including Fedora)

If your distribution does not package it, install the official release binary
(use `linux-arm64` instead of `linux-amd64` on ARM; pick the latest version on the
[releases page](https://github.com/SagerNet/sing-box/releases)):

```bash
VER=1.14.2
curl -LO https://github.com/SagerNet/sing-box/releases/download/v$VER/sing-box-$VER-linux-amd64.tar.gz
tar xzf sing-box-$VER-linux-amd64.tar.gz
sudo install -m 0755 sing-box-$VER-linux-amd64/sing-box /usr/local/bin/sing-box
sudo restorecon -v /usr/local/bin/sing-box     # only needed on SELinux systems such as Fedora
sing-box version
```

Qurp looks for `sing-box` in the shell's `PATH` and then in `/usr/local/bin`, `/usr/bin`, `~/.local/bin`,
`~/go/bin` and `~/bin`. Log out and back in after installing it.

## Installation

```bash
git clone https://github.com/1xpwn/qurp.git
cd qurp
./install.sh                # install the extension (checks your system first)
./install.sh --install-core # same, and download + install sing-box if it is missing
./install.sh --check        # only check your system, change nothing
```

The installer works in steps and tells you what it finds: GNOME Shell version, sing-box (and its version),
the optional tools, then what it installed. At the end it prints the **next steps**, and, if something is
missing, an **ACTION REQUIRED** block with the exact fix. It asks before downloading anything
(use `-y` to answer yes). Run it as your normal user, not with `sudo`; it asks for `sudo` only where needed.

Optional parts (they ask for `sudo`):

```bash
./install.sh --helper   # kill switch: installs /usr/local/libexec/qurp-helper and a polkit policy
./install.sh --tun      # TUN mode: owner-only copy of sing-box with network capabilities
./install.sh --all      # both
```

Then **restart GNOME Shell** (Wayland: log out and back in; X11: `Alt+F2`, type `r`, Enter) and enable it:

```bash
gnome-extensions enable qurp@gnome-shell-extension
```

### Manual install

```bash
DEST=~/.local/share/gnome-shell/extensions/qurp@gnome-shell-extension
mkdir -p "$DEST"
cp -r extension.js prefs.js metadata.json stylesheet.css schemas locales helper "$DEST"/
glib-compile-schemas "$DEST/schemas"
```

### Uninstall

```bash
./install.sh --uninstall
```

This removes the extension, the helper, the private sing-box copy and any leftover kill-switch rules.
Your settings and logs in `~/.config/qurp` are kept; delete that folder if you want them gone.

## Usage

1. Click the **Qurp** tile in Quick Settings (the panel also holds the server list).
2. Open **Settings** and, on the *Subscriptions* page, add your subscription URL (or use *Bulk add* to paste
   several URLs or links).
3. Pick a server in the panel and connect. Use the test button to measure servers first.

### System proxy vs. TUN

*System proxy* sets GNOME's proxy settings, so it only covers applications that respect them (browsers
usually do). *TUN* routes all traffic through a virtual interface and needs `./install.sh --tun`.
Your own proxy settings are saved when Qurp connects and restored when it disconnects.

### Kill switch

Needs `./install.sh --helper`; switch it on in *Settings → Advanced*. While connected, only the tunnel, the server address, local ranges and
DHCP may leave the machine; plain DNS and DNS-over-TLS (ports 53 and 853) are dropped outside the tunnel.
Authentication is requested through polkit when the rules are applied.

Things to know:

- With the kill switch **on**, domain- and app-based *direct* rules (including `ir-bypass`) are not applied,
  because direct traffic would be blocked. Direct IP ranges are allowed. The panel tells you when this happens.
- If the shell crashes while the kill switch is active, Qurp shows a *blocked* state on the next start with a
  button to release it. To remove the rules by hand: `sudo nft delete table inet qurp_ks`.
- Other servers cannot be tested while the kill switch is on.

## Privacy and network access

Qurp has no telemetry. It contacts:

- your **subscription URLs**;
- `www.gstatic.com/generate_204`, **through the tunnel**, to measure the connected server's latency;
- `api.ipify.org`, `ipv4.icanhazip.com`, `checkip.amazonaws.com`, `ifconfig.me`, **through the tunnel**, when you
  check the exit IP;
- the **GitHub API** (about twice a day) to look for a newer release. Turn it off in
  *Settings → Advanced → Check for new releases*.

Local files are in `~/.config/qurp/` (subscriptions cache, usage, `client.log`), created with owner-only
permissions. Subscription URLs and server links contain credentials; do not share these files or the log.
The core's log level is `warn`; *Verbose core log* writes every destination domain to disk, so leave it off
unless you are debugging.

## Troubleshooting

| Problem | What to do |
|---|---|
| "sing-box is not installed" (`core_missing` in the log) | Run `./install.sh --install-core` (or [install it by hand](#installing-sing-box-by-hand-any-distribution-including-fedora)), then log out and back in. The log line says what to do and shows the `PATH` the shell searched. |
| "sing-box could not be started" | The file exists but cannot run: check `ls -l $(command -v sing-box)`, the architecture (`file`), and SELinux (`sudo ausearch -m avc -ts recent`). |
| "sing-box is too old" | Run `./install.sh --install-core` to get the latest release (Qurp needs 1.12 or newer). |
| "The local proxy port is already in use" | Change the port in *Settings → Advanced*. |
| No internet after a crash | Release the *blocked* state in the panel, or run `sudo nft delete table inet qurp_ks`. |
| GNOME proxy still set after a crash | Qurp restores it at the next start; or run `gsettings set org.gnome.system.proxy mode 'none'`. |
| TUN mode refuses to start | Run `./install.sh --tun` again (after every sing-box update). |
| Logs | *Settings → Logs*, or `~/.config/qurp/client.log`; shell errors: `journalctl --user -g qurp`. |

## Compatibility

- GNOME Shell 46, 47, 48: supported.
- GNOME Shell 49 and 50 are listed in `metadata.json` but have had little testing; please report problems.
- Tested on: Fedora and Ubuntu.

## Limitations

- sing-box cannot carry **xhttp**, **kcp** and **quic** transports; such links are listed but marked and
  refuse to connect.
- **Clash YAML** subscriptions are not supported (use the plain link or sing-box JSON format).
- Connecting to the fastest server uses TCP or real delay probes, which can look similar behind a CDN.

## Building a release zip

```bash
git archive --format=zip --prefix=Qurp-1.0.0/ -o Qurp-1.0.0.zip v1.0.0
```

For the in-app update check to work, publish releases on GitHub with tags like `v1.0.0` and keep the
`url` field in `metadata.json` pointing at this repository.

## Contributing

Issues and pull requests are welcome. Please include your GNOME Shell version, your sing-box version and the
relevant lines of `client.log` (with domains and credentials removed).

## Disclaimer

Qurp is a general-purpose network tool. You are responsible for using it in accordance with the laws that
apply to you and with the terms of your network and service providers. It is provided as is, without warranty.

## License

[GPL-3.0-only](LICENSE). Copyright (C) 2026 MNM.

sing-box is a separate project with its own license and is not part of this repository.
