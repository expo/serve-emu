import { describe, expect, test } from "bun:test";
import type { Device } from "../src/adb.ts";
import {
  createRouter,
  type EmuApp,
  type RouterDependencies,
} from "../src/middleware.ts";
import type { RunningAvd } from "../src/emulator.ts";

type JsonObject = Record<string, unknown>;

async function responseJson(response: Response): Promise<JsonObject> {
  return (await response.json()) as JsonObject;
}

function post(path: string, body: JsonObject): Request {
  return new Request(`http://router.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function fakeApp(serial: string, stopped: string[]): EmuApp {
  return {
    session: { meta: { deviceName: `Device ${serial}` } },
    isStreaming: () => true,
    health: () => ({ status: "streaming" }),
    handleRequest: async (request: Request) =>
      Response.json({ serial, path: new URL(request.url).pathname }),
    attachWebSocket: () => {},
    stop: () => {
      stopped.push(serial);
    },
  } as unknown as EmuApp;
}

function routerDependencies(state: {
  devices: Device[];
  avds: string[];
  running: RunningAvd[];
  created: string[];
  stopped: string[];
}): RouterDependencies {
  return {
    listDevices: async () =>
      state.devices.filter((device) => device.state === "device"),
    listAllDevices: async () => state.devices.map((device) => ({ ...device })),
    listAvds: async () => [...state.avds],
    listRunningAvds: async () =>
      state.running.map((running) => ({ ...running })),
    resolveRunningAvds: async (devices) => {
      const serials = new Set(devices.map((device) => device.serial));
      return state.running
        .filter((running) => serials.has(running.serial))
        .map((running) => ({ ...running }));
    },
    createApp: async ({ serial }) => {
      state.created.push(serial);
      return fakeApp(serial, state.stopped);
    },
    startEmulator: async ({ avd }) => {
      const serial = "emulator-5556";
      state.devices.push({ serial, state: "device" });
      state.running.push({ serial, avd, state: "device" });
      return {
        serial,
        proc: null,
        ownsProcess: false,
        stop: () => {},
      };
    },
    stopEmulator: async (serial) => {
      state.devices = state.devices.filter(
        (device) => device.serial !== serial,
      );
      state.running = state.running.filter(
        (running) => running.serial !== serial,
      );
    },
  };
}

describe("createRouter DevicePanel compatibility", () => {
  test("discovers the grid and persists UI selection without a device query", async () => {
    const state = {
      devices: [
        { serial: "emulator-5554", state: "device" },
        { serial: "usb-1", state: "device" },
      ],
      avds: ["Pixel_8", "Pixel_9"],
      running: [
        { serial: "emulator-5554", avd: "Pixel_8", state: "device" },
      ],
      created: [] as string[],
      stopped: [] as string[],
    };
    const router = createRouter(
      { serial: "emulator-5554" },
      routerDependencies(state),
    );

    const gridResponse = await router.handleRequest(
      new Request("http://router.test/api/device-grid"),
    );
    expect(gridResponse.status).toBe(200);
    const grid = await responseJson(gridResponse);
    expect(grid.currentSerial).toBe("emulator-5554");
    expect(grid.sessionStatus).toBe("streaming");
    expect(grid.devices).toEqual([
      {
        id: "emulator-5554",
        kind: "emulator",
        serial: "emulator-5554",
        avd: "Pixel_8",
        name: "Pixel_8",
        state: "device",
        current: true,
        canSelect: true,
        canStart: false,
        canStop: true,
      },
      {
        id: "usb-1",
        kind: "physical",
        serial: "usb-1",
        avd: null,
        name: "usb-1",
        state: "device",
        current: false,
        canSelect: true,
        canStart: false,
        canStop: false,
      },
      {
        id: "avd:Pixel_9",
        kind: "avd",
        serial: null,
        avd: "Pixel_9",
        name: "Pixel_9",
        state: "stopped",
        current: false,
        canSelect: false,
        canStart: true,
        canStop: false,
      },
    ]);

    const selectResponse = await router.handleRequest(
      post("/api/devices/select", { serial: "usb-1" }),
    );
    expect(selectResponse.status).toBe(200);
    expect(await responseJson(selectResponse)).toEqual({
      ok: true,
      serial: "usb-1",
      device: "Device usb-1",
    });

    const selected = await router.handleRequest(
      new Request("http://router.test/api/foreground"),
    );
    expect((await responseJson(selected)).serial).toBe("usb-1");

    const explicit = await router.handleRequest(
      new Request(
        "http://router.test/api/foreground?device=emulator-5554",
      ),
    );
    expect((await responseJson(explicit)).serial).toBe("emulator-5554");

    const stillSelected = await router.handleRequest(
      new Request("http://router.test/api/foreground"),
    );
    expect((await responseJson(stillSelected)).serial).toBe("usb-1");
    expect(state.created).toEqual(["usb-1", "emulator-5554"]);
  });

  test("starts, selects, discovers, and stops an AVD through UI routes", async () => {
    const state = {
      devices: [{ serial: "usb-1", state: "device" }],
      avds: ["Pixel_9"],
      running: [] as RunningAvd[],
      created: [] as string[],
      stopped: [] as string[],
    };
    const router = createRouter({}, routerDependencies(state));

    const startResponse = await router.handleRequest(
      post("/api/avds/start", { avd: "Pixel_9" }),
    );
    expect(startResponse.status).toBe(200);
    expect(await responseJson(startResponse)).toEqual({
      ok: true,
      serial: "emulator-5556",
      avd: "Pixel_9",
      device: "Device emulator-5556",
    });

    const selected = await router.handleRequest(
      new Request("http://router.test/api/foreground"),
    );
    expect((await responseJson(selected)).serial).toBe("emulator-5556");

    const gridResponse = await router.handleRequest(
      new Request("http://router.test/api/device-grid"),
    );
    const grid = await responseJson(gridResponse);
    expect(grid.currentSerial).toBe("emulator-5556");
    expect(
      (grid.devices as Array<JsonObject>).find(
        (device) => device.serial === "emulator-5556",
      ),
    ).toMatchObject({
      avd: "Pixel_9",
      current: true,
      canStop: true,
    });

    const stopResponse = await router.handleRequest(
      post("/api/avds/stop", { avd: "Pixel_9" }),
    );
    expect(stopResponse.status).toBe(200);
    expect(await responseJson(stopResponse)).toEqual({
      ok: true,
      serial: "emulator-5556",
    });
    expect(state.stopped).toEqual(["emulator-5556"]);

    const fallback = await router.handleRequest(
      new Request("http://router.test/api/foreground"),
    );
    expect((await responseJson(fallback)).serial).toBe("usb-1");
  });

  test("rejects an unavailable selection without replacing the current device", async () => {
    const state = {
      devices: [{ serial: "usb-1", state: "device" }],
      avds: [] as string[],
      running: [] as RunningAvd[],
      created: [] as string[],
      stopped: [] as string[],
    };
    const router = createRouter({}, routerDependencies(state));

    const response = await router.handleRequest(
      post("/api/devices/select", { serial: "missing" }),
    );
    expect(response.status).toBe(400);
    expect(await responseJson(response)).toEqual({
      ok: false,
      error: "device missing is not connected",
    });
    expect(await router.resolveSerial(null)).toBe("usb-1");
    expect(state.created).toEqual([]);
  });
});
