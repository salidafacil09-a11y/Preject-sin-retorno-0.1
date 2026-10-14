(function (G) {
  'use strict';

  // Objetos sueltos y arrojables (inspirado en el vídeo de referencia, con diseño y números propios)
  // - Los objetos aparecen encima de mesas, mostradores y escritorios, o en el suelo, repartidos por el mapa.
  //   Brillan un poco; de cerca muestran su icono blanco y se cogen con ∆ / T de pasada (un gesto rápido,
  //   sin pararse: si está en una mesa, estira el brazo; si está en el suelo, se agacha).
  // - Arrojables: ladrillo y botella. Solo se lleva uno. G, la cruceta arriba o el botón Lanzar lo tiran
  //   con un lanzamiento rápido al infectado fijado (el más centrado delante); si no hay ninguno, hacia
  //   donde miras. Al darle queda aturdido unos segundos (listo para rematarlo). Al caer hace ruido.

  const U = G.Util;
  const KINDS = {
    mun_9mm: { name: 'balas de 9 mm', n: [2, 4], w: 3, lift: 0 },
    venda: { name: 'venda', n: [1, 1], w: 1.4, lift: 0 },
    alcohol: { name: 'alcohol', n: [1, 2], w: 1, lift: 0 },
    ladrillo: { name: 'Ladrillo', n: [1, 1], w: 2, lift: 0.034, thr: true },
    botella: { name: 'Botella', n: [1, 1], w: 2, lift: 0.035, thr: true }
  };
  const TABLES = { mesita: 1, comoda: 1, encimera: 1, mesa: 1, escritorio: 1, mostrador: 1, banco: 1, mueble_tv: 1, cajas: 1, carrito: 1, fregadero: 1 };
  const REACH = 1.55;            // distancia para cogerlo
  const ICON_D = 6;              // a esta distancia se ve el icono
  const GLINT_D = 16;            // y el brillo
  const THROW_SPEED = 15, GRAV = 9.8;

  let scene = null, mat = null, glintTex = null, layer = null, lockEl = null;
  const items = [];              // { id, n, x, y, z, lv, mesh, glint, el }
  const flying = [];             // proyectiles en vuelo
  let points = null;             // posibles sitios (se calculan una vez por mundo)
  const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _o = new THREE.Vector3();

  function texGlint() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,240,1)');
    g.addColorStop(0.18, 'rgba(255,245,210,0.55)');
    g.addColorStop(1, 'rgba(255,240,200,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    // destello en cruz
    x.fillStyle = 'rgba(255,255,245,0.85)';
    x.fillRect(31, 4, 2, 56); x.fillRect(4, 31, 56, 2);
    return new THREE.CanvasTexture(c);
  }

  function init(sc) {
    scene = sc;
    mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    glintTex = texGlint();
    layer = document.getElementById('picks');
    lockEl = document.getElementById('thr-lock');
  }

  // ---------- Sitios donde pueden aparecer ----------
  function findPoints() {
    const W = G.World, out = [];
    const CS = W.CS, A0 = W.ARENA_MIN, A1 = W.ARENA_MAX;
    const c0 = Math.floor(A0 / CS), c1 = Math.floor((A1 - 1) / CS);
    const rng = U.mulberry32(((W.stats().seed || 1) % 100000) + 77);
    for (let cz = c0; cz <= c1; cz++) {
      for (let cx = c0; cx <= c1; cx++) {
        const c = W.chunkAt(cx, cz);
        for (const f of c.furn) {
          if (!TABLES[f.type] || (f.x1 - f.x0) < 0.35 || (f.z1 - f.z0) < 0.3) continue;
          const x = U.lerp(f.x0 + 0.12, f.x1 - 0.12, rng()), z = U.lerp(f.z0 + 0.1, f.z1 - 0.1, rng());
          // que no haya otro mueble encima (una estantería, por ejemplo)
          if (W.furnTop(x, z, f.lv || 0) > f.y + f.h + 0.1) continue;
          out.push({ x, z, y: f.y + f.h, lv: f.lv || 0, table: true });
        }
      }
    }
    // en el suelo: dentro y fuera de los edificios, lejos de las paredes
    for (let i = 0, tries = 0; i < 70 && tries < 900; tries++) {
      const x = U.lerp(A0 + 3, A1 - 3, rng()), z = U.lerp(A0 + 3, A1 - 3, rng());
      if (W.circleBlocked(x, z, 0.45, 0) || W.furnTop(x, z, 0, 0.3) > 0) continue;
      out.push({ x, z, y: W.groundY(x, z, 0), lv: 0, table: false, indoor: W.isIndoor(Math.floor(x), Math.floor(z), 0) });
      i++;
    }
    return out;
  }

  function pickKind(rng, weights) {
    let tot = 0;
    for (const k in weights) tot += weights[k];
    let r = rng() * tot;
    for (const k in weights) { r -= weights[k]; if (r <= 0) return k; }
    return 'mun_9mm';
  }

  function makeMesh(id) {
    const g = new THREE.Group();
    const m = new THREE.Mesh(G.Models.weaponGeometry(id), mat);
    m.rotation.x = Math.PI / 2;            // tumbado: lo que en el modelo es -Z queda arriba
    m.position.y = KINDS[id].lift || 0;
    m.castShadow = true;
    g.add(m);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glintTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.8 }));
    s.material.toneMapped = false;
    s.scale.setScalar(0.22);
    s.position.y = 0.09;
    g.add(s);
    return { group: g, glint: s };
  }

  function add(id, n, p) {
    const k = KINDS[id];
    const it = { id, n: n != null ? n : k.n[0] + Math.floor(Math.random() * (k.n[1] - k.n[0] + 1)), x: p.x, y: p.y, z: p.z, lv: p.lv || 0, ph: Math.random() * 6 };
    const mm = makeMesh(id);
    it.mesh = mm.group; it.glint = mm.glint;
    it.mesh.position.set(p.x, p.y + 0.004, p.z);
    it.mesh.rotation.y = Math.random() * Math.PI * 2;
    scene.add(it.mesh);
    if (layer) {
      const u = G.Icons.white(id);
      const d = document.createElement('div');
      d.className = 'pk hidden';
      d.innerHTML = (u ? '<img alt="" src="' + u + '">' : '') + (it.n > 1 ? '<span>' + it.n + '</span>' : '') + '<i></i>';
      layer.appendChild(d);
      it.el = d;
    }
    items.push(it);
    return it;
  }

  function removeAt(i) {
    const it = items[i];
    if (it.mesh.parent) it.mesh.parent.remove(it.mesh);
    it.glint.material.dispose();
    if (it.el) it.el.remove();
    items.splice(i, 1);
  }

  function clear() {
    while (items.length) removeAt(items.length - 1);
    for (const f of flying) if (f.mesh.parent) f.mesh.parent.remove(f.mesh);
    flying.length = 0;
  }

  // n objetos repartidos (al menos a 5 m entre sí y a 4 m de la protagonista), con pesos por tipo
  function spawn(n, opts) {
    opts = opts || {};
    if (!points) points = findPoints();
    const P = G.debug && G.debug.player;
    const rng = Math.random;
    const weights = opts.weights || { mun_9mm: KINDS.mun_9mm.w, venda: KINDS.venda.w, alcohol: KINDS.alcohol.w, ladrillo: KINDS.ladrillo.w, botella: KINDS.botella.w };
    let made = 0;
    for (let tries = 0; made < n && tries < n * 30; tries++) {
      const p = points[Math.floor(rng() * points.length)];
      if (!p) break;
      if (P && Math.hypot(p.x - P.pos.x, p.z - P.pos.z) < 4) continue;
      if (items.some((o) => Math.hypot(o.x - p.x, o.z - p.z) < 5)) continue;
      const id = pickKind(rng, weights);
      // los arrojables caen más en el suelo y en la calle; lo demás, más en las mesas
      if (KINDS[id].thr && p.table && rng() < 0.5) continue;
      if (!KINDS[id].thr && !p.table && rng() < 0.4) continue;
      add(id, null, p);
      made++;
    }
    return made;
  }

  // Al reiniciar el mundo
  function reset() { clear(); points = null; }

  // ---------- Coger ----------
  // el objeto más cercano que se puede coger (al alcance y sin pared en medio)
  function near(player) {
    let best = null, bd = REACH;
    for (const it of items) {
      if ((it.lv || 0) !== (player.lv || 0)) continue;
      const d = Math.hypot(it.x - player.pos.x, it.z - player.pos.z);
      if (d < bd && Math.abs(it.y - player.y) < 1.6) { bd = d; best = it; }
    }
    if (best && !G.World.hasLOS(player.pos.x, player.pos.z, best.x, best.z, player.lv)) best = null;
    return best;
  }
  function label(it) {
    const k = KINDS[it.id];
    return 'Coger ' + (k.thr ? k.name.toLowerCase() : (it.n > 1 ? it.n + ' ' : '') + k.name);
  }

  function startPickup(player, it) {
    if (!it || player.busy() || player.struggle) return null;
    const k = KINDS[it.id];
    if (k.thr && player.throwable) return 'Ya llevas ' + (player.throwable === 'ladrillo' ? 'un ladrillo' : 'una botella') + ' (lánzalo antes)';
    if (!k.thr && player.itemRoom(it.id) <= 0) return 'No te cabe más ' + k.name;
    const hi = it.y - player.y > 0.45;
    player.action = { kind: hi ? 'pickupHi' : 'pickup', t: 0, dur: hi ? 0.5 : 0.62, impact: 0.42, face: Math.atan2(it.x - player.pos.x, it.z - player.pos.z), item: it, done: false };
    return null;
  }

  function collect(player, a) {
    const it = a.item, i = items.indexOf(it);
    if (i < 0) return;
    const k = KINDS[it.id];
    let msg;
    if (k.thr) {
      if (player.throwable) return;
      player.throwable = it.id;
      msg = (it.id === 'ladrillo' ? 'Ladrillo' : 'Botella') + (G.Input.isTouch ? ': toca Lanzar' : ': G para lanzarlo');
      removeAt(i);
    } else {
      const r = player.takeItem(it.id, it.n);
      msg = r.msg;
      if (r.left > 0) { it.n = r.left; const s = it.el && it.el.querySelector('span'); if (s) s.textContent = it.n; }
      else removeAt(i);
    }
    if (Pickups.onMessage) Pickups.onMessage(msg, 'good');
    if (G.Mode && G.Mode.stats) G.Mode.stats.picked++;
  }

  // ---------- Lanzar ----------
  // infectado fijado: el más centrado hacia donde miras, hasta 15 m, a la vista
  function lockTarget(player, zombies, camYaw) {
    let best = null, bs = Infinity;
    for (const z of zombies) {
      if (!z.alive || !z.standing || (z.lv || 0) !== (player.lv || 0) || z.state === 'held' || z.state === 'grapple') continue;
      const dx = z.pos.x - player.pos.x, dz = z.pos.z - player.pos.z, d = Math.hypot(dx, dz);
      if (d > 15 || d < 0.8) continue;
      const a = Math.abs(U.angleDiff(Math.atan2(dx, dz), camYaw));
      if (a > 0.75) continue;
      const s = a * 6 + d * 0.25;
      if (s < bs && G.World.hasLOS(player.pos.x, player.pos.z, z.pos.x, z.pos.z, player.lv)) { bs = s; best = z; }
    }
    return best;
  }

  function startThrow(player, zombies, camYaw) {
    if (!player.throwable) return null;
    if (player.busy() || player.struggle || player.dead || player.climb) return null;
    const tgt = lockTarget(player, zombies, camYaw);
    const face = tgt ? Math.atan2(tgt.pos.x - player.pos.x, tgt.pos.z - player.pos.z) : camYaw;
    player.action = { kind: 'throw', t: 0, dur: 0.78, impact: 0.46, face, item: player.throwable, target: tgt, done: false };
    if (player.stance === 'prone') player.stance = 'crouch';
    return null;
  }

  // suelta el proyectil desde la mano (lo llama Combat en el momento del lanzamiento)
  function release(player, a) {
    const id = a.item;
    if (!id || player.throwable !== id) return;
    player.throwable = null;
    const h = player.model;
    h.root.updateMatrixWorld(true);
    const start = h.handR.getWorldPosition(new THREE.Vector3());
    let aim;
    const z = a.target;
    if (z && z.alive) {
      // a la cabeza, donde va a estar cuando llegue
      const d0 = Math.hypot(z.pos.x - start.x, z.pos.z - start.z);
      const T = Math.max(0.12, d0 / THROW_SPEED);
      const vx = (z.speedNow || 0) * Math.sin(z.facing), vz = (z.speedNow || 0) * Math.cos(z.facing);
      aim = new THREE.Vector3(z.pos.x + vx * T * 0.8, z.y + 1.5, z.pos.z + vz * T * 0.8);
    } else {
      // hacia donde mira la cámara: al suelo o a lo que haya, como mucho a 16 m
      const C = G.Camera;
      _o.copy(C.pos); _d.copy(C.dir).normalize();
      let t = 16;
      if (_d.y < -0.02) t = Math.min(t, (_o.y - player.y) / -_d.y);
      aim = _o.clone().addScaledVector(_d, Math.max(4, t));
    }
    const dx = aim.x - start.x, dz = aim.z - start.z, dh = Math.hypot(dx, dz) || 0.01;
    const T = Math.max(0.15, dh / THROW_SPEED);
    const v = new THREE.Vector3(dx / T, (aim.y - start.y + 0.5 * GRAV * T * T) / T, dz / T);
    const mesh = new THREE.Mesh(G.Models.weaponGeometry(id), mat);
    mesh.castShadow = true;
    mesh.position.copy(start);
    scene.add(mesh);
    flying.push({ id, mesh, p: start, v, spin: new THREE.Vector3(8 + Math.random() * 6, Math.random() * 4, 3), life: 0, lv: player.lv || 0, target: z });
    G.World.emit(player.pos.x, player.pos.z, 2, player.lv);
    if (G.Mode && G.Mode.stats) G.Mode.stats.thrown++;
  }

  function impact(f, p, d, z) {
    if (f.mesh.parent) f.mesh.parent.remove(f.mesh);
    const brick = f.id === 'ladrillo';
    if (G.Guns && G.Guns.burst) G.Guns.burst(p, d, false, brick ? 7 : 10);
    // el golpe se oye: atrae a los que no te han visto (sirve de distracción)
    G.World.emit(p.x, p.z, brick ? 8 : 10, f.lv);
    if (z) {
      z.takeHit(brick ? 0.45 : 0.3, 0.2, d.x, d.z, false, 1, 'side', 'body');
      if (z.alive) {
        z.stun(z.blind ? 1.7 : 2.6, d.x, d.z, 1.6);
        if (G.Mode && G.Mode.stats) G.Mode.stats.stun++;
      }
      if (G.Combat.onHit) G.Combat.onHit(z.alive ? 'hit' : 'kill', false);
      if (G.Camera.hitFx) G.Camera.hitFx(0.25, 1);
      if (Pickups.onMessage) Pickups.onMessage('¡Aturdido! Remátalo', 'good');
    }
  }

  function updateFlying(dt, zombies) {
    const W = G.World;
    for (let i = flying.length - 1; i >= 0; i--) {
      const f = flying[i];
      f.life += dt;
      const p0 = f.p.clone();
      f.v.y -= GRAV * dt;
      f.p.addScaledVector(f.v, dt);
      const seg = f.p.clone().sub(p0), L = seg.length() || 1e-4;
      _d.copy(seg).divideScalar(L);
      let done = false;
      // infectados
      let bz = null, bt = Infinity;
      for (const z of zombies) {
        if (!z.alive || (z.lv || 0) !== f.lv) continue;
        if (Math.abs(z.pos.x - p0.x) > L + 1.5 || Math.abs(z.pos.z - p0.z) > L + 1.5) continue;
        const h = G.Guns.hitZombie(z, p0, _d);
        if (h && h.t <= L + 0.15 && h.t < bt) { bt = h.t; bz = z; }
      }
      const fw = W.lineHit(p0.x, p0.z, f.p.x, f.p.z, W.blocksSightEdge, f.lv);
      const tW = fw >= 0 ? fw * L : Infinity;
      const gy = W.groundY(f.p.x, f.p.z, f.lv) + Math.max(0, W.furnTop(f.p.x, f.p.z, f.lv) - W.groundY(f.p.x, f.p.z, f.lv));
      const tG = f.p.y < gy ? L * (p0.y - gy) / Math.max(1e-4, p0.y - f.p.y) : Infinity;
      if (bz && bt <= tW && bt <= tG) { impact(f, p0.clone().addScaledVector(_d, bt), _d.clone(), bz); done = true; }
      else if (tW < Infinity || tG < Infinity) { impact(f, p0.clone().addScaledVector(_d, Math.max(0, Math.min(tW, tG) - 0.05)), _d.clone(), null); done = true; }
      else if (f.life > 4) { if (f.mesh.parent) f.mesh.parent.remove(f.mesh); done = true; }
      if (done) { flying.splice(i, 1); continue; }
      f.mesh.position.copy(f.p);
      f.mesh.rotation.x += f.spin.x * dt; f.mesh.rotation.y += f.spin.y * dt; f.mesh.rotation.z += f.spin.z * dt;
    }
  }

  // ---------- Cada fotograma ----------
  function update(dt, player, zombies, camera, camYaw, playing) {
    updateFlying(dt, zombies);
    const t = performance.now() / 1000;
    const Wd = window.innerWidth, H = window.innerHeight;
    const pick = playing && !player.dead ? near(player) : null;
    for (const it of items) {
      const d = Math.hypot(it.x - player.pos.x, it.z - player.pos.z);
      const sameLv = (it.lv || 0) === (player.lv || 0);
      // brillo que late (más fuerte de cerca)
      const gl = sameLv && d < GLINT_D;
      it.glint.visible = gl;
      if (gl) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 3 + it.ph);
        it.glint.material.opacity = (0.25 + 0.55 * pulse) * Math.min(1, (GLINT_D - d) / 4);
        it.glint.scale.setScalar(0.16 + 0.1 * pulse);
      }
      if (!it.el) continue;
      const show = playing && sameLv && d < ICON_D;
      if (!show) { if (!it.el.classList.contains('hidden')) it.el.classList.add('hidden'); continue; }
      _v.set(it.x, it.y + 0.28, it.z).project(camera);
      let sx = (_v.x * 0.5 + 0.5) * Wd, sy = (-_v.y * 0.5 + 0.5) * H;
      const behind = _v.z > 1;
      const off = behind || sx < 24 || sx > Wd - 24 || sy < 24 || sy > H - 24;
      if (off) {
        // fuera de la pantalla: en el borde, hacia donde está
        if (d > 4) { it.el.classList.add('hidden'); continue; }
        let ax = sx - Wd / 2, ay = sy - H / 2;
        if (behind) { ax = -ax; ay = -ay; }
        const k = Math.min((Wd / 2 - 30) / Math.max(1, Math.abs(ax)), (H / 2 - 30) / Math.max(1, Math.abs(ay)));
        sx = Wd / 2 + ax * k; sy = H / 2 + ay * k;
      }
      it.el.classList.remove('hidden');
      it.el.classList.toggle('edge', off);
      it.el.classList.toggle('near', it === pick);
      it.el.style.transform = 'translate(' + Math.round(sx) + 'px,' + Math.round(sy) + 'px) translate(-50%,-50%)';
      it.el.style.opacity = off ? 0.75 : Math.min(1, (ICON_D - d) / 1.5).toFixed(2);
    }
    // icono sobre el infectado fijado mientras llevas un arrojable
    if (lockEl) {
      const z = playing && player.throwable && !player.aiming ? lockTarget(player, zombies, camYaw) : null;
      if (z) {
        z.model.head.getWorldPosition(_v); _v.y += 0.28;
        _v.project(camera);
        if (_v.z < 1) {
          lockEl.classList.remove('hidden');
          lockEl.style.transform = 'translate(' + Math.round((_v.x * 0.5 + 0.5) * Wd) + 'px,' + Math.round((-_v.y * 0.5 + 0.5) * H) + 'px) translate(-50%,-50%)';
        } else lockEl.classList.add('hidden');
      } else lockEl.classList.add('hidden');
    }
    return pick;
  }

  const Pickups = {
    onMessage: null, KINDS,
    init, reset, clear, spawn, add, near, label, startPickup, collect, lockTarget, startThrow, release, update,
    get count() { return items.length; },
    get list() { return items; }
  };
  G.Pickups = Pickups;
})(window.Game = window.Game || {});
