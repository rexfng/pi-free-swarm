export function mountRayTracer(root, renderScene, environment = globalThis) {
  const get = (id) => {
    const element = root.getElementById(id);
    if (!element) throw new Error(`Missing scene control: ${id}`);
    return element;
  };
  const canvas = get("scene");
  const stage = get("stage");
  const light = get("light");
  const camera = get("camera");
  const resolution = get("resolution");
  const reflections = get("reflections");
  const status = get("render-status");
  const context = canvas.getContext("2d");
  if (!context) {
    status.textContent = "Canvas is unavailable in this browser.";
    return { dispose() {} };
  }
  let pending = null;
  let disposed = false;
  const listeners = [];
  const numeric = (element, fallback, min, max) => {
    const value = Number(element.value);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  };
  function values() {
    const lightX = numeric(light, -3, -8, 8);
    const degrees = numeric(camera, 0, -60, 60);
    const pixels = Math.round(numeric(resolution, 256, 128, 384));
    get("light-value").textContent = lightX.toFixed(1);
    get("camera-value").textContent = `${degrees}°`;
    get("resolution-value").textContent = `${pixels} px`;
    return { pixels, lightX, cameraAngle: (degrees * Math.PI) / 180, reflections: reflections.checked };
  }
  function draw() {
    pending = null;
    if (disposed) return;
    const options = values();
    const width = Math.max(96, Math.min(options.pixels, Math.floor(stage.clientWidth || options.pixels)));
    const height = Math.round((width * 5) / 8);
    const started = environment.performance.now();
    try {
      const rgba = renderScene(width, height, options);
      if (!(rgba instanceof Uint8ClampedArray) || rgba.length !== width * height * 4)
        throw new Error("Invalid renderer output");
      canvas.width = width;
      canvas.height = height;
      const image = context.createImageData(width, height);
      image.data.set(rgba);
      context.putImageData(image, 0, 0);
      get("dimensions").textContent = `${width} × ${height}`;
      status.textContent = `${(environment.performance.now() - started).toFixed(0)} ms / frame`;
    } catch (error) {
      status.textContent = `Render failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  function schedule() {
    values();
    if (pending !== null || disposed) return;
    status.textContent = "Tracing…";
    pending = environment.requestAnimationFrame(draw);
  }
  function listen(element, event, listener) {
    element.addEventListener(event, listener);
    listeners.push(() => element.removeEventListener(event, listener));
  }
  for (const control of [light, camera, resolution, reflections]) listen(control, "input", schedule);
  listen(get("reset"), "click", () => {
    light.value = "-3";
    camera.value = "0";
    resolution.value = "256";
    reflections.checked = true;
    schedule();
  });
  const observer = new environment.ResizeObserver(schedule);
  observer.observe(stage);
  schedule();
  return {
    dispose() {
      disposed = true;
      if (pending !== null) environment.cancelAnimationFrame(pending);
      observer.disconnect();
      for (const remove of listeners) remove();
    },
  };
}

if (typeof document !== "undefined") {
  try {
    const { renderScene } = await import("./renderer.mjs");
    mountRayTracer(document, renderScene);
  } catch (error) {
    const status = document.getElementById("render-status");
    if (status)
      status.textContent = `Could not start renderer: ${error instanceof Error ? error.message : String(error)}`;
  }
}
