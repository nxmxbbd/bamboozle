import {
  Accessory,
  Characteristic,
  HapStatusError,
  Service,
  uuid,
  type CharacteristicValue,
  type WithUUID,
} from 'hap-nodejs';
import { VERSION } from '../version.ts';
import { CATEGORY_SENSOR, STATUS_COMMUNICATION_FAILURE } from './hap-constants.ts';
import {
  remainingToLux,
  toDisplay,
  type DisplayValues,
  type ProgressStyle,
  type TemperatureSensor,
} from './display.ts';

export type Layout = 'grouped' | 'separate';

export interface PrinterAccessoryOptions {
  name: string;
  serial: string;
  model?: string;
  progress: readonly ProgressStyle[];
  temperatures: readonly TemperatureSensor[];
  /** grouped: one accessory with several services; separate: one tile each. */
  layout: Layout;
}

// Writes from the Home app (or Siri) to a repurposed control are accepted and
// then undone after this delay, so the tile settles back on the real value.
export const SNAP_BACK_MS = 300;

const TEMPERATURE_LABELS: Record<TemperatureSensor, string> = {
  chamber: 'Chamber',
  nozzle: 'Nozzle',
  bed: 'Bed',
};

const PROGRESS_LABELS: Record<ProgressStyle, string> = {
  humidity: 'Progress',
  window: 'Progress (blind)',
  fan: 'Progress (fan)',
  lightbulb: 'Progress (light)',
};

type Binding = (values: DisplayValues) => CharacteristicValue;

interface Bound {
  characteristic: Characteristic;
  value: Binding;
}

/**
 * The HomeKit face of one printer. Every characteristic is bound to a
 * function of the current DisplayValues; reads are served from the latest
 * values and updates are pushed on change. While the printer is unavailable
 * every characteristic reports a communication failure ("No Response").
 */
export class PrinterAccessories {
  readonly accessories: Accessory[] = [];
  readonly #options: PrinterAccessoryOptions;
  readonly #bound: Bound[] = [];
  #values: DisplayValues = toDisplay(null, false);

  constructor(options: PrinterAccessoryOptions) {
    this.#options = options;
    const { progress, temperatures } = options;

    this.#addStatusServices();
    for (const style of progress) this.#addProgress(style);
    this.#addCountdown();
    for (const sensor of temperatures) this.#addTemperature(sensor);
  }

  get values(): DisplayValues {
    return this.#values;
  }

  update(values: DisplayValues): void {
    this.#values = values;
    for (const { characteristic, value } of this.#bound) {
      if (values.available) characteristic.updateValue(value(values));
      else characteristic.updateValue(new HapStatusError(STATUS_COMMUNICATION_FAILURE));
    }
  }

  // --- building blocks -----------------------------------------------------

  #grouped: Accessory | null = null;

  #host(key: string, label: string): Accessory {
    const { name, serial, model, layout } = this.#options;
    if (layout === 'grouped') {
      this.#grouped ??= this.#newAccessory(name, uuid.generate(`bamboozle:${serial}:printer`));
      return this.#grouped;
    }
    return this.#newAccessory(`${name} ${label}`, uuid.generate(`bamboozle:${serial}:${key}`), model);
  }

  #newAccessory(displayName: string, id: string, model = this.#options.model): Accessory {
    const accessory = new Accessory(displayName, id);
    accessory.category = CATEGORY_SENSOR;
    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Bambu Lab')
      .setCharacteristic(Characteristic.Model, model ?? '3D printer')
      .setCharacteristic(Characteristic.SerialNumber, this.#options.serial)
      .setCharacteristic(Characteristic.FirmwareRevision, VERSION);
    this.accessories.push(accessory);
    return accessory;
  }

  #service(type: WithUUID<typeof Service>, key: string, label: string): Service {
    const accessory = this.#host(key, label);
    const name = `${this.#options.name} ${label}`;
    const service = accessory.addService(type, name, key);
    service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    service.setCharacteristic(Characteristic.ConfiguredName, name);
    return service;
  }

  #bind(characteristic: Characteristic, value: Binding): Characteristic {
    characteristic.updateValue(value(this.#values));
    characteristic.onGet(() => {
      if (!this.#values.available) throw new HapStatusError(STATUS_COMMUNICATION_FAILURE);
      return value(this.#values);
    });
    this.#bound.push({ characteristic, value });
    return characteristic;
  }

  /** A writable characteristic that only displays: accept writes, then undo them. */
  #bindReadOnly(characteristic: Characteristic, value: Binding): void {
    this.#bind(characteristic, value);
    characteristic.onSet(() => {
      setTimeout(() => {
        if (this.#values.available) characteristic.updateValue(value(this.#values));
      }, SNAP_BACK_MS);
    });
  }

  #addStatusServices(): void {
    const printing = this.#service(Service.OccupancySensor, 'printing', 'Printing');
    this.#bind(printing.getCharacteristic(Characteristic.OccupancyDetected), (v) =>
      v.printing
        ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
        : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
    );

    const fault = this.#service(Service.ContactSensor, 'fault', 'Fault');
    // Open contact = fault, the convention alarm-style contact sensors use.
    this.#bind(fault.getCharacteristic(Characteristic.ContactSensorState), (v) =>
      v.fault
        ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : Characteristic.ContactSensorState.CONTACT_DETECTED,
    );
  }

  #addProgress(style: ProgressStyle): void {
    const label = PROGRESS_LABELS[style];
    switch (style) {
      case 'humidity': {
        const service = this.#service(Service.HumiditySensor, 'progress-humidity', label);
        this.#bind(service.getCharacteristic(Characteristic.CurrentRelativeHumidity), (v) => v.progress);
        break;
      }
      case 'window': {
        const service = this.#service(Service.WindowCovering, 'progress-window', label);
        this.#bind(service.getCharacteristic(Characteristic.CurrentPosition), (v) => v.progress);
        this.#bind(service.getCharacteristic(Characteristic.PositionState), () => Characteristic.PositionState.STOPPED);
        this.#bindReadOnly(service.getCharacteristic(Characteristic.TargetPosition), (v) => v.progress);
        break;
      }
      case 'fan': {
        const service = this.#service(Service.Fanv2, 'progress-fan', label);
        this.#bindReadOnly(service.getCharacteristic(Characteristic.Active), (v) =>
          v.printing ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
        );
        this.#bindReadOnly(service.getCharacteristic(Characteristic.RotationSpeed), (v) => v.progress);
        break;
      }
      case 'lightbulb': {
        const service = this.#service(Service.Lightbulb, 'progress-lightbulb', label);
        this.#bindReadOnly(service.getCharacteristic(Characteristic.On), (v) => v.printing);
        this.#bindReadOnly(service.getCharacteristic(Characteristic.Brightness), (v) => v.progress);
        break;
      }
    }
  }

  #addCountdown(): void {
    const service = this.#service(Service.LightSensor, 'remaining', 'Minutes left');
    this.#bind(service.getCharacteristic(Characteristic.CurrentAmbientLightLevel), (v) =>
      remainingToLux(v.remainingMinutes),
    );
  }

  #addTemperature(sensor: TemperatureSensor): void {
    const service = this.#service(Service.TemperatureSensor, `temperature-${sensor}`, TEMPERATURE_LABELS[sensor]);
    const characteristic = service.getCharacteristic(Characteristic.CurrentTemperature);
    // The default 0-100 °C range would clip nozzle and bed readings.
    characteristic.setProps({ minValue: -40, maxValue: 400 });
    this.#bind(characteristic, (v) => v.temperatures[sensor] ?? 0);
  }
}
