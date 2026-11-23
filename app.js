'use strict';
/* Shadchan Portal - demo build.
   All data lives in this browser (IndexedDB). No server, no account, no sending.
   Match suggestions come from a simple rules engine - ideas for the shadchan
   to review, not verified compatibility. Voice transcription and AI features
   are labeled honestly where they are not connected. */

/* ---------------- storage ---------------- */
const DB_NAME = 'shadchan-portal';
const DB_VER = 2;
let _dbp = null;

function openDB() {
  if (_dbp) return _dbp;
  _dbp = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('feedback')) db.createObjectStore('feedback', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('requests')) db.createObjectStore('requests', { keyPath: 'id' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return _dbp;
}
function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function storeAll(n) { if (window.__cs && n !== 'requests') return window.__cs.all(n); const db = await openDB(); return reqP(db.transaction(n).objectStore(n).getAll()); }
async function storeGet(n, k) { if (window.__cs && n !== 'requests') return window.__cs.get(n, k); const db = await openDB(); return reqP(db.transaction(n).objectStore(n).get(k)); }
async function storePut(n, v) { if (window.__cs && n !== 'requests') return window.__cs.put(n, v); const db = await openDB(); return reqP(db.transaction(n, 'readwrite').objectStore(n).put(v)); }
async function storeDel(n, k) { if (window.__cs && n !== 'requests') return window.__cs.del(n, k); const db = await openDB(); return reqP(db.transaction(n, 'readwrite').objectStore(n).delete(k)); }
async function storeClear(n) { if (window.__cs && n !== 'requests') return window.__cs.clear(n); const db = await openDB(); return reqP(db.transaction(n, 'readwrite').objectStore(n).clear()); }

async function ensureSeed() {
  if (window.__cs) return;
  const existing = await storeAll('profiles');
  if (!existing || existing.length === 0) {
    for (const p of SEED_PROFILES) await storePut('profiles', Object.assign({}, p));
    return;
  }
  // Remove the old synthetic cartoon portraits from demo seed profiles. Only a photo that is
  // exactly the old built-in illustration is cleared; any photo someone added is never touched.
  if (window.SEED_PORTRAITS) {
    for (const p of existing) {
      if (p.photo && window.SEED_PORTRAITS[p.id] === p.photo) {
        delete p.photo;
        await storePut('profiles', p);
      }
    }
  }
}

/* ---------------- utils ---------------- */
const app = document.getElementById('app');
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function uid() { return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob + 'T12:00:00');
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return a;
}
function dobFromAge(a) {
  const now = new Date();
  return (now.getFullYear() - a) + '-06-15';
}
function fmtWhen(ts) {
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function initials(name) {
  if (!name || !name.trim()) return '?';
  return name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}
function avatarHTML(p, cls) {
  const style = p.photo
    ? `background-image:url('${p.photo}')`
    : `background:${p.photoColor || '#0f4c46'}`;
  return `<div class="avatar ${cls || ''}" style="${style}">${p.photo ? '' : esc(initials(p.name))}</div>`;
}
function setActiveNav(key) {
  document.querySelectorAll('#bottomnav a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('data-nav') === key);
  });
}

/* ---------------- matching engine (rule-based, on-device) ---------------- */
const HASHKAFA_ORDER = ['Chassidish', 'Heimish', 'Yeshivish', 'Litvish', 'Modern Orthodox Machmir', 'Modern Orthodox', 'YU/Modern'];
const MOVIE_RANK = { 'No': 0, 'Rarely': 1, 'Occasionally': 2, 'Regularly': 3 };
const METRO = { 'Lakewood, NJ': 'nj', 'Teaneck, NJ': 'nj', 'Flatbush, Brooklyn': 'nyc', 'Boro Park, Brooklyn': 'nyc', 'Queens, NY': 'nyc', 'Five Towns, NY': 'nyc', 'Monsey, NY': 'rockland', 'Baltimore, MD': 'baltimore' };
const TRISTATE = ['nj', 'nyc', 'rockland'];
const STOPWORDS = new Set(['with', 'that', 'this', 'from', 'they', 'them', 'their', 'have', 'will', 'want', 'wants', 'looking', 'someone', 'years', 'year', 'good', 'very', 'girl', 'boy', 'nice', 'values', 'home', 'live']);

const DEFAULT_WEIGHTS = { age: 1, hashkafa: 1, lifestyle: 1, learning: 1, location: 1, keywords: 1 };
async function getWeights() {
  const r = await storeGet('meta', 'weights');
  return (r && r.w) ? r.w : Object.assign({}, DEFAULT_WEIGHTS);
}

function hIdx(h) { const i = HASHKAFA_ORDER.indexOf(h); return i < 0 ? 3 : i; }

function parseAgeRange(text) {
  const m = String(text || '').toLowerCase().match(/\b(1[89]|2\d|3\d)\s*(?:-|\u2013|to)\s*(1[89]|2\d|3\d|4\d)\b/);
  if (!m) return null;
  const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
  return [Math.min(a, b), Math.max(a, b)];
}

function heightText(p) {
  const ft = p.heightFt, inch = p.heightIn;
  const hf = ft !== undefined && ft !== null && ft !== '', hi = inch !== undefined && inch !== null && inch !== '';
  if (hf && hi) return `${ft}'${inch}"`;
  if (hf) return `${ft}' (inches not entered)`;
  if (hi) return `feet not entered, ${inch} in`;
  return p.height || '';
}
function nm(p) { return (p && p.name) || 'Unnamed profile'; }
function ageSfx(p) { const a = ageFromDob(p.dob); return a != null ? ', ' + a : ''; }
function firstName(p) { return (p.name || 'this person').split(' ')[0]; }

function scorePair(subject, cand, weights) {
  if (!subject || !cand || !subject.gender || !cand.gender || subject.gender === cand.gender) return null;
  const boy = subject.gender === 'M' ? subject : cand;
  const girl = subject.gender === 'M' ? cand : subject;
  const factors = [];

  // age: scored only against explicitly stated age preferences; no hidden convention
  if (boy.dob && girl.dob) {
    const ba = ageFromDob(boy.dob), ga = ageFromDob(girl.dob);
    const boyRange = parseAgeRange(boy.lookingFor);
    const girlRange = parseAgeRange(girl.lookingFor);
    const parts = [];
    const scores = [];
    if (girlRange) {
      const inR = ba >= girlRange[0] && ba <= girlRange[1];
      const near = !inR && ba >= girlRange[0] - 2 && ba <= girlRange[1] + 2;
      scores.push(inR ? 1 : near ? 0.55 : 0.2);
      parts.push({ line: `She is looking for ages ${girlRange[0]}-${girlRange[1]}; he is ${ba}${inR ? ' - inside her range' : ' - outside her range'}`, concern: !inR && !near });
    }
    if (boyRange) {
      const inR = ga >= boyRange[0] && ga <= boyRange[1];
      const near = !inR && ga >= boyRange[0] - 2 && ga <= boyRange[1] + 2;
      scores.push(inR ? 1 : near ? 0.55 : 0.2);
      parts.push({ line: `He is looking for ages ${boyRange[0]}-${boyRange[1]}; she is ${ga}${inR ? ' - inside his range' : ' - outside his range'}`, concern: !inR && !near });
    }
    if (scores.length) {
      const s = scores.reduce((a, b) => a + b, 0) / scores.length;
      factors.push({ key: 'age', score: s, line: parts.map(p => p.line).join('. '), concern: parts.some(p => p.concern) });
    } else {
      factors.push({ key: 'age', score: 0.5, line: `Ages ${ba} and ${ga} - neither profile states an age preference, so age is not counted for or against`, concern: false });
    }
  }

  // hashkafa
  if (boy.hashkafa && girl.hashkafa) {
    const d = Math.abs(hIdx(boy.hashkafa) - hIdx(girl.hashkafa));
    const s = Math.max(0.15, 1 - 0.22 * d);
    factors.push({
      key: 'hashkafa', score: s,
      line: d === 0 ? `Both ${boy.hashkafa}` : d <= 1 ? `${boy.hashkafa} and ${girl.hashkafa} - close hashkafos` : `Hashkafos differ: ${boy.hashkafa} and ${girl.hashkafa}`,
      concern: d >= 3
    });
  }

  // lifestyle (movies / music)
  if (boy.movies && girl.movies) {
    const dm = Math.abs((MOVIE_RANK[boy.movies] != null ? MOVIE_RANK[boy.movies] : 1) - (MOVIE_RANK[girl.movies] != null ? MOVIE_RANK[girl.movies] : 1));
    let s = Math.max(0.1, 1 - dm * 0.3);
    if ((boy.music || '').toLowerCase() === (girl.music || '').toLowerCase() && boy.music) s = Math.min(1, s + 0.15);
    factors.push({
      key: 'lifestyle', score: s,
      line: s >= 0.8 ? 'Similar attitude to music and movies' : `Different attitude to movies (${boy.movies} vs ${girl.movies})`,
      concern: s < 0.5
    });
  }

  // learning / work direction
  const lf = (girl.lookingFor || '').toLowerCase();
  const role = (boy.role || '').toLowerCase();
  if (lf && role) {
    const wantsLearner = /learner|learning|kollel|full-time/.test(lf);
    const wantsWorking = /working|professional|earner|job/.test(lf);
    const wantsLearnerEarner = /learner-earner/.test(lf);
    const isLearner = /learner|kollel|learning|yeshiva|yungerman|rebbe/.test(role);
    let s = 0.6, line = '', concern = false;
    if (wantsLearnerEarner && /learner-earner/.test(role)) { s = 1; line = 'She asked for a learner-earner and that is exactly what he is'; }
    else if (wantsLearner && isLearner) { s = 1; line = `She is looking for a learner and he is learning (${boy.role})`; }
    else if (wantsWorking && !isLearner) { s = 0.9; line = 'She is looking for someone working, and he is established in work'; }
    else if (wantsLearner && !isLearner) { s = 0.2; line = 'She is looking for a learner; he is not currently learning full-time'; concern = true; }
    if (line) factors.push({ key: 'learning', score: s, line, concern });
  }

  // location
  if (boy.location && girl.location) {
    const bm = METRO[boy.location] || 'other', gm = METRO[girl.location] || 'other';
    let s, line, concern = false;
    if (boy.location === girl.location) { s = 1; line = `Both in ${boy.location}`; }
    else if (bm === gm) { s = 0.85; line = `Same area (${boy.location} and ${girl.location})`; }
    else if (TRISTATE.includes(bm) && TRISTATE.includes(gm)) { s = 0.6; line = `Both tri-state (${boy.location} / ${girl.location})`; }
    else { s = 0.3; line = `Different cities (${boy.location} / ${girl.location})`; concern = true; }
    factors.push({ key: 'location', score: s, line, concern });
  }

  // keyword overlap between what the subject asks for and the candidate
  const askText = ((subject.lookingFor || '') + ' ' + (subject.summary || '')).toLowerCase();
  const candText = [cand.role, cand.personality, cand.hashkafa, cand.location, cand.summary, cand.lookingFor].join(' ').toLowerCase();
  const tokens = askText.split(/[^a-z\-']+/).filter(t => t.length > 3 && !STOPWORDS.has(t));
  const matched = [...new Set(tokens.filter(t => candText.includes(t)))].filter(t => !/^\d+$/.test(t));
  if (tokens.length) {
    const s = Math.min(1, matched.length / 3);
    factors.push({
      key: 'keywords', score: s,
      line: matched.length ? `Matches what ${firstName(subject)} described: ${matched.slice(0, 4).join(', ')}` : `Little overlap with what ${firstName(subject)} described`,
      concern: matched.length === 0
    });
  }

  if (!factors.length) return null;
  let sw = 0, ws = 0;
  for (const f of factors) { const w = weights[f.key] || 1; sw += w * f.score; ws += w; }
  const total = Math.round(100 * sw / ws);
  const reasons = factors.filter(f => !f.concern && f.line).sort((a, b) => b.score - a.score).slice(0, 4).map(f => f.line);
  const concerns = factors.filter(f => f.concern && f.line).map(f => f.line);
  return { total, reasons, concerns };
}

/* ---------------- feedback / learning ---------------- */
const FB_TAGS = ['Age gap', 'Hashkafa', 'Lifestyle', 'Learning / work', 'Location', 'Personality', 'Other'];
const TAG_TO_WEIGHT = { 'Age gap': 'age', 'Hashkafa': 'hashkafa', 'Lifestyle': 'lifestyle', 'Learning / work': 'learning', 'Location': 'location', 'Personality': 'keywords', 'Other': 'keywords' };
const fbState = {};

window.fbVerdict = function (cid, verdict) {
  fbState[cid] = fbState[cid] || {};
  fbState[cid].verdict = verdict;
  if (verdict === 'yes') {
    saveFeedback(cid, 'yes', [], '');
    const el = document.getElementById('fbnote-' + cid);
    if (el) el.style.display = 'block';
  } else {
    const el = document.getElementById('fbtags-' + cid);
    if (el) el.style.display = 'block';
  }
};
window.fbSaveYesNote = function (cid) {
  const comment = (document.getElementById('fbyn-' + cid) || {}).value || '';
  saveFeedback(cid, 'yes', [], comment);
};
window.fbTag = function (cid, tag) {
  fbState[cid] = fbState[cid] || {};
  fbState[cid].tags = fbState[cid].tags || {};
  fbState[cid].tags[tag] = !fbState[cid].tags[tag];
  const el = document.getElementById('fbtag-' + cid + '-' + tag.replace(/[^a-z]/gi, ''));
  if (el) el.classList.toggle('on', !!fbState[cid].tags[tag]);
};
window.fbSaveNo = function (cid) {
  const st = fbState[cid] || {};
  const tags = Object.keys(st.tags || {}).filter(t => st.tags[t]);
  const comment = (document.getElementById('fbc-' + cid) || {}).value || '';
  saveFeedback(cid, 'no', tags, comment);
};
async function saveFeedback(cid, verdict, tags, comment) {
  const sid = window._matchSubject;
  await storePut('feedback', { id: uid(), subjectId: sid, candId: cid, verdict, tags, comment, ts: Date.now() });
  fbState[cid] = fbState[cid] || {};
  fbState[cid].saved = verdict;
  if (verdict === 'no') {
    const w = await getWeights();
    for (const t of tags) {
      const k = TAG_TO_WEIGHT[t];
      if (k) w[k] = Math.min(2.2, (w[k] || 1) + 0.2);
    }
    await storePut('meta', { id: 'weights', w });
  }
  render();
}

/* ---------------- voice notes ---------------- */
const REC = {};
window.toggleRec = async function (key) {
  if (REC[key]) {
    try { REC[key].stop(); } catch (e) {}
    return;
  }
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    alert('Voice recording is not available in this browser. You can still type notes.');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    alert('Microphone permission was not granted, so the voice note could not be recorded. Typed notes work fine.');
    return;
  }
  const mr = new MediaRecorder(stream);
  const chunks = [];
  mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  mr.onerror = () => { hideRecBar(key); };
  mr.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    delete REC[key];
    hideRecBar(key);
    const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
    if (key === 'ask') {
      window._askAudio = blob;
    } else if (key === 'new') {
      window._newAudio = blob;
      updateNewAudioWrap();
      return;
    } else {
      await storePut('notes', { id: uid(), profileId: key, type: 'audio', blob, mime: blob.type, ts: Date.now() });
    }
    render();
  };
  mr.start();
  REC[key] = mr;
  showRecBar(key);
  const btn = document.getElementById('rec-' + key);
  if (btn) { btn.textContent = 'Stop and save'; btn.classList.add('danger'); }
};

// Recording bar: visible only while a real MediaRecorder is running.
// The pulsing dot and timer are driven by actual recorder state, not animation alone.
function showRecBar(key) {
  hideRecBar();
  const bar = document.createElement('div');
  bar.id = 'recbar';
  bar.innerHTML = `<span class="recdot"></span><span class="rectext">Recording</span><span class="rectime" id="rectime">0:00</span><button class="recstop" id="recstop">Stop and save</button>`;
  document.body.appendChild(bar);
  const started = Date.now();
  REC._timer = setInterval(() => {
    if (!REC[key] || REC[key].state !== 'recording') { hideRecBar(); return; }
    const s = Math.floor((Date.now() - started) / 1000);
    const el = document.getElementById('rectime');
    if (el) el.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }, 500);
  document.getElementById('recstop').onclick = () => {
    if (REC[key]) { try { REC[key].stop(); } catch (e) {} }
  };
}
function hideRecBar() {
  if (REC._timer) { clearInterval(REC._timer); delete REC._timer; }
  const bar = document.getElementById('recbar');
  if (bar) bar.remove();
}

/* ---------------- views ---------------- */
async function render() {
  const hash = location.hash || '#/';
  // Never silently lose a recorded voice note on the Add form: ask before leaving it behind.
  if (window._newAudio && !hash.startsWith('#/add') && !window._newAudioKeep) {
    if (confirm('You recorded a voice note that is not saved with a profile yet. Discard it?')) {
      window._newAudio = null;
    } else {
      location.hash = '#/add';
      return;
    }
  }
  window._newAudioKeep = false;
  const parts = hash.slice(2).split('/');
  const key = parts[0] === 'profile' || parts[0] === 'match' || parts[0] === 'share' ? '' : parts[0];
  setActiveNav(key === 'edit' ? 'add' : key);
  try {
    if (parts[0] === '' || parts[0] === undefined) return await viewProfiles();
    if (parts[0] === 'profile') return await viewProfile(parts[1]);
    if (parts[0] === 'add') return await viewForm(null);
    if (parts[0] === 'edit') return await viewForm(parts[1]);
    if (parts[0] === 'match') return await viewMatch(parts[1]);
    if (parts[0] === 'ask') return await viewAsk();
    if (parts[0] === 'requests') return await viewRequests();
    if (parts[0] === 'request') return await viewRequest(parts[1]);
    if (parts[0] === 'reply') return await viewReplyPreview(parts[1]);
    if (parts[0] === 'share') return await viewShare(parts[1]);
    if (parts[0] === 'settings') return await viewSettings();
    return await viewProfiles();
  } catch (e) {
    app.innerHTML = `<div class="card"><p>Something went wrong showing this page: ${esc(e.message)}</p><p><a class="btn ghost" href="#/">Back to profiles</a></p></div>`;
  }
}

let _plistFilter = 'all', _plistQ = '';
let _pf = { learnTerm: '', workType: '', town: '', city: '', ageMin: '', ageMax: '' }, _pfOpen = false;
const _pfActive = () => Object.values(_pf).filter(Boolean).length;
async function viewProfiles() {
  const profiles = (await storeAll('profiles')).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const q = _plistQ.toLowerCase();
  const list = profiles.filter(p => {
    if (_plistFilter === 'boys' && p.gender !== 'M') return false;
    if (_plistFilter === 'girls' && p.gender !== 'F') return false;
    if (_plistFilter === 'unset' && (p.gender === 'M' || p.gender === 'F')) return false;
    if (_pf.learnTerm && p.learnTerm !== _pf.learnTerm) return false;
    if (_pf.workType && p.workType !== _pf.workType) return false;
    if (_pf.town && p.town !== _pf.town) return false;
    if (_pf.ageMin !== '' || _pf.ageMax !== '') {
      const ag = ageFromDob(p.dob);
      if (ag == null) return false;
      if (_pf.ageMin !== '' && ag < Number(_pf.ageMin)) return false;
      if (_pf.ageMax !== '' && ag > Number(_pf.ageMax)) return false;
    }
    if (_pf.city.trim() && !String(p.location || '').toLowerCase().includes(_pf.city.trim().toLowerCase())) return false;
    if (q && !((p.name || '') + ' ' + (p.location || '') + ' ' + (p.hashkafa || '') + ' ' + (p.summary || '')).toLowerCase().includes(q)) return false;
    return true;
  });
  app.innerHTML = `
    <input class="searchbar" id="pq" placeholder="Search name, place, hashkafa..." value="${esc(_plistQ)}">
    <div class="chiprow">
      <button class="chip ${_plistFilter === 'all' ? 'on' : ''}" onclick="plistFilter('all')">All (${profiles.length})</button>
      <button class="chip ${_plistFilter === 'boys' ? 'on' : ''}" onclick="plistFilter('boys')">Boys (${profiles.filter(p => p.gender === 'M').length})</button>
      <button class="chip ${_plistFilter === 'girls' ? 'on' : ''}" onclick="plistFilter('girls')">Girls (${profiles.filter(p => p.gender === 'F').length})</button>
      ${profiles.some(p => p.gender !== 'M' && p.gender !== 'F') ? `<button class="chip ${_plistFilter === 'unset' ? 'on' : ''}" onclick="plistFilter('unset')">Gender not set (${profiles.filter(p => p.gender !== 'M' && p.gender !== 'F').length})</button>` : ''}
    </div>
    <details class="filterbox" ${_pfOpen || _pfActive() ? 'open' : ''} ontoggle="_pfOpen=this.open"><summary>Filters${_pfActive() ? ` (${_pfActive()} on)` : ''}</summary>
      <div class="filtergrid">
        <label class="field">Learner<select onchange="pfSet('learnTerm',this.value)"><option value="">Any</option>${['Short-term learner', 'Long-term learner'].map(o => `<option ${_pf.learnTerm === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
        <label class="field">Working or learning<select onchange="pfSet('workType',this.value)"><option value="">Any</option>${['Working', 'Learning'].map(o => `<option ${_pf.workType === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
        <div class="field"><span class="flabel">Town</span><div class="townchips"><button type="button" class="chip ${_pf.town === 'In town' ? 'on' : ''}" onclick="pfSet('town', _pf.town === 'In town' ? '' : 'In town')">In town</button><button type="button" class="chip ${_pf.town === 'Out of town' ? 'on' : ''}" onclick="pfSet('town', _pf.town === 'Out of town' ? '' : 'Out of town')">Out of town</button></div></div>
        <div class="field"><span class="flabel">Age</span><div class="agerow"><input id="pfamin" type="number" inputmode="numeric" min="0" max="120" placeholder="Min" value="${esc(_pf.ageMin)}" oninput="pfAge('ageMin',this.value,'pfamin')"><span>to</span><input id="pfamax" type="number" inputmode="numeric" min="0" max="120" placeholder="Max" value="${esc(_pf.ageMax)}" oninput="pfAge('ageMax',this.value,'pfamax')"></div></div>
        <label class="field">City (typed)<input id="pfcity" value="${esc(_pf.city)}" placeholder="Any city" autocapitalize="words" oninput="pfSet('city',this.value,true)"></label>
      </div>
      <div class="small muted">City is typed. It matches any part of "Where they live", so "Lake" finds Lakewood. Age comes from the date of birth. Profiles missing a detail are hidden while that filter is on.</div>
      ${_pfActive() ? '<button class="btn subtle" onclick="pfClear()">Clear filters</button>' : ''}
    </details>
    ${list.length < profiles.length ? `<div class="banner small">Showing ${list.length} of ${profiles.length} profiles. ${profiles.length - list.length} hidden by the filter or search. <a href="javascript:void(0)" onclick="_plistQ='';_pf={learnTerm:'',workType:'',town:'',city:'',ageMin:'',ageMax:''};plistFilter('all')">Show all</a></div>` : ''}
    <div class="pgrid">
    ${list.map(p => `
      <a class="ptile" href="#/profile/${p.id}">
        ${p.photo
          ? `<div class="pphoto" style="background-image:url('${p.photo}')"></div>`
          : `<div class="pphoto noimg" style="background:${p.photoColor || '#0d443e'}">${esc(initials(p.name))}</div>`}
        <div class="pbody">
          <div class="pname">${esc(nm(p))}${ageSfx(p)}</div>
          <div class="psub">${esc(p.location || '')}</div>
          <div class="tagline"><span class="tag">${esc(p.hashkafa)}</span></div>
        </div>
      </a>`).join('') || '<p class="muted">No profiles match.</p>'}
    </div>
  `;
  document.getElementById('pq').addEventListener('input', e => { _plistQ = e.target.value; viewProfiles(); });
}
window.pfSet = function (k, v, keepFocus) { _pf[k] = v; viewProfiles().then(() => { if (keepFocus) { const e = document.getElementById('pfcity'); if (e) { e.focus(); e.setSelectionRange(v.length, v.length); } } }); };
window.pfAge = function (k, v, id) { _pf[k] = v; viewProfiles().then(() => { const e = document.getElementById(id); if (e) { e.focus(); try { e.setSelectionRange(v.length, v.length); } catch (x) {} } }); };
window.chipPick = function (btn, val) { const wrap = btn.closest('.chipfield'); const inp = wrap.querySelector('input[type=hidden]'); const off = inp.value === val; inp.value = off ? '' : val; wrap.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', !off && c.textContent === val)); };
window.pfClear = function () { _pf = { learnTerm: '', workType: '', town: '', city: '', ageMin: '', ageMax: '' }; viewProfiles(); };
window.plistFilter = function (f) { _plistFilter = f; viewProfiles(); };

const PROFILE_FIELDS = [
  ['name', 'Full name', 'text', false],
  ['gender', 'Boy or girl', 'select:This profile is a,Boy,Girl', false],
  ['dob', 'Date of birth', 'date', false],
  ['heightFt', 'Height: feet', 'number', false],
  ['heightIn', 'Height: inches (0 to 11)', 'number', false],
  ['location', 'Where they live', 'text', false],
  ['community', 'Community / neighborhood', 'text', false],
  ['hashkafa', 'Hashkafa', 'selecthashkafa', false],
  ['role', 'What they do (learning / work)', 'text', false],
  ['workType', 'Working or learning', 'select:,Working,Learning', false],
  ['learnTerm', 'Learner', 'select:,Short-term learner,Long-term learner', false],
  ['town', 'In town or out of town', 'chips:In town,Out of town', false],
  ['rav', 'Rav', 'text', false],
  ['minyan', 'Minyan', 'text', false],
  ['koveaItim', 'Kovea itim', 'text', false],
  ['music', 'Attitude to music', 'select:,Frum music only,Frum music,Jewish music,Chassidish music,Frum and pop,Open', false],
  ['movies', 'Attitude to movies', 'select:,No,Rarely,Occasionally,Regularly', false],
  ['personality', 'Personality', 'textarea', false],
  ['family', 'Family background', 'textarea', false],
  ['lookingFor', 'What they are looking for', 'textarea', false],
  ['summary', 'Profile synopsis (editable, shareable)', 'textarea', false]
];

async function viewForm(editId) {
  const p = editId ? await storeGet('profiles', editId) : {};
  if (editId && p && p.height && p.heightFt === undefined) { const m = String(p.height).match(/^\s*(\d)\s*['\u2019]\s*(\d{1,2})/); if (m) { p.heightFt = m[1]; p.heightIn = m[2]; } }
  if (editId && !p) { location.hash = '#/'; return; }
  const fields = PROFILE_FIELDS.map(([k, label, type, req]) => {
    const v = p[k] || '';
    if (k === 'heightIn') return '';
    if (k === 'heightFt') return `<div class="field heightrow"><div class="hlabel">Height</div><div class="hline"><label><input type="number" name="heightFt" inputmode="numeric" min="1" max="8" step="1" value="${esc(p.heightFt || '')}" aria-label="Height, feet"><span>ft</span></label><label><input type="number" name="heightIn" inputmode="numeric" min="0" max="11" step="1" value="${esc(p.heightIn || '')}" aria-label="Height, inches"><span>in</span></label></div></div>`;
    if (type === 'textarea') return `<label class="field">${label}<textarea name="${k}">${esc(v)}</textarea></label>`;
    if (type === 'selecthashkafa') {
      return `<label class="field">${label}<select name="${k}"><option value=""></option>${HASHKAFA_ORDER.map(h => `<option ${v === h ? 'selected' : ''}>${h}</option>`).join('')}</select></label>`;
    }
    if (type.startsWith('chips:')) {
      const opts = type.slice(6).split(',');
      return `<div class="field chipfield"><span class="flabel">${label}</span><input type="hidden" name="${k}" value="${esc(v)}"><div class="townchips">${opts.map(o => `<button type="button" class="chip ${v === o ? 'on' : ''}" onclick="chipPick(this,'${o}')">${esc(o)}</button>`).join('')}</div></div>`;
    }
    if (type.startsWith('select:')) {
      const opts = type.slice(7).split(',');
      return `<label class="field">${label}<select name="${k}">${opts.map(o => {
        const val = o === 'Boy' ? 'M' : o === 'Girl' ? 'F' : o;
        return `<option value="${esc(val)}" ${v === val ? 'selected' : ''}>${esc(o)}</option>`;
      }).join('')}</select></label>`;
    }
    return `<label class="field">${label}<input type="${type}" name="${k}" value="${esc(v)}" ${req ? 'required' : ''}></label>`;
  }).join('');
  app.innerHTML = `
    <h2>${editId ? 'Edit profile' : 'Add a profile'}</h2>
    <p class="small muted" style="margin:0 0 12px">Fictional demo profiles only, please. Basics go in the shareable profile; private notes you add later stay private and are never shared.</p>
    <form id="pform" novalidate>
      <div class="banner warn" id="formMissing" style="display:none"></div>
      <div class="photopick">
        <div class="pp-circle ${p.photo ? 'hasimg' : ''}" id="ppcircle" onclick="document.getElementById('fphoto').click()" ${p.photo ? `style="background-image:url('${p.photo}')"` : ''}>
          ${p.photo ? '' : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-2.5h6L17 8h3a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 18V9.5A1.5 1.5 0 0 1 4 8Z"/><circle cx="12" cy="13" r="3.5"/></svg><span class="pp-label">Add photo</span>`}
        </div>
        <div class="pp-hint" id="pphint">${p.photo ? 'Tap the photo to change it' : 'Tap to add a profile photo'}</div>
        <input type="file" id="fphoto" accept="image/*">
      </div>
      ${fields}
      <div class="field">Resume (optional). Saved exactly as you attach it. Nothing is read or rewritten.
        <div class="btnrow" style="margin-top:6px">
          <label class="btn ghost" style="cursor:pointer">Choose file<input type="file" id="fresume" accept=".pdf,.doc,.docx,.txt,image/*" style="display:none"></label>
          <label class="btn ghost" style="cursor:pointer">Take a picture<input type="file" id="fresumecam" accept="image/*" capture="environment" style="display:none"></label>
        </div>
        <div class="small muted" id="fresumeName"></div>
      </div>
      ${p.resumeName ? `<div class="small muted">A resume file is saved: ${esc(p.resumeName)}. Choosing a new one replaces it.</div>` : ''}
      ${!editId ? `
      <div class="field">
        <span class="small" style="font-weight:600">Voice note (optional, private)</span>
        <div class="small muted" style="margin:2px 0 8px">Record while you add the person - it saves as a private note on the new profile. Private notes are never shared. It is kept as a recording for playback only and is not transcribed.</div>
        <div id="newAudioWrap"></div>
      </div>` : ''}
      <div class="btnrow">
        <button type="submit" class="btn">${editId ? 'Save changes' : 'Add profile'}</button>
        <a class="btn subtle" href="${editId ? '#/profile/' + editId : '#/'}">Cancel</a>
      </div>
    </form>
  `;
  if (window.__afterForm) window.__afterForm(editId);
  document.getElementById('fphoto').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    const circle = document.getElementById('ppcircle');
    circle.style.backgroundImage = `url('${url}')`;
    circle.classList.add('hasimg');
    circle.innerHTML = '';
    document.getElementById('pphint').textContent = 'Tap the photo to change it';
  });
  updateNewAudioWrap();
  ['fresume', 'fresumecam'].forEach(i => document.getElementById(i).addEventListener('change', e => { const f = e.target.files[0]; document.getElementById('fresumeName').textContent = f ? 'Attached: ' + f.name : ''; const o = document.getElementById(i === 'fresume' ? 'fresumecam' : 'fresume'); if (f) o.value = ''; }));
  document.getElementById('pform').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    // Visible validation: native bubbles are easy to miss on a phone, so name what is missing.
    const missing = [];
    for (const [k, label, type, req] of PROFILE_FIELDS) {
      const el = form.querySelector(`[name="${k}"]`);
      if (el) el.classList.remove('field-missing');
      if (!req || !el) continue;
      const empty = k === 'gender' ? (el.value !== 'M' && el.value !== 'F') : !String(el.value || '').trim();
      if (empty) { missing.push(label); el.classList.add('field-missing'); }
    }
    const missBox = document.getElementById('formMissing');
    { const f = form.querySelector('[name="heightFt"]').value.trim(), i = form.querySelector('[name="heightIn"]').value.trim();
      const bad = (f !== '' && !(/^\d+$/.test(f) && +f >= 1 && +f <= 8)) || (i !== '' && !(/^\d+$/.test(i) && +i >= 0 && +i <= 11));
      if (bad) { missBox.textContent = 'Height: feet should be a whole number from 1 to 8 and inches a whole number from 0 to 11. You can also leave either one empty.'; missBox.style.display = ''; missBox.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; } }
    if (missing.length) {
      missBox.textContent = 'Please fill in before adding: ' + missing.join(', ') + '.';
      missBox.style.display = '';
      const first = form.querySelector('.field-missing');
      if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    missBox.style.display = 'none';
    const fd = new FormData(form);
    const prof = editId ? p : { id: uid(), photoColor: '#' + ['0f4c46', '7a3b2e', '274690', '3d6b35', '6b4fa1', '8a5a16'][Math.floor(Math.random() * 6)] };
    for (const [k, , type] of PROFILE_FIELDS) {
      let v = fd.get(k);
      if (type.startsWith('select:') && (k === 'gender')) v = v === 'M' ? 'M' : v === 'F' ? 'F' : '';
      prof[k] = typeof v === 'string' ? v.trim() : v;
    }
    const photoFile = document.getElementById('fphoto').files[0];
    if (photoFile) prof.photo = await resizePhoto(photoFile);
    const resumeFile = document.getElementById('fresume').files[0] || document.getElementById('fresumecam').files[0];
    if (resumeFile) {
      prof.resumeName = resumeFile.name;
      prof.resumeBlob = resumeFile;
    }
    try {
      await storePut('profiles', prof); _plistFilter = 'all'; _plistQ = '';
      if (window._newAudio) {
        await storePut('notes', { id: uid(), profileId: prof.id, type: 'audio', blob: window._newAudio, mime: window._newAudio.type, ts: Date.now() });
        window._newAudio = null;
        window._newAudioKeep = true;
      }
    } catch (err) {
      missBox.textContent = 'Something went wrong saving. Everything you entered is still on this page - please try again.';
      missBox.style.display = '';
      missBox.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    location.hash = '#/profile/' + prof.id;
  });
}

function updateNewAudioWrap() {
  const wrap = document.getElementById('newAudioWrap');
  if (!wrap) return;
  wrap.innerHTML = window._newAudio ? `
    <div class="newaudio">
      <audio controls id="newAudioPlayer"></audio>
      <div class="small muted">Recorded - saves with this profile. Discard to re-record.</div>
      <button type="button" class="btn ghost small" onclick="discardNewAudio()">Discard voice note</button>
    </div>` : `
    <button type="button" class="btn ghost" id="rec-new" onclick="toggleRec('new')">Record voice note</button>`;
  const nap = document.getElementById('newAudioPlayer');
  if (nap && window._newAudio) nap.src = URL.createObjectURL(window._newAudio);
}

window.discardNewAudio = function () {
  window._newAudio = null;
  updateNewAudioWrap();
};

function resizePhoto(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 400;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = rej;
    img.src = url;
  });
}

async function viewProfile(id) {
  const p = await storeGet('profiles', id);
  if (!p) { location.hash = '#/'; return; }
  const notes = (await storeAll('notes')).filter(n => n.profileId === id).sort((a, b) => b.ts - a.ts);
  // Saved good ideas for this profile: latest verdict per counterpart wins.
  const fb = (await storeAll('feedback')).filter(f => f.subjectId === id);
  const latestByCand = {};
  for (const f of fb) if (!latestByCand[f.candId] || latestByCand[f.candId].ts < f.ts) latestByCand[f.candId] = f;
  const goodIds = Object.keys(latestByCand).filter(cid => latestByCand[cid].verdict === 'yes');
  const goodIdeas = [];
  for (const cid of goodIds) {
    const c = await storeGet('profiles', cid);
    if (c) goodIdeas.push({ c, f: latestByCand[cid] });
  }
  goodIdeas.sort((a, b) => b.f.ts - a.f.ts);
  app.innerHTML = `
    <div class="hero">
      ${p.photo
        ? `<div class="hphoto" style="background-image:url('${p.photo}')"></div>`
        : `<div class="hphoto noimg" style="background:${p.photoColor || '#0d443e'}">${esc(initials(p.name))}</div>`}
      <div class="hoverlay">
        <div class="hname">${esc(nm(p))}</div>
        <div class="hsub">${p.gender === 'M' ? 'Boy' : p.gender === 'F' ? 'Girl' : 'Profile'} &middot; ${ageFromDob(p.dob) != null ? ageFromDob(p.dob) + ' years old' : 'age not added'} &middot; ${esc(p.location || '')}</div>
        <div class="htagline"><span class="htag">${esc(p.hashkafa || '')}</span></div>
      </div>
    </div>
    <div class="card">
      <div class="btnrow no-print" style="margin-top:0">
        ${(p.gender === 'M' || p.gender === 'F') ? `<a class="btn" href="#/match/${p.id}">Find ${p.gender === 'M' ? 'girls' : 'boys'} for ${esc(firstName(p))}</a>` : `<a class="btn ghost" href="#/edit/${p.id}">Set boy or girl to find matches</a>`}
        <a class="btn ghost" href="#/share/${p.id}">Share package</a>
      </div>

    <div class="card">
      <h3 style="margin-top:0">The basics</h3>
      <div class="kv">
        ${p.dob ? `<div class="k">Date of birth</div><div>${esc(p.dob)}</div>` : ''}
        ${heightText(p) ? `<div class="k">Height</div><div>${esc(heightText(p))}</div>` : ''}
        ${p.community ? `<div class="k">Community</div><div>${esc(p.community)}</div>` : ''}
        ${p.role ? `<div class="k">What ${p.gender === 'M' ? 'he' : 'she'} does</div><div>${esc(p.role)}</div>` : ''}
        ${p.workType ? `<div class="k">Working or learning</div><div>${esc(p.workType)}</div>` : ''}
        ${p.learnTerm ? `<div class="k">Learner</div><div>${esc(p.learnTerm)}</div>` : ''}
        ${p.town ? `<div class="k">Town</div><div>${esc(p.town)}</div>` : ''}
        ${p.rav ? `<div class="k">Rav</div><div>${esc(p.rav)}</div>` : ''}
        ${p.minyan ? `<div class="k">Minyan</div><div>${esc(p.minyan)}</div>` : ''}
        ${p.koveaItim ? `<div class="k">Kovea itim</div><div>${esc(p.koveaItim)}</div>` : ''}
        ${p.music ? `<div class="k">Music</div><div>${esc(p.music)}</div>` : ''}
        ${p.movies ? `<div class="k">Movies</div><div>${esc(p.movies)}</div>` : ''}
      </div>
      ${p.personality ? `<h3>Personality</h3><p>${esc(p.personality)}</p>` : ''}
      ${p.family ? `<h3>Family</h3><p>${esc(p.family)}</p>` : ''}
      ${p.lookingFor ? `<h3>What ${p.gender === 'M' ? 'he' : 'she'} is looking for</h3><p>${esc(p.lookingFor)}</p>` : ''}
      <div class="btnrow no-print"><a class="btn subtle" href="#/edit/${p.id}">Edit basics</a></div>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Profile synopsis</h3>
      <p class="small muted">This is the shareable summary. It is part of the profile package you can share. You write and edit it yourself. Nothing is rewritten for you.</p>
      <textarea id="summaryBox" class="searchbar" style="min-height:90px">${esc(p.summary || '')}</textarea>
      <div class="btnrow">
        <button class="btn ghost" onclick="saveSummary('${p.id}')">Save synopsis</button>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Resume</h3>
      ${p.resumeText ? `<p style="white-space:pre-wrap">${esc(p.resumeText)}</p>` : ''}
      ${p.resumeBlob ? `<p><button class="btn ghost" onclick="openResume('${p.id}')">Open saved resume file (${esc(p.resumeName || 'file')})</button></p>` : ''}
      ${!p.resumeText && !p.resumeBlob ? '<p class="muted">No resume yet. Add one through Edit basics.</p>' : ''}
    </div>

    ${goodIdeas.length ? `
    <div class="card">
      <h3 style="margin-top:0">Saved good ideas <span class="small muted">(private, never shared)</span></h3>
      ${goodIdeas.map(({ c, f }) => `
        <a class="idearow" href="#/profile/${c.id}">
          ${avatarHTML(c)}
          <div class="info">
            <div class="name">${esc(nm(c))}${ageSfx(c)}</div>
            <div class="sub">${esc(c.location)} &middot; ${esc(c.hashkafa || '')}</div>
            ${f.comment ? `<div class="sub">Your note: ${esc(f.comment)}</div>` : ''}
            <div class="when muted">Saved ${fmtWhen(f.ts)}</div>
          </div>
        </a>`).join('')}
    </div>` : ''}

    <div class="card">
      <h3 style="margin-top:0">Private notes <span class="small muted">(never shared)</span></h3>
      <div class="lockline">Private notes stay with you. They are never included in a shared package, an export, or any AI-generated shareable summary.</div>
      <div id="notesList">
        ${notes.map(n => `
          <div class="note">
            <div class="when">${n.type === 'audio' ? 'Voice note' : 'Note'} &middot; ${fmtWhen(n.ts)}
              <a href="javascript:void 0" onclick="deleteNote('${n.id}','${p.id}')" style="float:right" class="muted">Delete</a>
            </div>
            ${n.type === 'audio' ? `<audio controls id="aud-${n.id}"></audio><div class="small muted">Saved and playable here. Voice notes are not transcribed.</div>` : `<div>${esc(n.text)}</div>`}
          </div>`).join('') || '<p class="muted small">No notes yet.</p>'}
      </div>
      <textarea id="noteText" class="searchbar" style="min-height:64px" placeholder="Type a private note..."></textarea>
      <div class="btnrow">
        <button class="btn ghost" onclick="addTextNote('${p.id}')">Save note</button>
        <button class="btn subtle" id="rec-${p.id}" onclick="toggleRec('${p.id}')">Record voice note</button>
      </div>
    </div>

    <div class="card no-print">
      <button class="btn danger" onclick="deleteProfile('${p.id}')">Delete this profile</button>
    </div>
  `;
  // attach audio blobs
  for (const n of notes) {
    if (n.type === 'audio' && n.blob) {
      const el = document.getElementById('aud-' + n.id);
      if (el) el.src = URL.createObjectURL(n.blob);
    }
  }
}
window.saveSummary = async function (id) {
  const p = await storeGet('profiles', id);
  p.summary = document.getElementById('summaryBox').value.trim();
  await storePut('profiles', p);
  render();
};
window.addTextNote = async function (id) {
  const t = document.getElementById('noteText').value.trim();
  if (!t) return;
  await storePut('notes', { id: uid(), profileId: id, type: 'text', text: t, ts: Date.now() });
  render();
};
window.deleteNote = async function (nid) {
  await storeDel('notes', nid);
  render();
};
window.openResume = async function (id) {
  const p = await storeGet('profiles', id);
  if (p && p.resumeBlob) {
    const url = URL.createObjectURL(p.resumeBlob);
    window.open(url, '_blank');
  }
};
window.deleteProfile = async function (id) {
  if (!confirm('Delete this profile and its private notes?')) return;
  const notes = (await storeAll('notes')).filter(n => n.profileId === id);
  for (const n of notes) await storeDel('notes', n.id);
  await storeDel('profiles', id);
  location.hash = '#/';
};

async function viewMatch(id) {
  const subject = await storeGet('profiles', id);
  if (!subject) { location.hash = '#/'; return; }
  window._matchSubject = id;
  const weights = await getWeights();
  const all = await storeAll('profiles');
  const scored = all
    .map(c => ({ c, s: scorePair(subject, c, weights) }))
    .filter(x => x.s)
    .sort((a, b) => b.s.total - a.s.total);
  const top = scored.slice(0, 5);
  const seeking = subject.gender === 'M' ? 'girls' : 'boys';
  app.innerHTML = `
    <h2>Ideas for ${esc(nm(subject))}</h2>
    <div class="banner info">These suggestions come from a simple rules engine on this device - they are ideas for you to review, not verified compatibility. "Good idea" is saved to your list and does not change the ranking. "Not a fit" with reason tags makes those factors count more in later searches on this device. Written comments are saved for you and are not read by the matcher.</div>
    ${top.map(({ c, s }) => `
      <div class="card sugg">
        <div class="top">
          ${avatarHTML(c)}
          <div class="info">
            <div class="name"><a href="#/profile/${c.id}" style="color:inherit">${esc(nm(c))}${ageSfx(c)}</a></div>
            <div class="sub muted small">${esc(c.location)} &middot; ${esc(c.hashkafa)}</div>
          </div>
        </div>
        <ul class="reasons">
          ${s.reasons.map(r => `<li>${esc(r)}</li>`).join('')}
          ${s.concerns.map(r => `<li class="concern">To check: ${esc(r)}</li>`).join('')}
        </ul>
        <div class="feedback no-print">
          ${(fbState[c.id] && fbState[c.id].saved) ? `<div class="small" style="color:var(--ok);font-weight:600">Feedback saved${fbState[c.id].saved === 'yes' ? ' - marked a good idea' : (Object.keys((fbState[c.id].tags) || {}).some(t => fbState[c.id].tags[t]) ? ' - the tagged factors will count more in later searches' : ' - no reason tags picked, so the ranking is unchanged')}.</div>` : ''}
          <div class="btnrow" style="margin:0 0 6px">
            <button class="btn ghost" onclick="fbVerdict('${c.id}','yes')">Good idea</button>
            <button class="btn subtle" onclick="fbVerdict('${c.id}','no')">Not a fit</button>
          </div>
          <div id="fbnote-${c.id}" style="display:none">
            <label class="field small" style="margin:8px 0 4px">A note for yourself about this idea (optional, private)
              <input type="text" id="fbyn-${c.id}" placeholder="e.g. mention after the Yom Tov"></label>
            <button class="btn ghost" onclick="fbSaveYesNote('${c.id}')" style="padding:8px 14px;font-size:13.5px">Save note</button>
          </div>
          <div id="fbtags-${c.id}" style="display:none">
            <div class="small muted">Why not? Pick what applies:</div>
            <div class="tagpick">
              ${FB_TAGS.map(t => `<button class="chip" id="fbtag-${c.id}-${t.replace(/[^a-z]/gi, '')}" onclick="fbTag('${c.id}','${t}')">${t}</button>`).join('')}
            </div>
            <input class="searchbar" id="fbc-${c.id}" placeholder="Optional - say more in your own words">
            <button class="btn" onclick="fbSaveNo('${c.id}')">Save feedback</button>
          </div>
        </div>
      </div>`).join('') || `<p class="muted">No ${seeking} in the system yet.</p>`}
    <p class="no-print"><a class="btn subtle" href="#/profile/${subject.id}">Back to ${esc(firstName(subject))}</a></p>
  `;
  if (window.__afterMatch) window.__afterMatch({ subjectId: subject.id, candidateIds: all.filter(c => c.id !== subject.id && subject.gender && c.gender && c.gender !== subject.gender).map(c => c.id) });
}

/* ---- Ask a match (ad hoc description) ---- */
async function viewAsk() {
  const saved = window._askState || { have: 'M', desc: '' };
  window._askState = saved;
  let resultsHTML = '';
  if (saved.results) {
    resultsHTML = `
      <h3>Ideas from your description</h3>
      ${saved.results.map(({ c, s }) => `
        <div class="card sugg">
          <div class="top">
            ${avatarHTML(c)}
            <div class="info">
              <div class="name"><a href="#/profile/${c.id}" style="color:inherit">${esc(nm(c))}${ageSfx(c)}</a></div>
              <div class="sub muted small">${esc(c.location)} &middot; ${esc(c.hashkafa)}</div>
            </div>
          </div>
          <ul class="reasons">
            ${s.reasons.map(r => `<li>${esc(r)}</li>`).join('')}
            ${s.concerns.map(r => `<li class="concern">To check: ${esc(r)}</li>`).join('')}
          </ul>
        </div>`).join('') || '<p class="muted">No candidates found.</p>'}
    `;
  }
  app.innerHTML = `
    <h2>Ask a match</h2>
    <div class="banner info">Describe someone, even without a profile in the system, and get ideas from the people you have entered. In this demo, describe fictional people only.</div>
    <div class="card">
      <label class="field">I have a
        <select id="askHave">
          <option value="M" ${saved.have === 'M' ? 'selected' : ''}>Boy</option>
          <option value="F" ${saved.have === 'F' ? 'selected' : ''}>Girl</option>
        </select>
      </label>
      <label class="field">Describe them
        <textarea id="askDesc" placeholder="Example: a 24 year old yeshivish boy in Lakewood, learning full time, quiet and warm, looking for a teacher type">${esc(saved.desc)}</textarea>
      </label>
      <div class="btnrow">
        <button class="btn" onclick="runAsk()">Suggest 3 ${saved.have === 'M' ? 'girls' : 'boys'}</button>
        <button class="btn subtle" id="rec-ask" onclick="toggleRec('ask')">Record voice note</button>
      </div>
      <div class="small muted" id="askAudioNote">${window._askAudio ? 'A voice note is attached to this search below. ' : ''}Voice notes are kept for playback only and are not transcribed. The suggestions use your typed description.</div>
      <div id="askAudioSlot">${window._askAudio ? '<audio controls id="askAudioPlayer"></audio>' : ''}</div>
    </div>
    ${resultsHTML}
  `;
  if (window.__afterAsk) window.__afterAsk();
  if (window._askAudio) {
    const el = document.getElementById('askAudioPlayer');
    if (el) el.src = URL.createObjectURL(window._askAudio);
  }
}
window.runAsk = async function () {
  const have = document.getElementById('askHave').value;
  const desc = document.getElementById('askDesc').value.trim();
  const st = window._askState = window._askState || {};
  st.have = have; st.desc = desc;
  if (!desc) { alert('Type a short description first.'); return; }
  const lower = desc.toLowerCase();
  const pseudo = { id: '_adhoc', name: 'the person you described', gender: have, dob: null, hashkafa: null, role: '', location: null, lookingFor: desc, summary: desc, movies: null, music: '' };
  const ageM = lower.match(/\b(1[89]|2\d|3\d)\b/);
  if (ageM) pseudo.dob = dobFromAge(parseInt(ageM[1], 10));
  for (const h of HASHKAFA_ORDER) {
    if (lower.includes(h.toLowerCase())) { pseudo.hashkafa = h; break; }
  }
  if (!pseudo.hashkafa) {
    if (/yeshivish|yeshiva|bmg|lakewood style/.test(lower)) pseudo.hashkafa = 'Yeshivish';
    else if (/chassidish|chasidish|hasidic/.test(lower)) pseudo.hashkafa = 'Chassidish';
    else if (/heimish/.test(lower)) pseudo.hashkafa = 'Heimish';
    else if (/modern orthodox|mo\b/.test(lower)) pseudo.hashkafa = 'Modern Orthodox';
  }
  if (/learner|learning|kollel|full-time|yungerman/.test(lower)) pseudo.role = 'Full-time learner';
  else if (/learner-earner/.test(lower)) pseudo.role = 'Learner-earner';
  else if (/work|job|professional|business|lawyer|doctor|med|account|finance|nurse|teacher|therapist/.test(lower)) pseudo.role = 'Working';
  for (const loc of Object.keys(METRO)) {
    const city = loc.split(',')[0].toLowerCase();
    if (lower.includes(city)) { pseudo.location = loc; break; }
  }
  const weights = await getWeights();
  const all = await storeAll('profiles');
  const scored = all
    .map(c => ({ c, s: scorePair(pseudo, c, weights) }))
    .filter(x => x.s)
    .sort((a, b) => b.s.total - a.s.total)
    .slice(0, 3);
  st.results = scored;
  viewAsk();
};

/* ---- Share package ---- */
const SHARE_FIELDS = [
  ['photo', 'Profile photo', 'Picture of the person'],
  ['resume', 'Resume', 'Resume text and uploaded file'],
  ['synopsis', 'Profile synopsis', 'The shareable summary'],
  ['lookingFor', 'What they are looking for', 'Their preferences'],
  ['personality', 'Personality and family background', 'Optional extra']
];
async function viewShare(id) {
  const p = await storeGet('profiles', id);
  if (!p) { location.hash = '#/'; return; }
  const st = window._shareState = window._shareState || {};
  st[id] = st[id] || { photo: true, resume: true, synopsis: true, lookingFor: true, personality: false };
  const sel = st[id];
  app.innerHTML = `
    <h2>Share ${esc(firstName(p))}'s profile</h2>
    <div class="banner info">A shared package lets another shadchan receive this profile in their own workspace. Choose exactly what goes in.</div>
    <div class="card">
      <div class="sharefield"><input type="checkbox" checked disabled><div>The basics <div class="small muted">Name, age, height, location, hashkafa, what they do</div></div><span class="hint">Always included</span></div>
      ${SHARE_FIELDS.map(([k, label, hint]) => `
        <div class="sharefield"><input type="checkbox" id="sf-${k}" ${sel[k] ? 'checked' : ''} onchange="toggleShareField('${id}','${k}')"><div>${label}</div><span class="hint">${hint}</span></div>
      `).join('')}
      <div class="lockline">Private notes are never part of a shared package - not as an option, not inside an AI-generated summary, not in an export.</div>
    </div>
    <div class="btnrow">
      <button class="btn" onclick="previewShare('${id}')">Preview package</button>
      <button class="btn ghost" onclick="downloadShare('${id}')">Download package file</button>
    </div>
    <button class="btn disabled" disabled>Send directly to another shadchan (needs the hosted version with accounts - not connected yet)</button>
    <div class="banner warn" style="margin-top:12px">Design decision still open: this package is an <b>independent copy</b> - later updates you make will not reach the recipient automatically. Whether shadchanim should instead get ongoing live access with updates is still to be decided with Shalom.</div>
    <div id="sharePreview"></div>
    <p><a class="btn subtle" href="#/profile/${p.id}">Back to ${esc(firstName(p))}</a></p>
  `;
}
window.toggleShareField = function (id, k) {
  const st = window._shareState[id];
  st[k] = !st[k];
};
function buildPackageInner(p, sel) {
  const a = ageFromDob(p.dob);
  return `
    <div class="package-sheet">
      <div class="ph">
        ${sel.photo ? avatarHTML(p, 'lg') : ''}
        <div>
          <div class="name">${esc(nm(p))}</div>
          <div class="muted">${p.gender === 'M' ? 'Boy' : p.gender === 'F' ? 'Girl' : 'Profile'} &middot; ${a != null ? a + ' years old' : ''} &middot; ${esc(p.location || '')}</div>
          <div class="tagline"><span class="tag">${esc(p.hashkafa || '')}</span></div>
        </div>
      </div>
      <div class="kv">
        ${p.dob ? `<div class="k">Date of birth</div><div>${esc(p.dob)}</div>` : ''}
        ${heightText(p) ? `<div class="k">Height</div><div>${esc(heightText(p))}</div>` : ''}
        ${p.community ? `<div class="k">Community</div><div>${esc(p.community)}</div>` : ''}
        ${p.role ? `<div class="k">What ${p.gender === 'M' ? 'he' : 'she'} does</div><div>${esc(p.role)}</div>` : ''}
        ${p.rav ? `<div class="k">Rav</div><div>${esc(p.rav)}</div>` : ''}
        ${p.koveaItim ? `<div class="k">Kovea itim</div><div>${esc(p.koveaItim)}</div>` : ''}
        ${p.movies ? `<div class="k">Movies</div><div>${esc(p.movies)}</div>` : ''}
        ${p.music ? `<div class="k">Music</div><div>${esc(p.music)}</div>` : ''}
      </div>
      ${sel.synopsis && p.summary ? `<h3>Profile synopsis</h3><p>${esc(p.summary)}</p>` : ''}
      ${sel.lookingFor && p.lookingFor ? `<h3>What ${p.gender === 'M' ? 'he' : 'she'} is looking for</h3><p>${esc(p.lookingFor)}</p>` : ''}
      ${sel.personality && p.personality ? `<h3>Personality</h3><p>${esc(p.personality)}</p>` : ''}
      ${sel.personality && p.family ? `<h3>Family</h3><p>${esc(p.family)}</p>` : ''}
      ${sel.resume && p.resumeText ? `<h3>Resume</h3><p style="white-space:pre-wrap">${esc(p.resumeText)}</p>` : ''}
      ${sel.resume && p.resumeName ? `<p class="small muted">Resume file attached in the sender's system: ${esc(p.resumeName)}</p>` : ''}
    </div>
    <p class="small muted">Shared as an independent copy. Private notes are never included.</p>
  `;
}
window.previewShare = async function (id) {
  const p = await storeGet('profiles', id);
  const sel = window._shareState[id];
  document.getElementById('sharePreview').innerHTML = buildPackageInner(p, sel);
};
window.downloadShare = async function (id) {
  const p = await storeGet('profiles', id);
  const sel = window._shareState[id];
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(nm(p))} - Shidduch profile</title><style>body{font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;max-width:560px;margin:24px auto;padding:0 16px;color:#21312e;line-height:1.45}.package-sheet{border:1px solid #e4e0d5;border-radius:12px;padding:20px}.ph{display:flex;gap:14px;align-items:center;border-bottom:2px solid #0f4c46;padding-bottom:12px;margin-bottom:12px}.name{font-size:20px;font-weight:700}.muted{color:#5b6b68}.small{font-size:12.5px}.avatar{width:84px;height:84px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:26px;background-size:cover;background-position:center}.tag{background:#e3efec;color:#0f4c46;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600}.kv{display:grid;grid-template-columns:120px 1fr;row-gap:6px;column-gap:10px;font-size:14.5px}.k{color:#5b6b68}h3{font-size:15px;color:#0f4c46;margin:16px 0 6px}.tagline{margin-top:6px}</style></head><body>${buildPackageInner(p, sel)}</body></html>`;
  const blob = new Blob([html], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (p.name || 'profile').replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-shidduch-profile.html';
  a.click();
};

/* ---- Settings / more ---- */
async function viewSettings() {
  const fb = await storeAll('feedback');
  const profiles = await storeAll('profiles');
  const notes = await storeAll('notes');
  const no = fb.filter(f => f.verdict === 'no');
  const tagCounts = {};
  for (const f of no) for (const t of f.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  app.innerHTML = `
    <h2>More</h2>
    <div class="card">
      <h3 style="margin-top:0">Your feedback so far</h3>
      ${fb.length === 0 ? '<p class="muted small">No feedback yet. On any profile, tap "Find" and mark suggestions as good ideas or not a fit.</p>' : `
        <p class="small">You have given feedback on ${fb.length} suggestion${fb.length === 1 ? '' : 's'} (${no.length} declined).</p>
        ${topTags.length ? `<p class="small">Reasons you decline most: ${topTags.map(([t, c]) => `${t} (${c})`).join(', ')}. Those factors now count more heavily.</p>` : ''}
      `}
    </div>
    <div class="card">
      <h3 style="margin-top:0">Your data</h3>
      <p class="small muted">${profiles.length} profiles and ${notes.length} private notes, all stored only in this browser.</p>
      <p><button class="btn ghost" onclick="exportData()">Back up profiles (JSON)</button></p>
      <p class="small muted">Backups and exports never include private notes.</p>
      <p><button class="btn danger" onclick="resetDemo()">Reset demo data</button></p>
    </div>
    <div class="card">
      <h3 style="margin-top:0">What is real in this demo</h3>
      <p class="small">Working now: profiles, photos, resumes, typed and voice notes (voice plays back), rule-based match suggestions with reasons, your feedback teaching the matcher, share packages as files.</p>
      <p class="small">Not connected yet: voice-to-text, AI summaries and AI matching, accounts, sharing directly between shadchanim inside the app. Those need the hosted version and are labeled wherever they appear.</p>
      <p class="small muted">Fictional profiles only in this demo; browser storage has no backup. Real profiles come with the hosted, account-based version.</p>
    </div>
  `;
}
window.exportData = async function () {
  const profiles = await storeAll('profiles');
  const clean = profiles.map(p => {
    const c = Object.assign({}, p);
    delete c.resumeBlob;
    return c;
  });
  const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), note: 'Private notes are never included in exports.', profiles: clean }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'shadchan-portal-backup.json';
  a.click();
};
window.resetDemo = async function () {
  if (!confirm('Erase everything and reload the fictional demo profiles?')) return;
  await storeClear('profiles'); await storeClear('notes'); await storeClear('feedback'); await storeClear('meta');
  window._askState = null; window._askAudio = null; window._shareState = {};
  await ensureSeed();
  location.hash = '#/';
  render();
};

/* ---- Shadchan-to-shadchan requests (fictional demo of the flow) ---- */
async function viewRequests() {
  app.innerHTML = `
    <h2>Send profiles to a shadchan</h2>
    <div class="banner warn">Not available in this demo. This demo is one browser on one device, so it cannot deliver anything to another shadchan.</div>
    <div class="card">
      <p>In the account version, each shadchan has a private login and their own list. You select one or more profiles, search for a shadchan who has chosen to be listed, pick copy or live, and send. Only the shareable package goes (resume, picture, synopsis, what they seek). Private notes never do, and nobody sees anyone's whole list.</p>
      <p class="small muted">There is no request feature. Shadchanim ask each other privately outside the app.</p>
    </div>`;
}
window.saveRequest = async function () {
  const seek = document.getElementById('rqSeek').value;
  const count = parseInt(document.getElementById('rqCount').value, 10);
  const desc = document.getElementById('rqDesc').value.trim();
  if (!desc) { alert('Describe who would fit first.'); return; }
  const id = uid();
  await storePut('requests', { id, seek, count, desc, ts: Date.now() });
  location.hash = '#/request/' + id;
};

async function viewRequest(id) {
  const r = await storeGet('requests', id);
  if (!r) { location.hash = '#/requests'; return; }
  app.innerHTML = `
    <h2>Request</h2>
    <div class="card">
      <p>"I'm looking for <b>${r.count} ${r.seek === 'F' ? 'girls' : 'boys'}</b> who fit this description: <b>${esc(r.desc)}</b>"</p>
      <p class="small muted">${fmtWhen(r.ts)} &middot; Not sent - this demo has no accounts or sending.</p>
      <div class="btnrow">
        <button class="btn ghost" onclick="location.hash='#/reply/${r.id}'">Preview what the other shadchan would see</button>
        <button class="btn danger" onclick="deleteRequest('${r.id}')">Delete</button>
      </div>
      <button class="btn disabled" disabled>Send to a shadchan (needs the hosted version with accounts - not connected yet)</button>
    </div>
    <p><a class="btn subtle" href="#/requests">All requests</a></p>
  `;
}
window.deleteRequest = async function (id) {
  await storeDel('requests', id);
  location.hash = '#/requests';
};

async function viewReplyPreview(id) {
  const r = await storeGet('requests', id);
  if (!r) { location.hash = '#/requests'; return; }
  const profiles = (await storeAll('profiles'))
    .filter(p => p.gender === r.seek)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const st = window._replyPick = window._replyPick || {};
  st[id] = st[id] || {};
  app.innerHTML = `
    <h2>Recipient view <span class="small muted">(demonstration)</span></h2>
    <div class="banner warn">This is a preview of the receiving shadchan's experience, using the fictional profiles on this device. Nothing is sent or received. The recipient sees only this request and their own list - never your database.</div>
    <div class="card">
      <p class="small muted">Request from another shadchan:</p>
      <p>"I'm looking for <b>${r.count} ${r.seek === 'F' ? 'girls' : 'boys'}</b> who fit this description: <b>${esc(r.desc)}</b>"</p>
    </div>
    <h3>Choose profiles from your own list to send back</h3>
    ${profiles.map(p => `
      <div class="card pcard" style="cursor:pointer" onclick="pickReply('${id}','${p.id}')">
        ${avatarHTML(p)}
        <div class="info">
          <div class="name">${esc(nm(p))}${ageSfx(p)}</div>
          <div class="sub">${esc(p.location || '')} &middot; ${esc(p.hashkafa)}</div>
        </div>
        <input type="checkbox" style="width:20px;height:20px;margin-left:auto" ${st[id][p.id] ? 'checked' : ''} onclick="event.stopPropagation();pickReply('${id}','${p.id}')">
      </div>`).join('') || '<p class="muted">No profiles of this kind on this device.</p>'}
    <div class="btnrow">
      <button class="btn" onclick="previewReply('${id}')">Preview reply package</button>
      <a class="btn subtle" href="#/request/${id}">Back</a>
    </div>
    <div class="lockline">The reply contains only the shareable package for each chosen profile (basics, photo, resume, synopsis, what they are looking for). Private notes are never included.</div>
    <div id="replyPreview"></div>
  `;
}
window.pickReply = function (rid, pid) {
  const st = window._replyPick[rid];
  st[pid] = !st[pid];
  viewReplyPreview(rid);
};
window.previewReply = async function (rid) {
  const picks = Object.keys(window._replyPick[rid]).filter(k => window._replyPick[rid][k]);
  if (!picks.length) { alert('Choose at least one profile.'); return; }
  const sel = { photo: true, resume: true, synopsis: true, lookingFor: true, personality: false };
  let html = '<h3>Reply package preview</h3>';
  for (const pid of picks) {
    const p = await storeGet('profiles', pid);
    html += buildPackageInner(p, sel);
  }
  document.getElementById('replyPreview').innerHTML = html;
  document.getElementById('replyPreview').scrollIntoView({ behavior: 'smooth' });
};

/* ---------------- boot ---------------- */
window.addEventListener('hashchange', render);
(async function boot() {
  if (window.__ready) await window.__ready;
  await ensureSeed();
  if (!location.hash) location.hash = '#/';
  render();
})();
