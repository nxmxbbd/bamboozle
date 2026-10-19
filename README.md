# bamboozle

Your Bambu Lab printer, in Apple Home. No cloud, no Home Assistant, no Homebridge. Just one small process on your network, telling HomeKit a few white lies.

> **Status:** early, read-only. Tested with an H2C. Other models (X1, P1, A1) send the same report format and should work, but are untested.

## The lies

Apple Home has never heard of a 3D printer. It knows fans, doors and people walking around. So bamboozle improvises:

| What's really happening | What Home believes |
|---|---|
| The print is 47 % done | A fan is spinning at 47 % |
| The printer is printing | Someone is in the room |
| The print failed | A door was left open |

Home believes every word. Please don't tell it.

Not a fan of the fan? You can show progress as a window blind, a lightbulb or a humidity sensor instead (see `display.progress` in the configuration reference). bamboozle will gently undo any attempts to "turn off the fan" or "close the blind": the printer is in charge.

### The camera

When you point bamboozle at a video relay (more on that below), the Home app gets a camera tile with a status overlay: state, progress, time left, estimated finish time, layer count and temperatures, drawn over the live stream, plus a warning pill when the printer reports an HMS message or a print error. The overlay leaves the bottom-left corner free so the Home app can draw its own snapshot age label there.

![The Home app room view with sensors and a camera tile](docs/home.png)

![The camera overlay in every printer state](docs/overlay.jpg)

### The sensors

bamboozle also publishes a few sensors per printer:

- **Printing** (occupancy): "someone is in the room" while a job is active.
- **Fault** (contact): "a door was left open" on a print error or a fatal HMS message.
- **Chamber temperature**: the real thing, though a 265 C nozzle nearby will make the Home app think you live in a sauna. Give the printer its own room, or turn off **Include in Home Summaries** in the sensor's settings.

Nozzle and bed temperatures are available too (`display.temperatures`). A light sensor whose lux value is the minutes remaining (`display.countdown: ["lux"]`) is there for automations, though it only shows in the room's status bar.

### No controls (yet)

There are no controls yet. Chamber light and pause/resume are planned, only for printers that accept unsigned LAN commands (Developer Mode). There will never be a "stop". Printers are expensive, your models are precious, and bamboozle does not want that responsibility.

## What you need

The accomplice kit:

- **Node.js 22.18** or newer (TypeScript runs directly via type stripping).
- The printer's **IP address**, **serial number** and **LAN access code** (all shown on the printer's screen). bamboozle connects to the printer's MQTT port (8883).
- **Developer Mode is not needed.** Read-only status works with the printer in cloud mode, in LAN-only mode, with or without Developer Mode. (Future controls will need it.)
- For the camera: **ffmpeg** (with `libx264`, or an Intel/AMD GPU with VAAPI for hardware encoding), the **Hermit** font (`fonts-hermit` on Debian/Ubuntu) and **fontconfig**.

That's it. No plugins, no Home Assistant, no Homebridge.

<!-- DRAFT: pending implementation -->
## Install (npm, coming soon)

The short version, once the package exists:

```sh
npm install -g @nxmxbbd/bamboozle
```

Then let it set itself up:

```sh
bamboozle init
```

`init` asks for the printer IP and access code (the code is not echoed), reads the serial from the printer's TLS certificate, writes the config and an access-code file to `~/.config/bamboozle/`, and checks that the printer answers. One command, zero config files to hand-write.

Then start the bridge:

```sh
bamboozle serve
```

While it is not paired, `serve` shows a QR code in the terminal. Point the iPhone camera at it.
<!-- /DRAFT -->

## Install (from source)

For now, the old-fashioned way:

```sh
git clone https://github.com/nxmxbbd/bamboozle.git && cd bamboozle
npm ci --omit=dev
```

Two commands. You have survived worse. From a checkout, `node src/cli.ts` plays the part of the `bamboozle` command.

## Printer prep

You need two things from the printer's touchscreen, both in its network / LAN settings: the IP address and the LAN access code. Writing the config by hand? Grab the serial number too.

The access code belongs in a file, not on a command line where your shell might remember it, and not in the config where you might accidentally commit it. `init` takes care of that. Doing it yourself:

```sh
(umask 077; read -rsp 'Access code: ' code && printf '%s' "$code" > printer.code)
```

(That keeps the code out of your shell history. Opening `printer.code` in an editor works too: surrounding whitespace and the final newline are ignored. Then `chmod 600 printer.code`.)

## Camera

The printer's own camera stream is RTSPS on port 322, authenticated with the access code as a password. bamboozle refuses camera URLs that contain credentials (they would show up in ffmpeg's command line as process arguments), so the stream needs a middleman.

[go2rtc](https://github.com/AlexxIT/go2rtc) does the job nicely. Point it at the printer:

```yaml
streams:
  printer: rtspx://bblp:ACCESS_CODE@192.0.2.10:322/streaming/live/1
```

(`rtspx` is go2rtc's shorthand for RTSPS without certificate verification.)

Then point bamboozle at the relay:

```json
"camera": { "source": "rtsp://127.0.0.1:8554/printer" }
```

A relay is good anyway: every Home app viewer shares the relay's one connection to the printer, so people can open and close the camera all day without the printer noticing. That matters, because whenever a direct RTSPS client disconnects, the printer's stream freezes for everyone else for about 10 seconds. Fewer direct clients, fewer hiccups.

**go2rtc security note:** go2rtc's API endpoints (`/api/streams`, `/api/config`) will happily show the source URL, access code included. Bind the go2rtc API to localhost, or firewall it.

<!-- DRAFT: pending implementation -->
### Docker Compose (coming soon)

A Docker Compose setup with bamboozle and a go2rtc sidecar, both on the host network (mDNS, HomeKit TCP and video UDP need it):

```yaml
services:
  bamboozle:
    image: ghcr.io/nxmxbbd/bamboozle
    network_mode: host
    volumes:
      - ./config.json:/app/config.json:ro
      - ./printer.code:/app/printer.code:ro
      - bamboozle-storage:/app/storage
    # Optional: VAAPI hardware encoding
    # devices:
    #   - /dev/dri:/dev/dri

  go2rtc:
    image: alexxit/go2rtc
    network_mode: host
    volumes:
      - ./go2rtc.yaml:/config/go2rtc.yaml:ro

volumes:
  bamboozle-storage:
```
<!-- /DRAFT -->

## Configure and pair

Now to introduce them. The quick way:

```sh
node src/cli.ts init
```

It asks for the IP and the access code (typing the code shows nothing, on purpose), reads the serial from the printer's certificate, asks for a name and an optional camera relay URL, writes everything to `~/.config/bamboozle/` (readable only by you) and checks that the printer answers. It will not overwrite an existing config, because your Home pairing lives next to it; `init --force` rewrites the config and keeps the pairing.

Then start the bridge:

```sh
node src/cli.ts serve
```

While the bridge is not paired, `serve` shows a QR code: point the iPhone camera at it. No camera handy? In the Home app choose **Add Accessory**, then **More options**, pick the bridge and enter the code printed above the QR code.

**Where the config lives.** `--config <file>` wins, then `$BAMBOOZLE_CONFIG`, then `$XDG_CONFIG_HOME/bamboozle/config.json` (usually `~/.config/bamboozle/config.json`). Pairing keys and certificate pins sit in `storage/` next to the config: keep one config and you keep one bridge.

**By hand.** Prefer to write the config yourself? Put this in a `config.json` (`chmod 600`) next to `printer.code`:

```json
{
  "printers": [
    {
      "name": "Printer",
      "model": "H2C",
      "host": "192.0.2.10",
      "serial": "YOUR-PRINTER-SERIAL",
      "accessCodeFile": "printer.code",
      "camera": { "source": "rtsp://127.0.0.1:8554/printer" }
    }
  ],
  "camera": { "encoder": "libx264" }
}
```

Check that bamboozle can reach the printer:

```sh
node src/cli.ts probe --config config.json
```

`probe` connects to every configured printer, grabs one status report, prints it as JSON and exits. If all printers respond, you're good. If not, that printer shows `"ok": false`, plus the error when there was one.

Want to see how it looks before printing anything? `serve --simulate` feeds a simulated print cycle into the Home app, complete with progress, temperatures, and a brief simulated fault at the halfway mark. The printer need not be on.

## Run it for real

Once you're happy with the tiles, make it permanent. Here is an example systemd unit that puts the code in `/opt/bamboozle` and the config, access-code file and pairing state in `/var/lib/bamboozle`, owned by a dedicated `bamboozle` system user (add it to the `render` group if you use VAAPI):

```ini
[Unit]
Description=bamboozle (Apple Home bridge for Bambu Lab printers)
Wants=network-online.target
After=network-online.target

[Service]
User=bamboozle
Group=bamboozle
SupplementaryGroups=render
WorkingDirectory=/opt/bamboozle
ExecStart=/usr/bin/node src/cli.ts serve --config /var/lib/bamboozle/config.json
StateDirectory=bamboozle
StateDirectoryMode=0700
UMask=0077
Restart=always
RestartSec=10
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

Keep `storagePath` when you move or upgrade bamboozle. It holds the bridge's identity and pairing keys. Lose it and the Home app has to pair again (and rearrange tiles, and redo automations, and generally make you regret everything).

## Troubleshooting

**"No Response" on every tile.** Either bamboozle cannot reach the printer (while the printer is unavailable, every tile reports "No Response"), or the Home app cannot reach bamboozle. Run `probe` first: if it fails, it's the printer side. If `probe` works and the tiles still say "No Response", the Home app can't get to the bridge: see [Network and firewall](#network-and-firewall).

**The camera tile stays blank.** Make sure the relay is running and reachable at the URL in `camera.source`. bamboozle needs ffmpeg on PATH (or set `camera.ffmpeg` to the full path). For VAAPI encoding, the bamboozle user needs access to the render device (`/dev/dri/renderD128` by default).

**"certificate ... does not match the pinned ..."** The printer got a new TLS certificate (factory reset, board replacement). Delete the pin file at `storage/pins/<serial>.sha256` and bamboozle will trust the new certificate on the next connection.

**Temperatures make the room say 30 C.** A 265 C nozzle is persuasive. Give the printer its own room, or turn off **Include in Home Summaries** in each temperature sensor's settings.

**Watching remotely.** Viewing through a home hub works (tested once: the Home app asked for 640x360 and RTCP came back). If video does not load remotely, check that your home hub (Apple TV, HomePod, iPad) is signed into the same iCloud account and shows as "Connected" in Home settings.

## Network and firewall

bamboozle sits between two worlds: your Apple devices and your printer. They have different needs and, if you run VLANs, possibly different subnets.

### The Apple side

HomeKit finds the bridge with mDNS, which stays inside one subnet. Run bamboozle on the same network as your Apple devices, or have your router repeat mDNS between networks (often called an mDNS reflector, repeater or Bonjour gateway). You can limit advertising to specific interfaces with `bridge.bind`.

Ports to allow:

- `bridge.port` (TCP, default 51827): the HomeKit connection.
- UDP 5353: mDNS. `bridge.bind` only limits where bamboozle advertises; the HomeKit server itself listens on all interfaces, so restrict with the firewall if needed.

Live video goes from bamboozle to the viewer, and the viewer sends RTCP receiver reports back to a UDP port bamboozle picked for the stream. An iPhone sends them from the port it receives the video on (other Apple devices have not been checked). bamboozle sends one empty datagram from its port to the viewer when a stream starts, so a stateful firewall (ufw, firewalld) treats that RTCP as a reply: no extra rule needed. bamboozle uses the RTCP to end a stream whose viewer vanished without saying goodbye; if none ever arrives, streams still end normally when the Home app stops them.

### The printer side

bamboozle connects to `printers[].host` directly and does not look for printers on the network, so the printer can sit on another subnet. bamboozle needs to reach:

- The MQTT port (`printers[].port`, default 8883).
- The camera port if you use the printer's own stream (322 for RTSPS).

### Several subnets or VLANs

Not tested yet. The short version: mDNS stays in one subnet, so put bamboozle with the Apple devices or reflect mDNS. Apple devices must reach `bridge.port` (TCP), and bamboozle must be able to send UDP to them (live video is a flow bamboozle starts, so a rule that only lets replies leave bamboozle's network would drop it). The printer can be anywhere bamboozle can reach the MQTT and camera ports.

## Configuration reference

`storagePath` and `accessCodeFile` are relative to the config file. Camera paths (`camera.ffmpeg`, `camera.vaapiDevice`, `camera.fonts.*`) are used as given: use absolute paths, or a command on `PATH` for `ffmpeg`.

| Key | Default | Meaning |
|---|---|---|
| `printers[].name` | (required) | Name in the Home app |
| `printers[].host` | (required) | Printer IP address or host name |
| `printers[].port` | `8883` | Printer MQTT port |
| `printers[].serial` | (required) | Printer serial number |
| `printers[].accessCode` / `accessCodeFile` | (one required) | LAN access code, inline or in a file |
| `printers[].model` | `3D printer` | Model shown in the Home app |
| `printers[].camera.source` | none | `rtsp://`, `rtsps://`, `http://`, `https://` URL without credentials, an absolute file path, or `lavfi:<graph>` |
| `storagePath` | `storage` | Pairing keys, bridge identity and printer certificate pins |
| `bridge.name` | `bamboozle` | Bridge name in the Home app |
| `bridge.port` | `51827` | HomeKit (HAP) TCP port |
| `bridge.bind` | all | Interfaces or addresses to advertise on |
| `display.progress` | `["fan"]` | Any of `fan`, `window`, `lightbulb`, `humidity` |
| `display.countdown` | `[]` | `["lux"]`: a light sensor whose lux is the minutes left |
| `display.temperatures` | `["chamber"]` | Any of `chamber`, `nozzle`, `bed` |
| `display.layout` | `separate` | `separate` tiles, or `grouped` into one accessory per printer |
| `camera.encoder` | `libx264` | `libx264` or `vaapi` |
| `camera.vaapiDevice` | `/dev/dri/renderD128` | Render node for `vaapi` |
| `camera.ffmpeg` | `ffmpeg` | ffmpeg binary |
| `camera.timeZone` | the host's | IANA zone for times on the overlay |
| `camera.fonts.bold` / `.medium` | Hermit via fontconfig | Font files for the overlay |

**Note:** changing `display.layout` gives accessories new identities; the Home app will replace their tiles.

## Security notes

- The printer's TLS certificate is pinned on first contact (`storage/pins/<serial>.sha256`), and nothing is sent before the pin matches. If the printer gets a new certificate (factory reset, board replacement), delete the pin file to trust the new one.
- The access code is never logged and never put on a command line. Keep the config file and `accessCodeFile` readable only by bamboozle.
- bamboozle only reads the printer's status. It asks for one full report per connection and sends no other commands.

## Known limitations

Early days. Here is what is known:

- A RECONFIGURE request from the Home app (a new resolution or bitrate during a stream) keeps the running encoder settings.
- For an IPv6 link-local viewer, RTCP is accepted from the interface of the HomeKit connection. If the host reports no interface for that address, it is accepted from any interface.
- Only the H2C has been tested with real reports.

If you find something new, file an issue.

## Development

Want to poke around?

```sh
npm install
npm test
npm run typecheck
```

`scripts/sanitize-report.ts` turns a captured printer report into a test fixture without serial numbers, job names or network addresses. Handy for sharing bug reports without sharing your whole setup.

`serve --simulate` is useful here too: it cycles through preparing, printing (with a brief fault at 50 %), finished and idle without a real printer. Just you, bamboozle, and a printer that exists only in its imagination.

## License

MIT. Not affiliated with or endorsed by Bambu Lab or Apple.
