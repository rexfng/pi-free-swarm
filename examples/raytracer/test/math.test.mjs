import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { add, sub, scale, dot, normalize, reflect, intersectSphere, intersectPlane } from "../math.mjs";

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

describe("immutable vector operations", () => {
  it("adds, subtracts, scales and computes dot products", () => {
    const a = Object.freeze([1, 2, 3]);
    const b = Object.freeze([-2, 4, 1]);
    assert.deepEqual(add(a, b), [-1, 6, 4]);
    assert.deepEqual(sub(a, b), [3, -2, 2]);
    assert.deepEqual(scale(a, 3), [3, 6, 9]);
    assert.equal(dot(a, b), 9);
    assert.notEqual(add(a, [0, 0, 0]), a);
  });

  it("normalizes finite vectors and safely handles zero", () => {
    const direction = normalize([3, 4, 0]);
    close(direction[0], 0.6);
    close(direction[1], 0.8);
    close(dot(direction, direction), 1);
    assert.deepEqual(normalize([0, 0, 0]), [0, 0, 0]);
    close(Math.hypot(...normalize([1e200, 1e200, 0])), 1);
  });

  it("reflects across a unit surface normal without changing magnitude", () => {
    assert.deepEqual(reflect([1, -2, 0], [0, 1, 0]), [1, 2, 0]);
    const original = normalize([1, -2, 3]);
    const reflected = reflect(original, [0, 1, 0]);
    close(dot(reflected, reflected), 1);
    close(dot(reflected, [0, 1, 0]), -dot(original, [0, 1, 0]));
  });
});

describe("sphere intersections", () => {
  it("returns the nearest forward surface", () => {
    assert.equal(intersectSphere([0, 0, 5], [0, 0, -1], [0, 0, 0], 1), 4);
    assert.equal(intersectSphere([0, 0, 5], [0, 0, -2], [0, 0, 0], 1), 2);
  });

  it("returns the exit when the ray starts inside", () => {
    assert.equal(intersectSphere([0, 0, 0], [1, 0, 0], [0, 0, 0], 2), 2);
  });

  it("handles tangency and translated sphere centers", () => {
    assert.equal(intersectSphere([1, 0, 5], [0, 0, -1], [0, 0, 0], 1), 5);
    assert.equal(intersectSphere([2, 3, 9], [0, 0, -1], [2, 3, 3], 2), 4);
  });

  it("rejects misses, zero directions and intersections behind the ray", () => {
    assert.equal(intersectSphere([3, 0, 5], [0, 0, -1], [0, 0, 0], 1), null);
    assert.equal(intersectSphere([0, 0, 5], [0, 0, 1], [0, 0, 0], 1), null);
    assert.equal(intersectSphere([0, 0, 0], [0, 0, 0], [0, 0, 0], 1), null);
    assert.equal(intersectSphere([0, 0, 5], [0, 0, -1], [0, 0, 0], -1), null);
  });

  it("suppresses self-intersection while retaining the opposite surface", () => {
    assert.equal(intersectSphere([0, 0, 1], [0, 0, 1], [0, 0, 0], 1), null);
    assert.equal(intersectSphere([0, 0, 1], [0, 0, -1], [0, 0, 0], 1), 2);
  });
});

describe("horizontal plane intersections", () => {
  it("finds positive hits from either side", () => {
    assert.equal(intersectPlane([0, 3, 0], [0, -1, 0], -1), 4);
    assert.equal(intersectPlane([0, -3, 0], [0, 1, 0], 1), 4);
  });

  it("rejects parallel, backward and surface-origin hits", () => {
    assert.equal(intersectPlane([0, 1, 0], [1, 0, 0], 0), null);
    assert.equal(intersectPlane([0, 1, 0], [0, 1, 0], 0), null);
    assert.equal(intersectPlane([0, 0, 0], [0, -1, 0], 0), null);
  });
});
