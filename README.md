# bamboozle

A LAN-only Apple Home bridge for Bambu Lab 3D printers.

bamboozle talks to the printer over its local MQTT interface and publishes it
to Apple Home as a HomeKit bridge. No cloud, no Home Assistant, no Homebridge:
one small process on your network.

> Status: early work in progress. Nothing here is usable yet.

## Why "bamboozle"?

Apple Home has no accessory type for a 3D printer, a progress bar, or a
countdown. So bamboozle politely bamboozles it: print progress shows up as a
fan's speed slider, time remaining as a light sensor's reading, and "printing"
as an occupancy sensor. Everything stays on your LAN.

## Planned for v0.1 (read-only)

- Printing / idle (occupancy sensor)
- Print progress (fan speed slider, read-only)
- Time remaining (light sensor, lux = minutes)
- Fault (contact sensor)
- Nozzle, bed and chamber temperatures
- Multiple printers on one bridge

Controls (chamber light, pause / resume) come later and are only exposed when
the printer accepts unsigned LAN commands (Developer Mode). There will be no
"stop" control.

## Development

Requires Node.js 22.18 or newer (TypeScript runs directly via type stripping).

```sh
npm install
npm test
npm run typecheck
```

## License

MIT. Not affiliated with or endorsed by Bambu Lab or Apple.
