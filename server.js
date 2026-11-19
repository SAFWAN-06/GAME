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
  let requested;
  try { requested = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.writeHead(400); return res.end('طلب غير صالح'); }
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
const isMafia = player => player?.role === 'mafia' || player?.role === 'godfather';
const living = room => room.players.filter(p => p.alive);
const livingMafia = room => room.players.filter(p => p.alive && isMafia(p));
const livingRole = (room, role) => room.players.filter(p => p.alive && p.role === role);
const aiNames = ['الظل', 'ليلى', 'الذيب', 'نور', 'العقرب', 'رِيم', 'الغريب', 'سُهيل', 'النديم', 'نجمة', 'شاهين'];
const aiTimers = new WeakMap();
const modeIds = new Set(['classic', 'storm', 'chaos']);
const weatherIds = new Set(['clear', 'rain', 'fog']);
const roleInfo = {
  mafia: { name: 'المافيا', label: 'عضو المافيا', symbol: '♠', team: 'mafia', action: 'vote', description: 'تعرّف إلى حلفائك. صوّت ليلًا مع المافيا لإخراج أحد السكان، وأخفِ هويتك نهارًا.' },
  godfather: { name: 'الأب الروحي', label: 'الأب الروحي للمافيا', symbol: '♛', team: 'mafia', action: 'vote', description: 'قائد المافيا. صوتك يشارك في اختيار الضحية، ويظهر تحقيق المحقق عنك بريئًا.' },
  doctor: { name: 'الطبيب', label: 'طبيب المدينة', symbol: '✚', team: 'town', action: 'protect', description: 'اختر شخصًا تحميه هذه الليلة؛ يمكنك إنقاذ الهدف الذي تختاره من هجوم المافيا.' },
  detective: { name: 'المحقق', label: 'محقق المدينة', symbol: '⌕', team: 'town', action: 'inspect', description: 'افحص لاعبًا كل ليلة. تصلك نتيجة سرية تخبرك إن كان من المافيا.' },
  bodyguard: { name: 'الحارس الشخصي', label: 'حارس المدينة', symbol: '⛨', team: 'town', action: 'guard', description: 'احرس لاعبًا ليلًا. إذا استهدفته المافيا، تتلقى الضربة بدلًا منه.' },
  vigilante: { name: 'حارس الليل', label: 'حارس الليل', symbol: '⌖', team: 'town', action: 'shoot', description: 'لديك طلقة واحدة في اللعبة. اختر هدفًا ليلًا أو احتفظ بها؛ قد تصيب بريئًا.' },
  medium: { name: 'الوسيط', label: 'وسيط الأرواح', symbol: '☽', team: 'town', action: 'seance', description: 'تواصل مع لاعب حي ليلًا، واكشف سرًا إن كان من المافيا. تصلك الإجابة وحدك.' },
  jester: { name: 'المهرّج', label: 'المهرّج المريب', symbol: '☻', team: 'neutral', action: null, description: 'هدفك أن تقنع المدينة بإقصائك بالتصويت نهارًا. عندها تفوز وحدك.' },
  serialkiller: { name: 'القاتل المتسلسل', label: 'القاتل المتسلسل', symbol: '☠', team: 'serialkiller', action: 'kill', description: 'تلعب وحدك. اختر هدفًا كل ليلة؛ افلت من المافيا والمدينة لتسيطر على المدينة.' },
  citizen: { name: 'أهل المدينة', label: 'من أهل المدينة', symbol: '♢', team: 'town', action: null, description: 'راقب أحاديث المدينة وصوّت نهارًا. استنتج من يخفي هويته وساعد الأبرياء على النجاة.' }
};
function publicState(room, viewer) {
  return {
    code: room.code, hostId: room.hostId, phase: room.phase, round: room.round, winner: room.winner, settings: room.settings,
    players: room.players.map(p => ({ id: p.id, name: p.name, alive: p.alive, host: p.id === room.hostId, isAI: !!p.isAI, diedRound: p.alive ? null : p.diedRound, diedCause: p.alive ? null : p.diedCause, role: room.phase === 'lobby' || room.phase === 'ended' || p.id === viewer.id || (isMafia(p) && isMafia(viewer)) ? p.role : null })),
    me: { id: viewer.id, role: viewer.role || null, alive: viewer.alive, actionTarget: room.actions.get(viewer.id)?.target || null, shotUsed: !!viewer.shotUsed },
    messages: room.messages.filter(m => !m.privateTo ? (!m.channel || room.phase === 'ended' || (m.channel === 'mafia' ? viewer.alive && isMafia(viewer) : viewer.alive)) : m.privateTo === viewer.id || room.phase === 'ended').slice(-70),
    votes: room.phase === 'night' && !isMafia(viewer) ? [] : Array.from(room.votes.entries()).map(([from, to]) => ({ from: room.phase === 'night' && !isMafia(playerById(room, from)) ? null : from, to })),
    event: room.event, roleInfo, chronicle: room.chronicle.slice(-80), summary: room.summary
  };
}
function broadcast(room) { room.players.forEach(p => send(p.ws, { type: 'state', state: publicState(room, p) })); }
function chron(room, text, kind = 'info', phase = room.phase) {
  room.chronicle.push({ id: (room.chronicle.at(-1)?.id || 0) + 1, round: room.round, phase, kind, text });
  if (room.chronicle.length > 140) room.chronicle.shift();
}
function system(room, text, kind = 'info') { room.messages.push({ name: 'النظام', text, system: true, at: Date.now() }); chron(room, text, kind); }
function makeEvent(room, type, detail = '') { room.event = { id: (room.event?.id || 0) + 1, type, detail }; }
function makeCode() { const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code; do { code = Array.from({ length: 5 }, () => chars[randomInt(chars.length)]).join(''); } while (rooms.has(code)); return code; }
function sendChat(room, message) {
  room.messages.push(message);
  room.players.filter(p => message.privateTo ? p.id === message.privateTo : message.channel === 'mafia' ? p.alive && isMafia(p) : room.phase === 'ended' || p.alive).forEach(p => send(p.ws, { type: 'chat', message }));
}
function addAIPlayer(room) {
  if (room.players.length >= room.settings.maxPlayers) return false;
  const botCount = room.players.filter(p => p.isAI).length;
  room.players.push({ id: Math.random().toString(36).slice(2, 11), name: aiNames[botCount % aiNames.length], ws: null, role: null, alive: true, isAI: true, shotUsed: false });
  system(room, `وصل ${aiNames[botCount % aiNames.length]} إلى المدينة. لاعب ذكي جديد انضم للجلسة.`);
  return true;
}
function addPlayer(room, ws, name) {
  if (room.phase !== 'lobby') return send(ws, { type: 'error', message: 'بدأت الجولة بالفعل، لا يمكن دخول الغرفة الآن.' });
  if (room.players.length >= room.settings.maxPlayers) return send(ws, { type: 'error', message: 'الغرفة مكتملة.' });
  const player = { id: Math.random().toString(36).slice(2, 11), name: String(name || 'لاعب').trim().replace(/[<>]/g, '').slice(0, 18) || 'لاعب', ws, role: null, alive: true, shotUsed: false };
  room.players.push(player); ws.room = room; ws.player = player;
  system(room, `انضم ${player.name} إلى الغرفة`); broadcast(room);
}
function roleDeck(room, count) {
  const mafiaCount = count >= (room.settings.mode === 'classic' ? 7 : 9) ? 2 : 1;
  let roles;
  if (room.settings.mode === 'storm') roles = ['mafia', 'doctor', 'detective', 'bodyguard', 'vigilante', 'medium', ...(count >= 9 ? ['godfather'] : [])];
  else if (room.settings.mode === 'chaos') roles = ['mafia', 'doctor', 'detective', 'jester', 'bodyguard', 'vigilante', 'serialkiller', ...(count >= 9 ? ['godfather', 'medium'] : [])];
  else roles = ['mafia', 'doctor', 'detective'];
  roles = roles.slice(0, count);
  while (roles.length < count) roles.push('citizen');
  if (mafiaCount > 1 && count >= (room.settings.mode === 'classic' ? 7 : 9) && !roles.slice(1).some(role => role === 'mafia' || role === 'godfather')) {
    const slot = room.settings.mode === 'classic' ? 6 : 8;
    if (slot < count) roles[slot] = 'mafia';
  }
  return roles;
}
function activeNightActions(room) {
  return living(room).filter(p => ['doctor', 'detective', 'bodyguard', 'vigilante', 'medium', 'serialkiller'].includes(p.role) && !(p.role === 'vigilante' && p.shotUsed));
}
function startPhaseTimer(room) {
  clearTimeout(room.phaseTimer);
  room.phaseTimer = setTimeout(() => {
    if (room.phase === 'lobby' || room.phase === 'ended') return;
    system(room, 'انتهى وقت الصحيفة؛ حُسمت القرارات المسجلة.'); resolveVote(room, true);
  }, 60000);
}
function pick(list) { return list.length ? list[randomInt(list.length)] : null; }
function scheduleAI(room, delay = 1100) {
  clearTimeout(aiTimers.get(room));
  if (!room.players.some(p => p.isAI && p.alive) || room.phase === 'lobby' || room.phase === 'ended') return;
  const phase = room.phase, round = room.round;
  aiTimers.set(room, setTimeout(() => {
    if (room.phase !== phase || room.round !== round) return;
    const bots = room.players.filter(p => p.isAI && p.alive);
    if (phase === 'night') {
      for (const bot of bots) {
        if (isMafia(bot) && !room.votes.has(bot.id)) {
          const target = pick(room.players.filter(p => p.alive && !isMafia(p)));
          if (target) room.votes.set(bot.id, target.id);
        }
        if (['doctor', 'detective', 'bodyguard', 'vigilante', 'medium', 'serialkiller'].includes(bot.role) && !room.actions.has(bot.id)) {
          const canSkip = bot.role === 'vigilante' && Math.random() < 0.45;
          const choices = room.players.filter(p => p.alive && (bot.role !== 'detective' && bot.role !== 'medium' || p.id !== bot.id) && (bot.role !== 'serialkiller' || p.id !== bot.id));
          const target = canSkip ? null : pick(choices);
          if (target || bot.role === 'vigilante') room.actions.set(bot.id, { role: bot.role, target: target?.id || null });
          if (bot.role === 'vigilante' && target) bot.shotUsed = true;
        }
      }
    } else if (phase === 'day') {
      const lines = ['تصرفات البعض اليوم تثير الشك...', 'لا تستعجلوا بالحكم، انتبهوا لمن يغيّر كلامه.', 'المدينة لا تنام؛ راقبوا الأصوات.', 'الحقيقة تختبئ في تفاصيل صغيرة.'];
      const speaker = pick(bots); if (speaker && Math.random() < 0.85) sendChat(room, { name: speaker.name, text: pick(lines), channel: 'town', at: Date.now() });
      for (const bot of bots) if (!room.votes.has(bot.id)) {
        const candidates = room.players.filter(p => p.alive && p.id !== bot.id && !(isMafia(bot) && isMafia(p)));
        const leader = candidates.map(p => ({ player: p, votes: [...room.votes.values()].filter(id => id === p.id).length })).sort((a, b) => b.votes - a.votes)[0];
        const target = leader?.votes && Math.random() < .38 ? leader.player : pick(candidates);
        if (target) room.votes.set(bot.id, target.id);
      }
    }
    resolveVote(room); broadcast(room);
  }, delay));
}
function startGame(room) {
  if (room.phase !== 'lobby') return { error: 'بدأت هذه الجولة بالفعل.' };
  if (room.players.length < 4) return { error: 'تحتاج إلى ٤ لاعبين على الأقل لبدء اللعبة.' };
  const roles = roleDeck(room, room.players.length);
  for (let i = roles.length - 1; i > 0; i--) { const j = randomInt(i + 1); [roles[i], roles[j]] = [roles[j], roles[i]]; }
  room.players.forEach((p, i) => { p.role = roles[i]; p.alive = true; p.shotUsed = false; });
  room.phase = 'night'; room.round = 1; room.winner = null; room.votes.clear(); room.actions.clear(); room.protectedId = null; room.summary = null; room.chronicle = [];
  room.players.forEach(p => { p.diedRound = null; p.diedCause = null; });
  system(room, 'دقّت ساعة منتصف الليل. وزّعت الهويات السرّية؛ اقرؤوا أدواركم.', 'start'); makeEvent(room, 'deal'); startPhaseTimer(room); scheduleAI(room); return {};
}
const causeLabels = { mafia: 'اغتيال من المافيا', vigilante: 'طلق نارية من حارس الليل', serialkiller: 'ضربة القاتل المتسلسل', guard: 'تضحية لحماية لاعب آخر', vote: 'إقصاء بتصويت المدينة', jester: 'إقصاء بالتصويت… وهو ما أراده' };
function endGame(room, winner, text, eventType) {
  room.phase = 'ended'; room.winner = winner;
  system(room, text, 'win'); makeEvent(room, eventType);
  clearTimeout(room.phaseTimer); room.votes.clear(); room.actions.clear();
  const teamOf = player => roleInfo[player.role]?.team;
  const winners = winner === 'town' ? room.players.filter(p => teamOf(p) === 'town')
    : winner === 'mafia' ? room.players.filter(p => teamOf(p) === 'mafia')
    : winner === 'jester' ? room.players.filter(p => p.role === 'jester')
    : room.players.filter(p => p.role === 'serialkiller');
  room.summary = {
    rounds: room.round, winner,
    winnerLabel: { town: 'أهل المدينة', mafia: 'المافيا', jester: 'المهرّج', serialkiller: 'القاتل المتسلسل' }[winner] || 'المدينة',
    winners: winners.map(p => ({ name: p.name, role: p.role, alive: p.alive })),
    survivors: room.players.filter(p => p.alive).map(p => ({ name: p.name, role: p.role })),
    casualties: room.players.filter(p => !p.alive).map(p => ({ name: p.name, role: p.role, round: p.diedRound, cause: p.diedCause }))
  };
  chron(room, `${room.summary.winnerLabel} حَسموا الملفّ بعد ${room.round} جولات.`, 'end');
}
function finishOrContinue(room) {
  const mafiaCount = livingMafia(room).length;
  const serialCount = livingRole(room, 'serialkiller').length;
  const townCount = living(room).filter(p => !isMafia(p) && p.role !== 'serialkiller').length;
  if (!mafiaCount && !serialCount) return void endGame(room, 'town', 'انتصرت المدينة! كُشفت المافيا والقاتل المتسلسل.', 'town-win');
  if (serialCount && serialCount >= mafiaCount + townCount) return void endGame(room, 'serialkiller', 'سيطر القاتل المتسلسل على المدينة.', 'serialkiller-win');
  if (mafiaCount && mafiaCount >= serialCount + townCount) return void endGame(room, 'mafia', 'انتصرت المافيا... أصبحت المدينة تحت سيطرتها.', 'mafia-win');
  if (room.phase === 'night') { room.phase = 'day'; system(room, 'أشرقت الشمس. اقرأوا خبر الصباح وناقشوا ما حدث قبل التصويت.', 'sunrise'); makeEvent(room, 'sunrise'); }
  else {
    room.phase = 'night'; room.round++; room.protectedId = null;
    const nightText = room.settings.weather === 'rain' ? 'حلّ الليل والمطر يضرب النوافذ؛ عادت الأدوار السرّية إلى العمل.' : room.settings.weather === 'fog' ? 'ابتلع الضباب الشوارع؛ بدأت الأدوار السرّية عملها.' : 'حلّ الليل مجددًا؛ عادت الأدوار السرّية إلى العمل.';
    system(room, nightText, 'nightfall'); makeEvent(room, room.settings.weather === 'rain' ? 'rain-night' : 'nightfall');
  }
  room.votes.clear(); room.actions.clear();
  startPhaseTimer(room); scheduleAI(room, 1100);
}
function closeNight(room, force) {
  const mafia = livingMafia(room), votes = [...room.votes.entries()].filter(([from, to]) => mafia.some(p => p.id === from) && room.players.some(p => p.id === to && p.alive && !isMafia(p)));
  if (!force && (votes.length < mafia.length || activeNightActions(room).some(p => !room.actions.has(p.id)))) return false;
  const totals = new Map(); votes.forEach(([, to]) => totals.set(to, (totals.get(to) || 0) + 1));
  const max = totals.size ? Math.max(...totals.values()) : 0;
  const choices = [...totals].filter(([, n]) => n === max);
  const attack = choices.length === 1 && max > 0 ? playerById(room, choices[0][0]) : null;
  const dead = new Map();
  const guard = livingRole(room, 'bodyguard')[0], guardAction = guard && room.actions.get(guard.id);
  const doctor = livingRole(room, 'doctor')[0], doctorAction = doctor && room.actions.get(doctor.id);
  const guardIntercepts = attack && guardAction?.target === attack.id;
  const saved = attack && attack.id === doctorAction?.target;
  if (guardIntercepts) { if (guard.id !== doctorAction?.target) dead.set(guard.id, 'guard'); }
  else if (attack && !saved) dead.set(attack.id, 'mafia');
  for (const detective of livingRole(room, 'detective')) {
    const action = room.actions.get(detective.id), target = action?.target && playerById(room, action.target);
    if (target?.alive) sendChat(room, { name: 'تقرير المحقق', text: `التحقيق في ${target.name}: ${target.role === 'mafia' ? 'قرائن قوية تربطه بالمافيا.' : 'لم تكشف القرائن انتماءه للمافيا.'}`, system: true, privateTo: detective.id, at: Date.now() });
  }
  for (const medium of livingRole(room, 'medium')) {
    const action = room.actions.get(medium.id), target = action?.target && playerById(room, action.target);
    if (target?.alive) sendChat(room, { name: 'همس الأرواح', text: `سألت أرواح المدينة عن ${target.name}: ${isMafia(target) ? 'ترافقه ظلال المافيا.' : 'لا تشير الهمسات إلى المافيا.'}`, system: true, privateTo: medium.id, at: Date.now() });
  }
  for (const vigilante of livingRole(room, 'vigilante')) {
    const action = room.actions.get(vigilante.id);
    if (action && action.target) {
      vigilante.shotUsed = true;
      const victim = playerById(room, action.target);
      if (victim?.alive) { dead.set(victim.id, 'vigilante'); chron(room, `حارس الليل أطلق رصاصته الوحيدة نحو ${victim.name}.`, 'shot'); makeEvent(room, 'gunshot'); }
    }
  }
  for (const killer of livingRole(room, 'serialkiller')) {
    const targetId = room.actions.get(killer.id)?.target, victim = targetId && playerById(room, targetId);
    if (victim?.alive) dead.set(victim.id, 'serialkiller');
  }
  if (attack && saved) chron(room, `الطبيب ${doctor.name} وصل في اللحظة الأخيرة وأنقذ ${attack.name} من محاولة اغتيال.`, 'save');
  if (guardIntercepts) chron(room, `الحارس ${guard.name} ارتمى أمام ${attack.name} واعترض الرصاصة بدلًا منه.`, 'save');
  for (const [id, cause] of dead) {
    const player = playerById(room, id); if (!player) continue;
    player.alive = false; player.diedRound = room.round; player.diedCause = cause;
    chron(room, `${player.name} (${roleInfo[player.role]?.name || 'ساكن'}) — ${causeLabels[cause] || 'إقصاء'} في الليلة ${room.round}.`, 'death');
  }
  const gunfire = !!attack || [...room.actions.values()].some(a => a.target && ['shoot', 'kill', 'vigilante', 'serialkiller'].includes(a.role));
  if (dead.size) system(room, `مع الفجر، غاب عن المدينة: ${[...dead.keys()].map(id => playerById(room, id)?.name).filter(Boolean).join('، ')}.`, 'dawn');
  else if (guardIntercepts || saved) system(room, 'نجا هدف المافيا الليلة بفضل الحراسة أو العلاج.', 'dawn');
  else system(room, 'مرّت الليلة هادئة؛ لم يصب أحد.', 'dawn');
  finishOrContinue(room);
  if (gunfire && room.phase !== 'ended') makeEvent(room, room.settings.weather === 'rain' ? 'rain-shot' : 'gunshot');
  return true;
}
function closeDay(room, force) {
  const eligible = living(room), valid = [...room.votes.entries()].filter(([from, to]) => eligible.some(p => p.id === from) && eligible.some(p => p.id === to && p.id !== from));
  if (!force && valid.length < eligible.length) return false;
  const totals = new Map(); valid.forEach(([, to]) => totals.set(to, (totals.get(to) || 0) + 1));
  const max = totals.size ? Math.max(...totals.values()) : 0, tied = [...totals].filter(([, n]) => n === max);
  const accused = tied.length === 1 && max > 0 ? playerById(room, tied[0][0]) : null;
  if (totals.size) chron(room, `نتيجة تصويت الجولة ${room.round}: ${[...totals].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${playerById(room, id)?.name} ${n}`).join(' · ')}.`, 'vote');
  if (accused) {
    accused.diedRound = room.round; accused.diedCause = accused.role === 'jester' ? 'jester' : 'vote';
    accused.alive = false;
    if (accused.role === 'jester') { endGame(room, 'jester', `خدع المهرّج المدينة: ${accused.name} أراد الإقصاء… وحصل عليه.`, 'jester-win'); return true; }
    system(room, `صوّتت المدينة على إقصاء ${accused.name} — وكان دوره ${roleInfo[accused.role]?.name || 'غير معروف'}.`, 'banish');
  } else system(room, 'تعادل التصويت؛ لم يُقصَ أحد هذه الجولة.', 'vote');
  finishOrContinue(room); return true;
}
function resolveVote(room, force = false) {
  if (room.phase === 'ended' || room.phase === 'lobby') return;
  const advanced = room.phase === 'night' ? closeNight(room, force) : closeDay(room, force);
  if (advanced) broadcast(room);
}
function applyNightAction(ws, player, room, targetId) {
  const info = roleInfo[player.role], target = targetId ? playerById(room, String(targetId)) : null;
  if (room.phase !== 'night' || !player.alive || !info?.action || ['vote'].includes(info.action)) return send(ws, { type: 'error', message: 'لا يتاح هذا الدور الآن.' });
  if (player.role === 'vigilante' && player.shotUsed) return send(ws, { type: 'error', message: 'استخدمت طلقتك الوحيدة بالفعل.' });
  if (targetId && (!target?.alive || target.id === player.id && ['detective', 'medium', 'serialkiller'].includes(player.role))) return send(ws, { type: 'error', message: 'اختر لاعبًا حيًا صالحًا لهذا الدور.' });
  if (['detective', 'medium', 'serialkiller', 'vigilante'].includes(player.role) && !targetId && player.role !== 'vigilante') return send(ws, { type: 'error', message: 'اختر هدفًا لهذا الدور.' });
  room.actions.set(player.id, { role: info.action, target: target?.id || null });
  if (player.role === 'vigilante' && target) player.shotUsed = true;
  const feedback = { protect: 'سُجّلت الحماية سرًا.', inspect: 'أُرسل التقرير إلى سجلّك الخاص.', guard: 'بدأت الحراسة في الخفاء.', shoot: target ? 'أُطلقت طلقتك الوحيدة.' : 'احتفظت بطلقتك لهذه الليلة.', seance: 'وصل همس الأرواح إلى سجلّك الخاص.', kill: 'سُجّل هدفك لهذه الليلة.' };
  send(ws, { type: 'notice', message: feedback[info.action] });
  resolveVote(room); broadcast(room);
}
wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: 'طلب غير صالح.' }); }
    if (msg.type === 'create') {
      const code = makeCode(), maxPlayers = Math.min(12, Math.max(4, Number(msg.maxPlayers) || 8));
      const room = { code, hostId: null, phase: 'lobby', round: 0, winner: null, players: [], messages: [], votes: new Map(), actions: new Map(), protectedId: null, phaseTimer: null, event: { id: 0, type: 'init', detail: '' }, chronicle: [], summary: null, settings: { maxPlayers, mode: modeIds.has(msg.mode) ? msg.mode : 'classic', weather: weatherIds.has(msg.weather) ? msg.weather : 'clear' } };
      rooms.set(code, room); addPlayer(room, ws, msg.name); if (ws.player) room.hostId = ws.player.id;
      if (msg.addAI) addAIPlayer(room);
      broadcast(room);
    } else if (msg.type === 'join') {
      const room = rooms.get(String(msg.code || '').trim().toUpperCase()); if (!room) return send(ws, { type: 'error', message: 'رمز الغرفة غير موجود. تحقق منه وحاول مجددًا.' }); addPlayer(room, ws, msg.name);
    } else {
      const room = ws.room, player = ws.player; if (!room || !player) return send(ws, { type: 'error', message: 'انضم إلى غرفة أولًا.' });
      if (msg.type === 'addAI') {
        if (player.id !== room.hostId || room.phase !== 'lobby') return send(ws, { type: 'error', message: 'يمكن لمضيف الجلسة إضافة لاعب ذكي قبل بدء الجولة.' });
        if (!addAIPlayer(room)) return send(ws, { type: 'error', message: 'اكتمل عدد اللاعبين المسموح به في الجلسة.' }); broadcast(room);
      } else if (msg.type === 'start') {
        if (player.id !== room.hostId) return send(ws, { type: 'error', message: 'مضيف الغرفة فقط يمكنه بدء اللعبة.' });
        const result = startGame(room); if (result.error) return send(ws, { type: 'error', message: result.error }); broadcast(room);
      } else if (msg.type === 'chat') {
        const text = String(msg.text || '').trim().replace(/[<>]/g, '').slice(0, 280); if (!text || (!player.alive && room.phase !== 'ended')) return;
        if (room.phase === 'night' && !isMafia(player)) return send(ws, { type: 'error', message: 'لا يمكن للمدينة التحدث أثناء الليل.' });
        sendChat(room, { name: player.name, text, channel: room.phase === 'night' ? 'mafia' : 'town', at: Date.now() });
      } else if (msg.type === 'vote') {
        const target = playerById(room, String(msg.target));
        if (!player.alive || !target?.alive || player.id === target.id || !['day', 'night'].includes(room.phase)) return;
        if (room.phase === 'night' && (!isMafia(player) || isMafia(target))) return send(ws, { type: 'error', message: 'تصويت الليل متاح للمافيا لاختيار شخص من المدينة.' });
        if (room.phase === 'day' && isMafia(player) && isMafia(target)) return send(ws, { type: 'error', message: 'لا يمكنك التصويت لإقصاء حليفك.' });
        room.votes.set(player.id, target.id); if (room.phase === 'day') system(room, `${player.name} أدلى بصوته.`);
        resolveVote(room); broadcast(room);
      } else if (msg.type === 'nightAction') applyNightAction(ws, player, room, msg.target || null);
      else if (msg.type === 'restart') {
        if (room.hostId !== player.id) return send(ws, { type: 'error', message: 'المضيف وحده يفتح جولة جديدة.' });
        if (room.phase !== 'ended') return;
        clearTimeout(room.phaseTimer); clearTimeout(aiTimers.get(room));
        room.phase = 'lobby'; room.round = 0; room.winner = null; room.summary = null; room.chronicle = [];
        room.votes.clear(); room.actions.clear(); room.protectedId = null;
        room.players.forEach(p => { p.alive = true; p.role = null; p.shotUsed = false; p.diedRound = null; p.diedCause = null; });
        system(room, `${player.name} أعاد الجميع إلى الردهة. جولة جديدة تنتظر توزيع البطاقات.`, 'lobby'); broadcast(room);
      }
      else if (msg.type === 'leave') ws.close();
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
