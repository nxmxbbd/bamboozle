// A stand-in for the MQTT client, driven by hand: the test emits its events and reads what was subscribed and sent.
import { EventEmitter } from 'node:events';

export class FakeMqtt extends EventEmitter {
  subscribed: string[] = [];
  published: Array<{ topic: string; payload: string }> = [];
  subscribe(topic: string, _options: unknown, callback: (error: Error | null) => void) {
    this.subscribed.push(topic);
    callback(null);
    return this;
  }
  publish(topic: string, payload: string) {
    this.published.push({ topic, payload });
    return this;
  }
  connect() {
    return this;
  }
  async endAsync() {}
}
