(function (G) {
  'use strict';

  // Combate cuerpo a cuerpo al estilo del original:
  // - Apuntar (clic derecho / LT) te deja quieto y encarado; atacar sin apuntar también vale.
  // - Cada arma tiene alcance, daño, velocidad, críticos, golpes múltiples y probabilidad de derribo.
  // - Empujón (Espacio): aparta y puede tirar al suelo; contra un zombi caído es un pisotón.
  // - Golpear a un zombi caído es un ataque al suelo (más daño, a la cabeza).
  // - Los cuchillos pueden rematar de un golpe por la espalda o en el suelo.
  // - El arma se desgasta y se rompe. La resistencia baja con cada golpe.
  // - Los zombis agarran: rasguños, laceraciones y mordiscos (los mordiscos infectan).

  const U = G.Util;
  const IMPACT = 0.45;
  // golpes que se pueden encadenar
  const COMBO_KINDS = { swing1: 1, swing1b: 1, swing2: 1, swing2b: 1, overhead: 1, stab: 1, slash: 1, thrust: 1, punch1: 1, punch2: 1, punch3: 1, kslash1: 1, kslash2: 1, kstab: 1 };
  // Puños (manos libres): gancho de derecha, gancho de izquierda y un golpe fuerte que sale agachado.
  // dur en segundos; impact = momento del golpe (0 a 1); next = desde cuándo sale el siguiente del combo
  const PUNCH = [
    { kind: 'punch1', dur: 0.5, impact: 0.42, next: 0.6, dmg: [0.24, 0.4], knock: 0.06, side: 1 },
    { kind: 'punch2', dur: 0.46, impact: 0.42, next: 0.58, dmg: [0.22, 0.36], knock: 0.06, side: -1 },
    { kind: 'punch3', dur: 0.88, impact: 0.52, next: 0.8, dmg: [0.5, 0.8], knock: 0.5, side: 1 }
  ];
  const ANIM = 0.9;          // ritmo general de los ataques (menor = más rápidos)
  // con un arma cuerpo a cuerpo, un golpe que acierta quita al menos esto: como mucho 3 golpes por zombi
  const MELEE_MIN = 1.17;
  // reacción del zombi según el golpe: [tipo, lado, zona] (lado +1: hacia la derecha del zombi, la izquierda de
  // quien pega). Zona (con un arma): el tercer golpe del combo va a la cabeza (lo mata en el acto); el resto,
  // al cuerpo (daño normal). Los puñetazos nunca matan de un golpe
  const HIT_REACT = {
    swing2: ['side', 1, 'body'], swing2b: ['side', -1, 'body'], swing1: ['vert', 1, 'head'], swing1b: ['side', -1, 'body'], overhead: ['vert', 1, 'head'],
    slash: ['side', -1, 'body'], stab: ['stab', 1, 'body'], thrust: ['stab', 1, 'body'], punch1: ['side', 1, 'body'], punch2: ['side', -1, 'body'], punch3: ['heavy', 1, 'body'],
    kslash1: ['side', 1, 'body'], kslash2: ['side', -1, 'body'], kstab: ['stab', 1, 'head']
  };
  // estados en los que un zombi no te ha visto y se le puede agarrar por la espalda
  const GRAB_OK = { idle: 1, wander: 1, investigate: 1, bang: 1 };

  // Distancia a la primera superficie (pared, valla, puerta o ventana cerradas, o un mueble alto) en la
  // dirección (ux, uz) desde (x, z); null si no hay ninguna antes de maxD
  function surfaceHit(x, z, ux, uz, maxD, lv) {
    const W = G.World, E = W.E;
    const f = W.lineHit(x, z, x + ux * maxD, z + uz * maxD, (e) => e !== E.NONE && e !== E.DOOR_OPEN && e !== E.DOOR_BROKEN && e !== E.ARCH, lv);
    let d = f >= 0 ? f * maxD : null;
    const base = W.baseAt(x, z, lv) + (lv ? W.FLOOR_H : 0);
    for (let t = 0.25; t <= maxD; t += 0.1) {
      if (d != null && t >= d) break;
      if (W.furnTop(x + ux * t, z + uz * t, lv, 0.04) > base + 0.6) { d = t; break; }
    }
    return d;
  }

  const Combat = {
    stats: null,
    dragT: 0,
    hitStop: 0,
    onMessage: null,
    onHit: null,

    msg(text, kind) { if (this.onMessage) this.onMessage(text, kind); },

    // Cadena de golpes: [primero, segundo, tercero (fuerte)]
    comboFor(w, two) {
      if (w.knife) return ['kslash1', 'kslash2', 'kstab'];
      const base = this.animFor(w, two);
      if (base === 'swing2') return ['swing2', 'swing2b', 'overhead'];
      if (base === 'swing1') return two ? ['swing1', 'swing2b', 'overhead'] : ['swing1', 'swing1b', 'swing1'];
      if (base === 'stab') return ['stab', 'slash', 'stab'];
      return ['thrust', 'thrust', 'thrust'];
    },

    // Animación según el arma y cómo la agarras
    animFor(w, two) {
      if (w.cat === 'sblade') return 'stab';
      if (w.cat === 'spear') return 'thrust';
      if (w.cat === 'lblunt') return two ? 'swing2' : 'swing1';
      if (w.cat === 'axe' || w.cat === 'lblade') return w.hands === 2 && two ? 'swing2' : 'swing1';
      return 'swing1';
    },

    // Zombis delante del jugador dentro de un alcance y un ángulo
    inFront(player, zombies, range, arc, filter) {
      const out = [];
      for (const z of zombies) {
        if (!z.alive || !filter(z)) continue;
        const dx = z.pos.x - player.pos.x, dz = z.pos.z - player.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > range) continue;
        const a = Math.abs(U.angleDiff(Math.atan2(dx, dz), player.facing));
        if (a > arc && d > 0.45) continue;
        if ((z.lv || 0) !== (player.lv || 0)) continue;
        if (!G.World.hasLOS(player.pos.x, player.pos.z, z.pos.x, z.pos.z, player.lv)) continue;
        out.push({ z, d, a });
      }
      out.sort((p, q) => p.d - q.d);
      return out;
    },

    // Zombi al que apuntas: el más centrado delante de la cámara y a tu alcance
    pickTarget(player, zombies, camYaw, extra) {
      const range = player.weapon.range + (extra != null ? extra : 0.8);
      let best = null, bestA = 0.62;
      for (const z of zombies) {
        if (!z.alive) continue;
        const dx = z.pos.x - player.pos.x, dz = z.pos.z - player.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > range) continue;
        const a = Math.abs(U.angleDiff(Math.atan2(dx, dz), camYaw));
        if (a < bestA && (z.lv || 0) === (player.lv || 0) && G.World.hasLOS(player.pos.x, player.pos.z, z.pos.x, z.pos.z, player.lv)) { bestA = a; best = z; }
      }
      return best;
    },

    // Dirección de ataque con un poco de ayuda para apuntar
    aimYaw(player, zombies, camYaw) {
      const z = this.pickTarget(player, zombies, camYaw);
      return z ? Math.atan2(z.pos.x - player.pos.x, z.pos.z - player.pos.z) : camYaw;
    },

    // Objetivo cuerpo a cuerpo: el zombi más cercano a tu alcance (con un paso), en cualquier dirección.
    // Si empujas el joystick hacia uno, se elige ese: así se puede ir pegando a dos que te rodean.
    // Devuelve { z, d, yaw } o null
    meleeTarget(player, zombies, camYaw, input, extra) {
      const w = player.weapon;
      const range = (w.cat === 'none' ? 0.9 : w.range) + (extra != null ? extra : 1.35);
      let intent = null;
      const mv = input && input.move;
      if (mv && Math.hypot(mv.x, mv.y) > 0.35) {
        const fx = Math.sin(camYaw), fz = Math.cos(camYaw), rx = -Math.cos(camYaw), rz = Math.sin(camYaw);
        intent = Math.atan2(fx * -mv.y + rx * mv.x, fz * -mv.y + rz * mv.x);
      }
      let best = null, bestS = Infinity;
      for (const z of zombies) {
        if (!z.alive || !(z.standing || z.state === 'rise')) continue;
        if ((z.lv || 0) !== (player.lv || 0)) continue;
        const dx = z.pos.x - player.pos.x, dz = z.pos.z - player.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > range) continue;
        const yaw = Math.atan2(dx, dz);
        let s = d;
        if (intent != null) s += Math.abs(U.angleDiff(yaw, intent)) * 0.9;
        else s += Math.abs(U.angleDiff(yaw, camYaw)) * 0.22;     // a igual distancia, el que tienes delante
        if (s >= bestS) continue;
        if (!G.World.hasLOS(player.pos.x, player.pos.z, z.pos.x, z.pos.z, player.lv)) continue;
        bestS = s; best = { z, d, yaw };
      }
      return best;
    },

    // ---------- Entrada del jugador ----------
    handleInput(player, input, zombies, camYaw) {
      this.input = input;
      this.camYaw = camYaw;
      if (player.dead) return;
      // forcejeo: cada pulsación de atacar cuenta para soltarte
      if (player.struggle) { if (input.attack) player.struggle.n++; return; }
      // esquiva: también corta la recuperación de un golpe
      if (input.dodge) { this.startDodge(player, input, camYaw); return; }
      const a = player.action;
      // agarrar por la espalda a un zombi desprevenido: con el botón de ataque (sin apuntar)
      if (input.attack && !player.aiming && !player.busy() && !player.dodging && !(player.prone || player.proneAmt > 0.4)) {
        const g = this.grabTarget(player, zombies);
        if (g) { this.startGrab(player, g); return; }
      }
      // armas de fuego: disparar al apuntar, recargar (R, o empujar mientras apuntas)
      if (G.Guns && G.Guns.handleInput(player, input, zombies)) return;
      // pulsar atacar durante un golpe encadena el siguiente (combo de 3)
      if (a && input.attack && COMBO_KINDS[a.kind] && a.t > (a.punch ? 0.15 : 0.3)) { a.queued = true; return; }
      if (player.busy() || player.dodging) return;
      // tumbado no se puede atacar: el primer toque te levanta
      if (input.attack && (player.prone || player.proneAmt > 0.4)) { player.setStance('crouch'); return; }
      const w = player.weapon;
      // un aturdido al alcance: remate (con un arma de fuego en la mano, la guarda y saca la navaja). Va antes
      // que el ataque en carrera: llegar corriendo a uno aturdido y atacar también lo remata
      if (input.attack && !player.aiming) {
        const ez = this.execTarget(player, zombies);
        if (ez) { this.startExecution(player, ez); return; }
      }
      // ataque en carrera: corriendo, atacar lanza un golpe con todo el impulso
      if (input.attack && player.running && w.cat !== 'gun' && player.moveAmt > 0.6) { this.startRunAttack(player, zombies, camYaw); return; }
      if (input.attack && G.Weapons.isGun(w)) this.startBash(player, zombies, camYaw);
      else if (input.attack && w.cat !== 'none') this.startAttack(player, zombies, camYaw);
      else if (input.attack) this.startPunch(player, zombies, camYaw, 0);
    },

    // ¿Hay un zombi desprevenido de espaldas, al alcance, para agarrarlo?
    grabTarget(player, zombies) {
      if (player.dead || player.busy() || player.prone) return null;
      let best = null, bestD = 1.25;
      for (const z of zombies) {
        if (!z.alive || !z.standing || !GRAB_OK[z.state]) continue;
        const dx = z.pos.x - player.pos.x, dz = z.pos.z - player.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > bestD) continue;
        if (Math.abs(U.angleDiff(Math.atan2(dx, dz), player.facing)) > 1.0 && d > 0.5) continue;
        if (!this.behind(player, z)) continue;
        if ((z.lv || 0) !== (player.lv || 0)) continue;
        if (!G.World.hasLOS(player.pos.x, player.pos.z, z.pos.x, z.pos.z, player.lv)) continue;
        best = z; bestD = d;
      }
      return best;
    },

    // Siempre llevas una navaja para el sigilo (no se gasta ni ocupa espacio): tres puñaladas al cuello
    startGrab(player, z) {
      const knife = true;
      const face = Math.atan2(z.pos.x - player.pos.x, z.pos.z - player.pos.z);
      player.action = { kind: 'grab', t: 0, dur: knife ? 1.7 : 2.8, impact: knife ? 0.62 : 0.8, face, target: z, knife, done: false };
      if (player.stance !== 'stand') player.stance = 'stand';
      z.grab(player);
      player.stamina = Math.max(0, player.stamina - 0.06);
    },

    // Ataque en carrera: el personaje se lanza con el impulso (como en el vídeo de referencia):
    // brazo izquierdo adelante, el arma arriba detrás de la cabeza y golpe de arriba abajo al llegar.
    // Hace más daño y casi siempre derriba. Sin arma es un placaje.
    startRunAttack(player, zombies, camYaw) {
      const w = player.weapon;
      const moveYaw = Math.atan2(player.vel.x, player.vel.z);
      // objetivo: el zombi más centrado hacia donde corres (si hay)
      let tgt = null, bestA = 0.7;
      for (const z of zombies) {
        if (!z.alive || !z.standing || (z.lv || 0) !== (player.lv || 0)) continue;
        const dx = z.pos.x - player.pos.x, dz = z.pos.z - player.pos.z, d = Math.hypot(dx, dz);
        if (d > w.range + 2.4) continue;
        const a2 = Math.abs(U.angleDiff(Math.atan2(dx, dz), moveYaw));
        if (a2 < bestA && G.World.hasLOS(player.pos.x, player.pos.z, z.pos.x, z.pos.z, player.lv)) { bestA = a2; tgt = z; }
      }
      const face = tgt ? Math.atan2(tgt.pos.x - player.pos.x, tgt.pos.z - player.pos.z) : moveYaw;
      const d = tgt ? Math.hypot(tgt.pos.x - player.pos.x, tgt.pos.z - player.pos.z) : 2;
      const g = G.Weapons.grip(w);
      player.action = {
        kind: w.cat === 'none' ? 'runshove' : 'runatk', t: 0, dur: 0.78, impact: 0.42, face, done: false,
        weapon: w, two: player.twoHanded, g, run: true, target: tgt,
        step: { len: Math.max(0.6, Math.min(2.0, d - w.range * 0.6)), done: 0 }
      };
      player.stamina = Math.max(0, player.stamina - Math.max(0.05, w.stam * 1.5));
      player.running = false;
    },

    resolveRunAttack(player, zombies, a) {
      const w = a.weapon;
      const targets = this.inFront(player, zombies, (w.cat === 'none' ? 1.1 : w.range + 0.35), 0.9, (z) => z.standing);
      if (!targets.length) { this.hitWindow(player); G.World.emit(player.pos.x, player.pos.z, 2.5 * player.noiseMul, player.lv); return; }
      const { z } = targets[0];
      const dx = z.pos.x - player.pos.x, dz = z.pos.z - player.pos.z;
      const behind = this.behind(player, z);
      let res;
      if (w.cat === 'none') {
        // placaje: lo tira al suelo casi siempre
        z.react('heavy', 1, dx, dz); res = 'hit';         // placaje: lo echa atrás tambaleándose (ya no se caen)
      } else {
        let dmg = U.lerp(w.dmg[0], w.dmg[1], Math.random()) * a.g.dmg * G.Weapons.matMul(w) * 1.35;
        let crit = Math.random() < w.crit[0] + 0.1;
        if (crit) dmg *= w.crit[1];
        // con cuchillo se clava en la cabeza: casi siempre mata
        if (w.cat === 'sblade' && Math.random() < 0.6) { dmg = 99; crit = true; }
        dmg = Math.max(dmg, MELEE_MIN);
        // ataque en carrera: el arma baja desde arriba, a la cabeza
        res = z.takeHit(dmg, Math.max(0, w.knock + a.g.knock) + 0.5, dx, dz, behind, 1, 'heavy', 'head');
        if (this.onHit) this.onHit(res, crit);
        this.hitStop = 0.11;
        this.wear(player, w);
      }
      if (G.Camera.hitFx) G.Camera.hitFx(1, 1);
      else if (G.Camera.shake) G.Camera.shake(0.24);
      G.World.emit(player.pos.x, player.pos.z, 6 * player.noiseMul, player.lv);
    },

    // Culatazo con un arma de fuego (atacar sin apuntar)
    startBash(player, zombies, camYaw) {
      const face = this.aimYaw(player, zombies, camYaw);
      player.action = { kind: 'bash', t: 0, dur: 0.62, face, done: false, weapon: player.weapon };
      player.stamina = Math.max(0, player.stamina - player.weapon.stam);
    },

    resolveBash(player, zombies) {
      const w = player.weapon;
      const targets = this.inFront(player, zombies, 1.15, 0.9, (z) => z.standing);
      if (!targets.length) { this.hitWindow(player); G.World.emit(player.pos.x, player.pos.z, 2 * player.noiseMul, player.lv); return; }
      const { z } = targets[0];
      const dx = z.pos.x - player.pos.x, dz = z.pos.z - player.pos.z;
      const behind = this.behind(player, z);
      const res = z.takeHit(U.lerp(w.bash[0], w.bash[1], Math.random()), 0.35 + (behind ? 0.2 : 0), dx, dz, behind, 1, 'push');
      if (this.onHit) this.onHit(res, false);
      if (G.Camera.hitFx) G.Camera.hitFx(0.55, 1);
      else if (G.Camera.shake) G.Camera.shake(0.12);
      G.World.emit(player.pos.x, player.pos.z, 3 * player.noiseMul, player.lv);
    },

    startAttack(player, zombies, camYaw, combo) {
      combo = combo || 0;
      const w = player.weapon;
      const mt = this.meleeTarget(player, zombies, this.camYaw != null ? this.camYaw : camYaw, this.input);
      const face = mt ? mt.yaw : this.aimYaw(player, zombies, camYaw);
      player.facing = U.turnToward(player.facing, face, 1.2);
      const tired = player.stamina < 0.25;
      // ¿hay alguien de pie delante? si no, y hay uno caído, golpe al suelo
      const tmp = { pos: player.pos, facing: face };
      const standing = this.inFront(tmp, zombies, w.range + 0.3, 0.9, (z) => z.standing);
      // para el remate basta con estar cerca: el personaje se acerca solo
      const down = this.inFront(tmp, zombies, w.range + 1.0, 1.0, (z) => z.downed);
      const floor = !standing.length && down.length > 0;
      const two = player.twoHanded;
      const g = G.Weapons.grip(w, two);
      if (floor) {
        // remate: te arrodillas junto al torso del zombi caído (con cámara de cine)
        const z = down[0].z;
        if (z.state === 'down') z.timer = Math.max(z.timer, 1.6);   // que no se levante a mitad del remate
        const d = z.fallDir || -1;
        // eje del cuerpo tumbado (de los pies a la cabeza) y un lado del torso
        const ax = Math.sin(z.facing) * d, az = Math.cos(z.facing) * d;
        const tx = z.pos.x + ax * 1.0, tz = z.pos.z + az * 1.0;            // torso
        const hx = z.pos.x + ax * 1.4, hz = z.pos.z + az * 1.4;            // pecho y cabeza
        const side = ((player.pos.x - tx) * az - (player.pos.z - tz) * ax) >= 0 ? 1 : -1;
        const gx = tx + az * 0.72 * side, gz = tz - ax * 0.72 * side;
        const free = !G.World.circleBlocked(gx, gz, 0.28, player.lv) && G.World.hasLOS(player.pos.x, player.pos.z, gx, gz, player.lv);
        const goto = free ? { x: gx, z: gz } : null;
        const fx = goto ? gx : player.pos.x, fz = goto ? gz : player.pos.z;
        player.action = {
          kind: 'finisher', t: 0, dur: Math.max(1.15, w.speed * 1.35), impact: 0.54,
          face: Math.atan2(hx - fx, hz - fz), goto, floor: true, target: z,
          done: false, weapon: w, two, g
        };
        player.stamina = Math.max(0, player.stamina - w.stam);
        return;
      }
      const chain = this.comboFor(w, two);
      const heavy = combo === 2;
      const durMul = combo === 1 ? 0.9 : (heavy ? 1.15 : 1);
      // paso adelante hacia el objetivo si está un poco lejos
      let step = null;
      if (mt) {
        const want = mt.d - w.range * 0.75;
        if (want > 0.05) step = { len: Math.min(1.25, want), done: 0 };
      }
      player.action = {
        kind: chain[combo], t: 0, dur: w.speed * g.speed * ANIM * durMul * (tired ? 1.35 : 1),
        face, floor, done: false, weapon: w, two, g, combo, heavy, step,
        side: (combo === 1) ? -1 : 1
      };
      player.stamina = Math.max(0, player.stamina - w.stam * (heavy ? 1.3 : 1));
    },

    // Esquiva rápida hacia donde empujes (o hacia atrás), con unos instantes de invulnerabilidad
    startDodge(player, input, camYaw) {
      if (player.dead || player.climb || player.prone || player.dodging) return;
      if (player.action && (player.action.kind === 'finisher' || player.action.kind === 'grab' || player.action.t < 0.5)) return;
      if (player.blow && player.blow.t < 0.35) return;
      if (player.stamina < 0.08) return;
      let mx = input.move.x, my = input.move.y;
      if (Math.hypot(mx, my) < 0.2) { mx = 0; my = 1; }        // sin dirección: hacia atrás
      const f = { x: Math.sin(camYaw), z: Math.cos(camYaw) }, r = { x: -Math.cos(camYaw), z: Math.sin(camYaw) };
      let dx = f.x * -my + r.x * mx, dz = f.z * -my + r.z * mx;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      player.action = null;
      player.dodging = { t: 0, dur: 0.45, dx, dz, rel: U.angleDiff(Math.atan2(dx, dz), player.facing) };
      player.stamina = Math.max(0, player.stamina - 0.1);
      if (player.stance !== 'stand') player.stance = 'stand';
    },

    startShove(player, zombies, camYaw) {
      const face = this.aimYaw(player, zombies, camYaw);
      const tmp = { pos: player.pos, facing: face };
      const standing = this.inFront(tmp, zombies, 1.0, 0.9, (z) => z.standing);
      const down = this.inFront(tmp, zombies, 1.4, 1.0, (z) => z.downed);
      const stomp = !standing.length && down.length > 0;
      player.action = { kind: stomp ? 'stomp' : 'shove', t: 0, dur: stomp ? 0.68 : 0.5, face, done: false };
      player.stamina = Math.max(0, player.stamina - (stomp ? 0.04 : 0.035));
    },

    // Puñetazos: con las manos libres, atacar lanza el combo (empujar sigue en su botón).
    // Si delante solo hay un zombi caído, el primer golpe es un pisotón.
    startPunch(player, zombies, camYaw, combo) {
      combo = combo || 0;
      const mt = this.meleeTarget(player, zombies, this.camYaw != null ? this.camYaw : camYaw, this.input);
      const face = mt ? mt.yaw : this.aimYaw(player, zombies, camYaw);
      const tmp = { pos: player.pos, facing: face };
      const standing = mt ? [mt] : this.inFront(tmp, zombies, 1.25, 0.9, (z) => z.standing);
      const down = this.inFront(tmp, zombies, 1.4, 1.0, (z) => z.downed);
      if (!standing.length && down.length) { this.startShove(player, zombies, camYaw); return; }
      const P = PUNCH[combo];
      const tired = player.stamina < 0.25;
      if (player.stance === 'crouch') player.setStance('stand');      // se pega de pie
      // paso hacia el objetivo (se lanza hacia él si está a un par de metros)
      let step = null;
      if (mt) {
        const want = mt.d - 0.72;
        if (want > 0.05) step = { len: Math.min(1.25, want), done: 0 };
      }
      player.facing = U.turnToward(player.facing, face, 1.2);
      player.action = {
        kind: P.kind, t: 0, dur: P.dur * (tired ? 1.25 : 1), impact: P.impact, face, done: false,
        weapon: player.weapon, combo, heavy: combo === 2, step, side: P.side, punch: P, two: false, target: mt ? mt.z : null
      };
      player.stamina = Math.max(0, player.stamina - (combo === 2 ? 0.05 : 0.03));
    },

    resolvePunch(player, zombies, a) {
      const P = a.punch;
      const targets = this.inFront(player, zombies, 1.2, 0.85, (z) => z.standing || z.state === 'rise');
      this.preferTarget(targets, a.target);
      if (!targets.length) {
        if (this.hitWindow(player) && G.Camera.hitFx) G.Camera.hitFx(0.5, P.side);
        G.World.emit(player.pos.x, player.pos.z, 1.5 * player.noiseMul, player.lv);
        return;
      }
      const { z } = targets[0];
      const tired = player.stamina < 0.25;
      if (Math.random() > 0.93 - (tired ? 0.12 : 0)) { G.World.emit(player.pos.x, player.pos.z, 1.5 * player.noiseMul, player.lv); return; }
      const behind = this.behind(player, z);
      const counter = z.exposed && z.state === 'recover';
      let dmg = U.lerp(P.dmg[0], P.dmg[1], Math.random()) * (tired ? 0.75 : 1) * (counter ? 1.3 : 1);
      const crit = Math.random() < (a.heavy ? 0.15 : 0.06);
      if (crit) dmg *= 1.8;
      const dx = z.pos.x - player.pos.x, dz = z.pos.z - player.pos.z;
      const hr = HIT_REACT[a.kind] || ['side', 1];
      const res = z.takeHit(dmg, P.knock + (crit ? 0.2 : 0) + (counter ? 0.25 : 0), dx, dz, behind, hr[1], hr[0]);
      if (this.onHit) this.onHit(res, crit);
      this.hitStop = a.heavy ? 0.12 : 0.06;
      if (G.Camera.hitFx) G.Camera.hitFx(a.heavy ? 1 : 0.55, P.side);
      else if (G.Camera.shake) G.Camera.shake(a.heavy ? 0.22 : 0.12);
      G.World.emit(player.pos.x, player.pos.z, 3.5 * player.noiseMul, player.lv);
    },

    // ---------- Resolución ----------
    update(dt, player, zombies) {
      this.updateStruggle(dt, player);
      const a = player.action;
      if (a) {
        a.t += dt / a.dur;
        if (a.exec) this.updateExecution(dt, player, a);
        if (!a.done && a.t >= (a.impact || IMPACT)) {
          a.done = true;
          if (a.kind === 'shove') this.resolveShove(player, zombies);
          else if (a.kind === 'stomp') this.resolveStomp(player, zombies);
          else if (a.kind === 'bash') this.resolveBash(player, zombies);
          else if (a.kind === 'runatk' || a.kind === 'runshove') this.resolveRunAttack(player, zombies, a);
          else if (a.kind === 'grab') this.resolveGrab(player, a);
          else if (a.kind === 'search') { const m = G.Interact.finishSearch(player, a.target); if (m) this.msg(m, 'good'); }
          else if (a.kind === 'bandage') { const m = player.finishBandage(a.item); if (m) this.msg(m, 'good'); }
          else if (a.kind === 'pack') { /* mochila abierta: no termina sola */ }
          else if (a.exec) this.resolveExecution(player, a);
          else if (a.kind === 'shoveoff') { /* nada que resolver */ }
          else if (a.kind === 'pickup' || a.kind === 'pickupHi') { if (G.Pickups) G.Pickups.collect(player, a); }
          else if (a.kind === 'throw') { if (G.Pickups) G.Pickups.release(player, a); }
          else if (a.punch) this.resolvePunch(player, zombies, a);
          else this.resolveSwing(player, zombies, a);
        }
        // el siguiente golpe del combo sale al final de este (cortando la recuperación)
        if (a.queued && a.t >= (a.punch ? a.punch.next : 0.72) && COMBO_KINDS[a.kind]) {
          const next = ((a.combo || 0) + 1) % 3;
          player.action = null;
          if (a.punch) this.startPunch(player, zombies, a.face, next);
          else this.startAttack(player, zombies, a.face, next);
        } else if (a.t >= 1) player.action = null;
        // si el agarre se corta (te muerden, mueres...), el zombi se suelta
        if (a.kind === 'grab' && player.action !== a && !a.done && a.target.state === 'grabbed') a.target.release();
      }

      // Agarrado por varios a la vez: te derriban
      if (!player.dead) {
        let n = 0;
        for (const z of zombies) {
          if ((z.state === 'attack' || z.state === 'recover') && Math.hypot(z.pos.x - player.pos.x, z.pos.z - player.pos.z) < 1.15) n++;
        }
        if (n >= 4) this.dragT += dt; else this.dragT = Math.max(0, this.dragT - dt * 2);
        if (this.dragT > 2.2) player.die('Te rodearon y te derribaron.');
      } else this.dragT = 0;
    },

    resolveGrab(player, a) {
      const z = a.target;
      if (!z || !z.alive || z.state !== 'grabbed') return;
      z.die(1);                                     // cae boca abajo, hacia delante
      z.killedBy = 'stealth';
      if (this.stats) this.stats.stealth++;
      if (this.onHit) this.onHit('kill', true);
      G.World.emit(player.pos.x, player.pos.z, (a.knife ? 1.5 : 2.5) * player.noiseMul, player.lv);
      if (G.Mode && G.Mode.bark) G.Mode.bark('stealth');
    },

    // el zombi elegido al empezar el golpe va primero (si sigue al alcance)
    preferTarget(list, z) {
      if (!z) return;
      const i = list.findIndex((t) => t.z === z);
      if (i > 0) list.unshift(list.splice(i, 1)[0]);
    },

    behind(player, z) {
      // el jugador está detrás del zombi si el zombi mira hacia el otro lado
      const toPlayer = Math.atan2(player.pos.x - z.pos.x, player.pos.z - z.pos.z);
      return Math.abs(U.angleDiff(toPlayer, z.facing)) > 2.0;
    },

    resolveSwing(player, zombies, a) {
      const w = a.weapon;
      const tired = player.stamina < 0.25;
      const targets = a.kind === 'finisher'
        ? (a.target && a.target.alive && a.target.downed ? [{ z: a.target, d: 1, a: 0 }] : [])
        : a.floor
        ? this.inFront(player, zombies, w.range + 0.35, 1.0, (z) => z.downed)
        : this.inFront(player, zombies, w.range + 0.25, a.two ? 1.05 : 0.8, (z) => z.standing || z.state === 'rise');
      if (!a.floor && a.kind !== 'finisher') this.preferTarget(targets, a.target);
      if (!targets.length) {
        if (!a.floor && a.kind !== 'finisher' && this.hitWindow(player)) this.wear(player, w);
        G.World.emit(player.pos.x, player.pos.z, 2.5 * player.noiseMul, player.lv);
        return;
      }
      const base = { sblade: 0.92, sblunt: 0.88, lblunt: 0.85, axe: 0.85, lblade: 0.88, spear: 0.88 }[w.cat] || 0.85;
      let landed = 0;
      // un arma de dos manos usada con una sola solo alcanza a un zombi
      const n = a.floor ? 1 : Math.min(a.two ? w.hits : 1, targets.length);
      for (let i = 0; i < n; i++) {
        const { z } = targets[i];
        let chance = base + a.g.acc - (tired ? 0.15 : 0) - (player.moveAmt > 0.3 ? 0.08 : 0) - i * 0.1;
        if (a.floor) chance += 0.08;
        if (a.kind === 'finisher') chance = 0.97;
        if (Math.random() > chance) continue;
        landed++;
        const behind = this.behind(player, z);
        // contraataque: el zombi que falló al esquivarlo está vendido
        const counter = z.exposed && z.state === 'recover';
        let dmg = U.lerp(w.dmg[0], w.dmg[1], Math.random()) * a.g.dmg * G.Weapons.matMul(w) * (i > 0 ? 0.6 : 1) * (tired ? 0.75 : 1) * (a.heavy ? 1.25 : 1) * (counter ? 1.2 : 1);
        let crit = Math.random() < w.crit[0] + (behind ? 0.1 : 0);
        if (crit) dmg *= w.crit[1];
        if (a.floor) dmg *= a.kind === 'finisher' ? 3.5 : 2;   // el remate va a la cabeza
        // los cuchillos rematan por la espalda o en el suelo
        if (w.cat === 'sblade' && (a.floor || behind) && Math.random() < 0.4) { dmg = 99; crit = true; }
        if (!a.floor && i === 0) dmg = Math.max(dmg, MELEE_MIN);
        const dx = z.pos.x - player.pos.x, dz = z.pos.z - player.pos.z;
        const hr = HIT_REACT[a.kind] || ['side', a.side || 1, 'body'];
        // el tercer golpe del combo (el fuerte, de arriba abajo) va a la cabeza; los demás, al cuerpo
        const part = a.kind === 'finisher' || a.floor || a.heavy ? 'head' : 'body';
        const res = z.takeHit(dmg, Math.max(0, w.knock + a.g.knock) + (crit ? 0.25 : 0) + (a.heavy ? 0.2 : 0) + (counter ? 0.25 : 0), dx, dz, behind, hr[1], hr[0], i === 0 ? part : 'body');
        if (this.onHit) this.onHit(res, crit);
      }
      if (landed) {
        // parón breve y sacudida de cámara: el golpe se siente
        this.hitStop = a.heavy || a.kind === 'finisher' ? 0.11 : 0.065;
        if (G.Camera.hitFx) G.Camera.hitFx(a.heavy || a.kind === 'finisher' ? 1 : 0.6, a.kind === 'swing2b' || a.kind === 'slash' || a.kind === 'swing1b' ? -1 : 1);
        else if (G.Camera.shake) G.Camera.shake(a.heavy || a.kind === 'finisher' ? 0.22 : 0.12);
        G.World.emit(player.pos.x, player.pos.z, 6 * player.noiseMul, player.lv);
        this.wear(player, w);
      } else G.World.emit(player.pos.x, player.pos.z, 2.5 * player.noiseMul, player.lv);
    },

    wear(player, w) {
      const slot = player.slot;
      if (!slot) return;
      if (Math.random() < 1 / w.lower) {
        slot.cond -= 1 / (w.cond * G.Weapons.DURABILITY);
        if (slot.cond <= 0.001) {
          this.msg('Se rompió: ' + w.name, 'bad');
          player.breakCurrent();
        }
      }
    },

    // Golpe al aire delante de una ventana: si está cerrada se rompe; si está rota, quita los vidrios
    hitWindow(player) {
      const W = G.World, E = W.E;
      const fx = Math.sin(player.facing), fz = Math.cos(player.facing);
      const x0 = player.pos.x, z0 = player.pos.z, x1 = x0 + fx * 0.85, z1 = z0 + fz * 0.85;
      const f = W.lineHit(x0, z0, x1, z1, (e) => e === E.WIN || e === E.WIN_BROKEN, player.lv);
      if (f < 0) return false;
      const ref = W.edgeAt(x0 + (x1 - x0) * f, z0 + (z1 - z0) * f, fx, fz, player.lv);
      if (!ref) return false;
      const e = W.edgeGet(ref);
      if (e === E.WIN) { W.shatter(ref); this.msg('Rompiste la ventana (hay vidrios en el marco)', 'warn'); if (G.Camera.shake) G.Camera.shake(0.1); return true; }
      if (e === E.WIN_BROKEN && W.hasGlass(ref)) {
        W.clearGlass(ref);
        W.emit(player.pos.x, player.pos.z, 4 * player.noiseMul, player.lv);
        this.msg('Quitaste los vidrios del marco');
        return true;
      }
      return false;
    },

    resolveShove(player, zombies) {
      const targets = this.inFront(player, zombies, 1.05, 0.9, (z) => z.standing);
      if (!targets.length && this.hitWindow(player)) return;     // codazo al vidrio
      for (let i = 0; i < Math.min(2, targets.length); i++) {
        const { z } = targets[i];
        const behind = this.behind(player, z);
        const dx = z.pos.x - player.pos.x, dz = z.pos.z - player.pos.z;
        // tras un empujón tarda 2 segundos más en levantarse
        if (Math.random() < (behind ? 0.75 : 0.35)) z.knockDown(behind ? 1 : -1, dx, dz, 2);
        else z.doStagger(dx, dz, 2.6);
        if (this.onHit) this.onHit('shove', false);
      }
      if (targets.length && G.Camera.hitFx) G.Camera.hitFx(0.4, 1);
      G.World.emit(player.pos.x, player.pos.z, 2 * player.noiseMul, player.lv);
    },

    resolveStomp(player, zombies) {
      const targets = this.inFront(player, zombies, 1.4, 1.0, (z) => z.downed);
      if (!targets.length) return;
      const { z } = targets[0];
      let dmg = U.lerp(0.45, 0.95, Math.random());
      const crit = Math.random() < 0.18;
      if (crit) dmg *= 3;
      const res = z.takeHit(dmg, 0, 0, 0, false);
      if (this.onHit) this.onHit(res, crit);
      if (G.Camera.hitFx) G.Camera.hitFx(0.6, 1);
      G.World.emit(player.pos.x, player.pos.z, 3 * player.noiseMul, player.lv);
    },

    // Un zombi termina su intento de agarrar al jugador
    zombieStrike(z, player, dist) {
      if (player.dead) return false;
      // esquivado justo a tiempo: se pasa de largo y queda aturdido
      if ((player.dodging && player.dodging.t < 0.75) || (player.dodgeAfter > 0 && dist < 2.8)) { z.overextended = true; return false; }
      if (dist > (z.blind ? 1.5 : 1.38) || player.climb) return false;
      if ((z.lv || 0) !== (player.lv || 0) && !G.World.stairAt(player.pos.x, player.pos.z)) return false;
      if (!G.World.hasLOS(z.pos.x, z.pos.z, player.pos.x, player.pos.z, z.lv)) return false;
      let n = 0;
      for (const o of G.Population.list) {
        if ((o.state === 'attack' || o.state === 'recover' || o.state === 'grapple') && Math.hypot(o.pos.x - player.pos.x, o.pos.z - player.pos.z) < 1.4) n++;
      }
      const toZ = Math.atan2(z.pos.x - player.pos.x, z.pos.z - player.pos.z);
      const behind = Math.abs(U.angleDiff(toZ, player.facing)) > 1.9;
      const chance = 0.64 + (behind ? 0.25 : 0) + 0.06 * Math.max(0, n - 1) + (player.prone ? 0.2 : 0);
      if (Math.random() > chance) return false;
      // te agarra: forcejeo (si ya estás forcejeando o rematando, solo te araña)
      const busy = player.struggle || (player.action && player.action.exec);
      if (!busy) { this.startStruggle(player, z); return true; }
      player.damage(z.blind ? 16 : 8, z.blind ? 'Un ciego te despedazó.' : 'Te alcanzaron los infectados.');
      if (player.takeBlow) player.takeBlow(z, 'rasguño');
      if (this.stats) this.stats.hurt += z.blind ? 16 : 8;
      this.msg('Te arañó', 'warn');
      return true;
    },

    // ---------- Forcejeo: te agarran y tienes que pulsar atacar sin parar para soltarte ----------
    startStruggle(player, z) {
      player.action = null; player.dodging = null;
      if (player.gun) { player.gun.reload = null; }
      if (G.Input && G.Input.setAim) G.Input.setAim(false);
      player.struggle = { z, t: 0, dur: z.blind ? 1.7 : 2.1, need: z.blind ? 9 : 5, n: 0, prog: 0 };
      player.facing = Math.atan2(z.pos.x - player.pos.x, z.pos.z - player.pos.z);
      z.startGrapple();
      if (G.Camera.shake) G.Camera.shake(0.25);
      this.msg(G.Input.isTouch ? '¡Te agarró! Toca Atacar sin parar' : '¡Te agarró! Pulsa Atacar sin parar', 'bad');
    },

    updateStruggle(dt, player) {
      const st = player.struggle;
      if (!st) return;
      st.t += dt;
      st.prog = Math.min(1, st.n / st.need);
      const z = st.z;
      if (!z.alive || player.dead || z.state !== 'grapple') { player.struggle = null; return; }
      if (st.n >= st.need) {
        // ¡fuera! lo empuja y queda aturdido (listo para rematarlo)
        player.struggle = null;
        const dx = z.pos.x - player.pos.x, dz = z.pos.z - player.pos.z;
        z.stun(z.blind ? 1.4 : 1.9, dx, dz, 2.8);
        player.action = { kind: 'shoveoff', t: 0, dur: 0.45, impact: 0.35, face: Math.atan2(dx, dz), done: true };
        if (G.Camera.hitFx) G.Camera.hitFx(0.6, 1);
        if (this.stats) this.stats.escapes++;
        this.msg('¡Te soltaste! Remátalo', 'good');
        if (G.Mode && G.Mode.bark) G.Mode.bark('free');
      } else if (st.t >= st.dur) {
        // no te soltaste a tiempo: te muerde
        player.struggle = null;
        const dmg = z.blind ? 62 : 30;
        player.damage(dmg, z.blind ? 'Un ciego te atrapó.' : 'Te mordieron.');
        player.bleed = Math.max(player.bleed, 18); player.bleedRate = Math.max(player.bleedRate, 0.35);
        player.infect();                       // en el modo Asalto no infecta (solo daño)
        if (G.Mode && G.Mode.bark) G.Mode.bark('hurt');
        if (player.takeBlow) player.takeBlow(z, 'mordisco');
        if (this.stats) this.stats.hurt += dmg;
        z.enter('recover', 0.9); z.reach = 0.6;
        if (G.Camera.shake) G.Camera.shake(0.55);
        this.msg(z.blind ? '¡Te mordió un ciego!' : '¡Te mordió!', 'bad');
        if (player.health <= 0 && !player.dead) player.die(z.blind ? 'Un ciego te atrapó.' : 'Te mordieron.');
      }
    },

    // ---------- Remates: un infectado aturdido muere de un golpe ----------
    execTarget(player, zombies) {
      let best = null, bd = 1.95;
      for (const z of zombies) {
        if (!z.alive || z.state !== 'stun' || (z.lv || 0) !== (player.lv || 0)) continue;
        const d = Math.hypot(z.pos.x - player.pos.x, z.pos.z - player.pos.z);
        if (d < bd && G.World.hasLOS(player.pos.x, player.pos.z, z.pos.x, z.pos.z, player.lv)) { bd = d; best = z; }
      }
      return best;
    },

    // Con la navaja: si cerca del infectado hay una pared, una valla o un mueble alto, le estampa la cabeza
    // contra él; si no, le clava la navaja en el cuello. Con otra arma, un golpe brutal a la cabeza
    startExecution(player, z) {
      const W = G.World, gun = G.Weapons.isGun(player.weapon);
      const w = gun ? G.Weapons.KNIFE : player.weapon;     // con pistola o rifle en la mano, remata con la navaja
      const px = player.pos.x, pz = player.pos.z;
      let dx = z.pos.x - px, dz = z.pos.z - pz;
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      let kind = w.knife ? 'execKnife' : 'execHeavy', wall = null;
      if (w.knife) {
        let bestS = -9;
        const a0 = Math.atan2(dx, dz);
        for (let k = 0; k < 9; k++) {
          const a = a0 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 8);
          const ux = Math.sin(a), uz = Math.cos(a);
          const d = surfaceHit(z.pos.x, z.pos.z, ux, uz, 1.3, z.lv || 0);
          if (d == null) continue;
          const sc = ux * dx + uz * dz - d * 0.35;
          if (sc > bestS) { bestS = sc; wall = { ux, uz, d }; }
        }
        if (wall && bestS > -0.35) kind = 'execSlam'; else wall = null;
      }
      const D = { execKnife: [1.25, 0.72, [0.25, 0.48]], execSlam: [1.35, 0.68, [0.42]], execHeavy: [0.95, 0.47, []] }[kind];
      let zx = z.pos.x, zz = z.pos.z, fx = dx, fz = dz;
      // contra la pared: queda a medio metro de ella (al inclinarse, la cabeza llega justo a la superficie)
      if (wall) { const k = Math.max(-0.3, wall.d - 0.5); zx += wall.ux * k; zz += wall.uz * k; fx = wall.ux; fz = wall.uz; }
      // distancia entre los dos: con la navaja, cara a cara; contra la pared, pegada a su espalda; con un arma, más
      const gap = { execKnife: 0.68, execSlam: 0.52, execHeavy: 0.85 }[kind];
      const pTo = { x: zx - fx * gap, z: zz - fz * gap };
      if (W.circleBlocked(pTo.x, pTo.z, 0.24, player.lv)) { pTo.x = px; pTo.z = pz; }
      player.action = {
        kind, t: 0, dur: D[0], impact: D[1], hits: D[2], hd: {}, face: Math.atan2(fx, fz), target: z, exec: true, cine: true, done: false,
        from: { x: px, z: pz }, pTo, zFrom: { x: z.pos.x, z: z.pos.z }, zTo: { x: zx, z: zz },
        zFace: kind === 'execSlam' ? Math.atan2(fx, fz) : Math.atan2(-fx, -fz), weapon: w, two: gun ? false : player.twoHanded, g: G.Weapons.grip(w),
        knifeSwap: gun
      };
      if (gun) { player.gun.reload = null; player.gun.cycle = null; player.gun.aim = 0; }
      z.hold(kind);
      if (player.stance !== 'stand') player.stance = 'stand';
    },

    updateExecution(dt, player, a) {
      const z = a.target;
      const k = U.smooth(Math.min(1, a.t / 0.22));
      if (z && z.state === 'held') {
        z.pos.x = U.lerp(a.zFrom.x, a.zTo.x, k); z.pos.z = U.lerp(a.zFrom.z, a.zTo.z, k);
        z.facing = U.turnToward(z.facing, a.zFace, dt * 12);
      }
      player.pos.x = U.lerp(a.from.x, a.pTo.x, k); player.pos.z = U.lerp(a.from.z, a.pTo.z, k);
      for (const ht of a.hits) {
        if (a.hd[ht] || a.t < ht) continue;
        a.hd[ht] = 1;
        this.bloodAt(z, 6);
        if (G.Camera.hitFx) G.Camera.hitFx(0.5, a.kind === 'execSlam' ? -1 : 1);
        this.hitStop = 0.05;
      }
    },

    resolveExecution(player, a) {
      const z = a.target;
      if (!z || !z.alive) return;
      const dir = a.kind === 'execSlam' ? 1 : -1;
      z.die(dir);
      z.killedBy = 'exec';
      this.bloodAt(z, 12);
      if (this.onHit) this.onHit('kill', true);
      if (this.stats) this.stats.exec++;
      this.hitStop = 0.12;
      if (G.Camera.hitFx) G.Camera.hitFx(1, a.kind === 'execSlam' ? -1 : 1);
      G.World.emit(player.pos.x, player.pos.z, 4 * player.noiseMul, player.lv);
      if (a.kind === 'execHeavy') this.wear(player, a.weapon);
      if (G.Mode && G.Mode.bark) G.Mode.bark('kill');
    },

    // salpicadura de sangre a la altura de la cabeza del infectado
    bloodAt(z, n) {
      if (!G.Guns || !G.Guns.burst || !z.model) return;
      const h = z.model;
      h.head.updateWorldMatrix(true, false);
      const p = h.head.getWorldPosition(new THREE.Vector3());
      p.y -= 0.06;
      const d = new THREE.Vector3(Math.sin(z.facing + Math.PI), 0.2, Math.cos(z.facing + Math.PI));
      G.Guns.burst(p, d, true, n);
      if (G.Guns.decal && n >= 10) G.Guns.decal(z.pos.x + d.x * 0.3, z.pos.z + d.z * 0.3, 0.38, z.lv || 0);
    }
  };

  G.Combat = Combat;
})(window.Game = window.Game || {});
