// Minimal ambient types for the `lifx-lan-client` LAN library (it ships no types).
// Only the surface this worker uses. Verify against the installed version on the Pi.
declare module "lifx-lan-client" {
  export interface LifxLight {
    id: string;
    address: string;
    getState(
      cb: (
        err: Error | null,
        info: {
          label: string;
          power: number; // 0 = off
          color: { hue: number; saturation: number; brightness: number; kelvin: number };
        },
      ) => void,
    ): void;
    color(
      hue: number,
      saturation: number,
      brightness: number,
      kelvin: number,
      duration: number,
      cb?: (err: Error | null) => void,
    ): void;
    on(duration: number, cb?: (err: Error | null) => void): void;
    off(duration: number, cb?: (err: Error | null) => void): void;
  }
  export class Client {
    init(opts?: Record<string, unknown>): void;
    lights(status?: string): LifxLight[];
    on(event: string, handler: (arg: any) => void): void;
    destroy(): void;
  }
}
