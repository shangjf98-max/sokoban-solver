// Sokoban solver: push-optimal, room by room.
//
// A level is a hallway with one to four rooms off it, each room holding 3-4
// boxes that can never leave the room, so a level's push-optimal count is the
// sum of its rooms' optima. The solver therefore:
//
//   1. cuts the hallway (the dead squares of the player's row) out of the
//      floor, which splits the level into its rooms;
//   2. solves each room on its own with an A* search over pushes, the other
//      rooms' boxes standing as walls, the player walking on from where the
//      last room left it;
//   3. expands each room's pushes into single steps (shortest walks between
//      pushes) and concatenates the rooms' move strings.
//
// The search is a push-based A* over (sorted box squares, player region):
// a state is named by its boxes and the lowest square its player reaches,
// which collapses every walk that ends in the same region. The heuristic is
// the cheapest assignment of boxes to goals under shortest-path distances,
// an admissible lower bound on the pushes left, so the first solved state
// the search pops is push-optimal. Two deadlocks are pruned, both safe (they
// never cut a solvable state): a box on a dead square, one from which no
// push, ignoring the other boxes, can ever reach a goal; and a box in a
// frozen 2x2 block of walls and boxes with a box off its goal.
//
// Pure and deterministic: fixed direction order, fixed tie-breaking, fixed
// work budgets, no clock, no randomness, no environment reads. The same
// input always writes the same bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** [dx, dy, step letter, push letter], in a fixed order. */
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** The most states one room search keeps, and the whole-level fallback. */
const ROOM_STATE_CAP = 600_000;
const LEVEL_STATE_CAP = 2_000_000;

/**
 * A level in XSB text: width and height, walls (1 a wall; short rows and
 * squares outside padded as walls, the outermost frame always wall), goals,
 * boxes (sorted) and the player.
 */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares from which a box alone can be pushed onto some goal: pull back
 * from the goals over open floor. A box on a square outside this set can
 * never reach a goal, whatever the other boxes do.
 */
function liveSquares(level) {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      // A box on y is pushed in direction d onto x when the player can
      // stand on y - d: both squares must be open floor.
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The squares the player reaches from `from` with `occupied` in the way,
 * marked in `seen` with `stamp`; returns the lowest reached square, which
 * names the region.
 */
function reach(level, occupied, from, seen, stamp, stack) {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block of walls
 * and boxes with a box off its goal: nothing in the block can ever move.
 */
function frozenBlock(level, occupied, goal, t) {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b])) return true;
    if ((occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/**
 * Shortest-path distances (ignoring boxes) from every goal, one Int32Array
 * per goal, -1 where unreachable. A box's distance to a goal is a lower
 * bound on the pushes that box still needs.
 */
function goalDistances(level) {
  const { w, wall, goals } = level;
  const dists = [];
  for (const g of goals) {
    const dist = new Int32Array(wall.length).fill(-1);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi];
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && dist[q] < 0) {
          dist[q] = dist[p] + 1;
          queue.push(q);
        }
      }
    }
    dists.push(dist);
  }
  return dists;
}

/**
 * The cheapest assignment of boxes to goals under the distance tables: the
 * minimum over matchings, by DP over goal subsets (rooms hold few boxes).
 * Admissible: one push moves one box one square, so no push can cut this
 * sum by more than one.
 */
function assignmentBound(boxes, dists) {
  const n = boxes.length;
  if (n === 0) return 0;
  if (n > 8 || dists.length < n) {
    let s = 0;
    for (const b of boxes) {
      let m = Infinity;
      for (const d of dists) if (d[b] >= 0 && d[b] < m) m = d[b];
      if (m === Infinity) return Infinity;
      s += m;
    }
    return s;
  }
  const size = 1 << n;
  const dp = new Float64Array(size).fill(Infinity);
  dp[0] = 0;
  for (let mask = 0; mask < size; mask++) {
    const i = popcount(mask);
    if (i >= n || dp[mask] === Infinity) continue;
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) continue;
      const d = dists[j][boxes[i]];
      if (d < 0) continue;
      const nm = mask | (1 << j);
      const v = dp[mask] + d;
      if (v < dp[nm]) dp[nm] = v;
    }
  }
  return dp[size - 1];
}

function popcount(x) {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

/** A state's key: its region's lowest square and its boxes, as a string. */
function keyOf(boxes, low) {
  return `${low}:${boxes.join(',')}`;
}

/** A binary heap on [f, h, sequence], smallest first, ties by insertion. */
class Heap {
  constructor() {
    this.a = [];
  }
  get size() {
    return this.a.length;
  }
  push(e) {
    const a = this.a;
    let i = a.length;
    a.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(a[i], a[p])) break;
      const t = a[i];
      a[i] = a[p];
      a[p] = t;
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && less(a[c + 1], a[c])) c++;
        if (!less(a[c], a[i])) break;
        const t = a[i];
        a[i] = a[c];
        a[c] = t;
        i = c;
      }
    }
    return top;
  }
}

function less(x, y) {
  return x[0] < y[0] || (x[0] === y[0] && (x[1] < y[1] || (x[1] === y[1] && x[2] < y[2])));
}

/**
 * The push-optimal solution of `level`, searching at most `maxStates`
 * states: { pushes, moves } (moves in LURD, a lower letter a step, an upper
 * one a push), or null when the search gives up or the level has no solution.
 */
function searchPushOptimal(level, maxStates) {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const dists = goalDistances(level);
  const solved = (boxes) => boxes.every((b) => goal[b]);

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // The states in the order found: their boxes, the player's square just
  // after the push that made them, the lowest square of the player's region
  // after that push, their push count, and their parent.
  const statesBoxes = [level.boxes.slice()];
  const statesPlayer = [level.player];
  const statesLow = [0];
  const statesG = [0];
  const parent = [-1];
  const bestG = new Map();
  for (const b of level.boxes) occupied[b] = 1;
  const startLow = reach(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  statesLow[0] = startLow;
  bestG.set(keyOf(level.boxes, startLow), 0);

  const heap = new Heap();
  let seq = 0;
  const h0 = assignmentBound(level.boxes, dists);
  if (h0 === Infinity) return null;
  heap.push([h0, h0, seq++, 0]);

  let found = -1;
  while (heap.size > 0 && found < 0) {
    const [, , , s] = heap.pop();
    const boxes = statesBoxes[s];
    const g = statesG[s];
    // A stale heap entry: a better path to this state was found since.
    if (bestG.get(keyOf(boxes, statesLow[s])) !== g) continue;
    // Pop-time goal test: with a consistent heuristic the first solved
    // state popped is push-optimal.
    if (solved(boxes)) {
      found = s;
      break;
    }
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    reach(level, occupied, statesPlayer[s], seen, here, stack);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (t < 0 || t >= size) continue;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(level, occupied, goal, t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((x, y) => x - y);
        const low = reach(level, occupied, b, mark, ++stamp, stack);
        const key = keyOf(next, low);
        const prevG = bestG.get(key);
        occupied[t] = 0;
        occupied[b] = 1;
        if (prevG !== undefined && prevG <= g + 1) continue;
        if (statesBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        const h = assignmentBound(next, dists);
        if (h === Infinity) continue;
        bestG.set(key, g + 1);
        const id = statesBoxes.length;
        statesBoxes.push(next);
        statesPlayer.push(b);
        statesLow.push(low);
        statesG.push(g + 1);
        parent.push(s);
        heap.push([g + 1 + h, h, seq++, id]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;
  // The path of states, then the moves: walk to each push's square, then push.
  const path = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = statesBoxes[s];
    const from = boxes.find((b) => !nextBoxes.includes(b));
    const to = nextBoxes.find((b) => !boxes.includes(b));
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d);
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(level, occupied, from, to) {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, the case aside) from `from` on a board `w` wide. */
function endOf(w, from, moves) {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room, its squares, boxes and goals. Null when some part
 * holds more or fewer boxes than goals, or a box starts in the hallway: then
 * the level is no set of rooms.
 */
function roomsOf(level) {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it. A box
 * never leaves its room, so the rooms' optima add up to the level's:
 * { pushes, moves }, or null when a room's search gives up, or the level is
 * no set of rooms and the search over the whole level gives up.
 */
function solveByRooms(level) {
  const rooms = roomsOf(level);
  if (rooms === null) return searchPushOptimal(level, LEVEL_STATE_CAP);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = searchPushOptimal(sub, ROOM_STATE_CAP);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** Replay `moves` on the level: true only when every step is legal and every box ends on a goal. */
function verify(level, moves) {
  const { w, wall, goals } = level;
  const goal = new Set(goals);
  const boxes = new Set(level.boxes);
  let player = level.player;
  for (const ch of moves) {
    const lower = ch.toLowerCase();
    const d = lower === 'u' ? -w : lower === 'd' ? w : lower === 'l' ? -1 : 1;
    const q = player + d;
    if (wall[q]) return false;
    if (boxes.has(q)) {
      const t = q + d;
      if (wall[t] || boxes.has(t)) return false;
      boxes.delete(q);
      boxes.add(t);
    }
    player = q;
  }
  for (const b of boxes) if (!goal.has(b)) return false;
  return true;
}

function solve(text) {
  const level = parseLevel(text);
  if (level.boxes.length === 0) return '';
  if (level.boxes.every((b) => level.goals.includes(b))) return '';
  const byRooms = solveByRooms(level);
  if (byRooms !== null && verify(level, byRooms.moves)) return byRooms.moves;
  const whole = searchPushOptimal(level, LEVEL_STATE_CAP);
  if (whole !== null && verify(level, whole.moves)) return whole.moves;
  return '';
}

for (const id of readdirSync(INPUT).sort()) {
  const moves = solve(readFileSync(join(INPUT, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), `${moves}\n`);
}
