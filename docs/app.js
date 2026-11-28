'use strict';

/* =====================================================================
   RezeptBibliothek – Web-App (GitHub Pages + Supabase)
   - Anmeldung: E-Mail + Passwort (oder Magic Link) über Supabase Auth.
     Eingeladene Benutzer müssen KEIN GitHub-Konto haben.
   - Nur der Besitzer (OWNER_EMAIL) kann Rezepte erstellen/bearbeiten/löschen
     und Mitglieder per E-Mail einladen. Mitglieder: nur Lesen (RLS), Favoriten, PDF, Cookidoo-URL.
   - KI (Mistral) nur für Besitzer; Key lokal im Browser (localStorage).
   ===================================================================== */

const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

const CATEGORIES = ['Alle', 'Allgemein', 'Suppen', 'Hauptgerichte', 'Desserts', 'Backen', 'Getränke'];
const DEVICES = [
  { id: 'free', label: 'Freies Kochen', short: 'Frei',
    prompt: 'Gerät: Freies Kochen (Herd, Topf, Pfanne – kein elektrisches Küchengerät). Formuliere alle Zubereitungsschritte als normale Herd-/Topf-Schritte ohne Gerät.' },
  { id: 'thermomix', label: 'Thermomix (TM6/TM7)', short: 'TM6/TM7',
    prompt: 'Gerät: Thermomix TM6/TM7. Formuliere die Zubereitung als TM-Schritte mit Temperatur (°C), Stufe und Zeit (z. B. „3 Min. | 120 °C | Stufe 1“).' },
  { id: 'monsieur', label: 'Lidl Monsieur Cuisine', short: 'MC',
    prompt: 'Gerät: Lidl Monsieur Cuisine (Connect). Formuliere die Zubereitung als Monsieur-Cuisine-Schritte (z. B. „Rühren“, „Dämpfen“, „Kneten“, „Garen“ mit Temperatur, Stufe und Zeit).' },
];
const deviceById = id => DEVICES.find(d => d.id === id) || DEVICES[1];

/* ---------------- State ---------------- */
const state = {
  user: null,
  profile: null,
  isOwner: false,
  mistralKey: localStorage.getItem('mistral_key') || '',
  recipes: [],
  groups: [],
  groupMembers: {},
  favorites: new Set(),
  route: parseRoute(),
  filter: { q: '', category: 'Alle', device: 'Alle' },
  device: localStorage.getItem('rb_device') || 'thermomix',
  fallbackSkill: '',
};

/* ---------------- Helfer ---------------- */
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
const nowISO = () => new Date().toISOString();
const fmtDate = iso => { try { return new Date(iso).toLocaleString('de-DE'); } catch { return ''; } };

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean);
  return { name: parts[0] || 'bibliothek', a: parts[1], b: parts[2] };
}

/* ---------------- Mistral API (nur Besitzer) ---------------- */
async function mistral(path, { method = 'GET', body } = {}) {
  if (!state.mistralKey) throw new Error('Kein Mistral-API-Key hinterlegt (Einstellungen).');
  const res = await fetch('https://api.mistral.ai' + path, {
    method,
    headers: { 'Authorization': `Bearer ${state.mistralKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Mistral: ' + (data?.error?.message || res.status + ' ' + res.statusText));
  return data;
}

/* ---------------- Cookidoo (schema.org JSON-LD via öffentlichem Storage) ---------------- */
function mdToSchema(r) {
  const lines = (r.markdown || '').split('\n');
  let name = r.title, yield_ = '', section = '';
  const ingredients = [], steps = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line === '---') continue;
    if (line.startsWith('# ')) { name = line.slice(2).trim(); continue; }
    if (line.startsWith('## ')) { section = line.slice(3).trim().toLowerCase(); continue; }
    if (/portionen/i.test(line)) { const m = line.match(/Portionen:?\*\*\s*([^|]+)/i); if (m) yield_ = m[1].trim(); continue; }
    if (/^(zutaten|ingredients)/.test(section) && (line.startsWith('- ') || line.startsWith('* '))) {
      ingredients.push(line.replace(/^[-*]\s*/, '').replace(/\*\*/g, '').trim());
    } else if (/^(zubereitung|preparation|steps|schritte)/.test(section)) {
      const t = line.replace(/^\d+[.)]\s*/, '').replace(/^\*\*Schritt \d+\*\*\s*/i, '').replace(/\*\*/g, '').trim();
      if (t) steps.push(t);
    }
  }
  return { name, yield: yield_, ingredients, steps };
}

function cookidooHTML(r) {
  const s = mdToSchema(r);
  const schema = {
    '@context': 'https://schema.org', '@type': 'Recipe', name: s.name,
    recipeIngredient: s.ingredients,
    recipeInstructions: s.steps.map((t, i) => ({ '@type': 'HowToStep', position: i + 1, text: t })),
    datePublished: r.created_at,
  };
  if (s.yield) schema.recipeYield = s.yield;
  const ing = s.ingredients.map(i => `<li>${esc(i)}</li>`).join('\n');
  const steps = s.steps.map((t, i) => `<li><b>Schritt ${i + 1}:</b> ${esc(t)}</li>`).join('\n');
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${esc(s.name)}</title>
<script type="application/ld+json">${JSON.stringify(schema)}</script>
<style>body{font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;line-height:1.5}h1{font-size:24px}h2{font-size:18px;margin-top:24px;border-bottom:1px solid #ddd;padding-bottom:4px}</style>
</head><body>
<h1>${esc(s.name)}</h1>
${s.yield ? `<p><b>Portionen:</b> ${esc(s.yield)}</p>` : ''}
<h2>Zutaten</h2><ul>${ing}</ul>
<h2>Zubereitung</h2><ol>${steps}</ol>
<p><small>Erstellt mit RezeptBibliothek</small></p>
</body></html>`;
}

async function cookidooURL(r) {
  const path = `cookidoo/${r.id}.html`;
  const { error } = await sb.storage.from('cookidoo').upload(path, cookidooHTML(r), { contentType: 'text/html', upsert: true });
  if (error) throw new Error('Upload fehlgeschlagen: ' + error.message);
  const { data } = sb.storage.from('cookidoo').getPublicUrl(path);
  if (state.isOwner && r.cookidoo_path !== path) {
    await sb.from('recipes').update({ cookidoo_path: path, updated_at: nowISO() }).eq('id', r.id);
  }
  return data.publicUrl;
}

/* ---------------- KI ---------------- */
async function getSkillBody() {
  if (state.mistralKey) {
    try {
      const skill = await mistral('/v2/skills/skill:rezepte-thermomix?alias=main');
      if (skill?.definition?.body) return { body: skill.definition.body, source: 'Mistral Studio (Skill rezepte-thermomix)' };
    } catch (e) { console.warn('Skill nicht erreichbar, Fallback:', e.message); }
  }
  if (!state.fallbackSkill) {
    try { state.fallbackSkill = await (await fetch('fallback-skill.md')).text(); } catch { state.fallbackSkill = ''; }
  }
  return { body: state.fallbackSkill, source: 'Eingebettete Skill-Kopie' };
}
function buildSystemPrompt(skillBody, device) {
  return skillBody + '\n\n# Zusatz für die API-Nutzung\nGib ausschließlich das fertige Rezept als Markdown-Dokument zurück (Rezepttitel als H1). Keine Einleitung, keine Erklärung.\n\n# Gerät\n' + device.prompt;
}
async function aiChat(systemPrompt, userMessage) {
  const res = await mistral('/v1/chat/completions', {
    method: 'POST',
    body: { model: 'mistral-large-latest', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }], temperature: 0.4, max_tokens: 4096 },
  });
  let content = res?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) content = content.map(p => p.text || '').join('');
  if (!content) throw new Error('KI hat keine Antwort geliefert.');
  content = content.trim();
  if (content.startsWith('```')) content = content.replace(/^```[a-z]*\n/i, '').replace(/```$/, '').trim();
  return content;
}
function extractTitle(markdown) {
  for (const line of markdown.split('\n')) {
    const t = line.trim();
    if (t.startsWith('# ')) return t.slice(2).trim();
  }
  return 'Neues Rezept';
}

/* ---------------- Daten laden ---------------- */
async function loadAll() {
  const [recipes, groups, gm] = await Promise.all([
    sb.from('recipes').select('*').order('updated_at', { ascending: false }),
    sb.from('groups').select('*').order('created_at'),
    sb.from('group_members').select('group_id, user_id'),
  ]);
  state.recipes = recipes.data || [];
  state.groups = groups.data || [];
  state.favorites = new Set(JSON.parse(localStorage.getItem('rb_favs') || '[]'));
  state.groupMembers = {};
  for (const m of (gm.data || [])) (state.groupMembers[m.group_id] ||= []).push(m.user_id);
  for (const r of state.recipes) r.favorite = state.favorites.has(r.id);
}

async function onAuth(user) {
  state.user = user;
  const email = (user.email || '').toLowerCase();
  let { data: profile, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (!profile) {
    await new Promise(r => setTimeout(r, 800));
    profile = (await sb.from('profiles').select('*').eq('id', user.id).maybeSingle()).data;
  }
  // ohne Profil: öffentlich lesbar, is_owner = false
  state.profile = profile || { is_owner: false };
  state.isOwner = !!profile?.is_owner;
  await loadAll();
  location.hash = '#/bibliothek';
  App.render();
}

/* ---------------- App ---------------- */
window.App = {

  async boot() {
    const { data } = await sb.auth.getSession();
    if (data.session) await onAuth(data.session.user);
    else { await loadAll(); App.render(); }
    sb.auth.onAuthStateChange((_e, session) => {
      if (session && !state.user) onAuth(session.user);
      if (!session && state.user) { state.user = null; state.profile = null; state.isOwner = false; App.render(); }
    });
  },

  openOwnerLogin() {
    App.openModal(`
      <h3>🔑 Besitzer-Login</h3>
      <div class="field"><label>E-Mail</label><input id="login-email" type="email" autocomplete="username" placeholder="owner@beispiel.de"></div>
      <div class="field"><label>Passwort</label><input id="login-password" type="password" autocomplete="current-password" placeholder="••••••"></div>
      <div id="login-status" class="status"></div>
      <div id="login-error" class="error"></div>
      <div class="actions">
        <button class="btn" onclick="App.closeModal()">Abbrechen</button>
        <button class="btn primary" onclick="App.login()">Anmelden</button>
      </div>
    `);
    $('#login-email').focus();
  },

  async login() {
    const email = $('#login-email').value.trim();
    const password = $('#login-password').value;
    $('#login-status').innerHTML = '<span class="spinner"></span>Anmeldung …';
    $('#login-error').textContent = '';
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) { $('#login-status').textContent = ''; $('#login-error').textContent = 'Anmeldung fehlgeschlagen: ' + error.message; return; }
    App.closeModal();
    // onAuthStateChange übernimmt onAuth()
  },

  async logout() {
    localStorage.removeItem('mistral_key');
    state.mistralKey = '';
    await sb.auth.signOut();
    state.user = null; state.profile = null; state.isOwner = false;
    location.hash = '';
    App.render();
  },

  nav(name) { location.hash = '#/' + name; },
  setFilter(key, value) { state.filter[key] = value; App.renderList(); },
  setDevice(id) { state.device = id; localStorage.setItem('rb_device', id); App.render(); },

  renderList() {
    const listEl = $('#recipe-list');
    if (!listEl) return;
    const { q, category, device } = state.filter;
    let items = state.route.name === 'gruppe' ? state.recipes.filter(r => r.group_id === state.route.a) : state.recipes.filter(r => !r.group_id);
    if (q) items = items.filter(r => (r.title + ' ' + r.markdown).toLowerCase().includes(q.toLowerCase()));
    if (category !== 'Alle') items = items.filter(r => r.category === category);
    if (device !== 'Alle') items = items.filter(r => r.device === device);
    items = [...items].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    if (!items.length) { listEl.innerHTML = '<div class="empty">Keine Rezepte gefunden.</div>'; return; }
    listEl.innerHTML = items.map(r => `
      <div class="card" onclick="App.openRecipe('${esc(r.id)}')">
        <div class="title">${r.favorite ? '★ ' : ''}${esc(r.title)}</div>
        <div class="meta">
          <span class="badge">${esc(r.category)}</span>
          <span class="badge device">${esc(deviceById(r.device).short)}</span>
          <span>${esc(fmtDate(r.updated_at))}</span>
        </div>
      </div>`).join('');
  },

  openRecipe(id) {
    const base = state.route.name === 'gruppe' ? `#/gruppe/${state.route.a}` : '#/bibliothek';
    location.hash = base + '/' + id;
  },

  showRecipeDetail(id) {
    const r = state.recipes.find(x => x.id === id);
    const main = $('#main');
    if (!r) { main.innerHTML = '<div class="empty">Rezept nicht gefunden.</div>'; return; }
    const base = state.route.name === 'gruppe' ? `#/gruppe/${state.route.a}` : '#/bibliothek';
    const ownerButtons = state.isOwner ? `
        <button class="btn small" onclick="App.openAI('${esc(r.id)}')">Mit KI überarbeiten</button>
        <button class="btn small danger" onclick="App.deleteRecipe('${esc(r.id)}')">Löschen</button>` : '';
    main.innerHTML = `
      <div class="no-print detail-head">
        <button class="btn small" onclick="location.hash='${base}'">← Zurück</button>
        <h2>${r.favorite ? '★ ' : ''}${esc(r.title)}</h2>
        <button class="btn small" onclick="App.toggleFav('${esc(r.id)}')">${r.favorite ? '★ Favorit' : '☆ Favorit'}</button>
        <button class="btn small" onclick="App.printRecipe()">Als PDF drucken</button>
        <button class="btn small" onclick="App.openCookidoo('${esc(r.id)}')">🔗 Cookidoo-URL</button>
        ${ownerButtons}
      </div>
      <div class="meta" style="margin-bottom:10px">
        <span class="badge">${esc(r.category)}</span>
        <span class="badge device">${esc(deviceById(r.device).label)}</span>
        <span class="badge">${esc(fmtDate(r.updated_at))}</span>
        ${state.isOwner ? '' : '<span class="badge">schreibgeschützt</span>'}
      </div>
      <div id="print-area" class="article">${renderMarkdown(r.markdown)}</div>
    `;
  },

  async saveRecipe(recipe) {
    if (!state.isOwner) { alert('Nur der Besitzer kann Rezepte erstellen/bearbeiten.'); return; }
    const row = {
      title: recipe.title, category: recipe.category, device: recipe.device,
      markdown: recipe.markdown, group_id: recipe.group_id || null,
      updated_at: nowISO(),
    };
    let res;
    if (recipe.id && state.recipes.some(x => x.id === recipe.id)) {
      res = await sb.from('recipes').update(row).eq('id', recipe.id).select().single();
    } else {
      row.created_by = state.user.id;
      row.id = recipe.id || uid();
      res = await sb.from('recipes').insert(row).select().single();
    }
    if (res.error) { alert('Speichern fehlgeschlagen: ' + res.error.message); return; }
    await loadAll();
    App.render();
  },

  async deleteRecipe(id) {
    if (!state.isOwner) { alert('Nur der Besitzer kann löschen.'); return; }
    if (!confirm('Rezept wirklich löschen?')) return;
    await sb.from('recipes').delete().eq('id', id);
    await loadAll();
    history.back();
    App.render();
  },

  async toggleFav(id) {
    const favs = state.favorites;
    if (favs.has(id)) favs.delete(id); else favs.add(id);
    localStorage.setItem('rb_favs', JSON.stringify([...favs]));
    for (const r of state.recipes) r.favorite = favs.has(r.id);
    App.render();
  },

  openGroupModal() {
    if (!state.isOwner) { alert('Nur der Besitzer kann Gruppen erstellen.'); return; }
    App.openModal(`
      <h3>Neue Gruppe</h3>
      <div class="field"><label>Gruppenname</label><input id="group-name" placeholder="z. B. Familie"></div>
      <div id="group-error" class="error"></div>
      <div class="actions">
        <button class="btn" onclick="App.closeModal()">Abbrechen</button>
        <button class="btn primary" onclick="App.createGroup()">Gruppe erstellen</button>
      </div>
    `);
  },

  async createGroup() {
    const name = $('#group-name').value.trim();
    if (!name) { $('#group-error').textContent = 'Name eingeben.'; return; }
    const { data, error } = await sb.from('groups').insert({ name, created_by: state.user.id }).select().single();
    if (error) { $('#group-error').textContent = error.message; return; }
    await sb.from('group_members').insert({ group_id: data.id, user_id: state.user.id });
    App.closeModal();
    await loadAll();
    location.hash = '#/gruppe/' + data.id;
    App.render();
  },

  openAI(existingId) {
    if (!state.isOwner) { alert('Nur der Besitzer kann Rezepte mit der KI erstellen/überarbeiten.'); return; }
    const existing = existingId ? state.recipes.find(r => r.id === existingId) : null;
    const dev = DEVICES.map(d => `<button type="button" class="${state.device === d.id ? 'active' : ''}" onclick="App.setDevice('${d.id}')">${esc(d.short)}</button>`).join('');
    const groupOptions = ['<option value="">Bibliothek</option>']
      .concat(state.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`)).join('');
    App.openModal(`
      <h3>${existing ? 'Rezept mit KI überarbeiten' : 'Neues Rezept mit KI'}</h3>
      <div class="seg">${dev}</div>
      <div class="field">
        <label>${existing ? 'Änderungswunsch an die KI' : 'Dein Wunsch an die KI'}</label>
        <textarea id="ai-wish" rows="4" placeholder="${existing ? 'z. B. „weniger scharf, mehr Knoblauch“' : 'z. B. „Eine vegane Linsensuppe für 4 Personen, scharf, in 30 Minuten“'}"></textarea>
      </div>
      <div class="field"><label>Kategorie</label>
        <select id="ai-category">${CATEGORIES.filter(c => c !== 'Alle').map(c => `<option>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Ziel</label><select id="ai-group">${groupOptions}</select></div>
      <div id="ai-status" class="status"></div>
      <div id="ai-error" class="error"></div>
      <div class="actions">
        <button class="btn" onclick="App.closeModal()">Abbrechen</button>
        <button class="btn primary" onclick="App.runAI(${existing ? `'${existing.id}'` : 'null'})">${existing ? 'Überarbeiten (KI)' : 'Rezept generieren'}</button>
      </div>
      <div id="ai-preview"></div>
    `);
  },

  async runAI(existingId) {
    const wish = $('#ai-wish').value.trim();
    if (!wish) { $('#ai-error').textContent = 'Bitte Wunsch eingeben.'; return; }
    const category = $('#ai-category').value;
    const groupId = $('#ai-group').value || null;
    const device = deviceById(state.device);
    $('#ai-error').textContent = '';
    $('#ai-status').innerHTML = '<span class="spinner"></span>Skill wird geladen …';
    try {
      const skill = await getSkillBody();
      const systemPrompt = buildSystemPrompt(skill.body, device);
      let markdown;
      if (existingId) {
        const existing = state.recipes.find(r => r.id === existingId);
        $('#ai-status').textContent = 'KI überarbeitet das Rezept … (' + skill.source + ')';
        markdown = await aiChat(systemPrompt,
          'Überarbeite das folgende Rezept strikt gemäß diesem Änderungswunsch. Antworte ausschließlich mit dem vollständigen, überarbeiteten Rezept als Markdown.\n\nÄnderungswunsch:\n' + wish + '\n\nAktuelles Rezept:\n' + existing.markdown);
      } else {
        $('#ai-status').textContent = 'Rezept wird erstellt … (' + skill.source + ')';
        markdown = await aiChat(systemPrompt, wish);
      }
      const recipe = {
        id: existingId || null,
        title: extractTitle(markdown), category, device: device.id,
        markdown, group_id: groupId,
      };
      $('#ai-status').textContent = 'Fertig – speichern?';
      $('#ai-preview').innerHTML = `<div class="article">${renderMarkdown(markdown)}</div>
        <div class="actions">
          <button class="btn" onclick="App.closeModal()">Verwerfen</button>
          <button class="btn primary" onclick="App.saveAI()">${existingId ? 'Rezept aktualisieren' : 'Speichern'}</button>
        </div>`;
      window.__pendingAI = recipe;
    } catch (e) {
      $('#ai-error').textContent = e.message;
      $('#ai-status').textContent = '';
    }
  },

  async saveAI() {
    const recipe = window.__pendingAI;
    if (!recipe) return;
    App.closeModal();
    await App.saveRecipe(recipe);
  },

  async openCookidoo(id) {
    const r = state.recipes.find(x => x.id === id);
    if (!r) return;
    if (!confirm('Cookidoo-Import erzeugt eine ÖFFENTLICHE URL für dieses eine Rezept. Fortfahren?')) return;
    App.openModal(`<h3>Cookidoo-Import</h3><div id="cookidoo-status" class="status"><span class="spinner"></span>URL wird erzeugt …</div><div id="cookidoo-result"></div>`);
    try {
      const url = await cookidooURL(r);
      $('#cookidoo-status').textContent = '';
      $('#cookidoo-result').innerHTML = `
        <div class="field"><label>Import-URL (in Cookidoo einfügen)</label>
        <input id="cookidoo-url" readonly value="${esc(url)}" onclick="this.select()"></div>
        <div class="hint">Ablauf: <a href="https://cookidoo.de" target="_blank" rel="noopener">cookidoo.de</a> → „Meine Kreationen“ → „+“ → „Rezept importieren“ → URL einfügen → „Importieren". TM6/TM7-Einstellungen danach manuell ergänzen.</div>
        <div class="actions">
          <button class="btn primary" onclick="navigator.clipboard.writeText($('#cookidoo-url').value);this.textContent='Kopiert!'">URL kopieren</button>
          <button class="btn" onclick="App.closeModal()">Schließen</button>
        </div>`;
    } catch (e) {
      $('#cookidoo-status').textContent = '';
      $('#cookidoo-result').innerHTML = `<div class="error">${esc(e.message)}</div>
        <div class="actions"><button class="btn" onclick="App.closeModal()">Schließen</button></div>`;
    }
  },

  openSettings() {
    App.openModal(`
      <h3>Einstellungen</h3>
      <div class="field">
        <label>Mistral API-Key (lokal im Browser gespeichert; nur der Besitzer kann KI-Rezepte erstellen)</label>
        <input id="mistral-key" type="password" value="${esc(state.mistralKey)}" placeholder="sk-…">
        <div class="hint">Key erstellen: <a href="https://console.mistral.ai" target="_blank" rel="noopener">console.mistral.ai</a> → API Keys. Wird nur an api.mistral.ai gesendet.</div>
      </div>
      <div class="actions">
        <button class="btn" onclick="App.closeModal()">Abbrechen</button>
        <button class="btn primary" onclick="App.saveSettings()">Speichern</button>
      </div>
    `);
  },

  saveSettings() {
    state.mistralKey = $('#mistral-key').value.trim();
    localStorage.setItem('mistral_key', state.mistralKey);
    App.closeModal();
  },

  printRecipe() { window.print(); },

  openModal(html) { $('#modal-root').innerHTML = `<div class="modal-backdrop" onclick="if(event.target===this)App.closeModal()"><div class="modal">${html}</div></div>`; },
  closeModal() { $('#modal-root').innerHTML = ''; },

  render() {
    state.route = parseRoute();
    $('#app').innerHTML = viewShell();
    const r = state.route;
    if (r.name === 'gruppe' && r.a) {
      if (r.b) App.showRecipeDetail(r.b);
      else App.renderList();
    } else if ((r.name === 'bibliothek') && r.a) {
      App.showRecipeDetail(r.a);
    } else if (r.name === 'gruppen') {
      App.renderList();
    } else {
      App.renderList();
    }
  },
};

/* ---------------- Markdown ---------------- */
function renderMarkdown(md) {
  try {
    if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(md));
    if (window.marked) return marked.parse(md);
  } catch (e) { console.warn(e); }
  return '<pre>' + esc(md) + '</pre>';
}

/* ---------------- Views ---------------- */
function viewLogin() { return ''; } // Landing entfällt – Lesen ist öffentlich, Login über Topbar-Button

function viewShell() {
  const r = state.route;
  const groupsNav = state.groups.map(g => `
    <button class="nav-item ${r.name === 'gruppe' && r.a === g.id ? 'active' : ''}" onclick="location.hash='#/gruppe/${g.id}'">
      👥 ${esc(g.name)} (${(state.groupMembers[g.id] || []).length})
    </button>`).join('');
  const newGroupBtn = state.isOwner ? `<button class="btn small" style="margin-top:8px" onclick="App.openGroupModal()">+ Neue Gruppe</button>` : '';
  return `
  <div class="topbar no-print">
    <span class="logo">🍲 RezeptBibliothek</span>
    ${state.isOwner ? '<span class="badge">Besitzer</span>' : '<span class="badge">nur Lesen</span>'}
    <span class="spacer"></span>
    ${state.user
      ? `<span class="user">${esc(state.user.email)}</span>
         <button class="btn small" onclick="App.openSettings()">⚙️</button>
         <button class="btn small" onclick="App.logout()">Abmelden</button>`
      : `<button class="btn small" onclick="App.openOwnerLogin()">🔑 Besitzer-Login</button>`}
  </div>
  <div class="layout">
    <div class="sidebar no-print">
      <h3>Bibliothek</h3>
      <button class="nav-item ${r.name === 'bibliothek' ? 'active' : ''}" onclick="App.nav('bibliothek')">📖 Bibliothek (${state.recipes.filter(x => !x.group_id).length})</button>
      <h3>Gruppen</h3>
      ${groupsNav || '<div class="hint">Keine Gruppen.</div>'}
      ${newGroupBtn}
    </div>
    <div class="main" id="main">${viewMain()}</div>
  </div>`;
}

function viewMain() {
  const r = state.route;
  if (r.name === 'gruppen') {
    if (!state.groups.length) return '<div class="empty">Keine Gruppen.</div>';
    return `<h2>Gruppen</h2><div class="recipe-list">` + state.groups.map(g => `
      <div class="card" onclick="location.hash='#/gruppe/${g.id}'">
        <div class="title">👥 ${esc(g.name)}</div>
        <div class="meta"><span class="badge">${(state.groupMembers[g.id] || []).length} Mitglieder</span></div>
      </div>`).join('') + '</div>';
  }
  if (r.name === 'gruppe') {
    const g = state.groups.find(x => x.id === r.a);
    const aiBtn = state.isOwner ? `<button class="btn primary small" onclick="App.openAI(null)">✨ Neues Rezept mit KI</button>` : '';
    return `
      <div class="toolbar no-print">
        <h2 style="margin:0;flex:1">Gruppe: ${esc(g ? g.name : '')}</h2>
        ${aiBtn}
      </div>
      ${toolbarHtml()}
      <div class="recipe-list" id="recipe-list"></div>`;
  }
  const aiBtn = state.isOwner ? `<button class="btn primary small" onclick="App.openAI(null)">✨ Neues Rezept mit KI</button>` : '';
  return `
    <div class="toolbar no-print">
      <h2 style="margin:0;flex:1">Bibliothek</h2>
      ${aiBtn}
    </div>
    ${toolbarHtml()}
    <div class="recipe-list" id="recipe-list"></div>`;
}

function toolbarHtml() {
  const f = state.filter;
  return `
  <div class="toolbar no-print">
    <input type="search" placeholder="Suchen …" value="${esc(f.q)}" oninput="App.setFilter('q', this.value)">
    <select onchange="App.setFilter('category', this.value)">
      ${CATEGORIES.map(c => `<option ${f.category === c ? 'selected' : ''}>${c}</option>`).join('')}
    </select>
    <select onchange="App.setFilter('device', this.value)">
      <option value="Alle" ${f.device === 'Alle' ? 'selected' : ''}>Alle Geräte</option>
      ${DEVICES.map(d => `<option value="${d.id}" ${f.device === d.id ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}
    </select>
  </div>`;
}

/* ---------------- Router ---------------- */
window.addEventListener('hashchange', () => App.render());
App.boot();
