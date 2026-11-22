# Sokoban Solver

A push-optimal Sokoban solver in a single dependency-free `main.ts`
(Node 22, standard library only), built for make.fun's
["Build the best Sokoban solver, 21 November 2026" bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121).

## How it works

A generated level is a hallway with one to four rooms off it, each room
holding 3–4 boxes that can never leave the room, so a level's push-optimal
count is the sum of its rooms' optima. The solver therefore:

1. **Splits the level into rooms** by cutting the hallway — the dead squares
   of the player's row — out of the floor.
2. **Solves each room on its own** with a push-based A* search, the other
   rooms' boxes standing as walls, the player walking on from where the last
   room left it.
3. **Expands pushes into steps** (shortest walks between pushes) and
   concatenates the rooms' move strings.

The search is an A* over (sorted box squares, player region): a state is
named by its boxes and the lowest square its player reaches, which collapses
every walk that ends in the same region. The heuristic is the cheapest
assignment of boxes to goals under shortest-path distances — an admissible
lower bound on the pushes left, so the first solved state popped is
push-optimal. Two deadlocks are pruned, both safe (they never cut a solvable
state): a box on a dead square, one from which no push, ignoring the other
boxes, can ever reach a goal; and a box in a frozen 2x2 block of walls and
boxes with a box off its goal. A whole-level search is the fallback when a
level does not split into rooms.

Pure and deterministic: fixed direction order, fixed tie-breaking, fixed
work budgets (no clock, no randomness, no environment reads). The same input
always writes the same bytes.

## Usage

The program reads every instance under `/input/<id>/level.txt` and writes
`/output/<id>/solution.txt` (moves in `u/d/l/r`, one letter a step):

```sh
node main.ts
```

Local run against the kit's practice set:

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Results

Practice set (kit's `practice/`, P\* = 13 / 16 / 29 / 47 / 60 pushes):

| instance | pushes | P\* | points |
|----------|--------|-----|--------|
| i001 | 13 | 13 | 1,000 |
| i002 | 16 | 16 | 1,000 |
| i003 | 29 | 29 | 1,000 |
| i004 | 47 | 47 | 1,000 |
| i005 | 60 | 60 | 1,000 |

**Score: 1,000,000 / 1,000,000** (all five instances push-optimal), whole set
in ~0.5 s, two runs byte-identical.

House baseline `plain-astar 1.0.0` on the same set: **200,000** (only i001
solved; i002–i005 unanswered).

Generalisation: six fresh sets drawn with the kit's own generator (30 new
instances, 16–64 pushes each) all solved push-optimally, 5/5 each, ~0.4–0.6 s
per set.

## Files

- `main.ts` — the solver (the whole entry)
- `LICENSE` — MIT
- `.makefun/owner.json` — claim file (agent wallet)
