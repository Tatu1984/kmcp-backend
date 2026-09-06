# Standing the gateway up on AWS

Written for the topology KMCP is on: the cameras are reachable from the
internet, so the gateway pulls them and nothing runs at the kerb.

Mumbai — **ap-south-1** — for the same reasons as the rest of the production
plan: DPDP data residency, and the shortest path between a camera in Kolkata and
whoever is watching it.

Roughly 45 minutes end to end, most of it waiting for DNS.

---

## 1. The instance

**Lightsail, 2 GB / 2 vCPU (₹1,000–1,400 a month).** Lightsail rather than EC2
because it bundles the static IP, the firewall and 3 TB of transfer into one
price, and transfer is what this workload actually spends. On EC2 the same
machine is a `t4g.small` and the bandwidth is billed separately, which for
twenty cameras being watched is the larger number.

Sizing: MediaMTX re-packages streams rather than re-encoding them, so it never
decodes video and CPU stays low — 2 vCPU carries 20–40 cameras comfortably. What
runs out first is bandwidth: reckon the camera's own bitrate (2–4 Mbit/s) times
the number of people watching it, and use the sub-stream for tiles.

```
Region     ap-south-1 (Mumbai)
Blueprint  Ubuntu 24.04 LTS
Plan       2 GB RAM, 2 vCPU, 60 GB SSD
Name       kmcp-gateway
```

Attach a **static IP** immediately after it boots — Lightsail calls it "Networking
→ Create static IP". A gateway whose address changes on reboot takes both DNS
records and the API's control URL with it.

## 2. The firewall

In Lightsail's Networking tab, delete the default rules and add exactly these:

| Application | Protocol | Port | Restricted to |
| --- | --- | --- | --- |
| HTTP | TCP | 80 | Anywhere — needed only so Caddy can answer the ACME challenge |
| HTTPS | TCP | 443 | Anywhere |
| Custom | UDP | 8189 | Anywhere — WebRTC media |
| SSH | TCP | 22 | **Your office IP only** |

Nothing else. In particular **not 9997** and **not 8554**: the control API is
reached through Caddy on 443, and nothing publishes to this gateway in the pull
topology.

## 3. DNS

Three records at whoever holds `infinititechpartners.com`, all pointing at the
static IP:

```
video.infinititechpartners.com     A    <static-ip>
webrtc.infinititechpartners.com    A    <static-ip>
control.infinititechpartners.com   A    <static-ip>
```

**Wait for these to resolve before the next step.** Caddy asks Let's Encrypt for
certificates on first start and the challenge fails if the names do not yet
point at the box — and Let's Encrypt rate-limits failures, so a premature start
costs an hour rather than a retry.

```bash
dig +short video.infinititechpartners.com    # must print the static IP
```

## 4. The box

```bash
ssh ubuntu@<static-ip>

# Docker, from Docker's own repository rather than Ubuntu's, which ships an
# older engine without `docker compose` as a subcommand.
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit            # and ssh back in, so the group membership takes effect
```

Then copy this directory up. The repository is private, so either add a deploy
key, or simply send the five files — they are all this needs:

```bash
# from a laptop that has the repo
scp -r deploy/streaming ubuntu@<static-ip>:~/gateway
```

## 5. Configure and start

```bash
cd ~/gateway
cp .env.example .env

# Three secrets. Keep the plaintext of the third one — it goes to the API.
openssl rand -base64 24                                    # GATEWAY_READ_PASSWORD
openssl rand -base64 24                                    # GATEWAY_PUBLISH_PASSWORD
openssl rand -base64 24                                    # the control password
docker run --rm caddy:2-alpine caddy hash-password --plaintext '<control password>'
                                                           # → CONTROL_PASSWORD_HASH

nano .env      # DOMAIN, ACME_EMAIL, the two gateway passwords,
               # CONTROL_USER, CONTROL_PASSWORD_HASH

docker compose up -d
docker compose logs -f caddy     # watch the certificates being issued
```

Two or three minutes later:

```bash
curl -I https://video.infinititechpartners.com/          # 404 from MediaMTX is correct —
                                                         # no camera path exists yet
curl -u kmcp-api:'<control password>' \
     https://control.infinititechpartners.com/v3/config/global/get   # JSON = working
```

A 404 with a valid certificate is success at this stage. The gateway has no
cameras until the API tells it about them, and it will not do that until step 6.

## 6. Tell the API

In the Vercel dashboard, **kmcp-backend → Settings → Environment Variables**,
add five and redeploy:

| Variable | Value |
| --- | --- |
| `MEDIAMTX_CONTROL_URL` | `https://control.infinititechpartners.com` |
| `MEDIAMTX_CONTROL_USER` | `kmcp-api` |
| `MEDIAMTX_CONTROL_PASSWORD` | the control password in plaintext |
| `MEDIAMTX_HLS_BASE` | `https://video.infinititechpartners.com` |
| `MEDIAMTX_WEBRTC_BASE` | `https://webrtc.infinititechpartners.com` |

Plus `ENCRYPTION_KEY` (`openssl rand -base64 48`) if it is not set yet — without
it, registering a camera that has a password is refused.

Redeploy after saving. Vercel reads environment variables at build time; an
existing deployment does not pick them up.

## 7. The first camera

In the portal: **Cameras → Register camera**. Road, code, where it points, the
RTSP address, and the camera's own username and password. Then **Test
connection** — it opens the stream with ffprobe and reports the resolution and
codec, or why it could not.

Then expand that road. The picture should appear within a few seconds: the
gateway opens a camera when somebody asks to watch it, so the first play on a
cold path is slower than the rest.

### When it does not

| Symptom | Cause |
| --- | --- |
| Tile says "no gateway is configured" | The three variables did not reach the running deployment. Redeploy after saving them. |
| Tile connects forever, nothing plays | Almost always mixed content — an `http://` base on an HTTPS page, blocked silently. Check both bases begin `https://`. |
| Test connection says "Connection refused" | The camera is not reachable from the API host. Confirm the port-forward with `ffprobe` from anywhere outside the camera's network. |
| Test connection says "401 Unauthorized" | Right address, wrong credentials. Re-enter them; blank means keep. |
| Everything works, then stops after a reboot | `docker compose up -d` sets restart policies, but confirm with `docker compose ps` that both containers came back. |

## Running costs

| | Monthly |
| --- | --- |
| Lightsail 2 GB, ap-south-1 | ~₹1,000 |
| Static IP (attached) | free |
| Transfer, 3 TB included | free within allowance |
| Certificates | free |

Roughly ₹1,000–1,400 a month, and the first cost that grows is transfer: twenty
cameras at 2 Mbit/s watched eight hours a day is about 1.7 TB, inside the
allowance. A wall left open on a control-room screen overnight is what pushes
past it.

## When the API moves to AWS

The production plan puts the API on ECS Fargate in this same region. At that
point the control API should stop being public: delete the `control.` block from
the Caddyfile, publish `127.0.0.1:9997:9997` in the compose file, put both on the
same VPC, and drop `MEDIAMTX_CONTROL_USER` and `MEDIAMTX_CONTROL_PASSWORD` from
the environment. The code sends no credentials when none are set, so that is a
configuration change and not a deployment.
