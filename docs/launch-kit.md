# Qurp launch kit

Ready-to-post copy for the demo GIF/video. Replace nothing except the link if you fork the project.

## Files

| File | Best for |
|---|---|
| `assets/qurp-demo.gif` | GitHub README, blogs, forums |
| `assets/qurp-demo.mp4` | X/Twitter, Mastodon, Reddit, LinkedIn (better quality, smaller than the GIF) |
| `assets/qurp-social.png` | Link preview / social card (1280×640) |

**Alt text (use this everywhere):**

> Animated demo of Qurp in GNOME: the Quick Settings panel opens, a server is selected, the tunnel
> connects and the tile turns green; feature cards show the kill switch, TUN mode, auto-reconnect,
> DNS leak protection and routing rules.

## One-line pitch

> A full proxy client that lives in GNOME Quick Settings — built on sing-box, with TUN, a fail-closed
> kill switch and no telemetry.

## X / Twitter

> Qurp 1.0 is out: a proxy client that lives in GNOME Quick Settings.
>
> VLESS · VMess · Trojan · Shadowsocks · Hysteria2
> TUN or system proxy
> Kill switch · routing · DNS leak protection
> Auto-reconnect · no telemetry · GPL-3.0
>
> github.com/1xpwn/qurp

Attach `qurp-demo.mp4` (or the GIF).

## Mastodon

> Qurp 1.0 — a proxy client for GNOME Shell that lives in Quick Settings.
>
> Add a subscription, pick a server, connect. It runs sing-box underneath: VLESS (TCP/WS/gRPC/HTTP2/
> HTTPUpgrade, TLS + Reality), VMess, Trojan, Shadowsocks, Hysteria2. Choose system-proxy mode or TUN for
> every app. Optional nftables kill switch, direct/block routing, DNS leak protection, auto-reconnect.
>
> No telemetry. Destination domains are not logged by default. GPL-3.0.
>
> github.com/1xpwn/qurp
>
> #GNOME #Linux #sing-box #OpenSource #Privacy

## Reddit — r/gnome

**Title:** Qurp 1.0 — a proxy client that lives in GNOME Quick Settings (sing-box, TUN, kill switch)

**Body:**

> I built Qurp, a GNOME Shell extension that puts a full sing-box proxy client in Quick Settings.
>
> What it does:
>
> - Subscriptions: plain links, base64 and sing-box JSON, with traffic/expiry when the provider sends it.
> - Protocols: VLESS (TCP, WS, gRPC, HTTP/2, HTTPUpgrade; TLS and Reality), VMess, Trojan, Shadowsocks,
>   Hysteria2.
> - System-proxy mode, or TUN mode where every app goes through the tunnel.
> - Optional nftables kill switch (fail-closed), direct/block routing, `ir-bypass`, DNS leak protection,
>   TLS fragmentation, exit-IP check.
> - Auto-connect at login and auto-reconnect after a core crash, dead tunnel or network change.
> - English, Persian (RTL) and Chinese UI. No telemetry.
>
> The demo GIF is the real UI flow: Quick Settings → subscription → server → connect.
>
> Requirements: GNOME 46–50, sing-box 1.12+. The installer can fetch sing-box; `--helper` adds the kill
> switch and `--tun` sets up TUN mode.
>
> Repo: https://github.com/1xpwn/qurp — GPL-3.0. Feedback and bug reports are welcome, especially from
> GNOME 49/50 users.

## Hacker News — Show HN

**Title:** Show HN: Qurp – a proxy client in GNOME Quick Settings

**Body:**

> Qurp is a GNOME Shell extension that wraps sing-box in a Quick Settings panel. You add a subscription,
> pick a server and connect; the extension generates a sing-box config, validates it with `sing-box check`,
> runs the core and points either GNOME's system proxy or a TUN interface at it.
>
> The interesting parts: a fail-closed nftables kill switch through a small polkit helper, routing by
> domain/IP/app, DNS leak protection (always on in TUN), and a watchdog that reconnects after core crashes
> or network changes. It is GJS, GPL-3.0, and deliberately does not implement any proxy protocol itself.
>
> Demo and source: https://github.com/1xpwn/qurp
>
> Happy to answer questions about the GNOME Shell integration, the kill switch, or sing-box config
> generation.

## LinkedIn

> Qurp 1.0 is out: a native proxy client for GNOME Shell, built on sing-box.
>
> It lives in Quick Settings — add a subscription, pick a server, connect. Users get VLESS/VMess/Trojan/
> Shadowsocks/Hysteria2 support, a choice between system proxy and TUN, a fail-closed nftables kill switch,
> routing rules, DNS leak protection and automatic reconnect. No telemetry; GPL-3.0.
>
> The project is a thin GJS front-end: Qurp generates a private sing-box config at connect time, validates
> it, starts the core, and hands it either the GNOME proxy settings or a TUN device. A watchdog keeps the
> tunnel honest.
>
> Source and demo: https://github.com/1xpwn/qurp
>
> #GNOME #Linux #OpenSource #Privacy #Networking

## Short blog intro

> Most Linux proxy clients are Electron apps or browser extensions. Qurp takes a different route: it is a
> GNOME Shell extension, so the whole client lives where you already switch Wi-Fi and Bluetooth on — Quick
> Settings. Under the hood it is a careful front-end for sing-box: subscriptions are parsed into outbounds,
> a private config is generated and validated on every connect, and a watchdog keeps the tunnel alive.
> TUN mode covers every app; a fail-closed nftables kill switch makes sure nothing escapes if the tunnel
> drops. It is GPL-3.0 and has no telemetry.

## Screenshot captions

- **Panel:** "Qurp lives in GNOME Quick Settings — subscriptions and servers open right there."
- **Connected:** "One click: the tile turns green, the tunnel is up."
- **Under the hood:** "Kill switch, TUN, auto-reconnect, DNS protection and routing — all in the same panel."
- **Finale:** "One click. Whole system. github.com/1xpwn/qurp"

## Publishing checklist

1. Add `assets/qurp-demo.gif`, `assets/qurp-demo.mp4` and `assets/qurp-social.png` to the repo.
2. Confirm the README hero renders on GitHub (GIF autoplays, under ~10 MB).
3. Upload the MP4 as the native video on X/Mastodon/Reddit; use the GIF only where video is not supported.
4. Use the alt text above; do not describe it as a VPN — Qurp is a proxy client.
5. Pin a comment with the install steps:
   `git clone https://github.com/1xpwn/qurp && cd qurp && ./install.sh --install-core`
