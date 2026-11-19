(() => {
  const $ = id => document.getElementById(id);
  const sections = { home: $('home'), setup: $('setup'), room: $('room') };
  let socket = null, state = null, setupMode = 'create', toastTimer = null;
  const roleDetails = {
    mafia: { name: 'المافيا', label: 'أنت من المافيا', symbol: '♠', color: '#d28978', description: 'صوّت ليلًا سرًا مع فريقك، وأخفِ هويتك في النهار.' },
    doctor: { name: 'الطبيب', label: 'أنت الطبيب', symbol: '✚', color: '#8dc6a1', description: 'اختر لاعبًا لتحميه كل ليلة. يمكنك حماية نفسك.' },
    detective: { name: 'المحقق', label: 'أنت المحقق', symbol: '⌕', color: '#9fb4df', description: 'افحص لاعبًا كل ليلة؛ نتيجة التحقيق تظهر لك وحدك.' },
    town: { name: 'أهل المدينة', label: 'أنت من أهل المدينة', symbol: '♢', color: '#d0ae72', description: 'راقبوا الأحاديث وصوّتوا نهارًا لكشف المافيا.' }
  };
  function toast(text) { const node = $('toast'); node.textContent = text; node.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('visible'), 3200); }
  function show(name) { Object.entries(sections).forEach(([key, node]) => { node.hidden = key !== name; }); if (name !== 'room') window.scrollTo({ top: name === 'setup' ? 70 : 0, behavior: 'smooth' }); else setTimeout(() => $('room').scrollIntoView({ behavior: 'smooth', block: 'start' }), 30); }
  function connect() {
    return new Promise((resolve, reject) => {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${scheme}//${location.host}`); socket = ws;
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('تعذر الاتصال بالخادم. تأكد أن اللعبة تعمل ثم حاول مجدداً.')), { once: true });
      ws.addEventListener('close', () => { if (state) { state = null; show('home'); toast('انقطع الاتصال بالغرفة. تقدر تبدأ غرفة جديدة.'); } });
      ws.addEventListener('message', event => {
        let msg; try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'state') { state = msg.state; show('room'); render(); }
        else if (msg.type === 'chat') { if (state) { state.messages.push(msg.message); renderChat(); } }
        else if (msg.type === 'notice' || msg.type === 'error') toast(msg.message);
      });
    });
  }
  async function submitSetup() {
    const name = $('player-name').value.trim();
    if (!name) { $('player-name').focus(); return toast('اكتب اسمك أولاً عشان أصحابك يعرفونك.'); }
    if (socket?.readyState === WebSocket.OPEN) socket.close();
    $('submit-label').textContent = 'لحظة واحدة...'; $('setup-submit').disabled = true;
    try {
      await connect();
      if (setupMode === 'create') socket.send(JSON.stringify({ type: 'create', name, maxPlayers: Number($('player-limit').value) }));
      else { const code = $('room-code').value.trim().toUpperCase(); if (code.length !== 5) { socket.close(); return toast('رمز الغرفة يتكوّن من ٥ أحرف.'); } socket.send(JSON.stringify({ type: 'join', name, code })); }
    } catch (error) { toast(error.message); }
    finally { $('submit-label').textContent = setupMode === 'join' ? 'انضم إلى الغرفة' : 'أنشئ الغرفة'; $('setup-submit').disabled = false; }
  }
  function openSetup(mode) { setupMode = mode; $('setup-title').innerHTML = mode === 'join' ? 'عد للمدينة <em>مجدداً.</em>' : 'جهّز <em>غرفتك.</em>'; $('create-options').hidden = mode !== 'create'; $('join-options').hidden = mode !== 'join'; $('submit-label').textContent = mode === 'join' ? 'انضم إلى الغرفة' : 'أنشئ الغرفة'; $('player-name').placeholder = 'كيف يناديك أصدقاؤك؟'; show('setup'); setTimeout(() => $('player-name').focus(), 200); }
  $('hero-create').addEventListener('click', () => openSetup('create'));
  $('hero-join').addEventListener('click', () => openSetup('join'));
  $('hero-ai').addEventListener('click', () => openSetup('create'));
  $('setup-close').addEventListener('click', () => show('home'));
  $('setup-submit').addEventListener('click', submitSetup);
  $('room-code').addEventListener('input', e => { e.target.value = e.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 5); });
  $('start-game').addEventListener('click', () => socket?.send(JSON.stringify({ type: 'start' })));
  $('add-ai').addEventListener('click', () => socket?.send(JSON.stringify({ type: 'addAI' })));
  $('share-room').addEventListener('click', async () => {
    if (!state) return;
    const invite = new URL(location.href); invite.searchParams.set('room', state.code);
    try { await navigator.clipboard.writeText(invite.toString()); toast('تم نسخ رابط الدعوة ورمز الغرفة.'); }
    catch { toast(`رمز الدعوة: ${state.code} — انسخه وأرسله لأصدقائك.`); }
  });
  const inviteCode = new URLSearchParams(location.search).get('room');
  if (inviteCode && $('room-code')) {
    $('room-code').value = inviteCode.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 5);
    openSetup('join');
  }
  $('leave-room').addEventListener('click', () => { state = null; if (socket?.readyState === WebSocket.OPEN) socket.close(); show('home'); });
  $('chat-form').addEventListener('submit', e => { e.preventDefault(); const input = $('chat-input'), text = input.value.trim(); if (!text) return; socket?.send(JSON.stringify({ type: 'chat', text })); input.value = ''; });
  function render() {
    if (!state) return;
    const me = state.me, isHost = me.id === state.hostId, isNight = state.phase === 'night', dead = !me.alive;
    $('room-code-display').textContent = state.code;
    $('max-count').textContent = state.settings.maxPlayers.toLocaleString('ar');
    $('player-count').textContent = state.players.length.toLocaleString('ar');
    $('room-status-label').textContent = state.phase === 'lobby' ? 'الطبعة الحيّة · ردهة المدينة' : state.phase === 'ended' ? 'الطبعة الأخيرة · كُشفت الأسرار' : isNight ? 'الطبعة الحيّة · بعد منتصف الليل' : 'الطبعة الحيّة · شمس جديدة على المدينة';
    $('players-list').innerHTML = state.players.map(p => {
      const secret = state.phase === 'ended' || p.id === me.id || (p.role === 'mafia' && me.role === 'mafia');
      const details = roleDetails[secret ? p.role : null];
      const subtitle = !p.alive ? 'أُقصي من الجولة' : details ? `${details.symbol} ${details.name}` : state.phase === 'lobby' ? 'بيننا' : 'لا يزال بيننا';
      return `<div class="player-row"><div class="player-avatar">${escapeHtml(p.name.slice(0, 1))}</div><div class="player-info"><div class="player-name">${escapeHtml(p.name)}${p.id === me.id ? ' <span style="color:#988b76">(أنت)</span>' : ''}${p.isAI ? ' <span style="color:#988b76">✦ ذكي</span>' : ''}</div><div class="player-sub">${escapeHtml(subtitle)}</div></div>${p.host && state.phase === 'lobby' ? '<span class="player-tag">المضيف</span>' : ''}${!p.alive ? '<span class="player-tag dead">خارج اللعبة</span>' : ''}</div>`;
    }).join('');
    const roleCard = $('role-card');
    if (state.phase !== 'lobby') {
      const role = roleDetails[me.role] || roleDetails.town;
      roleCard.hidden = false; roleCard.className = `role-card role-${me.role || 'town'}`;
      roleCard.innerHTML = `<div class="identity-ticket"><div class="ticket-top"><span>بطاقة العضوية · رقم ${String(state.round).padStart(2, '0')}</span><span>✦ <span class="ticket-private">لك وحدك</span></span></div><div class="ticket-seal">${role.symbol}</div><div class="ticket-dossier"><span class="ticket-kicker">هويتك السرّية</span><h4>${role.label}</h4><span class="ticket-role-name">${role.name}</span></div><div class="ticket-ornament" aria-hidden="true">${role.symbol}</div><div class="ticket-description">${escapeHtml(role.description)}</div><div class="ticket-bottom"><span>مدينة الغياب · ليلة المافيا</span><span>••••</span></div></div>`;
    } else roleCard.hidden = true;
    $('add-ai').hidden = !(state.phase === 'lobby' && isHost && state.players.length < state.settings.maxPlayers);
    $('add-ai').disabled = state.players.length >= state.settings.maxPlayers;
    $('start-game').hidden = !(state.phase === 'lobby' && isHost);
    $('start-game').disabled = state.phase === 'lobby' && state.players.length < 4;
    $('lobby-hint').hidden = state.phase !== 'lobby' || !isHost;
    if (state.phase === 'lobby') $('lobby-hint').textContent = state.players.length < 4 ? `ينقص الجلسة ${(4 - state.players.length).toLocaleString('ar')} لاعبين. أضف أصدقاءك أو خصمًا ذكيًا واحدًا في كل مرة.` : 'اكتمل الحد الأدنى. أضف المزيد من الخصوم أو افتح ملف القضية.';
    const badge = $('phase-badge'); badge.className = `phase-badge ${state.phase}`;
    const voteArea = $('vote-area'), hint = $('action-hint'), scene = $('phase-scene'); voteArea.hidden = true; hint.hidden = true;
    scene.className = `phase-scene ${state.phase === 'ended' ? state.winner === 'town' ? 'victory-town' : 'victory-mafia' : state.phase === 'lobby' ? 'night' : state.phase}`;
    $('paper-edition').textContent = String(Math.max(1,state.round)).padStart(2, '0').replace(/[0-9]/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
    $('scene-eyebrow').textContent = state.phase === 'lobby' ? 'الطبعة الأولى · قبل منتصف الليل' : state.phase === 'ended' ? 'الطبعة الأخيرة · الحقيقة ظهرت' : isNight ? `الجولة ${state.round.toLocaleString('ar')} · المدينة بعد منتصف الليل` : `الجولة ${state.round.toLocaleString('ar')} · شمس جديدة فوق المدينة`;
    const latestHeadline = [...state.messages].reverse().find(message => message.system);
    $('bulletin-time').textContent = `الطبعة ${state.round.toLocaleString('ar')}`;
    $('bulletin-title').textContent = state.phase === 'ended' ? state.winner === 'town' ? 'أهل المدينة كشفوا المؤامرة!' : 'المافيا تسيطر على المدينة!' : isNight ? 'ليلٌ طويل... والمدينة تحبس أنفاسها' : 'خبر عاجل · سكان المدينة يناقشون القضية';
    $('bulletin-text').textContent = latestHeadline?.text || 'شارك رمز الدعوة. أضف أصدقاءك أو خصمًا ذكيًا إلى جلستك.';
    if (state.phase === 'lobby') {
      badge.textContent = 'الردهة · مباشر'; $('round-label').textContent = 'طبعة ما قبل الليل'; $('game-title').textContent = 'المدينة تنتظر حكايتها.'; $('game-description').textContent = 'شارك رمز الدعوة. أضف أصدقاءك أو خصمًا ذكيًا إلى الغرفة نفسها.'; $('chat-title').textContent = 'رسائل المدينة'; $('chat-subtitle').textContent = 'رسائل الغرفة';
      $('bulletin-title').textContent = `${state.players.filter(player => !player.isAI).length.toLocaleString('ar')} من السكان · ${state.players.filter(player => player.isAI).length.toLocaleString('ar')} من الذكاء الاصطناعي`;
    } else if (state.phase === 'ended') {
      badge.textContent = 'كُشفت الأسرار · نهاية الجولة'; $('round-label').textContent = `ملف القضية · الجولة ${state.round.toLocaleString('ar')}`; $('game-title').textContent = state.winner === 'town' ? 'العدالة عادت إلى المدينة.' : 'سقطت المدينة في يد المافيا.'; $('game-description').textContent = 'انتهى التحقيق. افتحوا سجل السكان لمعرفة هوية الجميع، وشاركوا قصتكم.'; $('chat-title').textContent = 'رسائل ما بعد النهاية'; $('chat-subtitle').textContent = 'الجميع مدعو للنقاش';
    } else {
      badge.textContent = isNight ? 'ليل · خيارات سرّية' : 'نهار · تحقيق عام'; $('round-label').textContent = `ملف القضية · الجولة ${state.round.toLocaleString('ar')}`;
      if (me.role === 'doctor' && isNight) $('bulletin-title').textContent = 'مناوبة الطبيب · المدينة تحتاج حمايتك.';
      else if (me.role === 'detective' && isNight) $('bulletin-title').textContent = 'المحقق · قضية جديدة بين يديك.';
      else if (me.role === 'mafia' && isNight) $('bulletin-title').textContent = 'نبأ عاجل · المافيا تتحرك في الخفاء.';
      else if (dead) $('bulletin-title').textContent = 'من أرشيف المدينة · تتابع الوقائع بصمت.';
      else $('bulletin-title').textContent = isNight ? 'المدينة نائمة... قبل ساعاتٍ حاسمة.' : 'خبر عاجل · سكان المدينة يناقشون القضية.';
      const role = roleDetails[me.role] || roleDetails.town;
      $('game-title').textContent = dead ? 'أصبحتَ من الظلال.' : isNight && ['doctor', 'detective'].includes(me.role) ? `المهمة السرية · ${role.name}` : isNight ? (me.role === 'mafia' ? 'جريمة جديدة تهزّ المدينة.' : 'شوارع خالية... ننتظر الفجر.') : 'خبر عاجل · وجوه تحت التحقيق.';
      $('game-description').textContent = dead ? 'تتابع مجريات الجولة بصفتك قارئًا للأحداث. لا تصوّت ولا ترسل رسائل للأحياء.' : isNight ? role.description : 'اقرأ سجل السكان. ناقش الأدلة وصوّت لاختيار المشتبه به.';
      $('chat-title').textContent = isNight && me.role !== 'mafia' ? (me.role === 'detective' ? 'حديثك وتحقيقك السري' : 'المدينة نائمة') : isNight ? 'حديث المافيا السري' : 'أحاديث المدينة'; $('chat-subtitle').textContent = isNight && me.role !== 'mafia' ? 'التقرير السري لا يظهر إلا لك' : 'تحدثوا واكتشفوا المشتبه به';
      const canVote = !dead && (isNight ? me.role === 'mafia' : true);
      const canAct = !dead && isNight && ['doctor', 'detective'].includes(me.role);
      if (canVote || canAct) {
        voteArea.hidden = false;
        const eligible = state.players.filter(p => p.alive && (canAct ? (me.role !== 'detective' || p.id !== me.id) : p.id !== me.id && (!isNight || p.role !== 'mafia')));
        const actionType = canAct ? 'nightAction' : 'vote';
        voteArea.innerHTML = eligible.map(p => {
          const vote = canVote ? state.votes.filter(v => v.to === p.id).length : 0;
          const chosen = canAct ? state.me.actionTarget === p.id : state.votes.some(v => v.from === me.id && v.to === p.id);
          return `<button class="vote-button${chosen ? ' selected' : ''}" data-target="${escapeHtml(p.id)}" data-action="${actionType}">${canAct ? (me.role === 'doctor' ? 'احمِ ' : 'افحص ') : ''}${escapeHtml(p.name)}${vote ? ` · ${vote.toLocaleString('ar')} صوت` : ''}${chosen && !canAct ? ' ✓' : ''}</button>`;
        }).join('');
        voteArea.querySelectorAll('.vote-button').forEach(button => button.addEventListener('click', () => socket?.send(JSON.stringify({ type: button.dataset.action, target: button.dataset.target }))));
      }
      if (isNight && !dead) {
        hint.hidden = false;
        hint.textContent = canAct ? (me.role === 'doctor' ? 'اختر لاعبًا لحمايته حتى الصباح.' : 'اختر لاعبًا للتحقيق في هويته؛ النتيجة سرية.') : me.role === 'mafia' ? 'صوّت سرًا لهدف المافيا. يمكن لفريقك رؤية الأصوات.' : 'حلّ الليل؛ ستعرف المدينة ما حدث عندما تشرق الشمس.';
      }
    }
    const chatAllowed = state.phase === 'ended' || (!dead && (state.phase !== 'night' || me.role === 'mafia')); $('chat-input').disabled = !chatAllowed; $('chat-form').querySelector('button').disabled = !chatAllowed; $('chat-input').placeholder = dead ? 'أنت متفرج في هذه الجولة' : chatAllowed ? 'اكتب رسالة...' : 'المدينة نائمة...';
    renderChat();
  }
  function renderChat() { const messages = state?.messages || []; const node = $('chat-messages'); node.innerHTML = messages.map(m => `<div class="chat-message ${m.system ? 'system' : ''}">${m.system ? escapeHtml(m.text) : `<b>${escapeHtml(m.name)}</b>${escapeHtml(m.text)}`}</div>`).join(''); node.scrollTop = node.scrollHeight; }
  function escapeHtml(value) { const div = document.createElement('div'); div.textContent = String(value); return div.innerHTML; }
})();
