// Adapted from Max W's weimer.dev/src/lib/backgrounds/ConstellationPreset.test.ts
// at dfccadd4e14420e4b58679110dfcbefcdefe3847. Uses only Node built-ins and loads
// the engine as a classic script, not as an ES module or a CommonJS module.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { createContext, Script } from 'node:vm';

const engineScript = new Script(
  readFileSync(new URL('../constellation/constellation-engine.js', import.meta.url), 'utf8'),
  { filename: 'constellation/constellation-engine.js' },
);

function loadEngine(globals = {}) {
  const sandbox = createContext({ ...globals }, { codeGeneration: { strings: false, wasm: false } });
  engineScript.runInContext(sandbox, { timeout: 1_000 });
  return sandbox;
}

const { Preset } = loadEngine().vivaldiConstellation;
const dimensions = { now: 0, elapsed: 1_000 / 60, width: 500, height: 200, pixelRatio: 1 };
const particle = (x, y, overrides = {}) => ({
  x, y, baseVelocity: { x: 0, y: 0 }, gravityVelocity: { x: 0, y: 0 }, size: 1, ...overrides,
});
const presetWith = (particles) => Object.assign(new Preset(), { particles });
const draw = (preset, frame = {}) => {
  const context = new TestContext();
  preset.draw(context, { ...dimensions, ...frame });
  return context;
};
const closeTo = (actual, expected) => {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} should equal ${expected}`);
};

class TestContext {
  strokeStyle = '';
  fillStyle = '';
  lineWidth = 1;
  path = [];
  arcCenter;
  strokes = [];
  connectionStrokes = [];
  connectionStyles = [];
  cometStrokes = [];
  cometStrokeOpacities = [];
  cometLineWidths = [];
  cometSparkles = [];
  fills = [];
  gradients = [];

  beginPath() {
    this.path = [];
    this.arcCenter = undefined;
  }

  moveTo(x, y) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y), 'finite moveTo coordinates');
    this.path.push({ x, y });
  }

  lineTo(x, y) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y), 'finite lineTo coordinates');
    this.path.push({ x, y });
  }

  createRadialGradient(...coordinates) {
    assert.ok(coordinates.every(Number.isFinite), 'finite radial gradient coordinates');
    const gradient = { coordinates, stops: [], addColorStop(offset, color) { this.stops.push({ offset, color }); } };
    this.gradients.push(gradient);
    return gradient;
  }

  stroke() {
    const [from, to] = this.path;
    if (!from || !to) return;
    const stroke = { from, to };
    this.strokes.push(stroke);
    if (this.strokeStyle.startsWith('rgba(198, 170, 255,')) {
      this.connectionStrokes.push(stroke);
      this.connectionStyles.push(this.strokeStyle);
    }
    if (this.strokeStyle.startsWith('rgba(220, 197, 255,')) {
      this.cometStrokes.push(stroke);
      this.cometStrokeOpacities.push(Number(this.strokeStyle.match(/, ([\d.e+-]+)\)$/)?.[1]));
      this.cometLineWidths.push(this.lineWidth);
    }
  }

  arc(x, y, radius) {
    assert.ok([x, y, radius].every(Number.isFinite), 'finite arc coordinates');
    assert.ok(radius >= 0, 'nonnegative arc radius');
    this.arcCenter = { x, y, radius };
  }

  fill() {
    this.fills.push({ ...this.arcCenter, style: this.fillStyle });
    if (typeof this.fillStyle === 'string' && this.fillStyle.startsWith('rgba(255, 239, 255,') && this.arcCenter) {
      this.cometSparkles.push(this.arcCenter);
    }
  }
}

describe('classic-script registration and initialization', () => {
  test('creates only its namespace without requiring DOM or module globals', () => {
    const sandbox = loadEngine();
    assert.deepEqual(Object.keys(sandbox), ['vivaldiConstellation']);
    assert.equal(typeof sandbox.vivaldiConstellation.Preset, 'function');
    const preset = new sandbox.vivaldiConstellation.Preset();
    assert.equal(preset.name, 'constellation');
    assert.equal(preset.label, 'Signal constellation');
    assert.equal(preset.appearance.blurPx, 2);
    assert.equal(preset.appearance.brightness, 0.7);
    assert.equal(preset.particles.length, 0);
  });

  test('preserves existing namespace identity and unrelated properties, including on reload', () => {
    const sentinel = {};
    const namespace = { sentinel, enabled: false };
    const sandbox = loadEngine({ vivaldiConstellation: namespace });
    assert.equal(sandbox.vivaldiConstellation, namespace);
    assert.equal(namespace.sentinel, sentinel);
    assert.equal(namespace.enabled, false);
    engineScript.runInContext(sandbox, { timeout: 1_000 });
    assert.equal(sandbox.vivaldiConstellation, namespace);
    assert.equal(namespace.sentinel, sentinel);
    assert.equal(typeof namespace.Preset, 'function');
  });

  test('uses source particle density, velocity, and size ranges and resets state on resize', () => {
    const math = Object.create(Math);
    math.random = () => 0.25;
    const preset = new (loadEngine({ Math: math }).vivaldiConstellation.Preset)();
    preset.resize({ width: 100, height: 100, pixelRatio: 1 });
    assert.equal(preset.particles.length, 42);
    const star = preset.particles[0];
    assert.equal(star.x, 25);
    assert.equal(star.y, 25);
    closeTo(star.baseVelocity.x, -0.0575);
    closeTo(star.baseVelocity.y, -0.0575);
    assert.equal(star.gravityVelocity.x, 0);
    assert.equal(star.gravityVelocity.y, 0);
    assert.equal(star.size, 1.35);
    assert.equal(star.cometTrail.length, 0);
    assert.equal(star.explosionFrames, 0);
    assert.equal(star.hasExploded, false);
    assert.notEqual(star.baseVelocity, preset.particles[1].baseVelocity);
    assert.notEqual(star.cometTrail, preset.particles[1].cometTrail);

    star.hasExploded = true;
    preset.resize({ width: 1920, height: 1080, pixelRatio: 2 });
    assert.equal(preset.particles.length, 86);
    assert.notEqual(preset.particles[0], star);
    assert.equal(preset.particles[0].hasExploded, false);
    assert.equal(preset.particles[0].x, 480);
    assert.equal(preset.particles[0].y, 270);
  });
});

describe('connection culling', () => {
  test('draws all neighboring-cell connections in their original particle order', () => {
    const preset = presetWith([0, 144, 146, 290].map((x) => particle(x, 0)));
    const context = draw(preset, { elapsed: 0, width: 400 });
    assert.deepEqual(context.strokes, [
      { from: { x: 0, y: 0 }, to: { x: 144, y: 0 } },
      { from: { x: 144, y: 0 }, to: { x: 146, y: 0 } },
      { from: { x: 146, y: 0 }, to: { x: 290, y: 0 } },
    ]);
  });

  test('matches ordered all-pairs culling across diagonal, negative, and exact-boundary cells', () => {
    const preset = presetWith([
      particle(145, 145), particle(290, 145), particle(144, 144),
      particle(146, 146), particle(0, 0), particle(-1, -1), particle(400, 400),
      particle(145, 0), particle(0, 145), particle(290.01, 145),
    ]);
    const expected = [];
    for (let first = 0; first < preset.particles.length; first += 1) {
      for (let second = first + 1; second < preset.particles.length; second += 1) {
        const a = preset.particles[first];
        const b = preset.particles[second];
        if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 <= 145 ** 2) {
          expected.push({ from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y } });
        }
      }
    }
    // An active cursor suppresses clumps, isolating connection culling.
    const context = draw(preset, { elapsed: 0, cursor: { x: 0, y: 0, speed: 0, idleDuration: 0 } });
    assert.deepEqual(context.connectionStrokes, expected);
  });

  test('does not connect an exploding star to neighboring stars', () => {
    const preset = presetWith([
      particle(0, 0), particle(60, 0, { explosionFrames: 2 }), particle(120, 0),
    ]);
    assert.deepEqual(draw(preset, { elapsed: 0 }).connectionStrokes, [
      { from: { x: 0, y: 0 }, to: { x: 120, y: 0 } },
    ]);
  });

  test('keeps the purple palette, cursor glow, and connection intensity', () => {
    const preset = presetWith([particle(100, 100, { size: 2 }), particle(200, 100), particle(400, 100)]);
    const context = draw(preset, {
      elapsed: 0, cursor: { x: 100, y: 100, speed: 0, idleDuration: 0 },
    });
    assert.equal(context.connectionStyles[0], `rgba(198, 170, 255, ${0.3 * (1 - 100 / 145) + 0.46})`);
    assert.deepEqual(context.gradients[0].coordinates, [100, 100, 0, 100, 100, 20]);
    assert.deepEqual(context.gradients[0].stops, [
      { offset: 0, color: 'rgba(238, 226, 255, 0.5)' },
      { offset: 0.3, color: 'rgba(203, 174, 255, 0.22)' },
      { offset: 1, color: 'rgba(203, 174, 255, 0)' },
    ]);
    closeTo(context.fills[1].radius, 2.9);
    assert.equal(context.fills[1].style, 'rgba(226, 210, 255, 1)');
    assert.equal(context.fills.at(-1).style, 'rgba(226, 210, 255, 0.82)');
    assert.equal(preset.cursorIntensity(particle(280, 100), { x: 100, y: 100 }), 0);
  });
});

describe('elapsed time and cursor gravity', () => {
  test('pulls stars on either side of a moving cursor, even outside its glow radius', () => {
    const preset = presetWith([particle(0, 0), particle(400, 0)]);
    draw(preset, { cursor: { x: 200, y: 0, speed: 1_000 } });
    assert.ok(preset.particles[0].gravityVelocity.x > 0);
    assert.ok(preset.particles[1].gravityVelocity.x < 0);
  });

  test('scales pull with cursor speed and caps cursor mass at 2400 pixels per second', () => {
    const pull = (speed) => {
      const preset = presetWith([particle(0, 0)]);
      draw(preset, { cursor: { x: 200, y: 0, speed } });
      return preset.particles[0].gravityVelocity.x;
    };
    closeTo(pull(1_000), pull(500) * 2);
    closeTo(pull(24_000), pull(2_400));
  });

  test('does not pull stars when the cursor is still', () => {
    const preset = presetWith([particle(0, 0)]);
    draw(preset, { cursor: { x: 200, y: 0, speed: 0 } });
    assert.deepEqual(preset.particles[0].gravityVelocity, { x: 0, y: 0 });
  });

  test('scales movement, gravity retention, trail ages, and explosion duration by elapsed time', () => {
    const preset = presetWith([particle(100, 100, {
      baseVelocity: { x: 0.2, y: -0.1 }, gravityVelocity: { x: 1, y: 0.5 },
      cometTrail: [{ x: 90, y: 90, age: 5 }], explosionFrames: 5,
    })]);
    draw(preset, { elapsed: 2 * dimensions.elapsed });
    const star = preset.particles[0];
    closeTo(star.x, 100 + (0.2 + 0.998 ** 2) * 2);
    closeTo(star.y, 100 + (-0.1 + 0.5 * 0.998 ** 2) * 2);
    assert.equal(star.explosionFrames, 3);
    assert.equal(star.cometTrail[0].age, 0);
    assert.equal(star.cometTrail[1].age, 7);

    const ordinary = presetWith([particle(100, 100, { gravityVelocity: { x: 1, y: 0 } })]);
    draw(ordinary, { elapsed: dimensions.elapsed / 2 });
    closeTo(ordinary.particles[0].gravityVelocity.x, 0.94 ** 0.5);
    closeTo(ordinary.particles[0].x, 100 + 0.94 ** 0.5 / 2);

    const pulled = presetWith([particle(0, 0)]);
    draw(pulled, { elapsed: 2 * dimensions.elapsed, cursor: { x: 200, y: 0, speed: 1_000 } });
    const velocity = 200 * 2.8 * 2 / (200 ** 2 + 55 ** 2);
    closeTo(pulled.particles[0].gravityVelocity.x, velocity);
    closeTo(pulled.particles[0].x, velocity * 2);
  });

  test('fades residual gravity while retaining generated movement', () => {
    const preset = presetWith([particle(0, 0, {
      baseVelocity: { x: 0.2, y: 0 }, gravityVelocity: { x: 1, y: 0 },
    })]);
    for (let frame = 0; frame < 60; frame += 1) {
      draw(preset, { cursor: { x: 200, y: 0, speed: 0 } });
    }
    assert.ok(preset.particles[0].gravityVelocity.x < 0.03);
    assert.ok(preset.particles[0].x > 12);
  });

  test('does not pull an exploding star toward a moving cursor', () => {
    const preset = presetWith([particle(100, 100, { explosionFrames: 5 })]);
    draw(preset, { cursor: { x: 300, y: 100, speed: 2_400 } });
    assert.deepEqual(preset.particles[0].gravityVelocity, { x: 0, y: 0 });
  });

  test('fades explosion velocity more slowly than ordinary cursor gravity', () => {
    const preset = presetWith([
      particle(100, 100, { gravityVelocity: { x: 1, y: 0 }, explosionFrames: 5 }),
      particle(300, 100, { gravityVelocity: { x: 1, y: 0 } }),
    ]);
    draw(preset);
    closeTo(preset.particles[0].gravityVelocity.x, 0.998);
    closeTo(preset.particles[1].gravityVelocity.x, 0.94);
  });

  test('caps ordinary gravity speed at 1.4 and reflects both velocities at the bounds', () => {
    const preset = presetWith([particle(499.5, 199.5, {
      baseVelocity: { x: 1, y: 1 }, gravityVelocity: { x: 10, y: 10 },
    })]);
    draw(preset, { cursor: { x: 600, y: 300, speed: 2_400 } });
    const star = preset.particles[0];
    closeTo(Math.hypot(star.gravityVelocity.x, star.gravityVelocity.y), 1.4);
    assert.deepEqual(star.baseVelocity, { x: -1, y: -1 });
    assert.ok(star.gravityVelocity.x < 0 && star.gravityVelocity.y < 0);
    assert.ok(star.x > 500 && star.y > 200, 'source reflects velocity without clamping position');
  });
});

const clump = (count) => Array.from({ length: count }, (_, index) => particle(
  100 + index % 4 * 8, 100 + Math.floor(index / 4) * 8,
  { gravityVelocity: { x: 0.6, y: 0.2 } },
));
const linearClump = (spacing) => Array.from({ length: 6 }, (_, index) => particle(
  100 + index * spacing, 100, { gravityVelocity: { x: 0.6, y: 0.2 } },
));
const explosionTestParticles = () => [
  particle(90, 290), particle(110, 290), particle(90, 310), particle(110, 310),
  particle(100, 300), particle(100, 320), particle(100, 245),
];
const idleCursor = { x: 250, y: 100, speed: 0, idleDuration: 100 };

describe('clumps and explosions', () => {
  test('explodes clumps larger than five stars after 100 milliseconds idle', () => {
    const preset = presetWith(clump(6));
    draw(preset, { cursor: idleCursor });
    for (const star of preset.particles) {
      assert.ok(Math.hypot(star.gravityVelocity.x, star.gravityVelocity.y) > 28);
      assert.equal(star.explosionFrames, 41);
      assert.equal(star.hasExploded, true);
    }
  });

  test('fans a clump explosion across all directions despite a shared cursor pull', () => {
    const preset = presetWith(clump(6));
    draw(preset, { cursor: idleCursor });
    const velocities = preset.particles.map((star) => star.gravityVelocity);
    for (const axis of ['x', 'y']) {
      assert.ok(velocities.some((velocity) => velocity[axis] > 0));
      assert.ok(velocities.some((velocity) => velocity[axis] < 0));
    }
  });

  test('does not explode a clump of exactly five stars', () => {
    const preset = presetWith(clump(5));
    draw(preset);
    for (const star of preset.particles) {
      assert.ok(star.gravityVelocity.x > 0);
      assert.ok(star.gravityVelocity.y > 0);
      assert.equal(star.explosionFrames ?? 0, 0);
    }
  });

  test('waits for the 100 millisecond idle threshold before exploding', () => {
    const preset = presetWith(clump(6));
    draw(preset, { cursor: { ...idleCursor, speed: 1_000, idleDuration: 0 } });
    assert.ok(preset.particles.every((star) => (star.explosionFrames ?? 0) === 0));
    draw(preset, { cursor: { ...idleCursor, idleDuration: 99 } });
    assert.ok(preset.particles.every((star) => (star.explosionFrames ?? 0) === 0));
    draw(preset, { cursor: idleCursor });
    assert.ok(preset.particles.every((star) => star.explosionFrames > 0));
  });

  test('does not treat stars more than 35 pixels apart as one clump', () => {
    const preset = presetWith(Array.from({ length: 6 }, (_, index) => particle(
      40 + index * 40, 100, { gravityVelocity: { x: 0.6, y: 0.2 } },
    )));
    draw(preset, { cursor: idleCursor });
    assert.ok(preset.particles.every((star) => (star.explosionFrames ?? 0) === 0));
  });

  test('gives tighter clumps a stronger explosion impulse', () => {
    const tight = presetWith(linearClump(2));
    const loose = presetWith(linearClump(12));
    draw(tight);
    draw(loose);
    assert.ok(Math.abs(tight.particles[0].gravityVelocity.x) > Math.abs(loose.particles[0].gravityVelocity.x) * 2);
  });

  test('explodes nearby stars outward from the clump center', () => {
    const preset = presetWith(explosionTestParticles());
    draw(preset, { height: 500, cursor: { ...idleCursor, y: 300 } });
    assert.ok(preset.particles[6].explosionFrames > 0);
    assert.ok(preset.particles[6].gravityVelocity.y < -30);
  });

  test('does not relaunch an exploded clump until it separates and reforms', () => {
    const preset = presetWith(clump(6));
    draw(preset, { elapsed: 0 });
    const first = preset.particles[0];
    const launch = { ...first.gravityVelocity };
    first.explosionFrames = 9;
    draw(preset, { elapsed: 0 });
    assert.equal(first.explosionFrames, 9);
    assert.deepEqual(first.gravityVelocity, launch);

    preset.particles.forEach((star, index) => {
      star.x = index * 200;
      star.explosionFrames = 0;
    });
    draw(preset, { elapsed: 0, width: 2000 });
    assert.ok(preset.particles.every((star) => !star.hasExploded));
    preset.particles.forEach((star) => { star.x = 100; });
    draw(preset, { elapsed: 0 });
    assert.ok(preset.particles.every((star) => star.hasExploded && star.explosionFrames === 42));
  });
});

describe('comet trails', () => {
  test('draws a comet trail for every star affected by an explosion', () => {
    const preset = presetWith(explosionTestParticles());
    const context = draw(preset, { height: 500, cursor: { ...idleCursor, y: 300 } });
    assert.ok(preset.particles.every((star) => star.cometTrail.length));
    assert.equal(context.cometStrokes.length, preset.particles.length);
  });

  test('draws a comet trail behind an exploding star', () => {
    const preset = presetWith([particle(100, 100, {
      cometTrail: [{ x: 90, y: 100 }], explosionFrames: 1,
    })]);
    assert.deepEqual(draw(preset).strokes, [
      { from: { x: 100, y: 100 }, to: { x: 90, y: 100 } },
    ]);
  });

  test('renders a sharply fading comet trail as wide as its star and restores line width', () => {
    const preset = presetWith([particle(100, 100, {
      size: 2, cometTrail: [{ x: 90, y: 100, age: 0 }, { x: 80, y: 100, age: 48 }], explosionFrames: 1,
    })]);
    const context = draw(preset, { elapsed: 0 });
    assert.deepEqual(context.cometLineWidths, [2, 2, 2]);
    assert.ok(context.cometStrokeOpacities.at(-1) < context.cometStrokeOpacities[0] * 0.1);
    closeTo(context.cometStrokeOpacities.at(-1), 0.7 * 0.5 ** 4);
    assert.equal(context.lineWidth, 1);
  });

  test('leaves small sparkles beside active comet trail segments', () => {
    const preset = presetWith([particle(100, 100, {
      size: 2, cometTrail: [{ x: 90, y: 100, age: 0 }], explosionFrames: 1,
    })]);
    const context = draw(preset, { elapsed: 0 });
    assert.equal(context.cometSparkles.length, 1);
    assert.notEqual(context.cometSparkles[0].y, 100);
    assert.ok(context.cometSparkles[0].radius < 2);
  });

  test('does not tether a moving star to its residual comet trail after an explosion', () => {
    const preset = presetWith([particle(100, 100, {
      baseVelocity: { x: 10, y: 0 }, cometTrail: [{ x: 90, y: 100 }, { x: 80, y: 100 }], explosionFrames: 0,
    })]);
    assert.deepEqual(draw(preset).cometStrokes, [
      { from: { x: 90, y: 100 }, to: { x: 80, y: 100 } },
    ]);
  });

  test('keeps trail points for more than 48 frames and removes them at 96 frames', () => {
    const preset = presetWith([particle(100, 100, {
      cometTrail: [{ x: 90, y: 100, age: 0 }], explosionFrames: 0,
    })]);
    for (let frame = 0; frame < 49; frame += 1) draw(preset);
    assert.equal(preset.particles[0].cometTrail.length, 1);
    assert.equal(preset.particles[0].cometTrail[0].age, 49);
    draw(preset, { elapsed: 47 * dimensions.elapsed });
    assert.equal(preset.particles[0].cometTrail.length, 0);
  });
});

describe('finite coordinates', () => {
  test('softens gravity at a coincident cursor without dividing by zero', () => {
    const preset = presetWith([particle(100, 100)]);
    draw(preset, { cursor: { x: 100, y: 100, speed: 24_000, idleDuration: 0 } });
    assert.deepEqual(preset.particles[0].gravityVelocity, { x: 0, y: 0 });
    assert.equal(preset.particles[0].x, 100);
    assert.equal(preset.particles[0].y, 100);
  });

  test('launches coincident particles in deterministic directions and stays finite over many frames', () => {
    const preset = presetWith(Array.from({ length: 6 }, () => particle(250, 100)));
    draw(preset, { elapsed: 0 });
    for (const [index, star] of preset.particles.entries()) {
      closeTo(star.gravityVelocity.x, Math.cos(index * 2.399963229728653) * 0.8 * 48 * 3);
      closeTo(star.gravityVelocity.y, Math.sin(index * 2.399963229728653) * 0.8 * 48 * 3);
    }
    for (let frame = 0; frame < 240; frame += 1) {
      draw(preset, {
        elapsed: [0, 1_000 / 120, 1_000 / 60, 1_000 / 30, 250][frame % 5],
        cursor: frame % 3 ? { x: 250, y: 100, speed: frame * 100, idleDuration: 0 } : undefined,
      });
      for (const star of preset.particles) {
        assert.ok([
          star.x, star.y, star.baseVelocity.x, star.baseVelocity.y,
          star.gravityVelocity.x, star.gravityVelocity.y, star.explosionFrames,
        ].every(Number.isFinite));
        assert.ok(star.cometTrail.every((point) => [point.x, point.y, point.age].every(Number.isFinite)));
      }
    }
  });
});
