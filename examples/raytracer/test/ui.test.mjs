import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mountRayTracer } from "../app.mjs";

function harness(render = (w, h) => new Uint8ClampedArray(w * h * 4)) {
  const ids = [
    "scene",
    "stage",
    "light",
    "camera",
    "resolution",
    "reflections",
    "render-status",
    "light-value",
    "camera-value",
    "resolution-value",
    "dimensions",
    "reset",
  ];
  const elements = Object.fromEntries(
    ids.map((id) => [
      id,
      {
        value: "",
        checked: false,
        textContent: "",
        listeners: new Map(),
        addEventListener(event, listener) {
          this.listeners.set(event, listener);
        },
        removeEventListener(event) {
          this.listeners.delete(event);
        },
        emit(event) {
          this.listeners.get(event)?.();
        },
      },
    ]),
  );
  Object.assign(elements.light, { value: "-3" });
  Object.assign(elements.camera, { value: "0" });
  Object.assign(elements.resolution, { value: "256" });
  Object.assign(elements.reflections, { checked: true });
  elements.stage.clientWidth = 800;
  const frames = new Map();
  let nextFrame = 1;
  let clock = 0;
  let resize;
  let disconnected = false;
  let image;
  elements.scene.getContext = () => ({
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (value) => {
      image = value;
    },
  });
  const calls = [];
  const app = mountRayTracer(
    { getElementById: (id) => elements[id] },
    (width, height, options) => {
      calls.push({ width, height, options });
      return render(width, height, options);
    },
    {
      performance: { now: () => (clock += 5) },
      requestAnimationFrame(callback) {
        const id = nextFrame++;
        frames.set(id, callback);
        return id;
      },
      cancelAnimationFrame(id) {
        frames.delete(id);
      },
      ResizeObserver: class {
        constructor(callback) {
          resize = callback;
        }
        observe() {}
        disconnect() {
          disconnected = true;
        }
      },
    },
  );
  return {
    elements,
    calls,
    app,
    frames,
    resize: () => resize(),
    disconnected: () => disconnected,
    image: () => image,
    flush() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback();
    },
  };
}

test("page exposes labeled controls and local-only assets", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  for (const id of ["light", "camera", "resolution", "reflections"]) {
    assert.match(html, new RegExp(`<label for="${id}">`));
    assert.match(html, new RegExp(`<input id="${id}"`));
  }
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /<canvas[^>]+aria-label=/);
  assert.equal(/(?:src|href)="https?:/.test(html), false);
  assert.match(html, /type="module" src="\.\/app\.mjs"/);
});

test("first paint renders bounded pixels and reports timing", () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  h.flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].width, 256);
  assert.equal(h.calls[0].height, 160);
  assert.equal(h.image().data.length, 256 * 160 * 4);
  assert.equal(h.elements.dimensions.textContent, "256 × 160");
  assert.match(h.elements["render-status"].textContent, /5 ms/);
});

test("controls coalesce changes and convert camera degrees to radians", () => {
  const h = harness();
  h.flush();
  h.elements.camera.value = "60";
  h.elements.camera.emit("input");
  h.elements.light.value = "4";
  h.elements.light.emit("input");
  h.elements.reflections.checked = false;
  h.elements.reflections.emit("input");
  assert.equal(h.frames.size, 1);
  h.flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].options.cameraAngle, Math.PI / 3);
  assert.equal(h.calls[1].options.lightX, 4);
  assert.equal(h.calls[1].options.reflections, false);
  assert.equal(h.elements["camera-value"].textContent, "60°");
});

test("resize and hostile slider values cannot cause a full-HD synchronous render", () => {
  const h = harness();
  h.flush();
  h.elements.resolution.value = "100000";
  h.resize();
  h.flush();
  assert.equal(h.calls.at(-1).width, 384);
  h.elements.stage.clientWidth = 200;
  h.resize();
  h.flush();
  assert.equal(h.calls.at(-1).width, 200);
  h.elements.resolution.value = "NaN";
  h.elements.resolution.emit("input");
  h.flush();
  assert.ok(h.calls.at(-1).width <= 384);
});

test("reset restores scene defaults; disposal cancels work and removes listeners", () => {
  const h = harness();
  h.flush();
  h.elements.light.value = "7";
  h.elements.camera.value = "50";
  h.elements.reflections.checked = false;
  h.elements.reset.emit("click");
  h.flush();
  assert.equal(h.calls.at(-1).options.lightX, -3);
  assert.equal(h.calls.at(-1).options.cameraAngle, 0);
  assert.equal(h.calls.at(-1).options.reflections, true);
  h.resize();
  h.app.dispose();
  assert.equal(h.frames.size, 0);
  assert.equal(h.disconnected(), true);
  assert.equal(h.elements.light.listeners.size, 0);
});

test("renderer failures become readable status messages", () => {
  const h = harness(() => {
    throw new Error("fixture failed");
  });
  h.flush();
  assert.equal(h.elements["render-status"].textContent, "Render failed: fixture failed");
});
