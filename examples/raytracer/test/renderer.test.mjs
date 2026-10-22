import test from "node:test";
import assert from "node:assert/strict";
import { renderScene } from "../renderer.mjs";

const changedPixels = (a, b) => {
  let count = 0;
  for (let index = 0; index < a.length; index += 4) {
    if (a[index] !== b[index] || a[index + 1] !== b[index + 1] || a[index + 2] !== b[index + 2]) count++;
  }
  return count;
};

test("returns deterministic opaque RGBA with distinct visible colored spheres", () => {
  const image = renderScene(80, 60);
  assert.ok(image instanceof Uint8ClampedArray);
  assert.equal(image.length, 80 * 60 * 4);
  assert.deepEqual(image, renderScene(80, 60));
  let teal = 0;
  let orange = 0;
  const colors = new Set();
  for (let index = 0; index < image.length; index += 4) {
    const [r, g, b, a] = image.slice(index, index + 4);
    assert.equal(a, 255);
    if (g > r * 1.3 && b > r * 1.2) teal++;
    if (r > g * 1.2 && g > b * 1.15) orange++;
    colors.add(`${r},${g},${b}`);
  }
  assert.ok(teal > 30, "teal sphere is visible");
  assert.ok(orange > 30, "orange sphere is visible");
  assert.ok(colors.size > 250, "scene contains shading and material detail");
});

test("light, camera and reflection options change the rendered scene", () => {
  const original = renderScene(64, 48);
  assert.ok(changedPixels(original, renderScene(64, 48, { lightX: 4 })) > 300);
  assert.ok(changedPixels(original, renderScene(64, 48, { cameraAngle: 0.45 })) > 700);
  assert.ok(changedPixels(original, renderScene(64, 48, { reflections: false })) > 300);
});

test("supports tiny and tall images and rejects unsafe inputs", () => {
  assert.equal(renderScene(1, 1).length, 4);
  assert.equal(renderScene(9, 17, { cameraAngle: Math.PI * 2 }).length, 9 * 17 * 4);
  assert.deepEqual(renderScene(16, 12), renderScene(16, 12, { cameraAngle: Math.PI * 2 }));
  for (const [width, height] of [
    [0, 1],
    [1, -1],
    [1.5, 4],
    [Infinity, 2],
    [2048, 2048],
  ]) {
    assert.throws(() => renderScene(width, height), RangeError);
  }
  assert.throws(() => renderScene(8, 8, { lightX: NaN }), RangeError);
  assert.throws(() => renderScene(8, 8, { cameraAngle: Infinity }), RangeError);
  assert.throws(() => renderScene(8, 8, { reflections: "yes" }), TypeError);
});
