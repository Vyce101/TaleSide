export type GraphPoint = { x: number; y: number };
export type GraphBody = GraphPoint & { id: string; name: string; vx: number; vy: number; degree: number; community?: GraphPoint };
type Link<T> = { from: T; to: T };

const ringBaseSize = 10;
const ringSizeStep = 8;
const ringRadiusStep = 170;
const componentBaseRadius = 520;
const componentRadiusStep = 950;
const chargeDistance = 1200;
const alphaDecay = 0.02;
const velocityDecay = 0.2;
const goldenAngle = Math.PI * (3 - Math.sqrt(5));

export const graphRadius = (degree: number) => 6 + Math.sqrt(degree) * 3.2;

export function connectivitySeeds<T extends Pick<GraphBody, "id" | "name" | "degree">>(
  bodies: ReadonlyMap<string, T>, neighbors: ReadonlyMap<string, ReadonlySet<string>>,
) {
  const visited = new Set<string>();
  const components: { members: T[]; connections: number; first: string }[] = [];
  for (const id of bodies.keys()) {
    if (visited.has(id)) continue;
    const queue = [id];
    visited.add(id);
    let connections = 0;
    let first = id;
    const members = [];
    while (queue.length) {
      const member = bodies.get(queue.pop()!)!;
      members.push(member);
      connections += member.degree;
      if (member.id < first) first = member.id;
      for (const neighbor of neighbors.get(member.id) ?? []) {
        if (!visited.has(neighbor)) { visited.add(neighbor); queue.push(neighbor); }
      }
    }
    components.push({ members, connections, first });
  }
  components.sort((a, b) => b.connections - a.connections || b.members.length - a.members.length || a.first.localeCompare(b.first));

  const positions = new Map<string, GraphPoint>();
  for (const [index, { members }] of components.entries()) {
    members.sort((a, b) => b.degree - a.degree || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const angle = index * goldenAngle;
    const distance = index ? componentBaseRadius + Math.sqrt(index) * componentRadiusStep : 0;
    const cx = Math.cos(angle) * distance;
    const cy = Math.sin(angle) * distance;
    for (let start = 0, ring = 0; start < members.length; ring++) {
      const size = Math.min(members.length - start, ringBaseSize + ring * ringSizeStep);
      const radius = ring * ringRadiusStep;
      for (let slot = 0; slot < size; slot++) {
        const direction = angle / 2 + ring * 0.35 + 2 * Math.PI * slot / size;
        positions.set(members[start + slot].id, {
          x: Math.round(1000 * (cx + radius * Math.cos(direction))) / 1000,
          y: Math.round(1000 * (cy + radius * Math.sin(direction))) / 1000,
        });
      }
      start += size;
    }
  }
  return positions;
}

const communityMinNodes = 100;
const communityPasses = 12;
const communitySpacing = 570;
const communityPull = 0.016;

export function communityCenters(
  bodies: ReadonlyMap<string, Pick<GraphBody, "id" | "degree">>,
  neighbors: ReadonlyMap<string, ReadonlySet<string>>,
) {
  const centers = new Map<string, GraphPoint>();
  if (bodies.size < communityMinNodes) return centers;
  const linked = [...bodies.values()].filter(node => node.degree > 0)
    .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));
  const totalDegree = linked.reduce((sum, node) => sum + node.degree, 0);
  if (!totalDegree) return centers;

  // Local modularity moves favor groups with more internal edges than expected by degree alone.
  const assignments = new Map(linked.map(node => [node.id, node.id]));
  const groupDegrees = new Map(linked.map(node => [node.id, node.degree]));
  for (let pass = 0; pass < communityPasses; pass++) {
    let moved = false;
    for (const node of linked) {
      const current = assignments.get(node.id)!;
      groupDegrees.set(current, groupDegrees.get(current)! - node.degree);
      const weights = new Map<string, number>();
      for (const neighbor of neighbors.get(node.id) ?? []) {
        const group = assignments.get(neighbor)!;
        weights.set(group, (weights.get(group) ?? 0) + 1);
      }
      const gain = (group: string) => (weights.get(group) ?? 0) - node.degree * groupDegrees.get(group)! / totalDegree;
      let best = current;
      for (const group of weights.keys()) if (gain(group) > gain(best) + 1e-9) best = group;
      assignments.set(node.id, best);
      groupDegrees.set(best, groupDegrees.get(best)! + node.degree);
      moved ||= best !== current;
    }
    if (!moved) break;
  }

  const groups = [...groupDegrees].filter(([, degree]) => degree > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (groups.length < 2) return centers;
  const positions = new Map(groups.map(([group], index) => {
    const radius = Math.sqrt(index) * communitySpacing;
    return [group, { x: Math.cos(index * goldenAngle) * radius, y: Math.sin(index * goldenAngle) * radius }] as const;
  }));
  for (const [id, group] of assignments) centers.set(id, positions.get(group)!);
  return centers;
}

type ChargeCell<T> = {
  minX: number; minY: number; size: number; x: number; y: number; strength: number;
  children?: ChargeCell<T>[]; points?: T[];
};

function chargeTree<T extends GraphBody>(points: T[], minX: number, minY: number, size: number, depth = 0): ChargeCell<T> {
  let strength = 0;
  let x = 0;
  let y = 0;
  for (const node of points) {
    const charge = 240 + graphRadius(node.degree) * 26;
    strength += charge;
    x += node.x * charge;
    y += node.y * charge;
  }
  const cell = { minX, minY, size, x: x / strength, y: y / strength, strength };
  if (points.length <= 3 || depth >= 18) return { ...cell, points };
  const half = size / 2;
  const bags: T[][] = [[], [], [], []];
  for (const node of points) {
    const quadrant = Number(node.x >= minX + half) + 2 * Number(node.y >= minY + half);
    bags[quadrant].push(node);
  }
  return { ...cell, children: bags.flatMap((bag, quad) => bag.length
    ? [chargeTree(bag, minX + (quad % 2) * half, minY + (quad >> 1) * half, half, depth + 1)] : []) };
}

function repel<T extends GraphBody>(target: T, cell: ChargeCell<T>, alpha: number) {
  const dx = target.x - cell.x;
  const dy = target.y - cell.y;
  const distanceSquared = dx * dx + dy * dy;
  const possibleX = Math.max(cell.minX - target.x, target.x - cell.minX - cell.size, 0);
  const possibleY = Math.max(cell.minY - target.y, target.y - cell.minY - cell.size, 0);
  if (possibleX * possibleX + possibleY * possibleY >= chargeDistance * chargeDistance) return;
  const farthestX = Math.max(Math.abs(target.x - cell.minX), Math.abs(target.x - cell.minX - cell.size));
  const farthestY = Math.max(Math.abs(target.y - cell.minY), Math.abs(target.y - cell.minY - cell.size));
  if (cell.children && (possibleX || possibleY) && cell.size * cell.size < 0.81 * distanceSquared &&
    farthestX * farthestX + farthestY * farthestY < chargeDistance * chargeDistance) {
    target.vx += dx * alpha * cell.strength / distanceSquared;
    target.vy += dy * alpha * cell.strength / distanceSquared;
    return;
  }
  for (const child of cell.children ?? []) repel(target, child, alpha);
  for (const point of cell.points ?? []) {
    if (point === target) continue;
    let x = target.x - point.x;
    let y = target.y - point.y;
    if (!x && !y) {
      // Separate hubs that start at the same seed without a random layout change on refresh.
      const angle = ((point.id.length * 17 + point.id.charCodeAt(point.id.length - 1)) % 29) * goldenAngle;
      const direction = target.id < point.id ? 1 : -1;
      x = Math.cos(angle) * direction;
      y = Math.sin(angle) * direction;
    }
    const squared = x * x + y * y;
    if (squared >= chargeDistance * chargeDistance) continue;
    const force = alpha * (240 + graphRadius(point.degree) * 26) / Math.max(1, squared);
    target.vx += x * force;
    target.vy += y * force;
  }
}

export class GraphLayout<T extends GraphBody> {
  alpha = 1;

  step(bodies: T[], links: Iterable<Link<T>>, fixed?: T) {
    if (!bodies.length) return;
    this.alpha *= 1 - alphaDecay;
    const alpha = this.alpha;

    for (const { from, to } of links) {
      if (from === to) continue;
      const x = to.x + to.vx - from.x - from.vx;
      const y = to.y + to.vy - from.y - from.vy;
      const actual = Math.hypot(x, y);
      if (!actual) continue;
      const expected = 120 + (graphRadius(from.degree) + graphRadius(to.degree)) * 1.45;
      const bridge = from.community && to.community && from.community !== to.community;
      const spring = (actual - expected) / actual * alpha * (bridge ? 0.012 : 0.07);
      const bias = from.degree / Math.max(1, from.degree + to.degree);
      from.vx += x * spring * (1 - bias);
      from.vy += y * spring * (1 - bias);
      to.vx -= x * spring * bias;
      to.vy -= y * spring * bias;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of bodies) {
      minX = Math.min(minX, node.x); maxX = Math.max(maxX, node.x);
      minY = Math.min(minY, node.y); maxY = Math.max(maxY, node.y);
    }
    // Aggregate remote charges and keep the exact per-node charge nearby.
    const tree = chargeTree(bodies, minX, minY, Math.max(maxX - minX, maxY - minY, 1));
    for (const node of bodies) repel(node, tree, alpha);
    for (const node of bodies) {
      if (node === fixed) { node.vx = node.vy = 0; continue; }
      if (node.community) {
        node.vx += (node.community.x - node.x) * alpha * communityPull;
        node.vy += (node.community.y - node.y) * alpha * communityPull;
      }
      node.x += node.vx *= 1 - velocityDecay;
      node.y += node.vy *= 1 - velocityDecay;
    }
  }
}
