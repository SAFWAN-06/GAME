(() => {
  const $ = id => document.getElementById(id);
  // بعض المتصفحات تعرض الأرقام لاتينية مع اللغة العربية؛ نوحّدها إلى الأرقام العربية في كل الواجهة.
  const arabicDigits = value => String(value).replace(/[0-9]/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
  const nativeLocaleString = Number.prototype.toLocaleString;
  Number.prototype.toLocaleString = function (locales, options) {
    const text = nativeLocaleString.call(this, locales, options);
    return typeof locales === 'string' && locales.startsWith('ar') ? arabicDigits(text) : text;
  };
  const sections = { home: $('home'), setup: $('setup'), room: $('room') };
  const modalIds = ['setup-modal', 'invite-modal', 'role-modal', 'action-modal', 'ai-modal', 'start-modal', 'leave-modal', 'read-modal', 'end-modal'];
  let socket = null, state = null, setupMode = 'create', toastTimer, pendingAction = null;
  let audioContext = null, rainSource = null, rainGain = null, lastEventId = 0, audioOn = false;
  const roleDefaults = {
    mafia: { name: 'المافيا', label: 'عضو المافيا', symbol: '♠', action: 'vote', description: 'صوّت سرًا مع فريقك لاختيار ضحية، واخفِ هويتك نهارًا.' },
    godfather: { name: 'الأب الروحي', label: 'الأب الروحي للمافيا', symbol: '♛', action: 'vote', description: 'قائد المافيا. يظهر تحقيق المحقق عنك بريئًا.' },
    doctor: { name: 'الطبيب', label: 'طبيب المدينة', symbol: '✚', action: 'protect', description: 'اختر شخصًا تحميه هذه الليلة. قد تنقذ هدف المافيا.' },
    detective: { name: 'المحقق', label: 'محقق المدينة', symbol: '⌕', action: 'inspect', description: 'افحص لاعبًا ليلًا. نتيجة التحقيق سرية لك وحدك.' },
    bodyguard: { name: 'الحارس الشخصي', label: 'حارس المدينة', symbol: '⛨', action: 'guard', description: 'احرس لاعبًا؛ إن هاجمته المافيا تتلقى الضربة بدلًا منه.' },
    vigilante: { name: 'حارس الليل', label: 'حارس الليل', symbol: '⌖', action: 'shoot', description: 'لديك طلقة واحدة فقط. أطلقها بحذر أو احتفظ بها.' },
    medium: { name: 'الوسيط', label: 'وسيط الأرواح', symbol: '☽', action: 'seance', description: 'اسأل أرواح المدينة عن لاعب حي؛ تصل الإجابة إليك سرًا.' },
    jester: { name: 'المهرّج', label: 'المهرّج المريب', symbol: '☻', action: null, description: 'أقنع أهل المدينة بإقصائك نهارًا لتفوز وحدك.' },
    serialkiller: { name: 'القاتل المتسلسل', label: 'القاتل المتسلسل', symbol: '☠', action: 'kill', description: 'تقاتل وحدك. اختر هدفًا كل ليلة وحاول السيطرة على المدينة.' },
    citizen: { name: 'أهل المدينة', label: 'من أهل المدينة', symbol: '♢', action: null, description: 'ناقشوا الأدلة وصوّتوا نهارًا لكشف المخادعين.' }
  };
  const actionVerb = { vote: 'صوّت سرًا لاستهداف', protect: 'احمِ هذا اللاعب الليلة', inspect: 'افحص هويّة', guard: 'احرس هذا اللاعب الليلة', shoot: 'أطلق طلقتك الوحيدة على', seance: 'اسأل الأرواح عن', kill: 'اختر ضحيتك لهذه الليلة' };
  function escapeHtml(value) { const node = document.createElement('div'); node.textContent = String(value); return node.innerHTML; }
  function toast(text) { const node = $('toast'); node.textContent = text; node.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('visible'), 3000); }
  function openModal(id) { const dialog = $(id); if (dialog && !dialog.open) dialog.showModal(); }
  function closeModal(id) { const dialog = $(id); if (dialog?.open) dialog.close(); }
  function show(name) { Object.entries(sections).forEach(([key, node]) => { node.hidden = key !== name; }); if (name === 'setup') openModal('setup-modal'); else closeModal('setup-modal'); if (name !== 'room') window.scrollTo({ top: 0, behavior: 'smooth' }); else setTimeout(() => $('room').scrollIntoView({ behavior: 'smooth', block: 'start' }), 30); }

  function soundContext() {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume();
    return audioContext;
  }
  function tone(freq, duration, { type = 'sine', volume = .08, endFreq = freq, delay = 0 } = {}) {
    if (!audioOn) return;
    try { const c = soundContext(), osc = c.createOscillator(), gain = c.createGain(), start = c.currentTime + delay; osc.type = type; osc.frequency.setValueAtTime(freq, start); osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), start + duration); gain.gain.setValueAtTime(.0001, start); gain.gain.exponentialRampToValueAtTime(volume, start + .015); gain.gain.exponentialRampToValueAtTime(.0001, start + duration); osc.connect(gain).connect(c.destination); osc.start(start); osc.stop(start + duration + .02); } catch { /* Audio is optional. */ }
  }
  function noiseBurst(duration, volume, frequency, q = .7) {
    if (!audioOn) return;
    try { const c = soundContext(), frames = Math.ceil(c.sampleRate * duration), buffer = c.createBuffer(1, frames, c.sampleRate), data = buffer.getChannelData(0); for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames); const source = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain(); source.buffer = buffer; filter.type = 'lowpass'; filter.frequency.value = frequency; filter.Q.value = q; gain.gain.setValueAtTime(volume, c.currentTime); gain.gain.exponentialRampToValueAtTime(.0001, c.currentTime + duration); source.connect(filter).connect(gain).connect(c.destination); source.start(); } catch { /* Audio is optional. */ }
  }
  function startRain() {
    if (!audioOn || !state || state.settings.weather !== 'rain' || state.phase === 'ended' || rainSource) return;
    try { const c = soundContext(), frames = c.sampleRate * 2, buffer = c.createBuffer(1, frames, c.sampleRate), data = buffer.getChannelData(0); for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1; rainSource = c.createBufferSource(); const filter = c.createBiquadFilter(); rainGain = c.createGain(); rainSource.buffer = buffer; rainSource.loop = true; filter.type = 'lowpass'; filter.frequency.value = 850; rainGain.gain.value = .025; rainSource.connect(filter).connect(rainGain).connect(c.destination); rainSource.start(); } catch { rainSource = null; }
  }
  function stopRain() { if (rainSource) { try { rainSource.stop(); rainSource.disconnect(); } catch { /* already stopped */ } rainSource = null; rainGain = null; } }
  function setAudio(enabled) {
    audioOn = enabled; try { localStorage.setItem('mafia-sounds', enabled ? 'on' : 'off'); } catch { /* private browsing can disable storage */ }
    const button = $('sound-toggle'); if (button) { button.setAttribute('aria-pressed', String(enabled)); button.querySelector('.sound-toggle-state').textContent = enabled ? 'مفعّلة' : 'مغلقة'; button.classList.toggle('enabled', enabled); }
    if (!enabled) stopRain(); else if (state?.settings.weather === 'rain') startRain();
  }
  function playEvent(event) {
    if (!audioOn || !event || event.id <= lastEventId) return;
    lastEventId = event.id;
    if (event.type === 'deal') { tone(480, .2, { volume: .07 }); tone(650, .28, { volume: .055, delay: .13 }); }
    else if (event.type === 'sunrise' || event.type === 'town-win') { tone(392, .6, { volume: .065 }); tone(494, .75, { volume: .055, delay: .12 }); tone(587, .8, { volume: .045, delay: .25 }); }
    else if (event.type === 'jester-win') { tone(700, .17, { type: 'triangle', volume: .05 }); tone(840, .23, { type: 'triangle', volume: .045, delay: .15 }); }
    else if (event.type.includes('shot') || event.type === 'gunshot') { noiseBurst(.28, .22, 1150, 1.1); tone(72, .34, { type: 'sawtooth', volume: .18, endFreq: 34 }); }
    else if (event.type.includes('night') || event.type === 'jester-win' || event.type === 'mafia-win' || event.type === 'serialkiller-win') { tone(190, .38, { type: 'triangle', volume: .045, endFreq: 110 }); }
    if (state?.settings.weather === 'rain' && state.phase !== 'ended') startRain(); else stopRain();
  }
  $('sound-toggle').addEventListener('click', () => setAudio(!audioOn));
  try { setAudio(localStorage.getItem('mafia-sounds') === 'on'); } catch { setAudio(false); }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopRain(); else if (audioOn && state?.settings.weather === 'rain') startRain(); });

  function readAloud(text = '') {
    if (!('speechSynthesis' in window)) return toast('ميزة القراءة الصوتية غير متاحة في هذا المتصفح.');
    window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(text || $('bulletin-title').textContent + '. ' + $('bulletin-text').textContent); utterance.lang = 'ar-SA'; utterance.rate = .9; utterance.pitch = .95; window.speechSynthesis.speak(utterance);
  }
  $('read-bulletin').addEventListener('click', () => { $('read-modal-title').innerHTML = `${escapeHtml($('bulletin-title').textContent)}.`; $('read-modal-text').textContent = $('bulletin-text').textContent; openModal('read-modal'); });
  $('read-aloud').addEventListener('click', () => readAloud(`${$('read-modal-title').textContent}. ${$('read-modal-text').textContent}`));
  $('stop-reading').addEventListener('click', () => window.speechSynthesis?.cancel());

  function renderDealtCard() {
    if (!state) return;
    const role = state.roleInfo?.[state.me.role] || roleDefaults[state.me.role] || roleDefaults.citizen;
    $('dealt-card').className = `dealt-card role-${state.me.role} faction-${role.team || 'town'}`;
    $('dealt-card').innerHTML = ticketHtml(role, { topLeft: `بطاقة الهوية · الجولة ${state.round.toLocaleString('ar')}`, topRight: `NO. ${state.code}`, kicker: 'هويتك السرّية في هذه المدينة', footerLeft: 'صحيفة المدينة · ملفّ مختوم', footerRight: '✦ لك وحدك' });
    openModal('role-modal');
  }
  const factionLabel = team => team === 'mafia' ? 'المافيا' : (team === 'neutral' || team === 'serialkiller') ? 'مستقل' : 'المدينة';
  const causeLabels = { mafia: 'اغتيال من المافيا', vigilante: 'طلق نارية من حارس الليل', serialkiller: 'ضربة القاتل المتسلسل', guard: 'تضحية لحماية لاعب آخر', vote: 'إقصاء بتصويت المدينة', jester: 'إقصاء بالتصويت… وهو ما أراده' };
  function ticketHtml(role, { topLeft, topRight, kicker, footerLeft, footerRight }) {
    return `<div class="identity-ticket faction-${role.team || 'town'}"><span class="ticket-watermark" aria-hidden="true">${role.symbol}</span><span class="ticket-stub" aria-hidden="true"></span><div class="ticket-top"><span>${escapeHtml(topLeft)}</span><span class="ticket-serial">${escapeHtml(topRight)}</span></div><div class="ticket-seal"><span>${role.symbol}</span></div><div class="ticket-dossier"><span class="ticket-kicker">${escapeHtml(kicker)}</span><h4>${escapeHtml(role.label)}</h4><span class="ticket-role-name">${escapeHtml(role.name)}</span><span class="ticket-faction">فصيل ${factionLabel(role.team)}</span></div><div class="ticket-description">${escapeHtml(role.description)}</div><div class="ticket-bottom"><span>${escapeHtml(footerLeft)}</span><span>${escapeHtml(footerRight)}</span></div><span class="ticket-edge" aria-hidden="true"></span></div>`;
  }
  const kindIcons = { death: '✝', save: '✚', shot: '⌖', vote: '◈', win: '✦', start: '☾', nightfall: '☾', sunrise: '☀', dawn: '◐', banish: '⚑', end: '✧', lobby: '◌', info: '·' };
  function renderChronicle() {
    const entries = state?.chronicle || [], card = $('chronicle-card');
    card.hidden = !entries.length || state.phase === 'lobby';
    if (card.hidden) return;
    $('chronicle-count').textContent = `${entries.length.toLocaleString('ar')} وقائع`;
    let lastKey = '';
    $('chronicle-list').innerHTML = entries.map(entry => {
      const key = `${entry.round}-${entry.phase}`;
      const head = key === lastKey ? '' : `<li class="chronicle-round"><span>${entry.round === 0 ? 'سجل الردهة' : `الجولة ${entry.round.toLocaleString('ar')}`}</span><b>${entry.phase === 'day' ? 'نهار' : entry.phase === 'night' ? 'ليل' : 'ملفّ'}</b></li>`;
      lastKey = key;
      return `${head}<li class="chronicle-item kind-${entry.kind}"><span class="chronicle-dot" aria-hidden="true">${kindIcons[entry.kind] || '·'}</span><p>${escapeHtml(entry.text)}</p></li>`;
    }).join('');
  }
  let endShown = false;
  function buildSummary() {
    const summary = state.summary || { rounds: state.round, winner: state.winner, winnerLabel: '', winners: [], survivors: [], casualties: [] };
    const winners = summary.winners || [], survivors = summary.survivors || [], casualties = summary.casualties || [];
    const title = { town: 'عادت المدينة إلى أهلها.', mafia: 'المافيا صارت المدينة.', jester: 'المهرّج ضحك أخيرًا.', serialkiller: 'القاتل المتسلسل انفرد بالمدينة.' }[summary.winner] || 'انتهت الليلة.';
    const eyebrow = { town: 'خاتمة الملف · انتصار المدينة', mafia: 'خاتمة الملف · سيطرة المافيا', jester: 'خاتمة الملف · فوز مستقل', serialkiller: 'خاتمة الملف · فوز مستقل' }[summary.winner] || 'خاتمة الملف';
    $('end-modal').className = `modal-window end-modal winner-${summary.winner || 'town'}`;
    $('end-eyebrow').textContent = eyebrow;
    $('end-title').innerHTML = title;
    $('end-seal').textContent = { town: '♢', mafia: '♠', jester: '☻', serialkiller: '☠' }[summary.winner] || '✧';
    $('end-subtitle').textContent = `${summary.winnerLabel || 'المدينة'} انتصروا بعد ${(summary.rounds || state.round).toLocaleString('ar')} جولات · ${survivors.length.toLocaleString('ar')} ناجون · ${casualties.length.toLocaleString('ar')} ضحية.`;
    $('end-stats').innerHTML = [['الجولات', (summary.rounds || state.round).toLocaleString('ar')], ['السكان', state.players.length.toLocaleString('ar')], ['الناجون', survivors.length.toLocaleString('ar')], ['الضحايا', casualties.length.toLocaleString('ar')]].map(([label, value]) => `<div class="end-stat"><strong>${value}</strong><span>${label}</span></div>`).join('');
    $('end-roles').innerHTML = state.players.map(p => {
      const role = state.roleInfo?.[p.role] || roleDefaults[p.role] || roleDefaults.citizen;
      const won = winners.some(w => w.name === p.name);
      const fate = p.alive ? 'نجا حتى النهاية' : `أُقصي في الجولة ${(p.diedRound || 0).toLocaleString('ar')} · ${causeLabels[p.diedCause] || 'إقصاء'}`;
      return `<div class="end-role faction-${role.team || 'town'}${won ? ' is-winner' : ''}"><span class="end-role-symbol">${role.symbol}</span><div class="end-role-copy"><strong>${escapeHtml(p.name)}${p.id === state.me.id ? ' (أنت)' : ''}</strong><span>${escapeHtml(role.label)} · ${factionLabel(role.team)}</span><em>${escapeHtml(fate)}</em></div>${won ? '<span class="end-role-crown">♛</span>' : ''}</div>`;
    }).join('');
    const story = (state.chronicle || []).filter(e => ['death', 'save', 'shot', 'banish', 'vote', 'win', 'end', 'lobby'].includes(e.kind));
    $('end-story').innerHTML = (story.length ? story : (state.chronicle || [])).slice(-16).map(e => `<li class="kind-${e.kind}"><span>الجولة ${e.round.toLocaleString('ar')}</span><p>${escapeHtml(e.text)}</p></li>`).join('');
    $('end-again').hidden = state.me.id !== state.hostId;
  }
  function showEndScreen() { if (!state) return; endShown = true; buildSummary(); openModal('end-modal'); }
  function summaryText() {
    const summary = state.summary || {};
    const lines = [`ليلة المافيا — ${summary.winnerLabel || 'المدينة'} انتصروا بعد ${summary.rounds || state.round} جولات.`, '', 'الهويات:'];
    state.players.forEach(p => { const role = state.roleInfo?.[p.role] || roleDefaults[p.role] || roleDefaults.citizen; lines.push(`• ${p.name}: ${role.label}${p.alive ? '' : ` — أُقصي (${causeLabels[p.diedCause] || 'إقصاء'})`}`); });
    lines.push('', 'سجل الوقائع:');
    (state.chronicle || []).filter(e => ['death', 'save', 'shot', 'banish', 'win', 'end'].includes(e.kind)).forEach(e => lines.push(`• جولة ${e.round}: ${e.text}`));
    return lines.join('\n');
  }
  function confirmAction(target, actionType) {
    const player = state?.players.find(p => p.id === target); if (!player) return;
    pendingAction = { target, actionType };
    const role = state.roleInfo?.[state.me.role] || roleDefaults[state.me.role] || roleDefaults.citizen;
    const night = actionType === 'nightAction', action = role.action;
    const verbs = { protect: 'حمايته من استهداف المافيا', inspect: 'فحص هويته سرًا', guard: 'حراسته هذه الليلة؛ ستتلقى الضربة عنه', shoot: state.me.shotUsed ? 'لا تتاح لك طلقة أخرى هذا الموسم' : 'إطلاق طلقتك الوحيدة عليه', seance: 'سؤال أرواح المدينة عن انتمائه', kill: 'إقصاؤه في محاولة للسيطرة على المدينة' };
    $('action-modal-title').innerHTML = night ? 'أكّد <em>قرارك السرّي.</em>' : 'ثبّت <em>صوتك.</em>';
    $('action-modal-eyebrow').textContent = night ? `مهمة الليل · ${role.name}` : 'صحيفة المدينة · تصويت النهار';
    $('action-modal-description').textContent = night ? `قرارك: ${verbs[action] || actionVerb[action] || 'اختيار هدف لهذه الليلة'}. لا يمكن لأحد غيرك معرفة هذا الاختيار.` : 'صوتك يحدد مصير المدينة. راجع اختيارك قبل تأكيده.';
    $('action-target-name').textContent = player.name;
    $('action-target-subtitle').textContent = night ? `${role.symbol} ${role.name} · إجراء سري` : `${player.isAI ? '✦ لاعب ذكي' : '♙ أحد سكان المدينة'} · صوت واحد`;
    $('action-confirm').innerHTML = `${night ? 'أكّد المهمة' : 'أكّد التصويت'} <span class="button-arrow">←</span>`;
    openModal('action-modal');
  }
  function connect() {
    return new Promise((resolve, reject) => {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'; const ws = new WebSocket(`${scheme}//${location.host}`); socket = ws;
      ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('تعذر الاتصال بالخادم. حاول مجددًا.')), { once: true });
      ws.addEventListener('close', () => { stopRain(); if (state) { state = null; show('home'); toast('انقطع الاتصال بالغرفة.'); } });
      ws.addEventListener('message', event => {
        let message; try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'state') {
          const previous = state;
          const dealt = previous?.phase === 'lobby' && message.state.phase === 'night';
          const justEnded = previous && previous.phase !== 'ended' && message.state.phase === 'ended';
          state = message.state; show('room'); render(); playEvent(state.event);
          if (dealt && state.me.alive) renderDealtCard();
          if (justEnded && !endShown) showEndScreen();
        } else if (message.type === 'chat') { if (state) { state.messages.push(message.message); renderChat(); } }
        else if (message.type === 'notice' || message.type === 'error') toast(message.message);
      });
    });
  }
  async function submitSetup() {
    const name = $('player-name').value.trim(); if (!name) { $('player-name').focus(); return toast('اكتب اسمك أولًا.'); }
    if (socket?.readyState === WebSocket.OPEN) socket.close(); $('submit-label').textContent = 'لحظة واحدة...'; $('setup-submit').disabled = true;
    try {
      await connect();
      if (setupMode === 'create') socket.send(JSON.stringify({ type: 'create', name, maxPlayers: Number($('player-limit').value), mode: $('game-mode').value, weather: $('weather-mode').value, addAI: window.includeAIOnCreate === true }));
      else { const code = $('room-code').value.trim().toUpperCase(); if (code.length !== 5) { socket.close(); return toast('رمز الغرفة يتكوّن من ٥ أحرف.'); } socket.send(JSON.stringify({ type: 'join', name, code })); }
      window.includeAIOnCreate = false;
    } catch (error) { toast(error.message); }
    finally { $('submit-label').textContent = setupMode === 'join' ? 'انضم إلى الغرفة' : 'أنشئ الغرفة'; $('setup-submit').disabled = false; }
  }
  function openSetup(mode) { setupMode = mode; $('setup-title').innerHTML = mode === 'join' ? 'عد للمدينة <em>مجدداً.</em>' : 'جهّز <em>غرفتك.</em>'; $('create-options').hidden = mode !== 'create'; $('join-options').hidden = mode !== 'join'; $('submit-label').textContent = mode === 'join' ? 'انضم إلى الغرفة' : 'أنشئ الغرفة'; $('player-name').placeholder = 'كيف يناديك أصدقاؤك؟'; show('setup'); setTimeout(() => $('player-name').focus(), 200); }
  $('hero-create').addEventListener('click', () => { window.includeAIOnCreate = false; openSetup('create'); });
  $('hero-join').addEventListener('click', () => openSetup('join'));
  $('hero-ai').addEventListener('click', () => { window.includeAIOnCreate = true; openSetup('create'); });
  $('setup-close').addEventListener('click', () => show('home')); $('setup-submit').addEventListener('click', submitSetup);
  $('room-code')?.addEventListener('input', event => { event.target.value = event.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 5); });
  $('start-game').addEventListener('click', () => openModal('start-modal'));
  $('start-confirm').addEventListener('click', () => { closeModal('start-modal'); socket?.send(JSON.stringify({ type: 'start' })); });
  $('add-ai').addEventListener('click', () => openModal('ai-modal'));
  $('ai-confirm').addEventListener('click', () => { closeModal('ai-modal'); socket?.send(JSON.stringify({ type: 'addAI' })); });
  $('share-room').addEventListener('click', () => { if (!state) return; const link = new URL(location.href); link.searchParams.set('room', state.code); $('invite-link').value = link.toString(); $('invite-code').textContent = state.code; openModal('invite-modal'); });
  $('copy-invite').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('invite-link').value); toast('نُسخ رابط الدعوة.'); } catch { $('invite-link').select(); document.execCommand('copy'); toast('نُسخ رابط الدعوة.'); } });
  $('leave-room').addEventListener('click', () => openModal('leave-modal'));
  $('end-review').addEventListener('click', () => showEndScreen());
  $('end-copy').addEventListener('click', async () => { const text = summaryText(); try { await navigator.clipboard.writeText(text); toast('نُسخت خلاصة اللعبة.'); } catch { toast('تعذّر النسخ من هذا المتصفح.'); } });
  $('end-again').addEventListener('click', () => { closeModal('end-modal'); socket?.send(JSON.stringify({ type: 'restart' })); toast('عادت المدينة إلى الردهة.'); });
  $('chronicle-read').addEventListener('click', () => { const lines = (state?.chronicle || []).slice(-8).map(e => e.text); if (!lines.length) return toast('لا وقائع بعد.'); readAloud(`سجل المدينة. ${lines.join('. ')}`); });
  $('leave-confirm').addEventListener('click', () => { closeModal('leave-modal'); state = null; stopRain(); if (socket?.readyState === WebSocket.OPEN) socket.close(); show('home'); });
  $('action-confirm').addEventListener('click', () => { if (pendingAction) socket?.send(JSON.stringify({ type: pendingAction.actionType, target: pendingAction.target })); pendingAction = null; closeModal('action-modal'); });
  $('reveal-confirm').addEventListener('click', () => closeModal('role-modal'));
  modalIds.map($).forEach(dialog => { dialog?.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }); });
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => closeModal(button.dataset.close)));
  const inviteCode = new URLSearchParams(location.search).get('room'); if (inviteCode) { $('room-code').value = inviteCode.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 5); openSetup('join'); }
  $('chat-form').addEventListener('submit', event => { event.preventDefault(); const input = $('chat-input'), text = input.value.trim(); if (!text) return; socket?.send(JSON.stringify({ type: 'chat', text })); input.value = ''; });

  function render() {
    if (!state) return;
    const me = state.me, meRole = state.roleInfo?.[me.role] || roleDefaults[me.role] || roleDefaults.citizen, isHost = me.id === state.hostId, night = state.phase === 'night', dead = !me.alive;
    $('room-code-display').textContent = state.code; $('max-count').textContent = state.settings.maxPlayers.toLocaleString('ar'); $('player-count').textContent = state.players.length.toLocaleString('ar');
    $('room-status-label').textContent = state.phase === 'lobby' ? 'الطبعة الحيّة · ردهة المدينة' : state.phase === 'ended' ? 'الطبعة الأخيرة · كُشفت الأسرار' : night ? 'الطبعة الحيّة · بعد منتصف الليل' : 'الطبعة الحيّة · شمس جديدة على المدينة';
    $('players-list').innerHTML = state.players.map(p => {
      const known = state.phase === 'ended' || p.id === me.id || p.role && ['mafia', 'godfather'].includes(me.role) && ['mafia', 'godfather'].includes(p.role);
      const role = known ? (state.roleInfo?.[p.role] || roleDefaults[p.role]) : null;
      const subtitle = !p.alive ? `أُقصي في الجولة ${(p.diedRound || 0).toLocaleString('ar')}${p.diedCause ? ' · ' + (causeLabels[p.diedCause] || 'إقصاء') : ''}` : role ? `${role.symbol} ${role.name}` : state.phase === 'lobby' ? 'بيننا' : 'لا يزال بيننا';
      const faction = role ? ` faction-${role.team || 'town'}` : '';
      return `<div class="player-row${!p.alive ? ' player-dead' : ''}${faction}"><span class="player-tone" aria-hidden="true"></span><div class="player-avatar">${escapeHtml(p.name.slice(0, 1))}</div><div class="player-info"><div class="player-name">${escapeHtml(p.name)}${p.id === me.id ? ' <span>(أنت)</span>' : ''}${p.isAI ? ' <span>✦ ذكي</span>' : ''}</div><div class="player-sub">${escapeHtml(subtitle)}</div></div>${role && state.phase === 'ended' ? `<span class="player-role-chip">${role.symbol} ${escapeHtml(role.name)}</span>` : ''}${p.host && state.phase === 'lobby' ? '<span class="player-tag">المضيف</span>' : ''}${!p.alive ? '<span class="player-tag dead">خارج الجولة</span>' : ''}</div>`;
    }).join('');
    const roleCard = $('role-card');
    if (state.phase !== 'lobby') { roleCard.hidden = false; roleCard.className = `role-card role-${me.role} faction-${meRole.team || 'town'}`; roleCard.innerHTML = ticketHtml(meRole, { topLeft: `بطاقة العضوية · الجولة ${state.round.toLocaleString('ar')}`, topRight: me.shotUsed ? 'الطلقة أُطلقت' : '•••• مختوم', kicker: 'هويتك السرّية · لا تُظهرها لأحد', footerLeft: `فصيل: ${factionLabel(meRole.team)}`, footerRight: 'اضغط للفتح' }); }
    else roleCard.hidden = true;
    roleCard.tabIndex = state.phase === 'lobby' ? -1 : 0; roleCard.setAttribute('role', state.phase === 'lobby' ? 'presentation' : 'button'); roleCard.setAttribute('aria-label', 'افتح بطاقة هويتك السرية'); roleCard.onclick = () => { if (state.phase !== 'lobby') renderDealtCard(); }; roleCard.onkeydown = event => { if (state.phase !== 'lobby' && ['Enter', ' '].includes(event.key)) { event.preventDefault(); renderDealtCard(); } };
    $('add-ai').hidden = !(state.phase === 'lobby' && isHost && state.players.length < state.settings.maxPlayers); $('add-ai').disabled = state.players.length >= state.settings.maxPlayers;
    $('start-game').hidden = !(state.phase === 'lobby' && isHost); $('start-game').disabled = state.phase === 'lobby' && state.players.length < 4; $('lobby-hint').hidden = state.phase !== 'lobby' || !isHost;
    if (state.phase === 'lobby') $('lobby-hint').textContent = `التشكيلة: ${{ classic: 'الصحيفة الكلاسيكية', storm: 'ليلة العاصفة', chaos: 'مدينة الفوضى' }[state.settings.mode]} · الطقس: ${{ clear: 'صحو', rain: 'ماطر', fog: 'ضبابي' }[state.settings.weather]}. ${state.players.length < 4 ? `ينقصكم ${4 - state.players.length} لاعبين على الأقل.` : 'اكتمل الحد الأدنى؛ افتحوا ملف القضية.'}`;
    const badge = $('phase-badge'), area = $('vote-area'), hint = $('action-hint'), scene = $('phase-scene'); area.hidden = true; hint.hidden = true;
    scene.className = `phase-scene ${state.phase === 'ended' ? state.winner === 'town' ? 'victory-town' : 'victory-mafia' : state.phase === 'lobby' ? 'night' : state.phase} weather-${state.settings.weather}`;
    $('paper-edition').textContent = String(Math.max(1, state.round)).padStart(2, '0').replace(/[0-9]/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
    $('paper-weather').textContent = `${({ clear: 'صحو', rain: 'ماطر', fog: 'ضبابي' })[state.settings.weather] || 'صحو'}${state.phase === 'lobby' ? '' : state.phase === 'ended' ? ' · ملفّ مغلق' : night ? ' · ليل' : ' · نهار'}`;
    $('scene-eyebrow').textContent = state.phase === 'lobby' ? 'الطبعة الأولى · قبل منتصف الليل' : state.phase === 'ended' ? 'الطبعة الأخيرة · الحقيقة ظهرت' : night ? `الجولة ${state.round.toLocaleString('ar')} · المدينة بعد منتصف الليل` : `الجولة ${state.round.toLocaleString('ar')} · شمس جديدة فوق المدينة`;
    const headline = [...state.messages].reverse().find(m => m.system)?.text || 'شارك رمز الدعوة. أضف أصدقاءك إلى الغرفة نفسها.';
    $('bulletin-time').textContent = `الجولة ${state.round.toLocaleString('ar')}`; $('bulletin-text').textContent = headline;
    if (state.phase === 'lobby') { badge.textContent = 'الردهة · مباشر'; $('round-label').textContent = 'طبعة ما قبل الليل'; $('game-title').textContent = 'المدينة تنتظر حكايتها.'; $('game-description').textContent = `التشكيلة: ${{ classic: 'الكلاسيكية', storm: 'العاصفة', chaos: 'الفوضى' }[state.settings.mode]} · الطقس ${state.settings.weather === 'rain' ? 'ممطر' : state.settings.weather === 'fog' ? 'ضبابي' : 'صحو'}.`; $('chat-title').textContent = 'رسائل المدينة'; $('chat-subtitle').textContent = 'رسائل الغرفة'; $('bulletin-title').textContent = 'الأبواب مفتوحة للسكان'; }
    else if (state.phase === 'ended') { badge.textContent = 'كُشفت الأسرار · نهاية الجولة'; $('round-label').textContent = `الطبعة الأخيرة · الجولة ${state.round.toLocaleString('ar')}`; $('game-title').textContent = state.winner === 'town' ? 'العدالة عادت إلى المدينة.' : state.winner === 'jester' ? 'المهرّج خدع الجميع!' : state.winner === 'serialkiller' ? 'المدينة سقطت بيد القاتل.' : 'سقطت المدينة في يد المافيا.'; $('game-description').textContent = 'انتهى التحقيق. راجعوا سجل السكان وهويات اللاعبين.'; $('chat-title').textContent = 'رسائل ما بعد النهاية'; $('chat-subtitle').textContent = 'الجميع مدعو للنقاش'; $('bulletin-title').textContent = 'كُشفت هويات المدينة'; }
    else {
      badge.textContent = night ? 'ليل · خيارات سرّية' : 'نهار · تحقيق عام'; $('round-label').textContent = `${night ? 'الطبعة الليلية' : 'الطبعة الصباحية'} · الجولة ${state.round.toLocaleString('ar')}`;
      $('bulletin-title').textContent = night ? (meRole.team === 'mafia' ? 'اجتماع المافيا · قرار في الظلام.' : `${meRole.name} · مهمتك السرّية.`) : 'خبر عاجل · شمس على وجوه المدينة.';
      $('game-title').textContent = dead ? 'أصبحتَ من الظلال.' : night ? meRole.action ? `المهمة السرّية · ${meRole.name}` : 'شوارع خالية... ننتظر الفجر.' : 'خبر عاجل · وجوه تحت التحقيق.';
      $('game-description').textContent = dead ? 'تتابع مجريات الجولة بصفتك قارئًا للأحداث.' : night ? meRole.description : 'اقرأ سجل السكان. ناقش الأدلة وصوّت لاختيار المشتبه به.';
      $('chat-title').textContent = night && meRole.team !== 'mafia' ? 'المدينة نائمة' : night ? 'حديث المافيا السري' : 'أحاديث المدينة'; $('chat-subtitle').textContent = night && meRole.team !== 'mafia' ? 'لا رسائل عامة أثناء الليل' : 'ناقشوا واكتشفوا المشتبه به';
      const canVote = !dead && (night ? meRole.action === 'vote' : true), canAct = !dead && night && meRole.action && meRole.action !== 'vote';
      if (canVote || canAct) {
        area.hidden = false; const eligible = state.players.filter(p => p.alive && (canAct ? (['inspect', 'seance', 'kill'].includes(meRole.action) ? p.id !== me.id : true) : p.id !== me.id && (!night || !['mafia', 'godfather'].includes(p.role)) && !(night && p.id === me.id)));
        const actionType = canAct ? 'nightAction' : 'vote', abstain = canAct && meRole.action === 'shoot' && !me.shotUsed;
        area.innerHTML = eligible.map(p => { const count = canVote ? state.votes.filter(v => v.to === p.id).length : 0; const chosen = canAct ? state.me.actionTarget === p.id : state.votes.some(v => v.from === me.id && v.to === p.id); return `<button class="vote-button${chosen ? ' selected' : ''}" data-target="${escapeHtml(p.id)}" data-action="${actionType}">${canAct ? `${meRole.symbol} ${actionVerb[meRole.action] || 'اختر'} · ` : ''}${escapeHtml(p.name)}${count ? ` · ${count.toLocaleString('ar')} صوت` : ''}${chosen ? ' ✓' : ''}</button>`; }).join('');
        if (abstain) area.insertAdjacentHTML('beforeend', '<button class="vote-button abstain-button" data-target="" data-action="nightAction">احتفظ بطلقتك هذه الليلة</button>');
        area.querySelectorAll('.vote-button').forEach(button => button.addEventListener('click', () => { if (button.dataset.target) confirmAction(button.dataset.target, button.dataset.action); else { socket?.send(JSON.stringify({ type: 'nightAction' })); toast('احتفظت بطلقتك.'); } }));
      }
      if (night && !dead) { hint.hidden = false; hint.textContent = canAct ? `${meRole.symbol} ${meRole.description}` : meRole.team === 'mafia' ? 'صوّت سرًا مع فريقك. أهل المدينة لا يرون أصواتكم.' : 'حلّ الليل؛ ستعرف المدينة ما حدث عندما تشرق الشمس.'; }
    }
    $('chat-input').disabled = !(state.phase === 'ended' || !dead && (!night || meRole.team === 'mafia')); $('chat-form').querySelector('button').disabled = $('chat-input').disabled; $('chat-input').placeholder = dead ? 'أنت متفرج في هذه الجولة' : $('chat-input').disabled ? 'المدينة نائمة...' : 'اكتب رسالة...';
    startRain(); renderChat(); renderChronicle();
    $('end-review').hidden = state.phase !== 'ended';
    if (state.phase !== 'ended') endShown = false;
  }
  function renderChat() { const messages = state?.messages || []; const node = $('chat-messages'); node.innerHTML = messages.map(m => `<div class="chat-message ${m.system ? 'system' : ''}">${m.system ? escapeHtml(m.text) : `<b>${escapeHtml(m.name)}</b>${escapeHtml(m.text)}`}</div>`).join(''); node.scrollTop = node.scrollHeight; }
})();