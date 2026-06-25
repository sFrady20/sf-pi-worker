// Thin async adapter over the LIFX LAN library. All library specifics live here,
// so the daemon stays library-agnostic. HSBK: hue 0-360, sat/bri 0-100, kelvin.
import { Client, type LifxLight } from "lifx-lan-client";

export interface LightState {
  power: boolean;
  hue: number;
  saturation: number;
  brightness: number;
  kelvin: number;
}
export interface LightInfo {
  id: string;
  label: string;
}

export class Lifx {
  #client = new Client();
  #byId = new Map<string, LifxLight>();
  #labels = new Map<string, string>();

  start(): void {
    this.#client.on("light-new", (light) => {
      this.#byId.set(light.id, light);
      light.getState((err, info) => {
        if (!err) this.#labels.set(light.id, info.label);
      });
    });
    this.#client.init();
  }

  list(): LightInfo[] {
    return [...this.#byId.keys()].map((id) => ({ id, label: this.#labels.get(id) ?? id }));
  }

  #light(id: string): LifxLight {
    const light = this.#byId.get(id);
    if (!light) throw new Error(`light ${id} not found`);
    return light;
  }

  getState(id: string): Promise<LightState> {
    const light = this.#light(id);
    return new Promise((resolve, reject) => {
      light.getState((err, info) => {
        if (err) return reject(err);
        this.#labels.set(id, info.label);
        resolve({
          power: info.power > 0,
          hue: info.color.hue,
          saturation: info.color.saturation,
          brightness: info.color.brightness,
          kelvin: info.color.kelvin,
        });
      });
    });
  }

  setColor(
    id: string,
    c: { hue: number; saturation: number; brightness: number; kelvin: number },
    durationMs = 1000,
  ): Promise<void> {
    const light = this.#light(id);
    return new Promise((resolve, reject) => {
      light.color(c.hue, c.saturation, c.brightness, c.kelvin, durationMs, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  setPower(id: string, on: boolean, durationMs = 1000): Promise<void> {
    const light = this.#light(id);
    return new Promise((resolve, reject) => {
      const cb = (err: Error | null) => (err ? reject(err) : resolve());
      if (on) light.on(durationMs, cb);
      else light.off(durationMs, cb);
    });
  }
}
