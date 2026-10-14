(function (G) {
  'use strict';

  // Cámara en tercera persona sobre el hombro. Se acerca al apuntar y se
  // pega al personaje cuando hay paredes, techos o árboles detrás.

  const U = G.Util;
  // Encuadre medido en el vídeo de referencia (números propios):
  // - explorando: la cámara va a la altura de su cabeza, unos 2 m detrás y algo a la derecha, mirando
  //   hacia abajo (unos 19°); se la ve de cuerpo entero en el tercio izquierdo, con mucho suelo delante
  // - apuntando: pegada al hombro derecho (la cabeza queda abajo a la izquierda) y recta
  // - peleando cuerpo a cuerpo: más cerca y más baja, de la cadera para arriba
  const PIVOT = 0.95, PIVOT_AIM = 1.5, PIVOT_FIGHT = 1.15;
  const DIST = 2.25, DIST_AIM = 0.8;
  const SHOULDER = 0.55, SHOULDER_AIM = 0.42;
  const TILT = 0.24;             // inclinación extra hacia abajo al explorar (al apuntar desaparece)
  // zoom dinámico: corriendo se aleja, abre el campo de visión y se mece con la zancada; con zombis cerca
  // se cierra un poco; quieto, se acerca despacio
  const RUN_OUT = 0.32, RUN_FOV = 6, TENSE_IN = 0.06, TENSE_FOV = -2, IDLE_IN = 0.06, FIGHT_FOV = -3;
  const PITCH_MIN = -0.45, PITCH_MAX = 1.05;
  // pelea cuerpo a cuerpo: la cámara se acerca y baja un poco, y acompaña cada golpe
  const DIST_FIGHT = 1.6, SHOULDER_FIGHT = 0.5;
  // planos de cine: giro respecto a la espalda, distancia, cabeceo, altura y cuánto se centra en el infectado
  const CINE = {
    grab: { yaw: 1.35, dist: 1.45, pitch: 0.1, piv: 1.28, mid: 0.5 },     // forcejeo: de lado, cerca, las dos caras
    exec: { yaw: 1.05, dist: 1.6, pitch: 0.16, piv: 1.2, mid: 0.5 },      // remate: de tres cuartos, cerca
    floor: { yaw: 0.95, dist: 2.6, pitch: 0.42, piv: 1.3, mid: 0 }        // remate en el suelo
  };

  // Coreografía de cámara por golpe (inspirada en las peleas de los juegos de referencia, con números propios).
  // Claves: [t, giro, acercar, alabeo, altura, cabeceo]. giro > 0: la cámara rodea hacia el hombro derecho;
  // acercar en metros; alabeo en radianes (> 0 inclina a la izquierda); cabeceo > 0 mira más abajo.
  // Patrón: en la carga la cámara se va hacia el lado del brazo que golpea; en el impacto da un latigazo
  // hacia el otro lado siguiendo el puño (o el arma), se mete encima y vuelve sola. En el golpe fuerte
  // se abre a tres cuartos mientras el personaje se agacha y vuelve a la espalda justo antes de pegar.
  const K0 = [0, 0, 0, 0, 0, 0], K1 = [1, 0, 0, 0, 0, 0];
  const mirror = (keys) => keys.map((k) => [k[0], -k[1], k[2], -k[3], k[4], k[5]]);
  const CHOREO = {
    punch1: [K0, [0.3, 0.17, 0.2, 0.015, -0.02, 0], [0.42, -0.1, 0.38, -0.04, -0.02, 0.02], [0.6, -0.14, 0.26, -0.02, 0, 0], K1],
    punch3: [K0, [0.3, 0.42, 0.18, 0.03, -0.15, -0.04], [0.44, 0.28, 0.26, 0.0, -0.07, 0], [0.52, -0.15, 0.52, -0.06, -0.02, 0.05],
      [0.72, -0.12, 0.4, -0.03, -0.06, 0.1], K1],
    swing2: [K0, [0.3, 0.22, 0.14, 0.02, 0, 0], [0.45, -0.14, 0.36, -0.04, 0, 0.02], [0.66, -0.16, 0.2, -0.02, 0, 0], K1],
    swing1: [K0, [0.3, 0.08, -0.05, 0.01, 0.06, -0.04], [0.45, -0.03, 0.32, -0.02, -0.04, 0.08], [0.7, 0, 0.18, 0, 0, 0.04], K1],
    overhead: [K0, [0.36, 0.1, -0.15, 0.02, 0.1, -0.06], [0.47, -0.04, 0.46, -0.03, -0.06, 0.12], [0.7, 0, 0.3, 0, -0.03, 0.06], K1],
    stab: [K0, [0.3, 0.05, 0.1, 0, 0, 0], [0.45, -0.03, 0.34, -0.02, 0, 0.03], K1],
    shove: [K0, [0.3, 0, 0.06, 0, 0, 0], [0.45, 0, 0.3, 0, 0, 0.02], K1],
    stomp: [K0, [0.3, 0.06, 0, 0, 0.05, 0], [0.45, 0, 0.2, 0, -0.04, 0.13], K1],
    runatk: [K0, [0.24, 0.05, 0.22, 0.02, 0, 0], [0.42, -0.05, 0.52, -0.03, -0.04, 0.06], K1]
  };
  CHOREO.punch2 = mirror(CHOREO.punch1);
  CHOREO.swing2b = mirror(CHOREO.swing2);
  CHOREO.swing1b = mirror(CHOREO.swing1);
  CHOREO.slash = mirror(CHOREO.swing2).map((k) => [k[0], k[1] * 0.6, k[2], k[3] * 0.6, k[4], k[5]]);
  CHOREO.thrust = CHOREO.stab;
  CHOREO.bash = CHOREO.shove;
  CHOREO.runshove = CHOREO.runatk;
  CHOREO.floor = CHOREO.overhead;
  const _ck = [0, 0, 0, 0, 0];
  function choreo(kind, t) {
    const keys = CHOREO[kind];
    for (let i = 0; i < 5; i++) _ck[i] = 0;
    if (!keys) return _ck;
    for (let k = 1; k < keys.length; k++) {
      const b = keys[k];
      if (t <= b[0] || k === keys.length - 1) {
        const a = keys[k - 1];
        const u = U.smooth(U.clamp((t - a[0]) / (b[0] - a[0]), 0, 1));
        for (let i = 0; i < 5; i++) _ck[i] = a[i + 1] + (b[i + 1] - a[i + 1]) * u;
        return _ck;
      }
    }
    return _ck;
  }

  const Cam = {
    yaw: Math.PI,      // mirando hacia -Z al empezar (hacia la puerta de la casa inicial)
    pitch: 0.08,       // el que mueve el jugador (explorando se suma TILT)
    dist: DIST,
    shoulder: SHOULDER,
    camera: null,
    near: false,        // la cámara quedó muy cerca del personaje
    dir: new THREE.Vector3(),
    pos: new THREE.Vector3(),
    roll: 0,
    aimW: 0,
    zoomRun: 0, zoomTense: 0, zoomIdle: 0, idleT: 0,
    fovOff: 0,         // grados que se suman al campo de visión (zoom dinámico)

    init(camera) { this.camera = camera; },

    // Sacudida breve al golpear (se apaga sola)
    shakeAmt: 0,
    shake(a) { this.shakeAmt = Math.max(this.shakeAmt, a); },

    // Retroceso de un disparo: la mira sube; una parte vuelve sola y otra se queda
    kickOff: 0,
    kick(a) {
      this.kickOff -= a * 0.7;
      this.pitch = U.clamp(this.pitch - a * 0.3, PITCH_MIN, PITCH_MAX);
      this.yaw += (Math.random() - 0.5) * a * 0.25;
    },

    // Impacto: sacudida, golpe de zoom, empujón hacia delante y un pequeño alabeo hacia donde va el golpe
    fovKick: 0,
    imp: { push: 0, roll: 0, yaw: 0 },
    hitFx(str, side) {
      side = side || 1;
      this.shake(0.12 + 0.14 * str);
      this.fovKick = Math.max(this.fovKick, 5.5 * str);
      this.imp.push += 0.14 * str;
      this.imp.roll += -0.035 * side * str;
      this.imp.yaw += -0.05 * side * str;
    },
    fight: 0,
    off: [0, 0, 0, 0, 0],      // giro, acercar, alabeo, altura y cabeceo de la coreografía (suavizados)

    forward() { return { x: Math.sin(this.yaw), z: Math.cos(this.yaw) }; },
    right() { return { x: -Math.cos(this.yaw), z: Math.sin(this.yaw) }; },

    update(dt, player, input, sens) {
      sens = sens || 1;
      this.yaw -= input.look.x * sens;
      this.pitch = U.clamp(this.pitch + input.look.y * sens, PITCH_MIN, PITCH_MAX);
      const aiming = player.aiming;
      const act = player.action;

      // Planos de cine: forcejeo (de lado), remates de pie (de tres cuartos, encuadrando a los dos) y el
      // remate en el suelo. Se elige el lado más cercano a donde está la cámara
      let ck = null, tgt = null;
      if (player.struggle) { ck = 'grab'; tgt = player.struggle.z; }
      else if (act && act.cine) { ck = 'exec'; tgt = act.target; }
      else if (act && act.kind === 'finisher') ck = 'floor';
      const cine = !!ck;
      if (cine && (!this.cineOn || ck !== this.cineKind)) {
        const yw = CINE[ck].yaw, a1 = player.facing + yw, a2 = player.facing - yw;
        this.cineSide = Math.abs(U.angleDiff(a1, this.yaw)) < Math.abs(U.angleDiff(a2, this.yaw)) ? yw : -yw;
        this.cineKind = ck;
      }
      this.cineOn = cine;
      if (tgt && tgt.pos) { this.cineTgt = this.cineTgt || { x: 0, z: 0 }; this.cineTgt.x = tgt.pos.x; this.cineTgt.z = tgt.pos.z; }
      this.cine = (this.cine || 0) + ((cine ? 1 : 0) - (this.cine || 0)) * Math.min(1, dt * (cine ? 6 : 3.5));
      const w = U.smooth(this.cine);
      const CP = CINE[this.cineKind || 'floor'];
      // modo pelea: desde el primer golpe y hasta un par de segundos después
      const melee = !!(act && CHOREO[act.kind]);
      const fightOn = (player.fightT != null && player.fightT < 2.4) && !G.Weapons.isGun(player.weapon);
      this.fight += ((fightOn ? 1 : 0) - this.fight) * Math.min(1, dt * (fightOn ? 5 : 1.5));
      const fw = U.smooth(this.fight) * (1 - w);
      // durante el golpe la cámara se coloca a la espalda del personaje (si no la estás moviendo tú)
      const looking = Math.abs(input.look.x) > 0.002;
      if (melee && !cine && !looking) this.yaw += U.angleDiff(player.facing, this.yaw) * Math.min(1, dt * 3.2);
      // coreografía del golpe (se suaviza con un muelle rápido: los cambios bruscos quedan como latigazos)
      const c = melee ? choreo(act.kind, Math.min(1, act.t)) : choreo(null, 0);
      const ks = Math.min(1, dt * 16);
      for (let i = 0; i < 5; i++) this.off[i] += (c[i] - this.off[i]) * ks;
      const im = this.imp, kd = Math.exp(-dt * 9);
      im.push *= kd; im.roll *= kd; im.yaw *= kd;
      this.fovKick *= Math.exp(-dt * 7);
      const o = this.off;

      const yawE = this.yaw + o[0] + im.yaw + U.angleDiff(player.facing + (this.cineSide || 0.95), this.yaw) * w;
      this.kickOff *= Math.exp(-dt * 9);
      this.aimW += ((aiming ? 1 : 0) - this.aimW) * Math.min(1, dt * 8);
      const aw = U.smooth(this.aimW);
      // explorando mira algo hacia abajo; apuntando, recto (la mira va donde tú la pones)
      const tiltE = TILT * (1 - aw) * (1 - 0.55 * fw);
      const pitchE = U.lerp(U.clamp(this.pitch + tiltE + this.kickOff + o[4], PITCH_MIN, PITCH_MAX), CP.pitch, w);
      // zoom dinámico
      const run = player.running && (player.moveAmt || 0) > 0.5;
      this.zoomRun += ((run ? 1 : 0) - this.zoomRun) * Math.min(1, dt * (run ? 1.6 : 2.4));
      let tense = 0;
      const zl = G.Population ? G.Population.list : [];
      for (let i = 0; i < zl.length; i++) {
        const z = zl[i];
        if (!z.alive || !(z.state === 'chase' || z.state === 'attack' || z.state === 'alert')) continue;
        const dd = Math.hypot(z.pos.x - player.pos.x, z.pos.z - player.pos.z);
        if (dd < 10) tense = Math.max(tense, 1 - dd / 10);
      }
      this.zoomTense += (tense - this.zoomTense) * Math.min(1, dt * 1.5);
      const still = (player.moveAmt || 0) < 0.05 && !act && !aiming;
      this.idleT = still ? this.idleT + dt : 0;
      this.zoomIdle += ((this.idleT > 2.5 ? 1 : 0) - this.zoomIdle) * Math.min(1, dt * 0.5);
      const zr = U.smooth(this.zoomRun) * (1 - aw);
      const cr = player.crouchAmt || 0;
      const baseD = U.lerp(DIST, DIST_AIM, aw) + RUN_OUT * zr - TENSE_IN * this.zoomTense * (1 - aw) - IDLE_IN * this.zoomIdle
        - 0.22 * cr * (1 - aw) + Math.sin((player.time || 0) * 0.7) * 0.03 * (1 - aw);
      this.fovOff = RUN_FOV * zr + TENSE_FOV * this.zoomTense * (1 - aw) + FIGHT_FOV * fw;
      const wantD = Math.max(0.6, U.lerp(U.lerp(baseD, DIST_FIGHT, fw * (1 - aw)), CP.dist, w) - o[1] - im.push);
      // corriendo, la cámara se mece con la zancada (arriba y abajo y un leve alabeo)
      const ph = player.phase || 0;
      const bob = Math.abs(Math.sin(ph)) * 0.035 * zr * (1 - w), sway = Math.sin(ph) * 0.006 * zr * (1 - w);
      this.roll = o[2] + im.roll + sway;
      // en cobertura, la cámara se pasa al hombro del lado contrario a la pared (para no meterse en ella)
      const cv = player.cover;
      let side = 1;
      if (cv) {
        const rx = -Math.cos(this.yaw), rz = Math.sin(this.yaw);
        if (-cv.nx * rx - cv.nz * rz > 0.25) side = -1;
      }
      this.side = (this.side == null ? 1 : this.side) + (side - (this.side == null ? 1 : this.side)) * Math.min(1, dt * 6);
      const wantS = U.lerp(U.lerp(U.lerp(SHOULDER, SHOULDER_AIM, aw), SHOULDER_FIGHT, fw * (1 - aw)), 0, w) * this.side;
      this.shoulder += (wantS - this.shoulder) * Math.min(1, dt * 8);

      const f = { x: Math.sin(yawE), z: Math.cos(yawE) }, r = { x: -Math.cos(yawE), z: Math.sin(yawE) };
      const cp = Math.cos(pitchE), sp = Math.sin(pitchE);
      // dirección de la mirada (adelante y un poco hacia abajo)
      this.dir.set(f.x * cp, -sp, f.z * cp);
      const ao = player.aimOut || { x: 0, z: 0 };
      // en los planos de cine el centro se va hacia el infectado (salen los dos)
      const mid = CP.mid * w, ct = this.cineTgt;
      const hx = player.pos.x + ao.x + (ct && mid ? (ct.x - player.pos.x) * mid : 0);
      const hz = player.pos.z + ao.z + (ct && mid ? (ct.z - player.pos.z) * mid : 0);
      let piv = U.lerp(U.lerp(PIVOT, PIVOT_FIGHT, fw), PIVOT_AIM, aw) - 0.32 * cr * (1 - 0.4 * aw);
      piv = U.lerp(piv, 0.5, player.proneAmt || 0);
      piv = U.lerp(piv, CP.piv, w);
      const hy = player.y + piv + o[3] + bob;
      // posición deseada
      const tx = hx + r.x * this.shoulder - this.dir.x * wantD;
      const ty = hy - this.dir.y * wantD + 0.12;
      const tz = hz + r.z * this.shoulder - this.dir.z * wantD;
      // planta para las paredes: la del jugador (en la escalera, la de arriba en cuanto sube un poco)
      const st = G.World.stairAt(hx, hz);
      const lv = st ? (G.World.stairProgress(st, hx, hz) > 0.3 ? 1 : 0) : (player.lv || 0);
      const free = sweep(hx, hy, hz, tx, ty, tz, lv);
      const d = Math.max(0.05, free * wantD);
      if (d < this.dist) this.dist = d;                       // acercarse rápido
      else this.dist += (d - this.dist) * Math.min(1, dt * 5); // alejarse suave
      const k = this.dist / wantD;
      this.pos.set(hx + (tx - hx) * k, hy + (ty - hy) * k, hz + (tz - hz) * k);
      this.camera.position.copy(this.pos);
      this.camera.lookAt(this.pos.x + this.dir.x, this.pos.y + this.dir.y, this.pos.z + this.dir.z);
      if (Math.abs(this.roll) > 1e-4) this.camera.rotateZ(this.roll);
      if (this.shakeAmt > 0.002) {
        const s = this.shakeAmt;
        this.camera.rotation.x += (Math.random() - 0.5) * 0.09 * s;
        this.camera.rotation.y += (Math.random() - 0.5) * 0.09 * s;
        this.camera.position.y += (Math.random() - 0.5) * 0.05 * s;
        this.shakeAmt *= Math.exp(-dt * 14);
      } else this.shakeAmt = 0;
      this.near = this.dist < 0.55;
    }
  };

  // Devuelve la fracción libre (0 a 1) del recorrido cabeza -> cámara
  function sweep(x0, y0, z0, x1, y1, z1, lv) {
    const W = G.World, E = W.E;
    const lvH = lv ? W.FLOOR_H : 0;
    const steps = 32;
    let px = x0, pz = z0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t, z = z0 + (z1 - z0) * t;
      const tx = Math.floor(x), tz = Math.floor(z);
      // suelo de la planta en este punto (base del edificio o terreno)
      const base = W.baseAt(x, z, 0) + lvH;
      const ceil = base + W.WALL_H - 0.18;
      const ptx = Math.floor(px), ptz = Math.floor(pz);
      let hit = false;
      // aristas cruzadas en este paso
      const yl = y - base;
      const test = (e) => {
        if (e === E.NONE) return false;
        if (e === E.FENCE) return yl < W.FENCE_H + 0.1;
        if (e === E.RAIL) return yl < 1.0;
        if (e === E.DOOR_OPEN || e === E.DOOR_BROKEN || e === E.ARCH) return yl > W.DOOR_H - 0.15;
        if (e === E.GATE) return yl > 2.45;
        return true;
      };
      if (tx !== ptx || tz !== ptz) hit = W.lineBlocked(px, pz, x, z, test, lv);
      // techo (sobre la escalera no hay techo hasta la planta de arriba)
      const inside = W.isIndoor(tx, tz, lv);
      const c2 = W.stairAt(x, z) ? base - lvH + W.FLOOR_H + W.WALL_H - 0.18 : ceil;
      if (!hit && inside && y > c2) hit = true;
      if (!hit && lv && !inside && W.isIndoor(ptx, ptz, lv)) hit = true;     // arriba no se sale por las paredes
      if (!hit && W.isIndoor(ptx, ptz, lv) && !inside && yl > W.DOOR_H) hit = true;
      // distancia mínima a paredes y troncos
      if (!hit && yl < W.WALL_H + 0.2 && W.circleBlocked(x, z, 0.16, lv, true)) hit = true;
      // muebles y vehículos: solo si la cámara queda por debajo de su altura
      if (!hit && y < W.furnTop(x, z, lv, 0.12)) hit = true;
      if (!hit && yl < W.DOOR_H + 0.05 && W.nearDoorLeaf(x, z, 0.14, lv)) hit = true;
      // que no se meta dentro de una loma
      if (!hit && !inside && y < W.terrainAt(x, z) + 0.3) hit = true;
      if (hit) return Math.max(0, (i - 1.6) / steps);
      px = x; pz = z;
    }
    return 1;
  }

  G.Camera = Cam;
})(window.Game = window.Game || {});
