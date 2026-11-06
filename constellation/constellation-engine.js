/*
 * Ported from Max W's weimer.dev constellation simulation:
 * https://github.com/M-ax/weimer.dev/blob/dfccadd4e14420e4b58679110dfcbefcdefe3847/src/lib/backgrounds/ConstellationPreset.ts
 *
 * Intentional differences: TypeScript-only declarations are removed, and the
 * module export is replaced by a classic-script IIFE and namespace registration.
 * Simulation constants, update order, rendering, and behavior are unchanged.
 *
 * API: resize({ width, height }); draw(context, { width, height, elapsed, cursor }).
 * Dimensions are CSS pixels; elapsed and cursor.idleDuration are milliseconds;
 * cursor.speed is pixels per second. The caller owns the canvas and frame loop.
 */
(() => {
  'use strict';

  const connectionDistance = 145;
  const clumpDistance = 35;
  const clumpDistanceSquared = clumpDistance * clumpDistance;
  const clumpThreshold = 5;
  const explosionRadius = 70;
  const explosionRadiusSquared = explosionRadius * explosionRadius;
  const explosionIdleDelay = 100;
  const cursorRadius = 180;
  const cursorRadiusSquared = cursorRadius * cursorRadius;
  const gravityStrength = 2.8;
  const gravitySoftening = 55;
  const gravitySofteningSquared = gravitySoftening * gravitySoftening;
  const maxCursorSpeed = 2_400;
  const maxGravitySpeed = 1.4;
  const gravityRetentionPerFrame = 0.94;
  const explosionGravityRetentionPerFrame = 0.998;
  const explosionVelocityMultiplier = 48;
  const maximumCompactnessMultiplier = 3;
  const fallbackExplosionSpeed = 0.8;
  const explosionFrames = 42;
  const cometTrailLifetime = 96;

  class ConstellationPreset {
    name = 'constellation';
    label = 'Signal constellation';
    appearance = { blurPx: 2, brightness: 0.7 };
    particles = [];

    resize({ width, height }) {
      this.particles = Array.from({ length: Math.max(42, Math.round((width * height) / 24000)) }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        baseVelocity: { x: (Math.random() - 0.5) * 0.23, y: (Math.random() - 0.5) * 0.23 },
        gravityVelocity: { x: 0, y: 0 },
        size: 1 + Math.random() * 1.4,
        cometTrail: [],
        explosionFrames: 0,
        hasExploded: false,
      }));
    }

    draw(context, { width, height, elapsed, cursor }) {
      const movementScale = elapsed / (1_000 / 60);
      for (const particle of this.particles) {
        this.fadeGravity(particle, movementScale);
        this.applyCursorGravity(particle, cursor, movementScale);
      }
      if (!cursor || cursor.idleDuration >= explosionIdleDelay) this.explodeLargeClumps(this.createParticleCells());

      const particleCells = new Map();
      for (let index = 0; index < this.particles.length; index += 1) {
        const particle = this.particles[index];
        this.updateCometTrail(particle, movementScale);
        particle.x += (particle.baseVelocity.x + particle.gravityVelocity.x) * movementScale;
        particle.y += (particle.baseVelocity.y + particle.gravityVelocity.y) * movementScale;
        if (particle.x < 0 || particle.x > width) {
          particle.baseVelocity.x *= -1;
          particle.gravityVelocity.x *= -1;
        }
        if (particle.y < 0 || particle.y > height) {
          particle.baseVelocity.y *= -1;
          particle.gravityVelocity.y *= -1;
        }

        const key = this.cellKey(particle.x, particle.y);
        const cell = particleCells.get(key);
        if (cell) cell.push(index);
        else particleCells.set(key, [index]);
      }
      this.drawCometTrails(context);

      const candidates = [];
      for (let first = 0; first < this.particles.length; first += 1) {
        const firstParticle = this.particles[first];
        const cellX = Math.floor(firstParticle.x / connectionDistance);
        const cellY = Math.floor(firstParticle.y / connectionDistance);
        candidates.length = 0;

        for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
          for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
            const cell = particleCells.get(`${cellX + columnOffset}:${cellY + rowOffset}`);
            if (!cell) continue;
            for (const second of cell) {
              if (second > first) candidates.push(second);
            }
          }
        }

        candidates.sort((left, right) => left - right);
        for (const second of candidates) {
          if (this.isExploding(this.particles[first]) || this.isExploding(this.particles[second])) continue;

          const horizontal = this.particles[first].x - this.particles[second].x;
          const vertical = this.particles[first].y - this.particles[second].y;
          if (horizontal * horizontal + vertical * vertical > connectionDistance * connectionDistance) continue;
          const distance = Math.hypot(horizontal, vertical);
          const connectionIntensity = Math.max(
            this.cursorIntensity(this.particles[first], cursor),
            this.cursorIntensity(this.particles[second], cursor),
          );
          const opacity = 0.3 * (1 - distance / connectionDistance) + connectionIntensity * 0.46;
          context.strokeStyle = `rgba(198, 170, 255, ${opacity})`;
          context.beginPath();
          context.moveTo(this.particles[first].x, this.particles[first].y);
          context.lineTo(this.particles[second].x, this.particles[second].y);
          context.stroke();
        }
      }
      const particleColor = 'rgba(226, 210, 255, 0.82)';
      context.fillStyle = particleColor;
      for (const particle of this.particles) {
        const cursorIntensity = this.cursorIntensity(particle, cursor);
        if (cursorIntensity) {
          const glowRadius = particle.size * (4 + cursorIntensity * 6);
          const glow = context.createRadialGradient(particle.x, particle.y, 0, particle.x, particle.y, glowRadius);
          glow.addColorStop(0, `rgba(238, 226, 255, ${cursorIntensity * 0.5})`);
          glow.addColorStop(0.3, `rgba(203, 174, 255, ${cursorIntensity * 0.22})`);
          glow.addColorStop(1, 'rgba(203, 174, 255, 0)');
          context.fillStyle = glow;
          context.beginPath();
          context.arc(particle.x, particle.y, glowRadius, 0, Math.PI * 2);
          context.fill();
          context.fillStyle = `rgba(226, 210, 255, ${0.82 + cursorIntensity * 0.18})`;
        } else {
          context.fillStyle = particleColor;
        }
        context.beginPath();
        context.arc(particle.x, particle.y, particle.size * (1 + cursorIntensity * 0.45), 0, Math.PI * 2);
        context.fill();
      }
    }

    cellKey(x, y) {
      return `${Math.floor(x / connectionDistance)}:${Math.floor(y / connectionDistance)}`;
    }

    createParticleCells() {
      const cells = new Map();
      for (let index = 0; index < this.particles.length; index += 1) {
        const particle = this.particles[index];
        const key = this.cellKey(particle.x, particle.y);
        const cell = cells.get(key);
        if (cell) cell.push(index);
        else cells.set(key, [index]);
      }
      return cells;
    }

    explodeLargeClumps(cells) {
      const visited = new Set();
      for (let index = 0; index < this.particles.length; index += 1) {
        if (visited.has(index)) continue;

        const clump = this.collectClump(index, cells, visited);
        if (clump.length <= clumpThreshold) {
          for (const particleIndex of clump) this.particles[particleIndex].hasExploded = false;
          continue;
        }
        if (clump.some((particleIndex) => this.particles[particleIndex].hasExploded)) continue;

        const center = clump.reduce(
          (total, particleIndex) => ({
            x: total.x + this.particles[particleIndex].x,
            y: total.y + this.particles[particleIndex].y,
          }),
          {x: 0, y: 0},
        );
        center.x /= clump.length;
        center.y /= clump.length;
        this.explodeParticlesNear(center, this.explosionPower(clump, center));
      }
    }

    explosionPower(clump, center) {
      const radius = clump.reduce((largestDistance, particleIndex) => Math.max(
        largestDistance,
        Math.hypot(
          this.particles[particleIndex].x - center.x,
          this.particles[particleIndex].y - center.y,
        ),
      ), 0);
      const compactnessMultiplier = Math.min(
        maximumCompactnessMultiplier,
        Math.max(1, clumpDistance / Math.max(radius, 1)),
      );
      return explosionVelocityMultiplier * compactnessMultiplier;
    }

    explodeParticlesNear(center, explosionPower) {
      for (let particleIndex = 0; particleIndex < this.particles.length; particleIndex += 1) {
        const particle = this.particles[particleIndex];
        const horizontal = particle.x - center.x;
        const vertical = particle.y - center.y;
        if (horizontal * horizontal + vertical * vertical > explosionRadiusSquared) continue;
        this.explodeParticle(particle, center, particleIndex, explosionPower);
      }
    }

    collectClump(startIndex, cells, visited) {
      const clump = [];
      const pending = [startIndex];
      visited.add(startIndex);

      while (pending.length) {
        const particleIndex = pending.pop();
        const particle = this.particles[particleIndex];
        clump.push(particleIndex);
        const cellX = Math.floor(particle.x / connectionDistance);
        const cellY = Math.floor(particle.y / connectionDistance);

        for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
          for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
            const cell = cells.get(`${cellX + columnOffset}:${cellY + rowOffset}`);
            if (!cell) continue;
            for (const otherIndex of cell) {
              if (visited.has(otherIndex)) continue;
              const other = this.particles[otherIndex];
              const horizontal = particle.x - other.x;
              const vertical = particle.y - other.y;
              if (horizontal * horizontal + vertical * vertical > clumpDistanceSquared) continue;
              visited.add(otherIndex);
              pending.push(otherIndex);
            }
          }
        }
      }

      return clump;
    }

    explodeParticle(particle, center, particleIndex, explosionPower) {
      if (this.isExploding(particle)) return;

      const gravitySpeed = Math.hypot(particle.gravityVelocity.x, particle.gravityVelocity.y);
      let horizontal = particle.x - center.x;
      let vertical = particle.y - center.y;
      const distance = Math.hypot(horizontal, vertical);
      if (distance) {
        horizontal /= distance;
        vertical /= distance;
      } else {
        const angle = particleIndex * 2.399963229728653;
        horizontal = Math.cos(angle);
        vertical = Math.sin(angle);
      }
      const launchSpeed = Math.max(gravitySpeed, fallbackExplosionSpeed) * explosionPower;
      particle.gravityVelocity.x = horizontal * launchSpeed;
      particle.gravityVelocity.y = vertical * launchSpeed;
      particle.cometTrail = [];
      particle.explosionFrames = explosionFrames;
      particle.hasExploded = true;
    }

    updateCometTrail(particle, movementScale) {
      const trail = particle.cometTrail ??= [];
      for (const point of trail) point.age = (point.age ?? 0) + movementScale;
      particle.cometTrail = trail.filter((point) => point.age < cometTrailLifetime);

      const remainingFrames = particle.explosionFrames ?? 0;
      if (remainingFrames <= 0) return;

      particle.cometTrail.unshift({x: particle.x, y: particle.y, age: 0});
      particle.explosionFrames = Math.max(0, remainingFrames - movementScale);
    }

    drawCometTrails(context) {
      for (const particle of this.particles) {
        const trail = particle.cometTrail;
        if (!trail.length) continue;

        const isExploding = this.isExploding(particle);
        let from = isExploding ? particle : trail[0];
        const points = isExploding ? trail : trail.slice(1);
        let visibleSegmentIndex = 0;
        for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
          const point = points[pointIndex];
          const opacity = 0.7 * Math.pow(Math.max(0, 1 - (point.age ?? 0) / cometTrailLifetime), 4);
          context.strokeStyle = `rgba(220, 197, 255, ${opacity})`;
          context.lineWidth = particle.size;
          context.beginPath();
          context.moveTo(from.x, from.y);
          context.lineTo(point.x, point.y);
          context.stroke();
          const hasLength = from.x !== point.x || from.y !== point.y;
          if (hasLength && visibleSegmentIndex % 3 === 0) {
            this.drawCometSparkle(context, particle.size, from, point, visibleSegmentIndex, opacity);
          }
          if (hasLength) {
            visibleSegmentIndex += 1;
          }
          from = point;
        }
      }
      context.lineWidth = 1;
    }

    drawCometSparkle(context, particleSize, from, to, pointIndex, opacity) {
      const horizontal = to.x - from.x;
      const vertical = to.y - from.y;
      const distance = Math.hypot(horizontal, vertical);
      if (!distance) return;

      const side = (pointIndex + Math.floor((to.age ?? 0) / 8)) % 2 ? -1 : 1;
      const offset = particleSize * (1.2 + (pointIndex % 3) * 0.35) * side;
      const x = (from.x + to.x) / 2 - vertical / distance * offset;
      const y = (from.y + to.y) / 2 + horizontal / distance * offset;
      context.fillStyle = `rgba(255, 239, 255, ${opacity * 0.85})`;
      context.beginPath();
      context.arc(x, y, particleSize * (0.5 + opacity * 0.5), 0, Math.PI * 2);
      context.fill();
    }

    applyCursorGravity(particle, cursor, movementScale) {
      if (this.isExploding(particle) || !cursor || cursor.speed <= 0) return;

      const horizontal = cursor.x - particle.x;
      const vertical = cursor.y - particle.y;
      const distanceSquared = horizontal * horizontal + vertical * vertical + gravitySofteningSquared;
      const mass = Math.min(cursor.speed, maxCursorSpeed) / 1_000;
      const force = gravityStrength * mass * movementScale / distanceSquared;
      particle.gravityVelocity.x += horizontal * force;
      particle.gravityVelocity.y += vertical * force;

      const speed = Math.hypot(particle.gravityVelocity.x, particle.gravityVelocity.y);
      if (speed <= maxGravitySpeed) return;
      particle.gravityVelocity.x = particle.gravityVelocity.x / speed * maxGravitySpeed;
      particle.gravityVelocity.y = particle.gravityVelocity.y / speed * maxGravitySpeed;
    }

    fadeGravity(particle, movementScale) {
      const retention = Math.pow(
        this.isExploding(particle) ? explosionGravityRetentionPerFrame : gravityRetentionPerFrame,
        movementScale,
      );
      particle.gravityVelocity.x *= retention;
      particle.gravityVelocity.y *= retention;
    }

    isExploding(particle) {
      return particle.explosionFrames > 0;
    }

    cursorIntensity(particle, cursor) {
      if (!cursor) return 0;

      const horizontal = particle.x - cursor.x;
      const vertical = particle.y - cursor.y;
      if (horizontal * horizontal + vertical * vertical >= cursorRadiusSquared) return 0;
      return Math.pow(1 - Math.hypot(horizontal, vertical) / cursorRadius, 2);
    }
  }

  const namespace = globalThis.vivaldiConstellation ??= {};
  namespace.Preset = ConstellationPreset;
})();
