# The streaming gateway

Everything needed to put a live camera picture on the Cameras screen, and the
three values the API needs once it is running.

A browser cannot open RTSP, and must never be handed the address or the password
to try. So a media server sits between the cameras and the portal: it holds the
connection to each camera and republishes the same picture as HLS and WebRTC on
URLs that carry no secret. That server is MediaMTX. This directory is its
deployment.

---

## The one decision that changes everything: where the cameras are

Answer this before provisioning anything, because it decides whether the gateway
reaches the cameras or the cameras reach the gateway.

### A — the cameras are reachable from the internet

A static public IP with the camera ports forwarded, or a site-to-site VPN
between the camera network and the gateway's network. The gateway **pulls**:
each camera is registered in the portal with its RTSP address, and the API tells
MediaMTX to go and get it. Nothing runs at the kerb.

This is what the code does today and needs no further work.

### B — the cameras are on a private municipal network behind NAT

Which is the ordinary case. Nothing in a datacentre can dial a camera on
`10.20.0.x`, and no amount of configuration changes that. A small machine on the
same network as the cameras **pushes** instead: it pulls each camera locally and
publishes to the gateway over one outbound connection, which NAT allows.

That box is the same MediaMTX image with a different configuration — see
`edge-agent.yml`. The API side needs a small change to stop trying to pull
cameras that are pushed to it; ask and it is an afternoon's work, not a
redesign.

**If you do not know which applies:** from any machine outside the camera
network, run `ffprobe -rtsp_transport tcp rtsp://<camera-ip>:554/<path>`. If it
returns a stream, it is A. If it times out, it is B.

---

## What to run it on

One always-on Linux box. Not Vercel — a media server holds long-lived
connections and serverless functions do not.

- **Size:** 2 vCPU / 2 GB handles roughly 20–40 cameras, because MediaMTX
  re-packages the stream rather than re-encoding it. It never decodes video, so
  CPU stays low and bandwidth is the real limit: reckon on the camera's own
  bitrate (2–4 Mbit/s each) multiplied by the number of people watching.
- **Where:** ap-south-1 (Mumbai), alongside the rest of the production plan. A
  Lightsail 2 GB instance or a t4g.small is the right order of thing.
- **Ports inbound:** 443/tcp (HLS and WebRTC signalling, via Caddy), 8189/udp
  (WebRTC media). Nothing else. The control API on 9997 must **never** be
  exposed — it is bound to localhost in `mediamtx.yml` and reached by the API
  over the private network or an SSH tunnel.

## Standing it up

**On AWS, follow `AWS.md`** — instance size, firewall rules, DNS, and the
commands in order. In outline it is:

```bash
# on the box
cp .env.example .env      # DOMAIN, ACME_EMAIL, the gateway passwords,
                          # and the control credentials
docker compose up -d
```

Caddy obtains and renews the TLS certificate on its own, which matters more here
than it looks: **the portal is served over HTTPS, so the video URLs must be HTTPS
too.** A browser blocks `http://` media on an `https://` page as mixed content
and does it silently — the tile would sit on "connecting" forever with nothing
on screen to say why. An IP address and a port will not do; this needs a real
hostname with a certificate.

## The three values to send back

Once it is up, these are what the API needs. They go in the **kmcp-backend**
project's environment variables on Vercel — settings the dashboard owns, which
no commit can reach:

| Variable | Value | Notes |
| --- | --- | --- |
| `MEDIAMTX_CONTROL_URL` | `https://control.<your-domain>` | See below — this one wants to be private and cannot be. |
| `MEDIAMTX_CONTROL_USER` | `kmcp-api` | Matches `CONTROL_USER` in the gateway's `.env`. |
| `MEDIAMTX_CONTROL_PASSWORD` | the plaintext password | Caddy stores only its hash. |
| `MEDIAMTX_HLS_BASE` | `https://video.<your-domain>` | What the browser opens. Must be HTTPS. |
| `MEDIAMTX_WEBRTC_BASE` | `https://webrtc.<your-domain>` | Same. |

**Why the control API is published, when it should not be.** It configures which
camera the gateway pulls, so anyone who reaches it can point this server at a
camera of their choosing — it belongs on a private network, and an earlier draft
of this kit bound it to localhost accordingly. That assumed the API could reach
it privately. It cannot: the API runs on Vercel, and a serverless function has
no fixed egress address to allow through a firewall. So it is served over TLS,
behind a password the API sends on every request, on a hostname that appears in
no page, and MediaMTX additionally refuses an API call that did not arrive from
inside the deployment.

When the API moves to ECS in the same VPC — which is the production plan — this
goes back to being private and the credentials come out of the environment. The
code sends none when none are set, so that is a configuration change rather than
a deployment. `AWS.md` says how.

And one more, unrelated to the gateway but needed before any camera can be
registered with a password:

| Variable | Value |
| --- | --- |
| `ENCRYPTION_KEY` | output of `openssl rand -base64 48` |

Without it the API refuses to store camera credentials rather than encrypting
them under a key that lives in this repository. Losing it later means every
camera has to be given its password again, so keep it where the other secrets
are kept.

## Then the cameras

Register each one in the portal — Cameras → **Register camera** — with:

- the **road** it is bolted to, a **code** (whatever is stencilled on the
  housing), and a plain-English note of where it points;
- its **RTSP address**, e.g. `rtsp://10.20.0.4:554/Streaming/Channels/101`;
- its **username and password**.

**Type the passwords into that form rather than sending them to anyone.** They
are encrypted before they are written, decrypted only to hand the gateway a
source address, and there is no response shape in the whole API that returns
them. An email or a chat message is a copy that stays readable forever.

Then press **Test connection** on the camera. It opens the stream with ffprobe
and tells you what answered — resolution, codec, frame rate — or why it did not,
in the words the tool used. "401 Unauthorized" and "Connection refused" are two
completely different jobs, and that distinction is the whole reason the message
is passed through rather than paraphrased.

### The vendor path formats, since they are never guessable

| Make | Typical path |
| --- | --- |
| Hikvision | `rtsp://user:pass@ip:554/Streaming/Channels/101` (`102` for the sub-stream) |
| Dahua | `rtsp://user:pass@ip:554/cam/realmonitor?channel=1&subtype=0` |
| CP Plus | `rtsp://user:pass@ip:554/cam/realmonitor?channel=1&subtype=0` |
| Uniview | `rtsp://user:pass@ip:554/media/video1` |
| ONVIF (any) | ask the device: `GetStreamUri` on `http://ip/onvif/device_service` |

Prefer the **sub-stream** (the `102` / `subtype=1` variants) for a wall of
cameras: 640×480 at a lower bitrate is plenty for a tile, and the main stream is
there when somebody opens one full screen.

---

## The security gap, named rather than buried

Anyone who can fetch `https://video.<domain>/<path>/index.m3u8` can watch that
camera. The gateway does not know who the viewer is: it serves a stream to
whoever asks for the right path.

What stands in the way today is that the path is unguessable. Each camera is
given a random 32-character stream key when it is registered, so the URL is a
capability — it is handed only to portal users the API has already authorised
for that camera, it appears in no page anybody else can open, and changing the
key revokes it. `cam-camac-01` would have been the second thing anybody tried;
`7f3a9c…` is not.

That is genuinely weaker than checking, on every segment request, whether this
particular person may watch this particular street. A leaked URL stays valid
until the key is changed, and it does not expire on sign-out.

The fix is a known one and MediaMTX is built for it: `authHTTPAddress` points
the server at an endpoint of ours, which it calls before serving each request,
and we answer from the same session the portal already holds. It is an
endpoint, a short-lived token in the playback response, and one line of this
config. Worth doing before real cameras on public streets go live; not worth
blocking the first camera on.

Until then, three things carry weight, and all three are in this deployment:

- the control API is not reachable from the internet, so nobody can add a path
  pointing at a camera of their choosing;
- publishing requires a password, so nobody can overwrite a stream with their
  own;
- there is no recording, so a leaked URL exposes a street now rather than a
  street's history.

---

## What this deliberately does not do

- **No recording.** Live video only. Retention of recorded footage is a
  DPDP-relevant decision about somebody's street and belongs in a policy before
  it belongs in a config file.
- **No credentials to the browser.** The HLS and WebRTC URLs address the
  gateway, never a camera. That is the entire point of the indirection.
- **No public control API.** Port 9997 configures the server; anyone who reaches
  it can point it at any camera they like.
