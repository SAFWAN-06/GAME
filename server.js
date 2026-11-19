const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomInt } = require('node:crypto');
const { WebSocketServer } = require('ws');
const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, 'public');
const rooms = new Map();
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const requested = decodeURIComponent((req.url || '/').split('?')[0]);
  const target = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const file = path.resolve(ROOT, target);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('غير موجود'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(data);
  });
});
const wss = new WebSocketServer({ server, maxPayload: 4096 });
const send = (ws, data) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(data)); };
const playerById = (room, id) => room.players.find(p => p.id === id);
const aliveAs = (room, role) => room.players.filter(p => p.alive && p.role === role);
const countMafia = room => aliveAs(room, 'mafia').length;
const aiNames = ['الظل', 'ليلى', 'الذيب', 'نور', 'العقرب', 'رِيم', 'الغريب', 'سُهيل', 'النديم', 'نجمة', 'شاهين'];
const aiTimers = new WeakMap();
function publicState(room, viewer) {
  return {
    code: room.code, hostId: room.hostId, phase: room.phase, round: room.round, winner: room.winner, settings: room.settings,
    players: room.players.map(p => ({ id: p.id, name: p.name, alive: p.alive, host: p.id === room.hostId, isAI: !!p.isAI, role: room.phase === 'lobby' || room.phase === 'ended' || p.id === viewer.id || (p.role === 'mafia' && viewer.role === 'mafia') ? p.role : null })),
    me: { id: viewer.id, role: viewer.role || null, alive: viewer.alive, actionTarget: room.actions.get(viewer.id)?.target || null },
    messages: room.messages.filter(m => !m.privateTo ? (!m.channel || room.phase === 'ended' || (m.channel === 'mafia' ? viewer.alive && viewer.role === 'mafia' : viewer.alive)) : m.privateTo === viewer.id || room.phase === 'ended').slice(-70),
    votes: room.phase === 'night' && viewer.role !== 'mafia' ? [] : Array.from(room.votes.entries()).map(([from, to]) => ({ from: room.phase === 'night' && playerById(room, from)?.role !== 'mafia' ? null : from, to }))
  };
}
function broadcast(room) { room.players.forEach(p => send(p.ws, { type: 'state', state: publicState(room, p) })); }
function system(room, text) { room.messages.push({ name: 'النظام', text, system: true, at: Date.now() }); }
function makeCode() { const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code; do { code = Array.from({ length: 5 }, () => chars[randomInt(chars.length)]).join(''); } while (rooms.has(code)); return code; }
function sendChat(room, message) {
  room.messages.push(message);
  room.players.filter(p => message.privateTo ? p.id === message.privateTo : message.channel === 'mafia' ? p.alive && p.role === 'mafia' : room.phase === 'ended' || p.alive).forEach(p => send(p.ws, { type: 'chat', message }));
}
function addAIPlayer(room) {
  if (room.players.length >= room.settings.maxPlayers) return null;
  const botCount = room.players.filter(p => p.isAI).length;
  const bot = { id: Math.random().toString(36).slice(2, 11), name: aiNames[botCount % aiNames.length], ws: null, role: null, alive: true, isAI: true };
  room.players.push(bot);
  system(room, `وصل ${bot.name} إلى المدينة. لاعب ذكي جديد انضم للجلسة.`);
  return bot;
}
function addPlayer(room, ws, name) {
  if (room.phase !== 'lobby') return send(ws, { type: 'error', message: 'بدأت الجولة بالفعل، لا يمكن دخول الغرفة الآن.' });
  if (room.players.length >= room.settings.maxPlayers) return send(ws, { type: 'error', message: 'الغرفة مكتملة.' });
  const player = { id: Math.random().toString(36).slice(2, 11), name: String(name || 'لاعب').trim().replace(/[<>]/g, '').slice(0, 18) || 'لاعب', ws, role: null, alive: true };
  room.players.push(player); ws.room = room; ws.player = player;
  system(room, `انضم ${player.name} إلى الغرفة`); broadcast(room);
}
function startPhaseTimer(room) {
  clearTimeout(room.phaseTimer);
  room.phaseTimer = setTimeout(() => {
    if (room.phase === 'lobby' || room.phase === 'ended') return;
    system(room, 'انتهى وقت الجولة؛ تم احتساب الأصوات المسجلة.');
    resolveVote(room, true);
  }, 60000);
}
function scheduleAI(room, delay = 1200) {
  clearTimeout(aiTimers.get(room));
  if (!room.players.some(p => p.isAI && p.alive) || room.phase === 'lobby' || room.phase === 'ended') return;
  const phase = room.phase, round = room.round;
  aiTimers.set(room, setTimeout(() => {
    if (room.phase !== phase || room.round !== round) return;
    if (phase === 'night') {
      for (const bot of room.players.filter(p => p.isAI && p.alive)) {
        if (bot.role === 'mafia' && !room.votes.has(bot.id)) {
          const candidates = room.players.filter(p => p.alive && p.role !== 'mafia');
          if (candidates.length) room.votes.set(bot.id, candidates[randomInt(candidates.length)].id);
        } else if (bot.role === 'doctor' && !room.actions.has(bot.id)) {
          const candidates = room.players.filter(p => p.alive);
          if (candidates.length) room.actions.set(bot.id, { role: 'doctor', target: candidates[randomInt(candidates.length)].id });
        } else if (bot.role === 'detective' && !room.actions.has(bot.id)) {
          const candidates = room.players.filter(p => p.alive && p.id !== bot.id);
          if (candidates.length) room.actions.set(bot.id, { role: 'detective', target: candidates[randomInt(candidates.length)].id });
        }
      }
      system(room, 'تتحرك المدينة في الخفاء...');
    } else if (phase === 'day') {
      const lines = ['تصرفات البعض اليوم تثير الشك...', 'لا تستعجلوا بالحكم، انتبهوا لمن يغيّر كلامه.', 'أظن أن بيننا من يعرف أكثر مما يقول.', 'أنا أراقب التصويت، أحيانًا يكشف أكثر من الكلام.'];
      const speakers = room.players.filter(p => p.isAI && p.alive);
      if (speakers.length && Math.random() < 0.82) sendChat(room, { name: speakers[randomInt(speakers.length)].name, text: lines[randomInt(lines.length)], channel: 'town', at: Date.now() });
      for (const bot of room.players.filter(p => p.isAI && p.alive && !room.votes.has(p.id))) {
        const candidates = room.players.filter(p => p.alive && p.id !== bot.id);
        if (!candidates.length) continue;
        const currentLeader = candidates.map(p => ({ player: p, votes: Array.from(room.votes.values()).filter(id => id === p.id).length })).sort((a, b) => b.votes - a.votes)[0];
        const human = candidates.filter(p => !p.isAI);
        let target;
        if (currentLeader?.votes > 0 && Math.random() < 0.45) target = currentLeader.player;
        else target = human.length && Math.random() < 0.32 ? human[randomInt(human.length)] : candidates[randomInt(candidates.length)];
        room.votes.set(bot.id, target.id);
      }
    }
    resolveVote(room); broadcast(room);
  }, delay));
}
function startGame(room) {
  if (room.players.length < 4) return { error: 'تحتاج إلى ٤ لاعبين على الأقل لبدء اللعبة.' };
  const pool = room.players.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = randomInt(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  let index = 0;
  pool[index++].role = 'mafia';
  if (pool.length >= 8) pool[index++].role = 'mafia';
  pool[index++].role = 'doctor';
  pool[index++].role = 'detective';
  for (; index < pool.length; index++) pool[index].role = 'town';
  room.players.forEach(p => { p.alive = true; });
  room.phase = 'night'; room.round = 1; room.winner = null; room.votes.clear(); room.actions.clear(); room.protectedId = null;
  system(room, 'هبط الليل على المدينة. لكل دور مهمته السرية.'); startPhaseTimer(room); scheduleAI(room); return {};
}
function finishOrContinue(room) {
  const aliveMafia = countMafia(room), aliveTown = room.players.filter(p => p.alive && p.role !== 'mafia').length;
  if (aliveMafia === 0) { room.phase = 'ended'; room.winner = 'town'; system(room, 'انتصرت المدينة! تم كشف المافيا.'); }
  else if (aliveMafia >= aliveTown) { room.phase = 'ended'; room.winner = 'mafia'; system(room, 'انتصرت المافيا... أصبحت المدينة تحت سيطرتها.'); }
  else if (room.phase === 'night') { room.phase = 'day'; system(room, 'أشرقت الشمس. ناقشوا واشتبِهوا وصوّتوا لإقصاء لاعب.'); }
  else { room.phase = 'night'; room.round++; room.protectedId = null; system(room, 'حلّ الليل مجدداً. الطبيب والمحقق والمافيا، حان دوركم.'); }
  room.votes.clear(); room.actions.clear();
  if (room.phase === 'ended') clearTimeout(room.phaseTimer);
  else { startPhaseTimer(room); scheduleAI(room, 1200); }
}
function resolveVote(room, force = false) {
  if (room.phase === 'ended' || room.phase === 'lobby') return;
  const night = room.phase === 'night';
  const eligible = room.players.filter(p => p.alive && (night ? p.role === 'mafia' : true));
  const validVotes = Array.from(room.votes.entries()).filter(([from, to]) => eligible.some(p => p.id === from) && room.players.some(p => p.id === to && p.alive && (night ? p.role !== 'mafia' : from !== to)));
  if (!force) {
    if (validVotes.length < eligible.length) return;
    if (night && ['doctor', 'detective'].some(role => aliveAs(room, role).some(p => !room.actions.has(p.id)))) return;
  }
  const totals = new Map(); validVotes.forEach(([, to]) => totals.set(to, (totals.get(to) || 0) + 1));
  const top = totals.size ? Math.max(...totals.values()) : 0;
  const tied = Array.from(totals).filter(([, n]) => n === top);
  let eliminated = tied.length === 1 && top > 0 ? playerById(room, tied[0][0]) : null;
  if (night) {
    const doctor = aliveAs(room, 'doctor').find(p => room.actions.get(p.id)?.role === 'doctor');
    room.protectedId = doctor ? room.actions.get(doctor.id).target : null;
    const detective = aliveAs(room, 'detective').find(p => room.actions.get(p.id)?.role === 'detective');
    if (detective) {
      const target = playerById(room, room.actions.get(detective.id).target);
      if (target?.alive) sendChat(room, { name: 'تحقيق سري', text: `التحقيق في ${target.name}: ${target.role === 'mafia' ? 'تؤكد الأدلة أنه من المافيا.' : 'لا تشير الأدلة إلى انتمائه للمافيا.'}`, system: true, privateTo: detective.id, at: Date.now() });
    }
    if (eliminated && eliminated.id === room.protectedId) eliminated = null;
  }
  if (eliminated) { eliminated.alive = false; system(room, night ? `مع بزوغ الفجر، اكتشفت المدينة اختفاء ${eliminated.name}.` : `صوّتت المدينة على إخراج ${eliminated.name} من اللعبة.`); }
  else system(room, night ? (top && room.protectedId ? 'مرّ الليل بسلام؛ يبدو أن الطبيب أنقذ ضحية الليلة.' : 'مرّ الليل بسلام؛ لم تتفق المافيا على ضحية.') : 'تعادل التصويت؛ لم يُقصَ أحد هذه الجولة.');
  finishOrContinue(room); broadcast(room);
}
wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: 'طلب غير صالح.' }); }
    if (msg.type === 'create') {
      const code = makeCode(); const maxPlayers = Number(msg.maxPlayers) || 8;
      const room = { code, hostId: null, phase: 'lobby', round: 0, winner: null, players: [], messages: [], votes: new Map(), actions: new Map(), protectedId: null, phaseTimer: null, settings: { maxPlayers: Math.min(12, Math.max(4, maxPlayers)) } };
      rooms.set(code, room); addPlayer(room, ws, msg.name); if (ws.player) room.hostId = ws.player.id;
      if (msg.addAI) addAIPlayer(room);
      broadcast(room);
    } else if (msg.type === 'join') {
      const room = rooms.get(String(msg.code || '').trim().toUpperCase()); if (!room) return send(ws, { type: 'error', message: 'رمز الغرفة غير موجود. تحقق منه وحاول مجدداً.' }); addPlayer(room, ws, msg.name);
    } else {
      const room = ws.room, player = ws.player; if (!room || !player) return send(ws, { type: 'error', message: 'انضم إلى غرفة أولاً.' });
      if (msg.type === 'addAI') {
        if (player.id !== room.hostId || room.phase !== 'lobby') return send(ws, { type: 'error', message: 'يمكن لمضيف الجلسة إضافة خصم ذكي قبل بدء الجولة.' });
        if (!addAIPlayer(room)) return send(ws, { type: 'error', message: 'اكتمل عدد اللاعبين المسموح به في الجلسة.' });
        broadcast(room);
      } else if (msg.type === 'start') {
        if (player.id !== room.hostId) return send(ws, { type: 'error', message: 'مضيف الغرفة فقط يمكنه بدء اللعبة.' });
        const result = startGame(room); if (result.error) return send(ws, { type: 'error', message: result.error }); broadcast(room);
      } else if (msg.type === 'chat') {
        const text = String(msg.text || '').trim().replace(/[<>]/g, '').slice(0, 280); if (!text || (!player.alive && room.phase !== 'ended')) return;
        if (room.phase === 'night' && player.role !== 'mafia') return send(ws, { type: 'error', message: 'لا يمكن للمدينة التحدث أثناء الليل.' });
        const channel = room.phase === 'night' ? 'mafia' : 'town'; sendChat(room, { name: player.name, text, channel, at: Date.now() });
      } else if (msg.type === 'vote') {
        const target = playerById(room, String(msg.target));
        if (!player.alive || !target?.alive || player.id === target.id || !['day', 'night'].includes(room.phase)) return;
        if (room.phase === 'night' && (player.role !== 'mafia' || target.role === 'mafia')) return send(ws, { type: 'error', message: 'هذا التصويت السري متاح للمافيا لاختيار لاعب من المدينة فقط.' });
        if (room.phase === 'day' && player.role === 'mafia') { /* للمافيا حق التصويت مع المدينة نهاراً. */ }
        room.votes.set(player.id, target.id); if (room.phase === 'day') system(room, `${player.name} أدلى بصوته.`);
        resolveVote(room); broadcast(room);
      } else if (msg.type === 'nightAction') {
        if (room.phase !== 'night' || !player.alive || !['doctor', 'detective'].includes(player.role)) return;
        const target = playerById(room, String(msg.target));
        if (!target?.alive || (player.role === 'detective' && target.id === player.id)) return;
        room.actions.set(player.id, { role: player.role, target: target.id });
        send(ws, { type: 'notice', message: player.role === 'doctor' ? 'تم تسجيل حماية المريض بسرية.' : 'تم إرسال نتيجة التحقيق إلى أحاديثك السرية.' });
        resolveVote(room); broadcast(room);
      } else if (msg.type === 'leave') ws.close();
    }
  });
  ws.on('close', () => {
    const room = ws.room, player = ws.player; if (!room || !player) return;
    room.players = room.players.filter(p => p.id !== player.id); room.votes.delete(player.id); room.actions.delete(player.id);
    if (!room.players.some(p => !p.isAI)) { clearTimeout(room.phaseTimer); clearTimeout(aiTimers.get(room)); rooms.delete(room.code); }
    else { if (room.hostId === player.id) room.hostId = room.players.find(p => !p.isAI)?.id || room.players[0].id; system(room, `${player.name} غادر الغرفة.`); broadcast(room); resolveVote(room); }
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`ليلة المافيا تعمل على http://localhost:${PORT}`));
