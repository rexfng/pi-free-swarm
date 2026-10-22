import { add, sub, scale, dot, normalize, reflect, intersectSphere, intersectPlane } from "./math.mjs";

const EPSILON = 0.0001;
const MAX_PIXELS = 1_048_576;
const SPHERES = [
  { center: [-1.05, -0.08, 0], radius: 0.92, color: [0.025, 0.58, 0.52], mirror: 0.24 },
  { center: [1.03, -0.25, 0.18], radius: 0.75, color: [0.94, 0.36, 0.075], mirror: 0.17 },
  { center: [0.08, -0.61, 1.35], radius: 0.39, color: [0.42, 0.22, 0.76], mirror: 0.36 },
];

const mix = (a, b, amount) => add(scale(a, 1 - amount), scale(b, amount));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function sky(direction) {
  return mix([0.61, 0.72, 0.82], [0.035, 0.08, 0.17], Math.min(1, Math.max(0, direction[1] * 0.8 + 0.35)));
}

function nearest(origin, direction) {
  let distance = Infinity;
  let material = null;
  for (const sphere of SPHERES) {
    const candidate = intersectSphere(origin, direction, sphere.center, sphere.radius);
    if (candidate !== null && candidate > EPSILON && candidate < distance) {
      distance = candidate;
      material = sphere;
    }
  }
  const plane = intersectPlane(origin, direction, -1);
  if (plane !== null && plane > EPSILON && plane < distance) {
    distance = plane;
    material = "floor";
  }
  if (material === null) return null;
  const point = add(origin, scale(direction, distance));
  if (material === "floor") {
    const checker = (((Math.floor(point[0]) + Math.floor(point[2])) % 2) + 2) % 2;
    return { point, distance, normal: [0, 1, 0], color: checker ? [0.6, 0.66, 0.7] : [0.13, 0.2, 0.25], mirror: 0.1 };
  }
  return {
    point,
    distance,
    normal: normalize(sub(point, material.center)),
    color: material.color,
    mirror: material.mirror,
  };
}

function trace(origin, direction, light, reflections, depth = 0) {
  const hit = nearest(origin, direction);
  if (!hit) return sky(direction);
  const offset = add(hit.point, scale(hit.normal, EPSILON * 4));
  const towardLight = sub(light, offset);
  const lightDistance = Math.sqrt(dot(towardLight, towardLight));
  const lightDirection = scale(towardLight, 1 / lightDistance);
  const obstacle = nearest(offset, lightDirection);
  const shadowed = obstacle !== null && obstacle.distance < lightDistance;
  const diffuse = shadowed ? 0 : Math.max(0, dot(hit.normal, lightDirection));
  const half = normalize(sub(lightDirection, direction));
  const specular = shadowed ? 0 : Math.pow(Math.max(0, dot(hit.normal, half)), 80) * 0.65;
  let color = add(scale(hit.color, 0.18 + diffuse * 0.82), [specular, specular * 0.94, specular * 0.85]);
  if (reflections && depth < 1) {
    color = mix(
      color,
      trace(offset, normalize(reflect(direction, hit.normal)), light, reflections, depth + 1),
      hit.mirror,
    );
  }
  return mix(color, sky(direction), Math.min(0.7, hit.distance * 0.012));
}

/** Pure synchronous renderer. cameraAngle is in radians; costs are bounded by image size and one reflection bounce. */
export function renderScene(width, height, options = {}) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > MAX_PIXELS
  ) {
    throw new RangeError("Use positive integer dimensions with at most 1,048,576 pixels");
  }
  const { lightX = -3, reflections = true, cameraAngle = 0 } = options;
  if (!Number.isFinite(lightX) || Math.abs(lightX) > 100 || !Number.isFinite(cameraAngle)) {
    throw new RangeError("Light must be between -100 and 100 and camera angle must be finite");
  }
  if (typeof reflections !== "boolean") throw new TypeError("reflections must be a boolean");
  const angle = cameraAngle % (Math.PI * 2);
  const origin = [Math.sin(angle) * 6.6, 2.65, Math.cos(angle) * 6.6];
  const forward = normalize(sub([0, -0.1, 0.2], origin));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const light = [lightX, 5, 4];
  const image = new Uint8ClampedArray(width * height * 4);
  const field = Math.tan(Math.PI / 7);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const horizontal = (((((x + 0.5) / width) * 2 - 1) * width) / height) * field;
      const vertical = (1 - ((y + 0.5) / height) * 2) * field;
      const direction = normalize(add(forward, add(scale(right, horizontal), scale(up, vertical))));
      const color = trace(origin, direction, light, reflections);
      const pixel = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        image[pixel + channel] = Math.round(Math.pow(Math.min(1, Math.max(0, color[channel])), 1 / 2.2) * 255);
      }
      image[pixel + 3] = 255;
    }
  }
  return image;
}
