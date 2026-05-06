const state = {
  catalogue: null,
  gamme: null,
  article: null,
  material: null,
  thickness: null,
  materialRef: null,
  result: null,
};

const $ = (id) => document.getElementById(id);

function setStatus(text) {
  $('status').textContent = text;
}

function isLocalServer() {
  if (window.location.protocol === 'file:') return false;
  const h = window.location.hostname;
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function isPlialuArticle(payload) {
  return payload && typeof payload.article === 'string' && payload.article.startsWith('plialu_');
}

async function api(url, payload = null) {
  // Articles Plialu : calcul/export systématiquement côté navigateur car le
  // serveur Python ne les connaît pas (ils sont dérivés de lib/database.js).
  const forceLocal = isPlialuArticle(payload);

  if (!forceLocal && isLocalServer()) {
    try {
      const options = payload ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      } : {};
      const res = await fetch(url, options);
      const ct = res.headers.get('content-type') || '';
      if (!res.ok || !ct.includes('application/json')) {
        throw new Error(`server ${res.status}`);
      }
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data;
    } catch (_) {
      // Bascule en mode secours si le serveur ne répond pas correctement.
    }
  }

  // Mode secours : pas de backend (file://, GitHub Pages, article Plialu, fetch KO).
  const cat = state.catalogue || window.CATALOGUE_EMBEDDED;
  if (url === '/api/catalogue') return window.CATALOGUE_EMBEDDED;
  if (url === '/api/calculate') return calculateLocal(cat, payload);
  if (url === '/api/export/dxf') {
    const result = calculateLocal(cat, payload);
    const filename = safeFilename(`${payload.values?.rep || result.article_id}_${result.article_id}_${Math.round(result.length_mm || 0)}.dxf`);
    const text = buildDxfText(result);
    const blobUrl = URL.createObjectURL(new Blob([text], { type: 'application/dxf' }));
    return { url: blobUrl, filename };
  }
  if (url === '/api/export/fiche') {
    const result = calculateLocal(cat, payload);
    const filename = safeFilename(`fiche_${payload.values?.rep || result.article_id}_${result.article_id}.html`);
    const html = buildFicheHtml(result, payload);
    const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    return { url: blobUrl, filename };
  }
  throw new Error('API locale inconnue : ' + url);
}

function findGamme() {
  return state.catalogue.gammes.find(g => g.id === state.gamme);
}

function findArticle() {
  const gamme = findGamme();
  return gamme?.articles.find(a => a.id === state.article);
}

function findMaterial() {
  return state.catalogue.materials.find(m => m.id === state.material) || state.catalogue.materials[0];
}

// ─────────────────────────────────────────────────────────────
//  Bridge avec lib/database.js (window.Plialu)
// ─────────────────────────────────────────────────────────────
function isAcierFamily(name) { return /acier/i.test(name || ''); }

function enrichCatalogueWithPlialu(cat) {
  if (!window.Plialu || !Array.isArray(window.Plialu.MATERIALS)) return cat;
  const P = window.Plialu;

  const byFamily = new Map();
  P.MATERIALS.forEach(m => {
    if (!byFamily.has(m.family)) byFamily.set(m.family, { thicknesses: new Set(), items: [] });
    const f = byFamily.get(m.family);
    if (typeof m.thickness === 'number') f.thicknesses.add(m.thickness);
    f.items.push(m);
  });

  const familyMaterials = Array.from(byFamily.entries()).map(([family, info]) => ({
    id: `PLIALU::${family}`,
    label: family,
    density_kg_m3: isAcierFamily(family) ? 7850 : 2700,
    k_factor: isAcierFamily(family) ? 0.42 : 0.38,
    default_radius_factor: 1.0,
    thicknesses: Array.from(info.thicknesses).sort((a, b) => a - b),
    plialu_items: info.items,
    plialu_family: family,
  }));

  cat.materials = [...familyMaterials, ...(cat.materials || [])];
  cat.default_material = familyMaterials[0]?.id || cat.default_material;

  // ── Gammes / articles ──────────────────────────────────────
  if (Array.isArray(P.FAMILLES) && Array.isArray(P.ARTICLES)) {
    const profiles = Array.isArray(P.PROFILES) ? P.PROFILES : [];
    const plialuGammes = P.FAMILLES.map(famille => {
      const famArts = P.ARTICLES.filter(a => a.famille === famille);
      if (!famArts.length) return null;
      const famProfiles = profiles.filter(p => p.famille === famille);
      return {
        id: 'plialu_' + slugify(famille),
        label: famille,
        description: `Famille Plialu — ${famArts.length} article${famArts.length > 1 ? 's' : ''}`,
        articles: famArts.map(art => buildArticleFromPlialu(art, pickProfileFor(art, famProfiles))),
      };
    }).filter(Boolean);

    cat.gammes = [...plialuGammes, ...(cat.gammes || [])];
  }
  return cat;
}

function slugify(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function pliCountFromName(name) {
  const m = String(name).match(/(\d)\s*plis/i);
  if (m) return Number(m[1]);
  if (/biaise/i.test(name)) return 2;
  return null;
}

function pickProfileFor(article, famProfiles) {
  if (!famProfiles.length) return null;
  const n = pliCountFromName(article.article);
  if (n != null) {
    const exact = famProfiles.find(p => p.bends.length === n);
    if (exact) return exact;
  }
  return famProfiles[0];
}

function buildArticleFromPlialu(art, profile) {
  const segLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  let segLabels, bendDefaults, turnSigns, segDefaults;

  if (profile) {
    segLabels = profile.segments.map(s => s.label);
    segDefaults = profile.segments.map(s => s.length);
    bendDefaults = profile.bends.map(b => Math.abs(b.angle));
    turnSigns = profile.bends.map(b => Math.sign(b.angle) || 1);
  } else {
    const pli = pliCountFromName(art.article) || 2;
    const segCount = pli + 1;
    segLabels = segLetters.slice(0, segCount);
    segDefaults = segLabels.map((_, i) => (i === Math.floor(segCount / 2) ? 150 : 30));
    bendDefaults = Array(pli).fill(90);
    turnSigns = Array(pli).fill(0).map((_, i) => (i % 2 === 0 ? -1 : 1));
  }

  const bendIds = bendDefaults.map((_, i) => `pli${segLetters[i]}`);
  const dimFields = segLabels.map((s, i) => ({
    id: s, label: s, type: 'number', default: segDefaults[i] || 30, min: 1, step: 1, unit: 'mm',
  }));
  dimFields.push({ id: 'Lg', label: 'Lg', type: 'number', default: 3000, min: 50, step: 1, unit: 'mm' });
  bendDefaults.forEach((d, i) => {
    dimFields.push({ id: bendIds[i], label: bendIds[i], type: 'number', default: d, min: 1, max: 179, step: 1, unit: '°' });
  });

  const prefix = (window.Plialu.PREFIXES || {})[art.famille] || '';
  return {
    id: `plialu_${art.id}`,
    label: art.article,
    title: art.article,
    reference_prefix: prefix,
    plialu_id: art.id,
    schema: [
      { group: 'Repère', fields: [{ id: 'rep', label: 'Rep', type: 'text', default: prefix || 'Rep' }] },
      { group: 'Dimensions', fields: dimFields },
    ],
    geometry: {
      segments: segLabels,
      bends: bendIds,
      turn_signs: turnSigns,
      flat_formula: 'segments_plus_bend_allowances',
      notes: profile
        ? `Géométrie issue du profil "${profile.name}" — à recalibrer pour cet article spécifique.`
        : 'Géométrie par défaut — à recalibrer pour cet article (ordre, angles, sens).',
    },
    limits: { max_length: 6000, min_flat_width: 20, max_flat_width: 1250 },
  };
}

function plialuRefsForCurrent() {
  const m = findMaterial();
  if (!m || !m.plialu_items) return [];
  const t = Number(state.thickness);
  return m.plialu_items
    .filter(it => Math.abs((it.thickness || 0) - t) < 1e-6)
    .sort((a, b) => (a.ral || '').localeCompare(b.ral || '', 'fr', { numeric: true }));
}

function refreshMaterialRefs() {
  const sel = $('materialRefSelect');
  if (!sel) return;
  const refs = plialuRefsForCurrent();
  if (!refs.length) {
    sel.innerHTML = '<option value="">— (pas de référence Plialu)</option>';
    sel.disabled = true;
    state.materialRef = null;
    return;
  }
  sel.disabled = false;
  sel.innerHTML = refs.map(r => {
    const ral = r.ral ? `RAL ${r.ral}` : '';
    const fin = r.finish || '';
    const tag = [ral, fin].filter(Boolean).join(' · ');
    return `<option value="${r.id}">${r.name}${tag ? ' — ' + tag : ''}</option>`;
  }).join('');
  state.materialRef = refs[0].id;
  sel.value = state.materialRef;
}

function fmt(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function initSelectors() {
  const cat = state.catalogue;
  $('gammeSelect').innerHTML = cat.gammes.map(g => `<option value="${g.id}">${g.label}</option>`).join('');
  state.gamme = cat.gammes[0]?.id;
  $('gammeSelect').value = state.gamme;

  $('materialSelect').innerHTML = cat.materials.map(m => `<option value="${m.id}">${m.label}</option>`).join('');
  state.material = cat.default_material || cat.materials[0]?.id;
  $('materialSelect').value = state.material;

  $('quantityInput').value = 1;
  renderGammeThumbs();
  refreshArticles();
  refreshThicknesses();
  refreshMaterialRefs();

  $('gammeSelect').addEventListener('change', () => {
    state.gamme = $('gammeSelect').value;
    refreshArticles();
    renderGammeThumbs();
    recalc();
  });
  $('articleSelect').addEventListener('change', () => {
    state.article = $('articleSelect').value;
    renderForm();
    renderArticleSchema();
    recalc();
  });
  $('materialSelect').addEventListener('change', () => {
    state.material = $('materialSelect').value;
    refreshThicknesses();
    refreshMaterialRefs();
    recalc();
  });
  $('thicknessSelect').addEventListener('change', () => {
    state.thickness = Number($('thicknessSelect').value);
    refreshMaterialRefs();
    recalc();
  });
  $('materialRefSelect').addEventListener('change', () => {
    state.materialRef = $('materialRefSelect').value || null;
    recalc();
  });
  $('quantityInput').addEventListener('input', recalc);
  $('btnCalculate').addEventListener('click', recalc);
  $('btnDxf').addEventListener('click', exportDxf);
  $('btnFiche').addEventListener('click', exportFiche);
  $('btnCopyJson').addEventListener('click', copyJson);
}

function refreshArticles() {
  const gamme = findGamme();
  $('articleSelect').innerHTML = gamme.articles.map(a => `<option value="${a.id}">${a.label}</option>`).join('');
  state.article = gamme.articles[0]?.id;
  $('articleSelect').value = state.article;
  renderForm();
  renderArticleSchema();
  renderDetails();
}

function refreshThicknesses() {
  const m = findMaterial();
  $('thicknessSelect').innerHTML = m.thicknesses.map(t => `<option value="${t}">${String(t).replace('.', ',')}</option>`).join('');
  state.thickness = m.thicknesses[0];
  $('thicknessSelect').value = String(state.thickness);
}

function imageForArticle(article) {
  if (!article || !window.PIECE_IMAGES) return null;
  const map = window.PIECE_IMAGES.articles || {};
  // Le label de l'article est conservé tel quel par buildArticleFromPlialu
  const f = map[article.label] || map[article.title] || map[article.id];
  return f ? `assets/pieces/${encodeURIComponent(f)}` : null;
}

function imageForGamme(gamme) {
  if (!gamme || !window.PIECE_IMAGES) return null;
  const fams = window.PIECE_IMAGES.familles || {};
  const arts = window.PIECE_IMAGES.articles || {};
  if (fams[gamme.label]) return `assets/pieces/${encodeURIComponent(fams[gamme.label])}`;
  // Fallback : prends la première image disponible parmi les articles de la gamme
  for (const a of (gamme.articles || [])) {
    const f = arts[a.label] || arts[a.title];
    if (f) return `assets/pieces/${encodeURIComponent(f)}`;
  }
  return null;
}

function renderGammeThumbs() {
  const gamme = findGamme();
  const articles = gamme?.articles || [];
  const arts = (window.PIECE_IMAGES && window.PIECE_IMAGES.articles) || {};
  const slots = articles.slice(0, 12);
  // Complète à 12 cases pour préserver la grille
  while (slots.length < 12) slots.push(null);
  $('gammeThumbs').innerHTML = slots.map((a, i) => {
    if (!a) return `<div class="thumb empty" title="—"></div>`;
    const f = arts[a.label] || arts[a.title];
    const isActive = a.id === state.article ? ' active' : '';
    if (f) {
      const url = `assets/pieces/${encodeURIComponent(f)}`;
      return `<div class="thumb${isActive}" data-article="${a.id}" title="${a.label}"><img src="${url}" alt="${a.label}" loading="lazy"></div>`;
    }
    return `<div class="thumb${isActive}" data-article="${a.id}" title="${a.label}"><span class="thumb-label">${a.label}</span></div>`;
  }).join('');

  // Permet de cliquer sur une vignette pour sélectionner l'article
  document.querySelectorAll('#gammeThumbs .thumb[data-article]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-article');
      const sel = $('articleSelect');
      if (sel && Array.from(sel.options).some(o => o.value === id)) {
        sel.value = id;
        sel.dispatchEvent(new Event('change'));
      }
    });
  });
}

function renderDetails() {
  const gamme = findGamme();
  const article = findArticle();
  $('detailTitle').textContent = article?.title || '—';
  $('detailText').textContent = `${gamme?.description || ''} ${article?.geometry?.notes || ''}`;

  // Vignette de l'article sélectionné dans le panneau Détails
  const wrap = $('detailImage');
  if (wrap) {
    const url = imageForArticle(article);
    wrap.innerHTML = url ? `<img src="${url}" alt="${article.label}" loading="lazy">` : '';
  }
}

function renderForm() {
  const article = findArticle();
  const form = $('dynamicForm');
  form.innerHTML = '';
  if (!article) return;
  article.schema.forEach(group => {
    const wrap = document.createElement('div');
    wrap.className = 'group-box';
    wrap.innerHTML = `<div class="group-title">${group.group}</div>`;
    group.fields.forEach(field => {
      const row = document.createElement('div');
      row.className = 'input-row';
      const inputType = field.type === 'number' ? 'number' : 'text';
      row.innerHTML = `
        <label for="field_${field.id}">${field.label} :</label>
        <input id="field_${field.id}" data-field="${field.id}" type="${inputType}" value="${field.default ?? ''}"
          ${field.min !== undefined ? `min="${field.min}"` : ''}
          ${field.max !== undefined ? `max="${field.max}"` : ''}
          ${field.step !== undefined ? `step="${field.step}"` : ''} />
        <span class="unit">${field.unit || ''}</span>`;
      wrap.appendChild(row);
    });
    form.appendChild(wrap);
  });
  form.querySelectorAll('input').forEach(input => input.addEventListener('input', recalc));
}

function getValues() {
  const values = {};
  document.querySelectorAll('[data-field]').forEach(el => {
    values[el.dataset.field] = el.type === 'number' ? Number(el.value) : el.value;
  });
  return values;
}

function payload() {
  return {
    affaire: $('affaireName').value,
    gamme: state.gamme,
    article: state.article,
    material: state.material,
    material_ref: state.materialRef,
    thickness: Number($('thicknessSelect').value),
    quantity: Number($('quantityInput').value || 1),
    values: getValues(),
  };
}

async function recalc() {
  try {
    const data = await api('/api/calculate', payload());
    state.result = data;
    renderCalculated(data);
    renderPreviews(data);
    renderDetails();
    setStatus('Calcul à jour');
  } catch (err) {
    setStatus('Erreur : ' + err.message);
  }
}

function renderCalculated(r) {
  const items = [
    ['Développé', `${fmt(r.flat_width_mm)} mm`],
    ['Lg', `${fmt(r.length_mm, 0)} mm`],
    ['Surface unit.', `${fmt(r.developed_area_m2_one, 4)} m²`],
    ['Surface totale', `${fmt(r.developed_area_m2_total, 4)} m²`],
    ['Poids unit.', `${fmt(r.weight_kg_one, 3)} kg`],
    ['Poids total', `${fmt(r.weight_kg_total, 3)} kg`],
    ['Rayon', `${fmt(r.radius_mm)} mm`],
    ['K-factor', `${fmt(r.k_factor, 3)}`],
  ];
  let html = items.map(([label, value]) => `<div class="calc-item"><div class="label">${label}</div><div class="value">${value}</div></div>`).join('');
  if (r.warnings?.length) {
    html += `<div class="calc-item warn"><div class="label">Alertes</div><ul class="warning-list">${r.warnings.map(w => `<li>${w}</li>`).join('')}</ul></div>`;
  }
  $('calculatedFields').innerHTML = html;
}

function drawLine(ctx, p1, p2, color = '#111', width = 2) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
  ctx.restore();
}

function drawText(ctx, text, x, y, color = '#ff00ff', size = 14, align = 'center') {
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = `${size}px Segoe UI, Arial`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function normalizePoints(points, width, height, padding = 50) {
  const xs = points.map(p => p[0]);
  const ys = points.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  // Recentre le tracé dans la bbox disponible (axe Y inversé pour le canvas).
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;
  return points.map(([x, y]) => ({
    x: offsetX + (x - minX) * scale,
    y: height - offsetY - (y - minY) * scale,
  }));
}

function prepareCanvas(id, fallbackW = 520, fallbackH = 300) {
  const canvas = $(id);
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(260, Math.floor(rect.width || fallbackW));
  const h = Math.max(180, Math.floor(rect.height || fallbackH));
  const pw = Math.floor(w * dpr);
  const ph = Math.floor(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, ctx, w, h };
}

function renderPreviews(r) {
  drawSectionPreview(r);
  drawFlatPreview(r);
}

function drawArrowHead(ctx, x, y, angle, color = '#ff00ff', size = 7) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - size * Math.cos(angle - Math.PI / 6), y - size * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(x, y);
  ctx.lineTo(x - size * Math.cos(angle + Math.PI / 6), y - size * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
  ctx.restore();
}

function drawRotatedText(ctx, text, x, y, angleRad, color = '#ff00ff', size = 13) {
  ctx.save();
  ctx.translate(x, y);
  let a = angleRad;
  if (a > Math.PI / 2 || a < -Math.PI / 2) a += Math.PI;
  ctx.rotate(a);
  ctx.fillStyle = color;
  ctx.font = `${size}px Segoe UI, Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function drawDimension(ctx, p1, p2, label, offset = 28, color = '#ff00ff', centerY = 180) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  let nx = -uy, ny = ux;

  // Oriente la cote plutôt vers l'extérieur de la pièce, avec une alternance légère.
  const midY = (p1.y + p2.y) / 2;
  if (midY > centerY) { nx = -nx; ny = -ny; }
  const q1 = { x: p1.x + nx * offset, y: p1.y + ny * offset };
  const q2 = { x: p2.x + nx * offset, y: p2.y + ny * offset };

  ctx.save();
  ctx.strokeStyle = '#2f8cff';
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y); ctx.lineTo(q1.x, q1.y);
  ctx.moveTo(p2.x, p2.y); ctx.lineTo(q2.x, q2.y);
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(q1.x, q1.y); ctx.lineTo(q2.x, q2.y);
  ctx.stroke();
  drawArrowHead(ctx, q1.x, q1.y, Math.atan2(q2.y - q1.y, q2.x - q1.x), color);
  drawArrowHead(ctx, q2.x, q2.y, Math.atan2(q1.y - q2.y, q1.x - q2.x), color);
  ctx.restore();

  const angle = Math.atan2(q2.y - q1.y, q2.x - q1.x);
  drawRotatedText(ctx, label, (q1.x + q2.x) / 2, (q1.y + q2.y) / 2 - 10, angle, color, 13);
}

function drawBendCallout(ctx, pt, label, idx) {
  const colors = ['#ff3333', '#ff00ff'];
  const color = colors[idx % colors.length];
  const ang = -Math.PI / 3 + idx * 0.35;
  const r = 26;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, r, ang, ang + Math.PI / 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
  drawText(ctx, label, pt.x + Math.cos(ang) * (r + 28), pt.y + Math.sin(ang) * (r + 28), color, 12, 'left');
}

// Rotation purement visuelle des points du profil pour rendu écran.
// (x, y) → (-y, x) ⇒ rotation +90° (sens anti-horaire) pour que les
// retours d'un U/Pi pointent vers le bas comme attendu en coupe atelier.
// N'altère pas les données métier : buildPreviewPoints, payload, exports
// DXF/fiche reçoivent toujours les coords d'origine.
function rotatePointsForScreen(points) {
  return points.map(([x, y]) => [-y, x]);
}

function drawSectionPreview(r) {
  const { ctx, w, h } = prepareCanvas('previewSection', 620, 360);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#fbfcfe';
  ctx.fillRect(0, 0, w, h);

  const rawPoints = rotatePointsForScreen(r.profile_points || [[0, 0], [100, 0]]);
  const pts = normalizePoints(rawPoints, w, h, Math.min(86, Math.max(54, w * 0.08)));

  // Petit cartouche titre, comme une zone de plan.
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#d8e1ec';
  ctx.lineWidth = 1;
  ctx.fillRect(10, 10, Math.min(300, w - 20), 44);
  ctx.strokeRect(10, 10, Math.min(300, w - 20), 44);
  ctx.fillStyle = '#111';
  ctx.font = '600 13px Segoe UI, Arial';
  ctx.fillText(r.article_title || 'Vue de coupe', 20, 29);
  ctx.font = '12px Segoe UI, Arial';
  ctx.fillStyle = '#657285';
  const refTxt = r.material_ref ? ` · réf. ${r.material_ref}` : '';
  ctx.fillText(`Matière ${r.material || '—'} · ép. ${fmt(r.thickness_mm)} mm${refTxt}`, 20, 45);
  ctx.restore();

  // Corps de la section : noir épais + centre clair pour évoquer la tôle pliée.
  for (let i = 0; i < pts.length - 1; i++) {
    drawLine(ctx, pts[i], pts[i + 1], '#111', 6);
    drawLine(ctx, pts[i], pts[i + 1], '#f5faff', 2.2);
  }

  const article = findArticle();
  const segNames = article?.geometry?.segments || [];
  const bends = r.bends || [];
  const segValues = Object.fromEntries((r.segments || []).map(s => [s.field, s.length_mm]));

  // Cotes des segments.
  for (let i = 0; i < Math.min(segNames.length, pts.length - 1); i++) {
    const p1 = pts[i], p2 = pts[i + 1];
    const name = segNames[i];
    const value = segValues[name];
    const offset = 28 + (i % 3) * 12;
    drawDimension(ctx, p1, p2, `${name} ${fmt(value, 0)} mm`, offset, '#ff00ff', h / 2);
  }

  // Labels de plis / angles.
  for (let i = 1; i < pts.length - 1; i++) {
    const bend = bends[i - 1];
    if (!bend) continue;
    drawBendCallout(ctx, pts[i], `${bend.field} ${fmt(bend.angle_deg, 0)}°`, i - 1);
  }

  // Points d'accroche / extrémités.
  ctx.save();
  ctx.fillStyle = '#111';
  pts.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2); ctx.fill(); });
  ctx.restore();
}

function drawFlatPreview(r) {
  const { ctx, w, h } = prepareCanvas('previewFlat', 520, 280);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#fbfcfe';
  ctx.fillRect(0, 0, w, h);

  const len = r.length_mm || 1000;
  const dev = r.flat_width_mm || 100;
  const margin = 40;
  const scale = Math.min((w - margin * 2) / len, (h - margin * 2) / dev);
  const rw = len * scale;
  const rh = Math.max(12, dev * scale);
  const x = (w - rw) / 2;
  const y = (h - rh) / 2;
  ctx.fillStyle = '#fff7fb';
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 2;
  ctx.fillRect(x, y, rw, rh);
  ctx.strokeRect(x, y, rw, rh);

  (r.bend_positions || []).forEach(b => {
    const by = y + b.position_mm * scale;
    ctx.setLineDash([7, 5]);
    drawLine(ctx, { x, y: by }, { x: x + rw, y: by }, '#ff00ff', 1.5);
    ctx.setLineDash([]);
    drawText(ctx, `${b.field} ${fmt(b.angle_deg, 0)}°`, x + rw + 36, by, '#ff00ff', 12, 'left');
  });
  drawText(ctx, `Développé ${fmt(dev)} mm`, x + rw / 2, y - 18, '#111', 13);
  drawText(ctx, `Lg ${fmt(len, 0)} mm`, x + rw / 2, y + rh + 18, '#111', 13);
}

function renderArticleSchema() {
  const { ctx, w, h } = prepareCanvas('articleSchema', 420, 150);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  const article = findArticle();
  if (!article) return;

  const defaultValues = {};
  article.schema.flatMap(g => g.fields).forEach(f => defaultValues[f.id] = f.default);
  const points = rotatePointsForScreen(buildPreviewPoints(article, defaultValues));
  const pts = normalizePoints(points, w, h, 32);

  for (let i = 0; i < pts.length - 1; i++) {
    drawLine(ctx, pts[i], pts[i + 1], '#111', 5);
    drawLine(ctx, pts[i], pts[i + 1], '#f9fbff', 2);
  }
  (article.geometry.segments || []).forEach((seg, i) => {
    if (i < pts.length - 1) {
      const p1 = pts[i], p2 = pts[i + 1];
      drawText(ctx, seg, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2 - 13, '#ff00ff', 14);
    }
  });
  (article.geometry.bends || []).forEach((bend, i) => {
    if (i + 1 < pts.length) drawText(ctx, bend, pts[i + 1].x + 10, pts[i + 1].y - 14, '#ff3333', 11, 'left');
  });
  drawText(ctx, article.label, 16, 16, '#333', 13, 'left');
}

function buildPreviewPoints(article, values) {
  const segs = article.geometry.segments || [];
  const bends = article.geometry.bends || [];
  const signs = article.geometry.turn_signs || [];
  let x = 0, y = 0, dir = 0;
  const pts = [[x, y]];
  segs.forEach((s, i) => {
    const length = Number(values[s] || 0);
    x += length * Math.cos(dir * Math.PI / 180);
    y += length * Math.sin(dir * Math.PI / 180);
    pts.push([x, y]);
    if (i < bends.length) dir += (signs[i] || 1) * Number(values[bends[i]] || 90);
  });
  return pts;
}


function asNumber(value, def = 0) {
  if (value === null || value === undefined || value === '') return def;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : def;
}

function safeFilename(name) {
  return String(name).replace(/[^a-zA-Z0-9_\-.]/g, '_');
}

function materialLookup(catalogue, materialId) {
  return (catalogue.materials || []).find(m => m.id === materialId || m.label === materialId) || (catalogue.materials || [{}])[0];
}

function articleLookup(catalogue, gammeId, articleId) {
  const gamme = (catalogue.gammes || []).find(g => g.id === gammeId);
  const article = gamme?.articles?.find(a => a.id === articleId);
  if (!article) throw new Error(`Article introuvable : ${gammeId}/${articleId}`);
  return article;
}

function bendAllowanceLocal(angleDeg, radiusMm, thicknessMm, kFactor) {
  return Math.abs(angleDeg) * Math.PI / 180 * (radiusMm + kFactor * thicknessMm);
}

function calculateLocal(catalogue, p) {
  const material = materialLookup(catalogue, p.material || catalogue.default_material);
  const article = articleLookup(catalogue, p.gamme, p.article);
  const values = p.values || {};
  const thickness = asNumber(p.thickness, 1);
  const qty = Math.max(1, Math.round(asNumber(p.quantity, 1)));
  const kFactor = asNumber(p.k_factor, asNumber(material.k_factor, 0.42));
  const radius = asNumber(p.radius, thickness * asNumber(material.default_radius_factor, 1));
  const segNames = article.geometry?.segments || [];
  const bendNames = article.geometry?.bends || [];
  const segmentLengths = segNames.map(s => asNumber(values[s], 0));
  const segmentSum = segmentLengths.reduce((a, b) => a + b, 0);
  const bends = bendNames.map(name => {
    const angle = asNumber(values[name], 90);
    return { field: name, angle_deg: angle, allowance_mm: bendAllowanceLocal(angle, radius, thickness, kFactor) };
  });
  const bendSum = bends.reduce((a, b) => a + b.allowance_mm, 0);
  const flatWidth = segmentSum + bendSum;
  const length = asNumber(values.Lg, asNumber(values.longueur, 0));
  const density = asNumber(material.density_kg_m3, 7850);
  const areaMm2 = flatWidth * length;
  const weightOne = areaMm2 * thickness * 1e-9 * density;
  const bendPositions = [];
  let cursor = 0;
  for (let i = 0; i < segNames.length - 1; i++) {
    cursor += asNumber(values[segNames[i]], 0);
    const bend = bends[i] || { field: `pli${i + 1}`, angle_deg: 90, allowance_mm: 0 };
    bendPositions.push({
      field: bend.field,
      position_mm: cursor + bend.allowance_mm / 2,
      angle_deg: bend.angle_deg,
      allowance_mm: bend.allowance_mm,
    });
    cursor += bend.allowance_mm;
  }
  const warnings = [];
  const limits = article.limits || {};
  if (length && limits.max_length && length > Number(limits.max_length)) warnings.push(`Longueur ${length.toFixed(0)} mm supérieure à la limite ${limits.max_length} mm.`);
  if (limits.max_flat_width && flatWidth > Number(limits.max_flat_width)) warnings.push(`Développé ${flatWidth.toFixed(1)} mm supérieur à la largeur maxi ${limits.max_flat_width} mm.`);
  if (limits.min_flat_width && flatWidth < Number(limits.min_flat_width)) warnings.push(`Développé ${flatWidth.toFixed(1)} mm inférieur à la largeur mini ${limits.min_flat_width} mm.`);
  return {
    article_title: article.title || p.article,
    article_id: p.article,
    gamme_id: p.gamme,
    material: material.label || p.material,
    material_ref: p.material_ref || null,
    thickness_mm: thickness,
    quantity: qty,
    radius_mm: radius,
    k_factor: kFactor,
    length_mm: length,
    segments: segNames.map((name, i) => ({ field: name, length_mm: segmentLengths[i] })),
    bends,
    bend_positions: bendPositions,
    flat_width_mm: flatWidth,
    developed_area_m2_one: areaMm2 / 1000000,
    developed_area_m2_total: areaMm2 * qty / 1000000,
    weight_kg_one: weightOne,
    weight_kg_total: weightOne * qty,
    profile_points: buildPreviewPoints(article, values),
    warnings,
    notes: article.geometry?.notes || '',
  };
}

function dxfLine(x1, y1, x2, y2, layer = 'CONTOUR') {
  return `0\nLINE\n8\n${layer}\n10\n${x1}\n20\n${y1}\n30\n0\n11\n${x2}\n21\n${y2}\n31\n0\n`;
}

function dxfText(text, x, y, height = 5, layer = 'TEXT') {
  return `0\nTEXT\n8\n${layer}\n10\n${x}\n20\n${y}\n30\n0\n40\n${height}\n1\n${text}\n`;
}

function buildDxfText(r) {
  const L = r.length_mm || 1000;
  const W = r.flat_width_mm || 100;
  let dxf = '0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n';
  dxf += dxfLine(0, 0, L, 0);
  dxf += dxfLine(L, 0, L, W);
  dxf += dxfLine(L, W, 0, W);
  dxf += dxfLine(0, W, 0, 0);
  (r.bend_positions || []).forEach(b => {
    dxf += dxfLine(0, b.position_mm, L, b.position_mm, 'PLIS');
    dxf += dxfText(`${b.field} ${Math.round(b.angle_deg)}deg`, 10, b.position_mm + 5, 5, 'TEXT');
  });
  dxf += dxfText(`${r.article_title} - dev ${r.flat_width_mm.toFixed(2)} mm - Lg ${r.length_mm.toFixed(0)} mm`, 10, W + 15, 6, 'TEXT');
  dxf += '0\nENDSEC\n0\nEOF\n';
  return dxf;
}

function buildFicheHtml(r, p) {
  const vals = p.values || {};
  const rows = Object.entries(vals).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  const bends = (r.bends || []).map(b => `<tr><td>${b.field}</td><td>${b.angle_deg.toFixed(0)}°</td><td>${b.allowance_mm.toFixed(2)} mm</td></tr>`).join('');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Fiche atelier</title>
  <style>body{font-family:Segoe UI,Arial,sans-serif;margin:28px;color:#111}h1{font-size:22px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}table{border-collapse:collapse;width:100%;margin:10px 0}td,th{border:1px solid #ccc;padding:7px;text-align:left}.big{font-size:18px;font-weight:700;background:#f3f7ff}.warn{color:#b00020}</style></head><body>
  <h1>Fiche atelier — ${r.article_title}</h1>
  <div class="grid"><section><h2>Commande</h2><table><tr><td>Affaire</td><td>${p.affaire || ''}</td></tr><tr><td>Matière</td><td>${r.material}</td></tr>${r.material_ref ? `<tr><td>Réf. matière</td><td>${r.material_ref}</td></tr>` : ''}<tr><td>Épaisseur</td><td>${r.thickness_mm} mm</td></tr><tr><td>Quantité</td><td>${r.quantity}</td></tr></table></section>
  <section><h2>Calculs</h2><table><tr class="big"><td>Développé</td><td>${r.flat_width_mm.toFixed(2)} mm</td></tr><tr><td>Longueur</td><td>${r.length_mm.toFixed(0)} mm</td></tr><tr><td>Poids total</td><td>${r.weight_kg_total.toFixed(3)} kg</td></tr><tr><td>K-factor</td><td>${r.k_factor.toFixed(3)}</td></tr></table></section></div>
  <h2>Saisies</h2><table>${rows}</table><h2>Plis</h2><table><tr><th>Pli</th><th>Angle</th><th>Compensation</th></tr>${bends}</table>
  ${(r.warnings || []).length ? `<h2 class="warn">Alertes</h2><ul>${r.warnings.map(w => `<li>${w}</li>`).join('')}</ul>` : ''}
  <p><em>Prototype : développé théorique à recaler avec vos tables atelier.</em></p></body></html>`;
}

async function exportDxf() {
  try {
    const data = await api('/api/export/dxf', payload());
    addLink('DXF généré', data.url, data.filename);
    setStatus('DXF généré');
  } catch (err) { setStatus('Erreur DXF : ' + err.message); }
}

async function exportFiche() {
  try {
    const data = await api('/api/export/fiche', payload());
    addLink('Fiche atelier', data.url, data.filename);
    window.open(data.url, '_blank');
    setStatus('Fiche générée');
  } catch (err) { setStatus('Erreur fiche : ' + err.message); }
}

function addLink(label, url, filename = '') {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  if (filename && url.startsWith('blob:')) a.download = filename;
  a.textContent = `${label} : ${filename || url.split('/').pop()}`;
  $('exportLinks').prepend(a);
}

async function copyJson() {
  const text = JSON.stringify(payload(), null, 2);
  await navigator.clipboard.writeText(text);
  setStatus('JSON commande copié');
}

async function main() {
  try {
    state.catalogue = await api('/api/catalogue');
    enrichCatalogueWithPlialu(state.catalogue);
    initSelectors();
    initFolderNavigation();
    await recalc();
  } catch (err) {
    setStatus('Erreur chargement : ' + err.message);
  }
}

main();

let resizeTimer = null;


function initFolderNavigation() {
  const picker = $('folderPicker');
  const button = $('btnPickFolder');
  if (!picker || !button) return;

  button.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    renderFolderTree(Array.from(picker.files || []));
  });
}

const HIDDEN_FILE_PATTERNS = [/^\./, /^Thumbs\.db$/i, /^desktop\.ini$/i, /^\$/];

function isHidden(name) {
  return HIDDEN_FILE_PATTERNS.some((re) => re.test(name));
}

function buildFolderTree(files) {
  const root = { folders: new Map(), files: [] };
  files.forEach((file) => {
    const parts = (file.webkitRelativePath || file.name || '').split('/').filter(Boolean);
    if (!parts.length || parts.some(isHidden)) return;
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      if (!node.folders.has(name)) {
        node.folders.set(name, { folders: new Map(), files: [] });
      }
      node = node.folders.get(name);
    }
    node.files.push(parts[parts.length - 1]);
  });
  return root;
}

function compareFr(a, b) {
  return a.localeCompare(b, 'fr', { sensitivity: 'base', numeric: true });
}

function renderTreeNode(node) {
  const folderNames = Array.from(node.folders.keys()).sort(compareFr);
  const fileNames = node.files.slice().sort(compareFr);
  const items = [];
  folderNames.forEach((name) => {
    items.push(
      `<li class="folder-item"><details open><summary>${escapeHtml(name)}</summary>${renderTreeNode(node.folders.get(name))}</details></li>`
    );
  });
  fileNames.forEach((name) => {
    items.push(`<li class="file-item">${escapeHtml(name)}</li>`);
  });
  return `<ul>${items.join('')}</ul>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderFolderTree(files) {
  const folderList = $('folderList');
  if (!folderList) return;
  if (!files.length) {
    folderList.innerHTML = '<li class="muted">Aucun dossier chargé.</li>';
    return;
  }

  const tree = buildFolderTree(files);
  if (!tree.folders.size && !tree.files.length) {
    folderList.innerHTML = '<li class="muted">Dossier vide ou fichiers masqués.</li>';
    return;
  }

  folderList.innerHTML = renderTreeNode(tree).replace(/^<ul>|<\/ul>$/g, '');
}
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    try {
      renderArticleSchema();
      if (state.result) renderPreviews(state.result);
    } catch (_) {}
  }, 120);
});
