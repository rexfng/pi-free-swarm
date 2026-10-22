const HIT_EPSILON = 1e-6;

export function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a, scalar) {
  return [a[0] * scalar, a[1] * scalar, a[2] * scalar];
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function normalize(a) {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length === 0 ? [0, 0, 0] : scale(a, 1 / length);
}

export function reflect(direction, normal) {
  return sub(direction, scale(normal, 2 * dot(direction, normal)));
}

export function intersectSphere(origin, direction, center, radius) {
  if (!(radius > 0) || !Number.isFinite(radius)) return null;
  const offset = sub(origin, center);
  const a = dot(direction, direction);
  if (a === 0) return null;
  const halfB = dot(offset, direction);
  const c = dot(offset, offset) - radius * radius;
  const discriminant = halfB * halfB - a * c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const near = (-halfB - root) / a;
  if (near > HIT_EPSILON) return near;
  const far = (-halfB + root) / a;
  return far > HIT_EPSILON ? far : null;
}

export function intersectPlane(origin, direction, y) {
  if (Math.abs(direction[1]) < HIT_EPSILON) return null;
  const distance = (y - origin[1]) / direction[1];
  return distance > HIT_EPSILON ? distance : null;
}
