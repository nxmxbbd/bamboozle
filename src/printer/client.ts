import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { MqttClient, type IClientOptions } from 'mqtt';
import { ReportAccumulator } from './accumulator.ts';
import { connectPinned, type PinStore } from './pinned-tls.ts';
import type { PrinterStatus } from './status.ts';

export interface PrinterConnection {
  name: string;
  host: string;
  port: number;
  serial: string;
  accessCode: string;
}

/** Builds the MQTT client; replaceable in tests. */
export type MqttFactory = (streamBuilder: ConstructorParameters<typeof MqttClient>[0], options: IClientOptions) => MqttClient;

export interface PrinterClientEvents {
  status: [PrinterStatus];
  online: [boolean];
  pinned: [string];
  error: [Error];
}

// Asks the printer for one full status report. The only message bamboozle
// publishes unless controls are enabled.
const PUSHALL = JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall', version: 1, push_target: 1 } });

export class PrinterClient extends EventEmitter<PrinterClientEvents> {
  readonly #connection: PrinterConnection;
  readonly #pins: PinStore;
  readonly #accumulator = new ReportAccumulator();
  #mqtt: MqttClient | null = null;
  #online = false;
  #status: PrinterStatus | null = null;

  readonly #createMqtt: MqttFactory;

  constructor(connection: PrinterConnection, pins: PinStore, createMqtt: MqttFactory = (builder, options) => new MqttClient(builder, options)) {
    super();
    this.#connection = connection;
    this.#pins = pins;
    this.#createMqtt = createMqtt;
  }

  get name(): string {
    return this.#connection.name;
  }

  get online(): boolean {
    return this.#online;
  }

  /** Latest status, or null before the first report. */
  get status(): PrinterStatus | null {
    return this.#status;
  }

  get hasFullStatus(): boolean {
    return this.#accumulator.complete;
  }

  start(): void {
    if (this.#mqtt) return;
    const { host, port, serial, accessCode } = this.#connection;
    const reportTopic = `device/${serial}/report`;
    const requestTopic = `device/${serial}/request`;

    const mqtt = this.#createMqtt(() => connectPinned(host, port, this.#pins, (fp) => this.emit('pinned', fp)), {
      protocolVersion: 4,
      clientId: `bamboozle_${randomBytes(4).toString('hex')}`,
      username: 'bblp',
      password: accessCode,
      keepalive: 30,
      reconnectPeriod: 5_000,
      connectTimeout: 15_000,
      clean: true,
      manualConnect: true,
    });
    this.#mqtt = mqtt;

    mqtt.on('connect', () => {
      // A fresh session starts from a fresh full report. Forget the old one
      // before announcing the connection, or listeners would see stale
      // readings as current.
      this.#accumulator.reset();
      this.#status = null;
      this.#setOnline(true);
      mqtt.subscribe(reportTopic, { qos: 0 }, (error) => {
        if (error) {
          this.emit('error', error);
          return;
        }
        mqtt.publish(requestTopic, PUSHALL, { qos: 0 });
      });
    });
    mqtt.on('message', (topic, payload) => {
      if (topic !== reportTopic) return;
      const status = this.#accumulator.handle(payload);
      if (status) {
        this.#status = status;
        this.emit('status', status);
      }
    });
    mqtt.on('close', () => this.#setOnline(false));
    mqtt.on('error', (error) => this.emit('error', error));

    mqtt.connect();
  }

  async stop(): Promise<void> {
    const mqtt = this.#mqtt;
    this.#mqtt = null;
    if (!mqtt) return;
    await mqtt.endAsync(true);
    this.#setOnline(false);
  }

  #setOnline(online: boolean): void {
    if (online === this.#online) return;
    this.#online = online;
    this.emit('online', online);
  }
}
