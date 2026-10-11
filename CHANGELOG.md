# Changelog

## 1.0.0
First public release.

- Proxy client for GNOME Shell (Quick Settings tile) on top of sing-box.
- VLESS (TCP, WebSocket, gRPC, HTTP/2, HTTPUpgrade; TLS and Reality), VMess, Trojan, Shadowsocks and
  Hysteria2 links.
- Subscriptions: plain link lists, base64 (also URL-safe) and sing-box JSON; auto-update, traffic and
  expiry shown when the provider sends them.
- System-proxy mode and TUN mode.
- Kill switch (nftables, through a small privileged helper): fail-closed, atomic rule replacement,
  plain DNS / DoT blocked outside the tunnel.
- Routing: direct / block lists for domains, IP ranges and apps, plus an `ir-bypass` preset.
- Server tests: TCP connect or real delay through sing-box; connect to the fastest server.
- Auto-connect, automatic reconnect (core exit, dead tunnel, network change), exit-IP check.
- DNS leak protection (always on in TUN mode), custom DNS servers, optional TLS fragmentation.
- Interface in English, Persian (right-to-left) and Chinese.
- Quick Settings tile placement (below Wi-Fi by default, or any slot) chosen in the settings window; the
  server list is fitted to the screen and subscriptions open as an accordion.
- Version chip with a twice-a-day check for newer GitHub releases (can be turned off).
- Core log level is `warn` by default so destination domains are not written to disk.
- Installer with a step-by-step report, `--check` (look only), `--install-core` (downloads the official
  sing-box release) and a closing "next steps" / "action required" summary.
- Log lines for every fixable error say exactly what to do (install sing-box, `./install.sh --helper`, ...),
  and the log records at start-up whether sing-box and the kill switch helper are usable.

Known limitations: transports sing-box cannot carry (xhttp, kcp, quic) and Clash YAML subscriptions are
not supported; with the kill switch on, domain- and app-based direct rules are not applied.
