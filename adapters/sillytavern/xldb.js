/* XLDB Tavern Helper MVP. Load this file as a JavaScript script in Tavern Helper. */
(() => {
  'use strict';

  let CORE_ORIGIN = 'http://127.0.0.1:4318';
  const CONFIG_STAGES = ['memory', 'emotion', 'preference', 'rewrite', 'calculation', 'front', 'embedding', 'reranker', 'inputPerspective', 'perspective', 'identity', 'outward', 'world', 'director', 'commitment', 'initialization', 'profile', 'strategy', 'proactiveDecision', 'proactive', 'physiology', 'geography'];
  const ACCESS_LEVELS = ['clear', 'gist', 'feeling', 'anchor', 'hidden'];
  const EMOTION_DEFAULTS = Object.freeze({
    driveBaseline: Object.freeze({ connection: 0.5, novelty: 0.5, expression: 0.5, safety: 0.5, play: 0.5 }),
    frustrationDecayPerHour: 0.08,
    connectionHungerPerHour: 0.15,
    noveltyHungerPerHour: 0.05,
    eventRetainedFraction: 0.9,
    stableRelationRate: 0.05,
    hebbianLearningRate: 0.02,
    phaseThreshold: 2,
    temperatureCoefficient: 0.12,
    temperatureFloor: 0.03,
  });
  const host = globalThis.SillyTavern || {};
  const viewDocument = (() => {
    try { return globalThis.parent && globalThis.parent.document ? globalThis.parent.document : globalThis.document; } catch { return globalThis.document; }
  })();
  const helpers = {
    fetch: globalThis.fetch?.bind(globalThis),
    createChatMessages: globalThis.createChatMessages,
    setChatMessages: globalThis.setChatMessages,
    deleteChatMessages: globalThis.deleteChatMessages,
    getCharData: globalThis.getCharData,
    getCharWorldbookNames: globalThis.getCharWorldbookNames,
    getWorldbook: globalThis.getWorldbook,
  };
  const state = {
    token: '',
    config: emptyConfig(),
    scope: null,
    interaction: null,
    clock: null,
    enabled: false,
    busy: false,
    candidate: null,
    scene: { enabled: false, roster: [], targetId: '', presentIds: [], mode: 'scene', needsReview: [], selectionVersion: 0, version: null, pendingSync: null },
    initialization: { catalog: [], selectedIds: [], preview: null, hasInitialized: false, provenance: null, refresh: null },
    resources: null,
    companion: { profile: null, status: null, timer: null, polling: false, pendingEvent: false, uncertainDeliveries: new Set() },
    epoch: 0,
    selfInserting: false,
    panel: null,
    dashboard: { data:null, loading:false, error:'', tab:'overview', compactTab:'overview', expanded:false },
    listeners: [],
    native: { enabled: false, automatic: false, materials: null, queue: Promise.resolve(), turn: null, error: '', generationType: '', active: false, stopped: false },
  };

  function emptyConfig() {
    return Object.fromEntries(CONFIG_STAGES.map(stage => [stage, { baseUrl: '', key: '', model: '' }]));
  }

  function sameScope(left, right) {
    return Boolean(left && right) && ['worldId', 'sessionId', 'branchId', 'characterId'].every(key => left[key] === right[key]);
  }

  function newId(prefix) {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return `${prefix}-${globalThis.crypto.randomUUID()}`;
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function safeStorageGet(key, fallback = '') {
    try { return globalThis.localStorage ? globalThis.localStorage.getItem(key) || fallback : fallback; } catch { return fallback; }
  }

  function safeStorageSet(key, value) {
    try { if (globalThis.localStorage) globalThis.localStorage.setItem(key, value); } catch { /* Browser storage is optional. */ }
  }

  function sceneStoragePrefix() {
    if (!state.scope) return '';
    const scope = state.scope;
    return `xldb.tavern.scene.${[scope.worldId, scope.sessionId, scope.branchId, scope.characterId].map(value => encodeURIComponent(String(value))).join('.')}`;
  }

  function readScenePreferences(roster) {
    const ids = new Set(roster.map(character => character.id));
    const prefix = sceneStoragePrefix();
    if (!prefix) return { targetId: roster[0] ? roster[0].id : '', presentIds: [], mode: 'scene' };
    const targetId = safeStorageGet(`${prefix}.target`, roster[0] ? roster[0].id : '');
    const mode = safeStorageGet(`${prefix}.mode`, 'scene') === 'direct' ? 'direct' : 'scene';
    let presentIds = [];
    try { presentIds = JSON.parse(safeStorageGet(`${prefix}.present`, '[]')); } catch { presentIds = []; }
    presentIds = Array.isArray(presentIds) ? presentIds.filter(id => typeof id === 'string' && ids.has(id)) : [];
    return { targetId: ids.has(targetId) ? targetId : (roster[0] ? roster[0].id : ''), presentIds, mode };
  }

  function persistScenePreferences() {
    const prefix = sceneStoragePrefix();
    if (!prefix) return;
    safeStorageSet(`${prefix}.target`, state.scene.targetId);
    safeStorageSet(`${prefix}.mode`, state.scene.mode);
    safeStorageSet(`${prefix}.present`, JSON.stringify(state.scene.presentIds));
  }

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizeSceneEmotion(emotion) {
    const source = emotion && typeof emotion === 'object' ? emotion : {};
    const hasBaseline = Boolean(source.driveBaseline && typeof source.driveBaseline === 'object');
    const baseline = hasBaseline ? source.driveBaseline : {};
    return {
      driveBaseline: Object.fromEntries(Object.entries(EMOTION_DEFAULTS.driveBaseline).map(([key, fallback]) => [key, finiteNumber(baseline[key], fallback)])),
      randomizedBaseline: typeof source.randomizedBaseline === 'boolean' ? source.randomizedBaseline : !hasBaseline,
      frustrationDecayPerHour: finiteNumber(source.frustrationDecayPerHour, EMOTION_DEFAULTS.frustrationDecayPerHour),
      connectionHungerPerHour: finiteNumber(source.connectionHungerPerHour, EMOTION_DEFAULTS.connectionHungerPerHour),
      noveltyHungerPerHour: finiteNumber(source.noveltyHungerPerHour, EMOTION_DEFAULTS.noveltyHungerPerHour),
      eventRetainedFraction: finiteNumber(source.eventRetainedFraction, EMOTION_DEFAULTS.eventRetainedFraction),
      stableRelationRate: finiteNumber(source.stableRelationRate, EMOTION_DEFAULTS.stableRelationRate),
      hebbianLearningRate: finiteNumber(source.hebbianLearningRate, EMOTION_DEFAULTS.hebbianLearningRate),
      phaseThreshold: finiteNumber(source.phaseThreshold, EMOTION_DEFAULTS.phaseThreshold),
      temperatureCoefficient: finiteNumber(source.temperatureCoefficient, EMOTION_DEFAULTS.temperatureCoefficient),
      temperatureFloor: finiteNumber(source.temperatureFloor, EMOTION_DEFAULTS.temperatureFloor),
    };
  }

  function setSceneRoster(roster, invalidateSelection = true) {
    const characters = Array.isArray(roster && roster.characters) ? roster.characters.map(character => ({
      id: String(character.id || ''), name: String(character.name || ''), aliases: Array.isArray(character.aliases) ? character.aliases.map(alias => String(alias)) : [], persona: String(character.persona || ''), emotion: normalizeSceneEmotion(character.emotion), ...(character.identitySource ? {identitySource:character.identitySource} : {}),
    })).filter(character => character.id && character.name) : [];
    const preferences = readScenePreferences(characters);
    const changed=invalidateSelection||JSON.stringify(state.scene.roster)!==JSON.stringify(characters);
    state.scene = { ...state.scene, enabled: characters.length >= 1, roster: characters, targetId: preferences.targetId, presentIds: preferences.presentIds, mode: preferences.mode, selectionVersion: state.scene.selectionVersion + (changed?1:0) };
    if (changed) {
      state.resources = null;
      invalidateInitializationPreview();
    }
    if (characters.length) persistScenePreferences();
  }

  function sceneEnvelope() {
    const ids = new Set(state.scene.roster.map(character => character.id));
    if (!state.scene.enabled || !ids.has(state.scene.targetId)) throw new Error('请先保存至少一名 NPC 的名单并选择目标');
    const presentIds = state.scene.presentIds.filter(id => ids.has(id));
    if (state.interaction?.mode === 'companion') return { targetId: state.scene.targetId, mode: 'direct', presentIds: [state.scene.targetId],
      ...(typeof nativeHost().name1 === 'string' && nativeHost().name1.trim() ? {playerName:nativeHost().name1.trim()} : {}) };
    if (!presentIds.includes(state.scene.targetId)) throw new Error('请勾选目标 NPC 为在场角色');
    const playerName = nativeHost().name1;
    return { targetId: state.scene.targetId, mode: state.scene.mode, presentIds: state.scene.mode === 'direct' ? [state.scene.targetId] : presentIds,
      ...(typeof playerName === 'string' && playerName.trim() ? { playerName: playerName.trim() } : {}) };
  }

  function activeNpc() {
    return state.scene.roster.find(character => character.id === state.scene.targetId) || null;
  }

  function currentScope(worldId) {
    const host = nativeHost();
    const chatId = typeof host.getCurrentChatId === 'function' ? host.getCurrentChatId() : host.chatId;
    const avatar = selectedAvatar();
    const characterId = avatar ? `avatar:${avatar}` : host.characterId ? `id:${host.characterId}` : '';
    const branchId = host.chatMetadata && host.chatMetadata.xldbBranchId ? host.chatMetadata.xldbBranchId : 'main';
    if (!chatId) throw new Error('请先打开一个单角色聊天');
    if (host.groupId) throw new Error('MVP 不支持群聊');
    if (typeof branchId !== 'string' || !branchId.trim() || branchId.length > 200) throw new Error('无效分支名称');
    if (!characterId) throw new Error('未找到当前角色身份');
    return { worldId: String(worldId || 'default'), sessionId: String(chatId), branchId, characterId: String(characterId) };
  }

  function selectedAvatar() {
    const host = nativeHost();
    const index = Number(host.characterId);
    const character = Array.isArray(host.characters) && Number.isFinite(index) ? host.characters[index] : null;
    return character && character.avatar ? character.avatar : '';
  }

  function assertBound() {
    if (!state.enabled || !state.scope) throw new Error('请先明确绑定当前聊天');
    if (!sameScope(currentScope(state.scope.worldId), state.scope)) {
      disableForChatChange();
      throw new Error('聊天已切换，已取消绑定');
    }
  }

  function assertHydrated() {
    if (!sameScope(nativeHost().chatMetadata?.xldbHydrate, state.scope)) return;
    disable('恢复结果待载入，请重新绑定当前聊天。');
    throw new Error('恢复结果待载入，请重新绑定当前聊天');
  }

  function assertHostScope(scope, epoch, message = '聊天已切换，请重新绑定') {
    let current = null;
    try { current = currentScope(scope.worldId); } catch { /* Report one stable recovery action below. */ }
    if (state.epoch !== epoch || !sameScope(state.scope, scope) || !sameScope(current, scope)) throw new Error(message);
  }

  function assertToken() {
    if (!state.token) throw new Error('请填写 XLDB 访问令牌');
  }

  function assertCandidateCurrent(candidate) {
    assertBound();
    if (!candidate || state.candidate !== candidate || !sameScope(candidate.scope, state.scope)) throw new Error('候选已失效');
    if (candidate.kind === 'scene' && candidate.selectionVersion !== state.scene.selectionVersion) throw new Error('场景范围已变更，候选已失效');
  }

  function assertSceneSelectionCurrent(selectionVersion) {
    if (!state.scene.enabled || selectionVersion !== state.scene.selectionVersion) throw new Error('场景范围已变更，候选已取消');
  }

  async function request(path, method, payload) {
    assertToken();
    if (typeof helpers.fetch !== 'function') throw new Error('浏览器不支持本地核心请求');
    const init = { method, headers: { Authorization: `Bearer ${state.token}` } };
    if (method !== 'GET') {
      init.headers['Content-Type'] = 'application/json';
      const interactionRevision = payload?.scope && sameScope(payload.scope, state.interaction?.scope) ? state.interaction.revision : undefined;
      init.body = JSON.stringify({ ...payload, ...(interactionRevision === undefined ? {} : {interactionRevision}) });
    }
    let response;
    try { response = await helpers.fetch(`${CORE_ORIGIN}${path}`, init); } catch { throw new Error('XLDB 核心不可用'); }
    if (!response || !response.ok) {
      const failure=response ? await response.json().catch(()=>({})) : {};
      throw new Error(typeof failure.error==='string' && /^[a-z_0-9]+$/.test(failure.error) ? `XLDB：${failure.error}` : 'XLDB 核心请求失败');
    }
    try { return await response.json(); } catch { throw new Error('XLDB 核心响应无效'); }
  }

  function setStatus(message) {
    if (state.panel && state.panel.status) state.panel.status.textContent = message;
  }

  async function withBusy(action) {
    if (state.busy) throw new Error('已有操作进行中');
    state.busy = true;
    refreshButtons();
    try { return await action(); } finally {
      state.busy = false; refreshButtons();
      if (state.companion.pendingEvent) { state.companion.pendingEvent = false; void pollCompanion('event').catch(error => setStatus(`主动陪伴检查失败：${error.message}`)); }
    }
  }

  function managedMessages() {
    const host = nativeHost();
    if (!state.scope || !Array.isArray(host.chat)) return [];
    return host.chat.flatMap(message => {
      const binding = message && message.extra && message.extra.xldb;
      if (!binding || !binding.id || !sameScope(binding.scope, state.scope)) return [];
      const role = message.is_system || (message.extra && message.extra.type === 'narrator') ? 'system' : message.is_user ? 'user' : 'assistant';
      if (role !== 'user' && role !== 'assistant') return [];
      return [{ id: String(binding.id), role, text: String(message.mes || ''), revision: Number(binding.revision) || 1, acceptedAtMs: Number(binding.acceptedAtMs) || Date.now() }];
    });
  }

  function sceneManagedMessages() {
    const host = nativeHost();
    if (!state.scope || !Array.isArray(host.chat)) return [];
    return host.chat.flatMap(message => {
      if (message?.is_hidden) return [];
      const binding = message && message.extra && message.extra.xldbScene;
      if (!binding || !binding.id || !sameScope(binding.scope, state.scope)) return [];
      const role = message.is_system || (message.extra && message.extra.type === 'narrator') ? 'system' : message.is_user ? 'user' : 'assistant';
      if (role !== 'user' && role !== 'assistant') return [];
      const envelope = binding.envelope;
      if (!envelope || !envelope.targetId || !['direct', 'scene'].includes(envelope.mode) || !Array.isArray(envelope.presentIds)) return [];
      return [{ id: String(binding.id), revision: Number(binding.revision) || 1, role, text: String(message.mes || ''), acceptedAtMs: Number(binding.acceptedAtMs) || Date.now(),
        envelope: { targetId: String(envelope.targetId), mode: envelope.mode, presentIds: envelope.presentIds.map(id => String(id)),
          ...(envelope.playerName ? { playerName: String(envelope.playerName) } : binding.automatic && host.name1 ? { playerName: String(host.name1) } : {}) },
        ...(binding.speakerId ? { speakerId: String(binding.speakerId) } : {}),
        ...(binding.automatic ? { automatic: true } : {}),
        ...(Array.isArray(binding.dependencies) ? { dependencies: binding.dependencies.map(item => ({ id: String(item.id), revision: Number(item.revision) || 1 })) } : {}),
      }];
    });
  }

  async function discoverScene() {
    const scope = { ...state.scope }; const epoch = state.epoch;
    const scene = await request('/v1/scene/inspect', 'POST', { scope });
    assertHostScope(scope, epoch, '读取场景期间聊天已切换，请重新绑定');
    if (!scene || !scene.roster) throw new Error('scene response unavailable');
    setSceneRoster(scene.roster);
    const saved=nativeHost().chatMetadata?.xldbSync;
    state.scene.version=sameScope(saved?.scope,scope)?saved.version:null;
    state.scene.pendingSync=null;
    const sources=(scene.sources||[]).filter(source=>source.status!=='deleted');
    const local=sceneManagedMessages();
    // Bootstrap only an identical snapshot. Never fetch a fresh version to bless stale local text.
    if(sources.length===local.length&&sources.every(source=>local.some(message=>message.id===source.id&&message.text===source.text&&message.role===source.role&&JSON.stringify(message.envelope)===JSON.stringify(source.envelope)))) {
      await recordSceneReceipt({...scene,bindings:sources},scope,epoch);
    }
    state.scene.needsReview = Array.isArray(scene.needsReview) ? scene.needsReview.map(id => String(id)) : [];
    state.initialization.hasInitialized = Boolean(scene.hasInitialization);
    state.initialization.provenance = null;
    state.initialization.refresh = null;
    renderInitializationMaintenance();
    renderSceneControls();
    return scene;
  }

  async function bind(worldId) {
    return withBusy(async () => {
      assertToken();
      const previous = { scope: state.scope, enabled: state.enabled, candidate: state.candidate, scene: state.scene, initialization: state.initialization, resources: state.resources, companion: state.companion };
      const epoch = state.epoch;
      let scope = currentScope(worldId);
      state.panel?.resetWorldForm?.();
      state.panel?.resetWorkbench?.();
      state.scope = scope;
      state.enabled = true;
      state.candidate = null;
      state.initialization = { catalog: [], selectedIds: [], preview: null, hasInitialized: false, provenance: null, refresh: null };
      state.resources = null;
      resetCompanionState();
      try {
        const interaction=await request('/v1/scene/interaction','POST',{scope});
        assertHostScope(scope,epoch);
        await selectInteraction(interaction,scope,epoch);
        scope={...state.scope};
        if (sameScope(nativeHost().chatMetadata?.xldbHydrate, scope)) {
          const scene=await request('/v1/scene/inspect','POST',{scope});
          if(scene.roster?.characters?.length)await materializeScene(scope,scene);
          else {delete nativeHost().chatMetadata.xldbHydrate;await saveNativeMetadata();}
        }
        await discoverScene();
        await syncInternal();
        await refreshClock();
        await restoreCompanionState();
      } catch (error) {
        if (state.epoch === epoch) {
          state.scope = null;
          state.enabled = false;
          state.candidate = null;
          state.native.enabled = false;
          state.scene = { ...previous.scene, enabled: false };
          state.initialization = previous.initialization;
          state.resources = previous.resources;
          state.companion = previous.companion;
          refreshCompanionTimer();
          renderSceneControls();
        }
        throw error;
      }
      setStatus(state.scene.enabled ? '已绑定当前聊天与 NPC 名单；仅 scene 受管消息会同步。' : '已绑定当前聊天；启用原生聊天后自动读取身份资料。');
      refreshButtons();
      if (state.panel?.branchInput) state.panel.branchInput.value = scope.branchId;
      return scope;
    });
  }

  async function selectInteraction(interaction,previousScope,epoch) {
    if(!interaction || !['roleplay','companion'].includes(interaction.mode) || !Number.isSafeInteger(interaction.revision) ||
      !interaction.scope || !sameScope({...interaction.scope,branchId:previousScope.branchId},previousScope))throw new Error('核心未返回有效模式，请升级匹配的核心与JS');
    assertHostScope(previousScope,epoch);
    const metadata=nativeHost().chatMetadata ||= {};
    metadata.xldbBranchId=interaction.scope.branchId;
    await saveNativeMetadata();
    if(state.epoch!==epoch || !sameScope(currentScope(previousScope.worldId),interaction.scope))throw new Error('保存模式期间聊天已切换，请重新绑定');
    state.scope={...interaction.scope};state.interaction=interaction;state.clock=null;
    if(!sameScope(previousScope,state.scope))state.panel?.resetWorkbench?.();
    if(!sameScope(previousScope,state.scope))metadata.xldbHydrate={...state.scope};
    const visibility=[];
    for(const [index,message] of (nativeHost().chat||[]).entries()) {
      const binding=message.extra?.xldb;
      if(binding?.scope?.worldId!==state.scope.worldId||binding.scope.sessionId!==state.scope.sessionId||binding.scope.characterId!==state.scope.characterId)continue;
      const hidden=!sameScope(binding.scope,state.scope);
      if(Boolean(message.is_hidden)!==hidden)visibility.push({message_id:index,is_hidden:hidden});
    }
    if(visibility.length) {requireSceneRestoreHost();await helpers.setChatMessages(visibility,{refresh:'affected'});assertHostScope(state.scope,epoch);await saveNativeMetadata();}
    renderInteraction();
  }

  async function changeInteraction(mode,settings) {
    assertBound();
    if(state.modeChanging)throw new Error('模式设置正在保存');
    if(!state.interaction)throw new Error('请重新绑定以读取模式');
    state.modeChanging=true;
    const previousScope={...state.scope};
    const previousRevision=state.interaction.revision,previousVersion=state.scene.version;
    state.epoch+=1;const epoch=state.epoch;
    state.candidate=null;state.native.turn=null;state.native.stopped=true;state.native.enabled=false;
    resetCompanionState();
    nativeHost().stopGeneration?.();setPreview('');refreshButtons();
    try{
      if(!settings)await syncInternal();
      const result=await request(settings?'/v1/scene/interaction-settings':'/v1/scene/interaction-switch','POST',{
        scope:previousScope,expectedRevision:state.interaction.revision,...(settings?{settings}:{mode})});
      await selectInteraction(result,previousScope,epoch);
      if(settings){
        state.scene.pendingSync=null;
        if(state.scene.enabled)await recordSceneReceipt({version:previousVersion+(result.revision===previousRevision?0:1)},state.scope,epoch);
      }else{
        const data=await request('/v1/scene/inspect','POST',{scope:state.scope});
        assertHostScope(state.scope,epoch);
        if(data.roster?.characters?.length)await materializeScene(state.scope,data);
        else {delete nativeHost().chatMetadata.xldbHydrate;await discoverScene();}
      }
      await refreshClock();
      if(state.scene.enabled)await refreshDashboard();
      await restoreCompanionState();
      state.panel?.resetWorldForm?.();
      setStatus(settings?'设置已保存，旧候选已取消；请重新启用原生聊天。':`已切换为${result.mode==='roleplay'?'跑团／角色扮演':'伴侣'}；请重新启用原生聊天。`);
      return result;
    }catch(error){disable('模式状态待核对，请重新绑定当前聊天。');throw error;}
    finally{state.modeChanging=false;refreshButtons();}
  }

  const switchMode=mode=>changeInteraction(mode);
  const setTimeZone=timeZone=>changeInteraction(undefined,{timeZone:typeof timeZone==='string'&&timeZone.trim()?timeZone.trim():null});
  const setDirectorEnabled=enabled=>changeInteraction(undefined,{directorEnabled:Boolean(enabled)});

  async function refreshClock() {
    if(!state.enabled||!state.interaction)return;
    const scope={...state.scope},epoch=state.epoch;
    const clock=await request('/v1/scene/interaction-clock','POST',{scope});
    assertHostScope(scope,epoch);state.clock={...clock,sampledAt:Date.now()};renderClock();return clock;
  }

  function renderClock() {
    if(state.panel?.variableToggle&&state.dashboard.data)state.panel.variableToggle.textContent=`${dashboardClock()} · ${state.dashboard.data.playerName}`;
    for(const area of [state.panel?.dashboardArea,state.panel?.variableArea])for(const node of area?.querySelectorAll?.('[data-xldb-clock]')||[])node.textContent=dashboardClock();
    if(!state.panel?.clockText)return;
    const clock=state.clock;
    if(!clock){state.panel.clockText.textContent='尚未同步时钟';return;}
    if(!clock.known||clock.timeMs===null){state.panel.clockText.textContent='剧情时间：日期未设置；现实等待不推进剧情。';return;}
    const now=clock.timeMs+(clock.kind==='realtime'?Date.now()-clock.sampledAt:0);
    state.panel.clockText.textContent=`${clock.kind==='realtime'?'系统时间':'剧情时间'}：${new Intl.DateTimeFormat('zh-CN',{timeZone:clock.timeZone,dateStyle:'medium',timeStyle:'medium'}).format(now)}（${clock.timeZone}）`;
  }

  function renderInteraction() {
    if(!state.panel?.interactionMode)return;
    const current=state.interaction;
    state.panel.interactionMode.value=current?.mode||'roleplay';
    state.panel.timeZoneInput.value=current?.configuredTimeZone??'';
    state.panel.directorInput.checked=Boolean(current?.directorEnabled);
    state.panel.directorInput.disabled=!current||current.mode!=='roleplay'||state.modeChanging;
    state.panel.directorStatus.textContent=current?.mode==='companion'?'伴侣模式不运行导演。':'导演启用时，在本轮状态同步后规划；请配置独立 director API。关闭后继续角色回复。';
    if(state.panel.worldMode){state.panel.worldMode.value=current?.mode==='companion'?'companion':'story';state.panel.worldMode.disabled=true;}
    renderClock();
  }

  async function syncInternal() {
    assertBound();
    assertHydrated();
    if (state.scene.enabled) {
      const scope={...state.scope},epoch=state.epoch,messages=sceneManagedMessages();
      if(!Number.isSafeInteger(state.scene.version))throw new Error('缺少同步基准，请核对当前分支并恢复权威正文后重试');
      const signature=JSON.stringify([scope,messages]);
      if(state.scene.pendingSync?.signature!==signature)state.scene.pendingSync={signature,operationId:newId('sync'),expectedVersion:state.scene.version};
      const pending=state.scene.pendingSync;
      const result = await request('/v1/scene/reconcile', 'POST', { scope, messages, expectedVersion:pending.expectedVersion,operationId:pending.operationId });
      await recordSceneReceipt(result,scope,epoch);
      state.scene.pendingSync=null;
      if (result.status === 'failed') throw new Error(`场景同步未完成：${result.error || '未知错误'}。请检查配置或正文视角后重试。`);
      state.scene.needsReview = Array.isArray(result.needsReview) ? result.needsReview.map(id => String(id)) : [];
      return result;
    }
    const result = await request('/v1/reconcile', 'POST', { scope: state.scope, messages: managedMessages().map(({ id, role, text }) => ({ id, role, text })) });
    for (const message of Array.isArray(result.reprocess) ? result.reprocess : []) {
      assertBound();
      const receipt = await request('/v1/process', 'POST', { scope: state.scope, message });
      assertBound();
      if (receipt.status === 'failed' || receipt.status === 'conflict') throw new Error('同步未完成，请稍后重试');
    }
    return result;
  }

  async function recordSceneReceipt(receipt,scope=state.scope,epoch=state.epoch) {
    assertHostScope(scope,epoch,'同步期间聊天已切换，未更新当前聊天绑定');
    if(!Number.isSafeInteger(receipt?.version))throw new Error('核心未返回权威版本，请更新核心后重试');
    const bindings=new Map((receipt.bindings||[]).map(binding=>[binding.id,binding]));
    for(const message of nativeHost().chat||[]) {
      const binding=message.extra?.xldbScene;
      if(!sameScope(binding?.scope,scope))continue;
      const current=bindings.get(binding.id);
      if(current&&current.status!=='deleted') {
        binding.revision=current.revision;binding.dependencies=current.dependencies||[];
        const swipe=message.swipe_info?.[message.swipe_id];if(swipe)swipe.extra={...message.extra};
      }
    }
    if (state.scene.version !== receipt.version) invalidateInitializationPreview();
    state.scene.version=receipt.version;
    state.scene.needsReview=receipt.needsReview||state.scene.needsReview;
    const metadata=nativeHost().chatMetadata||=( {} );
    metadata.xldbSync={scope:{...scope},version:receipt.version};
    await saveNativeMetadata();
    assertHostScope(scope,epoch,'保存绑定期间聊天已切换');
    await refreshClock();
    if(state.scene.enabled&&state.panel?.dashboardArea)await refreshDashboard();
  }

  async function reconfirmSceneSource(sourceId) {
    return withBusy(async()=>{
      assertBound();await state.native.queue.catch(()=>{});
      const scope={...state.scope},epoch=state.epoch;
      const result=await request('/v1/scene/reconfirm','POST',{scope,sourceId,expectedVersion:state.scene.version,operationId:newId('review')});
      await recordSceneReceipt(result,scope,epoch);
      renderSceneMaterials(await inspectInternal());
      if(result.status==='failed')throw new Error(`来源已确认，整理仍失败：${result.error}`);
      setStatus('已按当前有效来源重新确认并整理。');return result;
    });
  }

  async function sync() {
    return withBusy(async () => {
      setStatus('正在同步当前正文与未完成阶段……');
      if (state.native.enabled) await state.native.queue.catch(() => {});
      const result = await syncInternal();
      await refreshClock();
      if (state.native.enabled) { state.native.error = ''; state.native.queue = Promise.resolve(); }
      setStatus(result.removed ? `同步完成，已失效 ${result.removed} 条受管记录。` : '同步完成。');
      return result;
    });
  }

  async function generate(input, persona) {
    return withBusy(async () => {
      assertBound();
      if (!String(input || '').trim()) throw new Error('请输入本轮内容');
      state.candidate = null;
      setPreview('');
      await ensureInitializationFreshForGeneration();
      await syncInternal();
      assertBound();
      if (state.scene.enabled) return generateScene(String(input));
      if (state.interaction?.mode === 'roleplay') throw new Error('跑团需要至少一名 NPC，请先保存名单或启用原生聊天读取角色卡');
      const submitted = await submitUser(String(input));
      const candidate = { id: newId('candidate'), scope: { ...state.scope }, input: String(input), answer: '', inserted: false, messages: null, submitted, epoch:state.epoch };
      state.candidate = candidate;
      // Host generation hooks can append unrelated state after generateRaw assembles prompts.
      const {answer} = await request('/v1/generate', 'POST', {scope:candidate.scope, input:candidate.input, persona:String(persona || '')});
      assertCandidateCurrent(candidate);
      if (typeof answer !== 'string') throw new Error('前台模型未返回文本');
      candidate.answer = answer;
      candidate.messages = [submitted, {id:newId('message'),revision:1,role:'assistant',text:answer,acceptedAtMs:Date.now()}];
      setPreview(answer);
      setStatus('候选已生成；请预览后明确接受或拒绝。');
      refreshButtons();
      return answer;
    });
  }

  async function submitUser(input, envelope) {
    assertBound();
    const scope={...state.scope},epoch=state.epoch;
    const key=envelope?'xldbScene':'xldb';
    const managed=envelope?sceneManagedMessages():managedMessages();
    let message=managed.at(-1);
    const raw=nativeHost().chat.find(item=>sameScope(item.extra?.[key]?.scope,scope)&&item.extra[key].id===message?.id);
    if(!message || message.role!=='user' || message.text!==input || !raw?.extra?.xldbSubmitted ||
      (envelope && JSON.stringify(message.envelope)!==JSON.stringify(envelope))) {
      if(typeof helpers.createChatMessages!=='function')throw new Error('未找到 Tavern Helper 的 createChatMessages');
      message={id:newId('message'),revision:1,role:'user',text:input,acceptedAtMs:Date.now(),...(envelope?{envelope}:{})};
      state.selfInserting=true;
      try { await helpers.createChatMessages([{role:'user',message:input,extra:{xldbSubmitted:true,[key]:{...message,scope}}}],{insert_before:'end',refresh:'affected'}); }
      finally {state.selfInserting=false;}
      assertHostScope(scope,epoch);
      await saveNativeMetadata();
    }
    setStatus('用户正文已提交，正在同步本轮记忆与情绪……');
    await syncInternal();
    assertHostScope(scope,epoch);
    return (envelope?sceneManagedMessages():managedMessages()).find(item=>item.id===message.id);
  }

  async function generateScene(input) {
    const selectionVersion = state.scene.selectionVersion;
    const envelope = sceneEnvelope();
    const scope={...state.scope},epoch=state.epoch;
    const submitted=await submitUser(input,envelope);
    assertHostScope(scope,epoch);assertSceneSelectionCurrent(selectionVersion);
    const result = await request('/v1/scene/prepare', 'POST', { scope, envelope, input,
      userSubmission:{expectedVersion:state.scene.version,operationId:newId('prepare'),userMessageId:submitted.id,acceptedAtMs:submitted.acceptedAtMs} });
    assertHostScope(scope,epoch);
    assertBound();
    assertSceneSelectionCurrent(selectionVersion);
    if(result.status==='failed')throw new Error(`本轮同步失败：${result.error||'请重试'}；用户正文已保留。`);
    renderSceneMaterials(result);
    if (Array.isArray(result.unresolved) && result.unresolved.length) {
      setStatus(`场景需要补充说明：${result.unresolved.join('；')}`);
      return '';
    }
    if (!result.draftId || typeof result.answer !== 'string' || !result.answer.trim() || !result.userMessage || !result.assistantMessage) {
      throw new Error('场景候选不可接受，请补充明确场景');
    }
    const messages = [result.userMessage, result.assistantMessage].map(message => ({
      ...message,
      id: String(message.id || ''),
      revision: Number(message.revision) || 1,
      acceptedAtMs: Number(message.acceptedAtMs) || Date.now(),
      envelope: message.envelope || envelope,
    }));
    if (messages[0].id!==submitted.id || messages[0].role !== 'user' || messages[0].text !== input || messages[1].role !== 'assistant' || messages[1].text !== result.answer) {
      throw new Error('场景候选正文无效');
    }
    const candidate = { kind: 'scene', id: String(result.draftId), draftId: String(result.draftId), scope: { ...state.scope }, input, answer: result.answer,
      envelope, targetId: envelope.targetId, selectionVersion, messages, inserted: false, epoch };
    state.candidate = candidate;
    setPreview(result.answer);
    setStatus(`已生成 ${activeNpc().name} 的场景候选；请预览后明确接受。`);
    refreshButtons();
    return result.answer;
  }

  async function regenerateScene() {
    return withBusy(async () => {
      assertBound();
      if (!state.scene.enabled) throw new Error('当前聊天尚未启用场景模式');
      state.candidate = null; setPreview('');
      if (state.native.enabled) await state.native.queue.catch(() => {});
      await ensureInitializationFreshForGeneration();
      await syncInternal();
      assertBound();
      const current = sceneManagedMessages();
      const replacedMessage = current.at(-1); const user = current.at(-2);
      if (!replacedMessage || replacedMessage.role !== 'assistant' || !user || user.role !== 'user') throw new Error('没有可重新生成的上一条回复');
      const selectionVersion = state.scene.selectionVersion;
      const result = await request('/v1/scene/regenerate', 'POST', { scope: state.scope });
      assertBound(); assertSceneSelectionCurrent(selectionVersion);
      renderSceneMaterials(result);
      if (Array.isArray(result.unresolved) && result.unresolved.length) {
        setStatus(`重新生成需要补充说明：${result.unresolved.join('；')}`);
        return '';
      }
      if (!result.draftId || typeof result.answer !== 'string' || !result.answer.trim() || !result.userMessage || !result.assistantMessage) throw new Error('重新生成候选不可接受');
      const messages = [result.userMessage, result.assistantMessage].map(message => ({
        ...message, id: String(message.id || ''), revision: Number(message.revision) || 1,
        acceptedAtMs: Number(message.acceptedAtMs) || Date.now(), envelope: message.envelope || replacedMessage.envelope,
      }));
      if (String(result.replacementId || '') !== replacedMessage.id || messages[0].role !== 'user' || messages[0].id !== user.id
        || messages[0].text !== user.text || messages[0].revision !== user.revision || messages[1].role !== 'assistant'
        || messages[1].id !== replacedMessage.id || messages[1].text !== result.answer || messages[1].revision <= replacedMessage.revision) {
        throw new Error('重新生成候选正文无效');
      }
      const candidate = { kind: 'scene', operation: 'regenerate', id: String(result.draftId), draftId: String(result.draftId), scope: { ...state.scope },
        input: user.text, answer: result.answer, envelope: messages[1].envelope, targetId: messages[1].speakerId || messages[1].envelope.targetId,
        selectionVersion, messages, replacementId: replacedMessage.id, replacedMessage: { ...replacedMessage }, inserted: false };
      state.candidate = candidate;
      setPreview(result.answer);
      setStatus('已重新生成上一条回复；接受后才会替换原正文，拒绝则保留原回复。');
      refreshButtons();
      return result.answer;
    });
  }

  function candidateMessages(candidate) {
    if (candidate.messages) return candidate.messages;
    const acceptedAtMs = Date.now();
    candidate.messages = [
      { id: newId('message'), revision: 1, role: 'user', text: candidate.input, acceptedAtMs },
      { id: newId('message'), revision: 1, role: 'assistant', text: candidate.answer, acceptedAtMs },
    ];
    return candidate.messages;
  }

  function assertCandidateMessagesCurrent(candidate, messages) {
    const current = candidate.kind === 'scene' ? sceneManagedMessages() : managedMessages();
    for (const expected of messages) {
      const actual = current.find(message => message.id === expected.id);
      if (!actual || actual.role !== expected.role || actual.text !== expected.text || actual.revision !== expected.revision) {
        throw new Error('已接受正文已被修改或删除；请同步更改后再继续');
      }
    }
  }

  async function accept() {
    return withBusy(async () => {
      const candidate = state.candidate;
      assertCandidateCurrent(candidate);
      if (!candidate.answer) throw new Error('没有可接受的候选');
      if (candidate.kind === 'scene') return acceptScene(candidate);
      const messages = candidateMessages(candidate);
      if (!candidate.inserted) {
        if (typeof helpers.createChatMessages !== 'function') throw new Error('未找到 Tavern Helper 的 createChatMessages');
        state.selfInserting = true;
        try {
          await helpers.createChatMessages(messages.filter(message => message.role !== 'user' || !candidate.submitted).map(message => ({
            role: message.role,
            message: message.text,
            extra: { xldb: { id: message.id, revision: message.revision, scope: candidate.scope, acceptedAtMs: message.acceptedAtMs } },
          })), { insert_before: 'end', refresh: 'affected' });
        } finally { state.selfInserting = false; }
        candidate.inserted = true;
        assertCandidateCurrent(candidate);
      }
      for (const message of messages.filter(message=>message.role!=='user'||!candidate.submitted)) {
        assertCandidateMessagesCurrent(candidate, messages);
        const receipt = await request('/v1/process', 'POST', { scope: candidate.scope, message });
        assertCandidateCurrent(candidate);
        assertCandidateMessagesCurrent(candidate, messages);
        if (receipt.status === 'failed' || receipt.status === 'conflict') {
          setStatus('正文已接受，核心仍待同步；请点击“同步更改”重试。');
          return receipt;
        }
      }
      state.candidate = null;
      setPreview('');
      setStatus('正文已接受并提交到 XLDB。');
      scheduleCompanionEventPoll();
      refreshButtons();
      return { status: 'committed' };
    });
  }

  async function acceptScene(candidate) {
    const messages = candidate.messages;
    if (!candidate.inserted) {
      if (candidate.operation === 'regenerate' && typeof helpers.setChatMessages !== 'function') throw new Error('未找到 Tavern Helper 的 setChatMessages');
      if (candidate.operation !== 'regenerate' && typeof helpers.createChatMessages !== 'function') throw new Error('未找到 Tavern Helper 的 createChatMessages');
      assertCandidateCurrent(candidate);
      state.selfInserting = true;
      try {
        if (candidate.operation === 'regenerate') {
          const current = sceneManagedMessages();
          const actualUser = current.find(message => message.id === messages[0].id);
          const actualReply = current.find(message => message.id === candidate.replacementId);
          const prior = candidate.replacedMessage;
          if (!actualUser || actualUser.role !== messages[0].role || actualUser.text !== messages[0].text || actualUser.revision !== messages[0].revision
            || !actualReply || actualReply.role !== prior.role || actualReply.text !== prior.text || actualReply.revision !== prior.revision) {
            throw new Error('原回复已被修改或删除；请同步更改后重新生成');
          }
          const chat = nativeHost().chat;
          const index = chat.findIndex(message => sameScope(message.extra?.xldbScene?.scope, candidate.scope) && message.extra.xldbScene.id === candidate.replacementId);
          if (index < 0) throw new Error('原回复已被修改或删除；请同步更改后重新生成');
          const replacement = messages[1];
          await helpers.setChatMessages([{ message_id: index, message: replacement.text, is_hidden: false,
            extra: { ...chat[index].extra, xldbScene: bindingForSource(replacement, candidate.scope) } }], { refresh: 'affected' });
        } else {
          await helpers.createChatMessages(messages.filter(message=>!sceneManagedMessages().some(existing=>existing.id===message.id)).map(message => ({
            role: message.role,
            message: message.text,
            extra: { xldbScene: { id: message.id, revision: message.revision, scope: candidate.scope, envelope: message.envelope, acceptedAtMs: message.acceptedAtMs,
              ...(message.speakerId ? { speakerId: message.speakerId } : {}), ...(message.dependencies ? { dependencies: message.dependencies } : {}) } },
          })), { insert_before: 'end', refresh: 'affected' });
        }
      } finally { state.selfInserting = false; }
      candidate.inserted = true;
    }
    assertCandidateCurrent(candidate);
    assertCandidateMessagesCurrent(candidate, messages);
    const receipt = await request('/v1/scene/accept', 'POST', { scope: candidate.scope, draftId: candidate.draftId, messages });
    assertCandidateCurrent(candidate);
    assertCandidateMessagesCurrent(candidate, messages);
    await recordSceneReceipt(receipt,candidate.scope,candidate.epoch);
    if (receipt.status === 'failed') {
      setStatus(`正文已接受，场景核心仍待同步：${receipt.error || '未知错误'}；请点击“同步更改”重试。`);
      return receipt;
    }
    state.candidate = null;
    setPreview('');
    setStatus(candidate.operation === 'regenerate' ? '上一条回复已替换并提交到 XLDB。' : '场景正文已接受并提交到 XLDB。');
    scheduleCompanionEventPoll();
    refreshButtons();
    return receipt;
  }

  function reject() {
    if (state.busy) throw new Error('已有操作进行中');
    const candidate = state.candidate;
    if (candidate && candidate.inserted) throw new Error('正文已写入聊天，请编辑或删除对应消息后同步，不能作为未接受候选拒绝。');
    state.candidate = null;
    setPreview('');
    if (candidate && candidate.kind === 'scene') {
      request('/v1/scene/reject', 'POST', { scope: candidate.scope, draftId: candidate.draftId }).catch(() => setStatus('候选已拒绝；通知核心失败但未写入聊天。'));
    }
    setStatus('回复候选已拒绝；已提交的用户正文和本轮状态保留。');
    refreshButtons();
  }

  async function connect(connection) {
    const origin = String(connection?.origin || '');
    const token = String(connection?.token || '');
    if (!/^http:\/\/(127\.0\.0\.1|localhost):[0-9]{1,5}$/.test(origin) || Number(origin.split(':').at(-1)) < 1 || Number(origin.split(':').at(-1)) > 65535 || !/^[a-f0-9]{64}$/i.test(token)) throw new Error('本机连接资料无效');
    if ((state.enabled || state.busy) && (CORE_ORIGIN !== origin || state.token !== token)) throw new Error('请先禁用当前聊天再切换核心');
    const previous = { origin: CORE_ORIGIN, token: state.token };
    CORE_ORIGIN = origin; state.token = token;
    try {
      const diagnostic = await request('/v1/diagnostics', 'POST', {});
      if (diagnostic.protocol !== 'xldb-scene-v2' || diagnostic.authenticated !== true) throw new Error('本机核心版本不兼容');
      await loadConfig();
      if (state.panel) { state.panel.token.value = token; state.panel.root.hidden = false; }
      setStatus('已自动连接本机核心并读取配置。填写所需模型后，绑定当前聊天并启用原生聊天。');
      return { connected: true, protocol: diagnostic.protocol };
    } catch (error) { CORE_ORIGIN = previous.origin; state.token = previous.token; throw error; }
  }

  async function loadConfig() {
    return withBusy(async () => {
      const config = await request('/v1/config', 'GET');
      state.config = normalizeConfig(config);
      renderConfigValues();
      setStatus(retrievalModeMessage());
      return state.config;
    });
  }

  async function saveConfig(config) {
    return withBusy(async () => {
      const normalized = normalizeConfig(config || readConfigValues());
      await request('/v1/config', 'PUT', normalized);
      state.config = normalized;
      setStatus('配置已保存到本地 XLDB 核心。');
      return normalized;
    });
  }

  function normalizeConfig(config) {
    const result = emptyConfig();
    for (const stage of CONFIG_STAGES) {
      const source = config && config[stage] ? config[stage] : {};
      const thinking = source.thinking === 'enabled' || source.thinking === 'disabled' ? source.thinking : '';
      result[stage] = { baseUrl: String(source.baseUrl || '').trim(), key: String(source.key || ''), model: String(source.model || '').trim(),
        ...(thinking ? { thinking } : {}) };
    }
    return result;
  }

  function retrievalModeMessage() {
    const embedding = state.config.embedding || {};
    const reranker = state.config.reranker || {};
    if (!embedding.baseUrl && !embedding.key && !embedding.model && !reranker.baseUrl && !reranker.key && !reranker.model) {
      return '已读取配置；检索模型未配置，当前为 BM25-only 模式。';
    }
    return '已读取配置；密钥仅保留在当前页面内存中。';
  }

  async function inspect() {
    return withBusy(async () => {
      const data = await inspectInternal();
      if (state.scene.enabled) {
        if (data && data.roster) {
          setSceneRoster(data.roster,false);
          renderSceneControls();
        }
        renderSceneMaterials(data);
      } else renderInspect(data);
      setStatus(`当前权威版本：${data.version ?? '未知'}`);
      return data;
    });
  }

  async function inspectInternal() {
    assertBound();
    return request(state.scene.enabled ? '/v1/scene/inspect' : '/v1/inspect', 'POST', { scope: state.scope });
  }

  function requireSceneRestoreHost() {
    if (![helpers.setChatMessages, helpers.createChatMessages, helpers.deleteChatMessages].every(fn => typeof fn === 'function')) throw new Error('当前酒馆助手缺少消息恢复接口');
  }

  function bindingForSource(source, scope) {
    return { id: source.id, revision: source.revision, scope: { ...scope }, acceptedAtMs: source.acceptedAtMs,
      envelope: source.envelope, ...(source.speakerId ? { speakerId: source.speakerId } : {}),
      ...(source.automatic ? { automatic: true } : {}), dependencies: source.dependencies || [] };
  }

  async function materializeScene(scope, data) {
    requireSceneRestoreHost();
    if (!data.roster?.characters?.length || !Array.isArray(data.sources)) throw new Error('分支尚未配置');
    const epoch = state.epoch;
    const ensureCurrent = () => assertHostScope(scope, epoch, '恢复时聊天已切换，请重新绑定');
    ensureCurrent();
    const sources = data.sources.filter(source => source.status !== 'deleted');
    const wanted = new Set(sources.map(source => source.id));
    state.selfInserting = true;
    try {
      const remove = [];
      nativeHost().chat.forEach((message, index) => {
        const binding = message.extra?.xldbScene;
        if (!binding) return;
        if (sameScope(binding.scope, scope)) { if (!wanted.has(binding.id)) remove.push(index); }
        else if (binding.scope.worldId === scope.worldId && binding.scope.sessionId === scope.sessionId && binding.scope.characterId === scope.characterId) remove.push(index);
      });
      if (remove.length) {
        const host=nativeHost();
        if(typeof host.clearChat!=='function'||typeof host.printMessages!=='function')throw new Error('宿主缺少聊天重绘接口');
        ensureCurrent();await helpers.deleteChatMessages(remove,{refresh:'none'});
        ensureCurrent();await host.clearChat({clearData:false});
        ensureCurrent();await host.printMessages();
      }
      for (const [position, source] of sources.entries()) {
        ensureCurrent();
        const chat = nativeHost().chat;
        const index = chat.findIndex(message => [message.extra?.xldbScene,message.extra?.xldbCandidate].some(binding=>sameScope(binding?.scope,scope)&&binding.id===source.id) ||
          (sameScope(message.extra?.xldbProactive?.scope,scope) && source.id===`proactive:${message.extra.xldbProactive.deliveryId}`));
        const binding = bindingForSource(source, scope);
        if (index >= 0) { const extra={...chat[index].extra,xldbScene:binding};delete extra.xldbCandidate;ensureCurrent(); await helpers.setChatMessages([{ message_id: index, message: source.text, is_hidden: false, extra }], { refresh: 'affected' }); }
        else {
          const nextIds = new Set(sources.slice(position + 1).map(item => item.id));
          const next = chat.findIndex(message => sameScope(message.extra?.xldbScene?.scope, scope) && nextIds.has(message.extra.xldbScene.id));
          ensureCurrent();
          await helpers.createChatMessages([{ role: source.role, message: source.text, is_hidden: false, extra: { xldbScene: binding } }], { insert_before: next < 0 ? 'end' : next, refresh: 'affected' });
        }
      }
      ensureCurrent(); setSceneRoster(data.roster); renderSceneControls(); renderSceneMaterials(data);
      ensureCurrent();
      delete nativeHost().chatMetadata.xldbHydrate;
      await recordSceneReceipt({...data,bindings:sources},scope,epoch);
      await saveNativeMetadata();
      ensureCurrent();
    } finally { state.selfInserting = false; }
  }

  async function sceneCheckpoint(reason = '手动保存点') {
    return withBusy(async () => { assertBound(); await state.native.queue.catch(() => {}); const result = await request('/v1/scene/checkpoint', 'POST', { scope: state.scope, reason }); setStatus('保存点已建立。'); return result; });
  }
  async function recoverScene(worldId) {
    return withBusy(async()=>{
      assertToken();requireSceneRestoreHost();
      if(state.native.active)nativeHost().stopGeneration?.();
      state.native.enabled=false;state.native.turn=null;
      await state.native.queue.catch(()=>{});
      let scope=currentScope(worldId);const epoch=state.epoch;
      resetCompanionState();state.scope=scope;state.enabled=true;state.candidate=null;
      try {
        await selectInteraction(await request('/v1/scene/interaction','POST',{scope}),scope,epoch);
        scope={...state.scope};
        const data=await request('/v1/scene/inspect','POST',{scope});
        assertHostScope(scope,epoch);
        if(!data.roster?.characters?.length)throw new Error('该范围尚无可恢复的核心场景');
        (nativeHost().chatMetadata||={}).xldbHydrate={...scope};await saveNativeMetadata();
        await materializeScene(scope,data);state.native.error='';await restoreCompanionState();
        setStatus('已从核心恢复当前正文；本地受管改动已覆盖。未接受的候选仍不进入记忆。');return data;
      } catch(error){state.enabled=false;throw error;}
    });
  }

  async function restoreScene(operation, checkpointId, expectedVersion = state.scene.version) {
    return withBusy(async () => {
      assertBound(); requireSceneRestoreHost(); await state.native.queue.catch(() => {}); assertBound();
      const scope = { ...state.scope }; const epoch = state.epoch;
      const restoreHost = nativeHost(); const restoreMetadata = restoreHost.chatMetadata ||= {};
      try {
        restoreMetadata.xldbHydrate = scope; await saveNativeMetadata();
        const result = await request(`/v1/scene/${operation}`, 'POST', { scope, expectedVersion, ...(checkpointId ? { checkpointId } : {}) });
        if (state.epoch !== epoch || !sameScope(state.scope, scope)) throw new Error('原分支已恢复，重新绑定后加载正文');
        state.candidate = null; state.native.turn = null; state.native.error = ''; state.epoch += 1;resetCompanionState();
        await materializeScene(scope, result);
        await restoreCompanionState();
        setStatus(result.cleanupPending ? '正文和状态已恢复；检索清理待重试，请点击同步更改，不要重复撤销。' : operation === 'undo' && !result.undone ? '没有可撤销的操作。' : '已恢复正文及其记忆、情绪和世界状态。');
        return result;
      } catch (error) {
        restoreMetadata.xldbHydrate = scope;
        disable('恢复结果待载入，请重新绑定当前聊天。');
        throw error;
      }
    });
  }

  async function switchSceneBranch(branchId, create = false) {
    return withBusy(async () => {
      assertBound(); requireSceneRestoreHost(); await state.native.queue.catch(() => {}); assertBound();
      branchId = String(branchId || '').trim(); if (!branchId) throw new Error('请填写分支名称');
      const prior = { ...state.scope }; let scope = { ...prior, branchId }; const epoch = state.epoch;
      if(create)await request('/v1/scene/fork','POST',{scope:prior,branchId});
      const interaction=await request('/v1/scene/interaction','POST',{scope});
      scope=interaction.scope;
      const result = await request('/v1/scene/inspect','POST',{scope,interactionRevision:interaction.revision});
      assertHostScope(prior, epoch);
      if (!result.roster?.characters?.length) throw new Error('未找到该分支');
      const branchHost = nativeHost(); const branchMetadata = branchHost.chatMetadata ||= {};
      try {
        branchMetadata.xldbBranchId = scope.branchId; branchMetadata.xldbHydrate = scope;
        if (typeof branchHost.saveChat === 'function') await branchHost.saveChat();
        let actual = null; try { actual = currentScope(scope.worldId); } catch { /* handled below */ }
        if (state.epoch !== epoch || !sameScope(state.scope, prior) || !sameScope(actual, scope)) throw new Error('聊天已切换，请重新绑定');
        resetCompanionState();state.scope = scope;state.interaction=interaction; state.epoch += 1; state.candidate = null; state.native.turn = null; state.native.error = ''; state.panel?.resetWorldForm?.();state.panel?.resetWorkbench?.();renderInteraction();
        await materializeScene(scope, result);
        await restoreCompanionState();
        if (state.panel?.branchInput) state.panel.branchInput.value = branchId;
        setStatus(`已切换到分支 ${branchId}。`); return scope;
      } catch (error) {
        branchMetadata.xldbHydrate = scope;
        disable('分支待载入，请重新绑定当前聊天。');
        throw error;
      }
    });
  }

  function invalidateSceneCandidate() {
    state.scene.selectionVersion += 1;
    if (state.candidate && state.candidate.kind === 'scene') {
      state.candidate = null;
      setPreview('');
      setStatus('场景范围已变更；上一份候选已取消。');
    }
    refreshButtons();
  }

  function normalizeSceneRoster(roster) {
    return (Array.isArray(roster) ? roster : []).map(character => ({
      id: String(character && character.id || '').trim(),
      name: String(character && character.name || '').trim(),
      aliases: Array.isArray(character && character.aliases) ? character.aliases.map(alias => String(alias).trim()).filter(Boolean) : [],
      persona: String(character && character.persona || '').trim(),
      emotion: normalizeSceneEmotion(character && character.emotion),
    })).filter(character => character.id && character.name);
  }

  async function configureScene(roster) {
    return withBusy(async () => {
      assertBound();
      const characters = normalizeSceneRoster(roster);
      if (characters.length < 1) throw new Error('请补充至少一名具有姓名和稳定 ID 的 NPC');
      const response = await request('/v1/scene/configure', 'POST', { scope: state.scope, expectedVersion:state.scene.version, roster: { characters } });
      assertBound();
      setSceneRoster(response && response.roster ? response.roster : { characters });
      await recordSceneReceipt(response);
      state.candidate = null;
      setPreview('');
      renderSceneControls();
      await syncInternal();
      if (state.interaction?.mode === 'companion') await restoreCompanionState();
      setStatus('NPC 名单已保存；每名 NPC 使用自己的设定与视角。');
      return state.scene.roster;
    });
  }

  async function setAccess(memoryId, access, characterId) {
    return withBusy(async () => {
      assertBound();
      const receipt=await request(state.scene.enabled ? '/v1/scene/access' : '/v1/access', 'POST', { scope: state.scope, memoryId, access, ...(state.scene.enabled ? {characterId:characterId || state.scene.targetId,expectedVersion:state.scene.version} : {}) });
      if(state.scene.enabled)await recordSceneReceipt(receipt);
      const data = await inspectInternal();
      if (state.scene.enabled) renderSceneMaterials(data); else renderInspect(data);
      return data;
    });
  }

  async function setPreference(id, enabled, text, characterId) {
    return withBusy(async () => {
      assertBound();
      const receipt=await request(state.scene.enabled?'/v1/scene/preference':'/v1/preference', 'POST', { scope: state.scope, id, enabled: Boolean(enabled), ...(text === undefined ? {} : { text }), ...(state.scene.enabled?{characterId:characterId||state.scene.targetId,expectedVersion:state.scene.version}:{}) });
      if(state.scene.enabled)await recordSceneReceipt(receipt);
      const data = await inspectInternal();
      if(state.scene.enabled)renderSceneMaterials(data);else renderInspect(data);
      return data;
    });
  }

  function disableForChatChange() {
    disable('聊天已切换，XLDB 已禁用；请在新聊天中重新绑定。');
  }

  function disable(message = 'XLDB 已禁用；已取消候选与正在进行的处理。') {
    if (state.native.active) nativeHost().stopGeneration?.();
    state.native.active = false;
    state.native.enabled = false;
    state.native.turn = null;
    state.epoch += 1;
    state.enabled = false;
    state.scope = null;
    state.interaction=null;state.clock=null;renderInteraction();
    resetCompanionState();
    state.candidate = null;
    state.panel?.resetWorldForm?.();
    state.panel?.resetWorkbench?.();
    setPreview('');
    setStatus(message);
    refreshButtons();
  }

  function onManagedChange() {
    if (!state.enabled || state.selfInserting) return;
    state.candidate = null;
    setPreview('');
    setStatus('受管消息可能已编辑、删除或换卡；请点击“同步更改”后再生成。');
    refreshButtons();
    if (state.native.enabled) return queueNative(async () => { await syncInternal(); await inspect(); });
  }

  function nativeFingerprint() {
    return JSON.stringify(sceneManagedMessages().map(({ id, text, role }) => ({ id, text, role })));
  }

  function nativeHost() { return typeof host.getContext === 'function' ? host.getContext() : host; }

  function queueNative(action) {
    const epoch = state.epoch;
    const work = state.native.queue.catch(() => {}).then(async () => {
      if (!state.native.enabled || epoch !== state.epoch) return;
      try { await action(); state.native.error = ''; }
      catch (error) { state.native.error = error.message; setStatus(`原生聊天处理失败：${error.message}。请同步更改后重试。`); throw error; }
    });
    state.native.queue = work;
    // Host event emitters may ignore rejected handlers; retain the failure for the generation gate.
    work.catch(() => {});
    return work;
  }

  async function readIdentityMaterials() {
    if (typeof helpers.getCharData !== 'function' || typeof helpers.getCharWorldbookNames !== 'function' || typeof helpers.getWorldbook !== 'function') throw new Error('酒馆助手缺少角色卡或世界书读取接口');
    const raw = await helpers.getCharData('current');
    if (!raw) throw new Error('未找到当前角色卡');
    const card = raw.data || raw;
    const cardText = [card.name || raw.name, card.description || raw.description, card.personality || raw.personality, card.scenario || raw.scenario].filter(Boolean).join('\n');
    const documents = [{ id: 'card', name: String(card.name || raw.name || ''), keys: [], text: cardText.slice(0, 20000) }];
    const embedded = Object.values(card.character_book?.entries || {});
    for (const [index, entry] of embedded.entries()) if (entry.enabled === true && entry.content) documents.push({ id: `embedded:${entry.id ?? index}`, name: String(entry.comment || ''), keys: entry.keys || [], text: String(entry.content).slice(0, 20000) });
    const names = await helpers.getCharWorldbookNames('current');
    for (const name of [...new Set([names.primary, ...(names.additional || [])].filter(Boolean))]) {
      const entries = await helpers.getWorldbook(name);
      for (const entry of entries) if (entry.enabled === true && entry.content) documents.push({ id: `book:${name}:${entry.uid}`, name: String(entry.name || ''), keys: entry.strategy?.keys || [], text: String(entry.content).slice(0, 20000) });
    }
    if (documents.length > 1001) throw new Error('关联世界书条目过多，请缩小当前角色卡范围');
    return { playerName: String(nativeHost().name1 || ''), card: { id: 'card', text: cardText.slice(0, 20000) }, documents };
  }

  function initializationSourceText(lines) {
    return lines.filter(value => typeof value === 'string' && value.trim()).join('\n').slice(0, 100000);
  }

  function initializationSourceIdPart(value) {
    return encodeURIComponent(String(value ?? '')).slice(0, 120) || 'entry';
  }

  function initializationEntryText(bookName, entry) {
    const keys = Array.isArray(entry.keys) ? entry.keys : Array.isArray(entry.strategy?.keys) ? entry.strategy.keys : [];
    return initializationSourceText([
      `世界书：${bookName}`,
      entry.name || entry.comment ? `条目：${entry.name || entry.comment}` : '',
      keys.length ? `关键词：${keys.filter(key => typeof key === 'string').join('、')}` : '',
      `内容：${String(entry.content)}`,
    ]);
  }

  async function collectInitializationSources() {
    if (typeof helpers.getCharData !== 'function' || typeof helpers.getCharWorldbookNames !== 'function' || typeof helpers.getWorldbook !== 'function') throw new Error('酒馆助手缺少角色卡或世界书读取接口');
    const raw = await helpers.getCharData('current');
    if (!raw) throw new Error('未找到当前角色卡');
    const card = raw.data || raw;
    const cardName = String(card.name || raw.name || '当前角色卡').slice(0, 500);
    const cardText = initializationSourceText([
      card.name || raw.name ? `角色名：${card.name || raw.name}` : '',
      card.description || raw.description ? `描述：${card.description || raw.description}` : '',
      card.personality || raw.personality ? `性格：${card.personality || raw.personality}` : '',
      card.scenario || raw.scenario ? `场景：${card.scenario || raw.scenario}` : '',
    ]);
    if (!cardText) throw new Error('当前角色卡没有可用于初始化的正文');
    const sources = [{ id: 'character-card:current', kind: 'character_card', name: cardName, text: cardText }];
    const appendEntry = (id, bookName, entry) => {
      if (!entry || entry.enabled !== true || typeof entry.content !== 'string' || !entry.content.trim()) return;
      sources.push({ id, kind: 'world_book', name: String(entry.name || entry.comment || bookName || '世界书条目').slice(0, 500), text: initializationEntryText(bookName, entry) });
    };
    const embedded = Array.isArray(card.character_book?.entries) ? card.character_book.entries : Object.values(card.character_book?.entries || {});
    for (const [index, entry] of embedded.entries()) appendEntry(`world-book:embedded:${initializationSourceIdPart(entry?.uid ?? entry?.id)}:${index}`, `${cardName}（内嵌世界书）`, entry);
    const names = await helpers.getCharWorldbookNames('current') || {};
    const linkedNames = [...new Set([names.primary, ...(Array.isArray(names.additional) ? names.additional : [])].filter(name => typeof name === 'string' && name.trim()))];
    for (const [bookIndex, bookName] of linkedNames.entries()) {
      const entries = await helpers.getWorldbook(bookName);
      for (const [entryIndex, entry] of (Array.isArray(entries) ? entries : []).entries()) {
        appendEntry(`world-book:linked:${bookIndex}:${initializationSourceIdPart(entry?.uid ?? entry?.id)}:${entryIndex}`, bookName, entry);
      }
    }
    return sources;
  }

  function hasInitializationProvenance(provenance) {
    return Boolean(provenance) && ((Array.isArray(provenance.sources) && provenance.sources.length > 0) ||
      (Array.isArray(provenance.artifacts) && provenance.artifacts.length > 0));
  }

  function renderInitializationMaintenance() {
    const area = state.panel?.initializationMaintenance;
    if (!area) return;
    clearElement(area);
    const provenance = state.initialization.provenance;
    const refresh = state.initialization.refresh;
    if (!state.initialization.hasInitialized && !provenance) {
      area.append(element('p', '当前场景尚无已应用的初始化来源。'));
      return;
    }
    if (provenance) {
      area.append(element('h5', '已保存的初始化来源与产物'));
      for (const source of provenance.sources || []) {
        area.append(element('p', `来源 · ${source.sourceId} · ${source.status} · r${source.revision} · ${source.name}`));
      }
      for (const artifact of provenance.artifacts || []) {
        const evidence = (artifact.evidence || []).map(item => item.sourceId).join('、') || '无';
        area.append(element('p', `产物 · ${artifact.type} · ${artifact.id} · ${artifact.status} · r${artifact.revision} · 来源：${evidence}`));
      }
    } else {
      area.append(element('p', '当前场景已初始化；请读取来源血缘查看保存状态。'));
    }
    if (!refresh) return;
    area.append(element('h5', '当前启用来源的变更预览'));
    const changeLabels = { added: '新增', changed: '内容已变更', deleted: '已停用／移除', restored: '已恢复' };
    for (const item of refresh.sourceChanges || []) area.append(element('p', `来源变更 · ${item.sourceId} · ${changeLabels[item.change] || item.change}`));
    for (const action of refresh.referenceActions || []) {
      const reason = [...(action.missingSourceIds || []).map(id => `缺少 ${id}`), ...(action.changedSourceIds || []).map(id => `已修改 ${id}`)].join('、');
      area.append(element('p', `${action.action === 'revoke' ? '将撤销' : '将恢复'}初始化参考 · ${action.entryId}${reason ? ` · ${reason}` : ''}`));
    }
    for (const conflict of refresh.characterConflicts || []) {
      const reason = [...(conflict.missingSourceIds || []).map(id => `缺少 ${id}`), ...(conflict.changedSourceIds || []).map(id => `已修改 ${id}`)].join('、');
      area.append(element('p', `NPC 设定冲突 · ${conflict.id}${reason ? ` · ${reason}` : ''}；需重新预览初始化后才能继续生成。`));
    }
    for (const conflict of refresh.referenceConflicts || []) {
      area.append(element('p', `已由管理员删除的参考保持删除 · ${conflict.id}`));
    }
    if (!(refresh.sourceChanges || []).length && !(refresh.referenceActions || []).length && !(refresh.characterConflicts || []).length && !(refresh.referenceConflicts || []).length) {
      area.append(element('p', '当前启用来源与已保存初始化一致。'));
    }
    if ((refresh.sourceChanges || []).length || (refresh.referenceActions || []).length) {
      area.append(button('确认应用来源刷新', applyInitializationRefresh));
    }
  }

  async function fetchInitializationProvenance() {
    const scope = { ...state.scope }, epoch = state.epoch;
    const provenance = await request('/v1/scene/initialization-provenance', 'POST', { scope });
    assertHostScope(scope, epoch, '读取初始化来源期间聊天已切换');
    if (!provenance || !Array.isArray(provenance.sources) || !Array.isArray(provenance.artifacts)) throw new Error('核心未返回有效初始化来源血缘');
    state.initialization.provenance = provenance;
    state.initialization.hasInitialized = hasInitializationProvenance(provenance);
    renderInitializationMaintenance();
    return provenance;
  }

  async function readInitializationProvenance() {
    return withBusy(async () => {
      assertBound();
      const provenance = await fetchInitializationProvenance();
      setStatus(state.initialization.hasInitialized ? '已读取初始化来源与产物血缘。' : '当前场景尚未应用初始化。');
      return provenance;
    });
  }

  async function previewInitializationRefreshInternal() {
    const scope = { ...state.scope }, epoch = state.epoch;
    const sources = await collectInitializationSources();
    assertHostScope(scope, epoch, '核对初始化来源期间聊天已切换');
    const result = await request('/v1/scene/initialization-refresh-preview', 'POST', { scope, sources });
    assertHostScope(scope, epoch, '核对初始化来源期间聊天已切换');
    if (!result || typeof result.previewId !== 'string' || !Number.isSafeInteger(result.expectedVersion) ||
      !Array.isArray(result.sourceChanges) || !Array.isArray(result.referenceActions) || !Array.isArray(result.characterConflicts) || !Array.isArray(result.referenceConflicts)) {
      throw new Error('核心未返回有效初始化来源变更预览');
    }
    state.initialization.refresh = { ...result, sources, scope, epoch, operationId: newId('initialization-refresh') };
    renderInitializationMaintenance();
    return state.initialization.refresh;
  }

  async function previewInitializationRefresh() {
    return withBusy(async () => {
      assertBound();
      if (!state.initialization.hasInitialized) await fetchInitializationProvenance();
      if (!state.initialization.hasInitialized) {
        setStatus('当前场景尚未应用初始化，无需刷新来源。');
        return null;
      }
      const result = await previewInitializationRefreshInternal();
      setStatus((result.referenceActions.length || result.characterConflicts.length) ? '发现会影响初始化产物的来源变更，请先核对。' : '已核对当前启用的初始化来源。');
      return result;
    });
  }

  async function ensureInitializationFreshForGeneration() {
    if (!state.initialization.hasInitialized) return null;
    const result = await previewInitializationRefreshInternal();
    if (!(result.referenceActions.length || result.characterConflicts.length)) return result;
    if (state.panel?.initializationSection) state.panel.initializationSection.open = true;
    setStatus('初始化来源已变更；已暂停生成，请在初始化面板核对撤销／恢复与 NPC 设定冲突。');
    throw new Error('初始化来源已变更，请先核对并确认来源刷新');
  }

  async function applyInitializationRefresh() {
    return withBusy(async () => {
      const pending = state.initialization.refresh;
      if (!pending) throw new Error('初始化来源变更预览已失效，请重新核对');
      assertHostScope(pending.scope, pending.epoch, '来源变更预览所属聊天已切换');
      const sources = await collectInitializationSources();
      assertHostScope(pending.scope, pending.epoch, '应用初始化来源刷新期间聊天已切换');
      if (!sameInitializationSources(pending.sources, sources)) {
        state.initialization.refresh = null;
        renderInitializationMaintenance();
        throw new Error('当前启用来源再次发生变化，请重新核对');
      }
      const receipt = await request('/v1/scene/initialization-refresh', 'POST', {
        scope: pending.scope, sources,
        expectedVersion: pending.expectedVersion, previewId: pending.previewId, operationId: pending.operationId,
      });
      assertHostScope(pending.scope, pending.epoch, '应用初始化来源刷新期间聊天已切换');
      await recordSceneReceipt(receipt, pending.scope, pending.epoch);
      state.initialization.hasInitialized = true;
      await fetchInitializationProvenance();
      state.initialization.refresh = {
        ...pending, expectedVersion: receipt.version, sourceChanges: [], referenceActions: [],
        characterConflicts: Array.isArray(receipt.characterConflicts) ? receipt.characterConflicts : [],
        referenceConflicts: Array.isArray(receipt.referenceConflicts) ? receipt.referenceConflicts : [],
      };
      state.candidate = null; setPreview('');
      renderInitializationMaintenance();
      setStatus(state.initialization.refresh.characterConflicts.length ? '来源刷新已应用；NPC 设定冲突仍需重新预览初始化。' : '初始化来源刷新已应用。');
      return receipt;
    });
  }

  function invalidateInitializationPreview(message = '') {
    state.initialization.preview = null;
    if (state.panel?.initializationPreview) {
      clearElement(state.panel.initializationPreview);
      if (message) state.panel.initializationPreview.append(element('p', message));
    }
  }

  function selectedInitializationSources(catalog = state.initialization.catalog) {
    const selected = new Set(state.initialization.selectedIds);
    return catalog.filter(source => selected.has(source.id));
  }

  function setInitializationCatalog(sources, preserveSelection = false) {
    const previous = new Set(preserveSelection ? state.initialization.selectedIds : []);
    state.initialization.catalog = sources.map(source => ({ ...source }));
    state.initialization.selectedIds = sources.filter(source => previous.has(source.id) || (!preserveSelection && source.kind === 'character_card')).map(source => source.id);
    invalidateInitializationPreview();
    const area = state.panel?.initializationSources;
    if (!area) return;
    clearElement(area);
    for (const source of state.initialization.catalog) {
      const row = element('div');
      const check = element('input'); check.type = 'checkbox'; check.checked = state.initialization.selectedIds.includes(source.id);
      check.setAttribute('aria-label', `初始化来源：${source.id}`);
      check.addEventListener('change', () => {
        const selected = new Set(state.initialization.selectedIds);
        if (check.checked) selected.add(source.id); else selected.delete(source.id);
        state.initialization.selectedIds = state.initialization.catalog.filter(item => selected.has(item.id)).map(item => item.id);
        invalidateInitializationPreview('来源选择已变化，请重新预览。');
      });
      const label = element('label', `${source.kind === 'character_card' ? '角色卡' : '世界书'}：${source.name}`); label.append(check);
      const details = element('details'); details.append(element('summary', '查看来源正文'), element('pre', source.text));
      row.append(label, details); area.append(row);
    }
  }

  async function loadInitializationSources() {
    return withBusy(async () => {
      assertBound(); const scope = { ...state.scope }, epoch = state.epoch;
      const sources = await collectInitializationSources();
      assertHostScope(scope, epoch, '读取初始化来源期间聊天已切换');
      setInitializationCatalog(sources);
      setStatus(`已读取 ${sources.length} 项可选来源；世界书条目需明确勾选后才会发送。`);
      return sources;
    });
  }

  function sameInitializationSources(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function renderInitializationPreview(result) {
    const area = state.panel?.initializationPreview;
    if (!area) return;
    clearElement(area);
    const candidate = result.candidate || {};
    const preview = result.preview || {};
    area.append(element('h5', `初始化预览：${candidate.name || '未命名'}`));
    area.append(element('p', `新增 NPC：${(preview.diff?.addedCharacters || []).join('、') || '无'}；保持不变：${(preview.diff?.unchangedCharacters || []).join('、') || '无'}`));
    for (const character of candidate.characters || []) area.append(element('p', `NPC · ${character.name}（${character.id}）：${character.persona}`));
    for (const entry of candidate.entries || []) {
      const readers = Array.isArray(entry.readerIds) && entry.readerIds.length ? entry.readerIds.join('、') : '仅管理员／非历史资料';
      area.append(element('p', `${entry.kind} · ${entry.id} · 知情者：${readers}${entry.subjectId ? ` · 主体：${entry.subjectId}` : ''}\n${entry.text}`));
    }
    for (const item of preview.conflicts || []) area.append(element('p', `冲突：${item.code}${item.id ? `（${item.id}）` : ''}`));
    for (const item of preview.warnings || []) area.append(element('p', `提示：${item.code}${item.id ? `（${item.id}）` : ''}`));
    if ((preview.nonHistorical || []).length) area.append(element('p', `以下分类只作为参考，不写成已经历历史：${preview.nonHistorical.map(item => item.id).join('、')}`));
    if (preview.valid) area.append(button('确认应用初始化', applyInitialization));
    area.append(button('取消初始化预览', () => invalidateInitializationPreview('已取消；没有写入任何初始化内容。')));
  }

  async function previewInitialization() {
    return withBusy(async () => {
      assertBound();
      if (!state.initialization.catalog.length) throw new Error('请先读取角色卡与世界书来源');
      const scope = { ...state.scope }, epoch = state.epoch;
      const selectedBefore = selectedInitializationSources();
      if (!selectedBefore.length) throw new Error('请至少选择一项初始化来源');
      if (selectedBefore.length > 128) throw new Error('一次最多选择 128 项初始化来源');
      if (selectedBefore.reduce((total, source) => total + source.text.length, 0) > 1000000) throw new Error('所选初始化来源正文过长，请减少选择');
      const freshCatalog = await collectInitializationSources();
      assertHostScope(scope, epoch, '预览初始化期间聊天已切换');
      const selectedIds = new Set(state.initialization.selectedIds);
      const freshSelected = freshCatalog.filter(source => selectedIds.has(source.id));
      if (!sameInitializationSources(selectedBefore, freshSelected)) {
        setInitializationCatalog(freshCatalog, true);
        throw new Error('已选来源内容发生变化，请核对后重新预览');
      }
      const result = await request('/v1/scene/initialization-preview', 'POST', { scope, sources: freshSelected });
      assertHostScope(scope, epoch, '预览初始化期间聊天已切换');
      if (!result || !result.candidate || !Array.isArray(result.sources) || !result.preview || typeof result.preview.previewId !== 'string' || !Number.isSafeInteger(result.preview.expectedVersion)) throw new Error('核心未返回有效初始化预览');
      state.initialization.preview = { ...result, scope, epoch, operationId: newId('initialization') };
      renderInitializationPreview(state.initialization.preview);
      setStatus(result.preview.valid ? '初始化候选已预览；确认后才会写入。' : '初始化候选存在冲突，未提供应用操作。');
      return result;
    });
  }

  async function applyInitialization() {
    return withBusy(async () => {
      const pending = state.initialization.preview;
      if (!pending) throw new Error('初始化预览已失效，请重新预览');
      assertHostScope(pending.scope, pending.epoch, '初始化预览所属聊天已切换');
      const freshCatalog = await collectInitializationSources();
      assertHostScope(pending.scope, pending.epoch, '应用初始化期间聊天已切换');
      const selectedIds = new Set(state.initialization.selectedIds);
      const freshSelected = freshCatalog.filter(source => selectedIds.has(source.id));
      if (!sameInitializationSources(pending.sources, freshSelected)) {
        setInitializationCatalog(freshCatalog, true);
        throw new Error('已选来源内容发生变化，请核对后重新预览');
      }
      const receipt = await request('/v1/scene/initialization-apply', 'POST', {
        scope: pending.scope, candidate: pending.candidate, sources: pending.sources,
        expectedVersion: pending.preview.expectedVersion, previewId: pending.preview.previewId, operationId: pending.operationId,
      });
      assertHostScope(pending.scope, pending.epoch, '应用初始化期间聊天已切换');
      await recordSceneReceipt(receipt, pending.scope, pending.epoch);
      state.initialization.hasInitialized = true;
      state.initialization.provenance = null;
      state.initialization.refresh = null;
      renderInitializationMaintenance();
      const data = await request('/v1/scene/inspect', 'POST', { scope: pending.scope });
      assertHostScope(pending.scope, pending.epoch, '刷新初始化结果期间聊天已切换');
      if (!data?.roster) throw new Error('核心未返回初始化后的 NPC 名单');
      setSceneRoster(data.roster); renderSceneControls();
      state.candidate = null; setPreview('');
      await syncInternal();
      if (state.interaction?.mode === 'companion') await restoreCompanionState();
      invalidateInitializationPreview(`初始化已应用${receipt.duplicate ? '（重复请求已安全复用）' : ''}。`);
      setStatus('初始化已应用并同步当前聊天；NPC 名单已刷新。');
      return receipt;
    });
  }

  function renderNpcResources() {
    const area = state.panel?.resourceArea;
    if (!area) return;
    clearElement(area);
    const status = state.resources;
    if (!state.scene.enabled) { area.append(element('p', '建立 NPC 名单后可配置资源上限。')); return; }
    if (!status) { area.append(element('p', '请先读取当前 NPC 资源状态。')); return; }
    const limit = field('NPC 同时激活上限', 'number'); limit.input.setAttribute('aria-label', 'NPC 同时激活上限'); limit.input.value = String(status.maxActive); limit.input.min = '1'; limit.input.max = '32';
    const priorities = element('div'); const checks = [];
    for (const character of state.scene.roster) {
      const check = element('input'); check.type = 'checkbox'; check.checked = status.priorityIds.includes(character.id); check.setAttribute('aria-label', `优先 NPC：${character.id}`);
      const label = element('label', `${character.name}（${character.id}）`); label.append(check); priorities.append(label); checks.push({ id: character.id, check });
    }
    const names = ids => ids.map(id => state.scene.roster.find(character => character.id === id)?.name || id).join('、') || '无';
    area.append(element('p', `控制版本 ${status.controlRevision} · 已选择：${names(status.selectedIds)} · 当前激活：${names(status.activeIds)} · 暂停：${names(status.pausedIds)}`), limit.wrap,
      element('p', '优先 NPC（按名单顺序）'), priorities,
      button('保存 NPC 资源配置', () => configureNpcResources(Number(limit.input.value), checks.filter(item => item.check.checked).map(item => item.id), status.controlRevision)));
  }

  async function readNpcResources() {
    return withBusy(async () => {
      assertBound(); const scope = { ...state.scope }, epoch = state.epoch;
      const result = await request('/v1/scene/resources', 'POST', { scope });
      assertHostScope(scope, epoch, '读取 NPC 资源状态期间聊天已切换');
      if (!result || !Number.isSafeInteger(result.controlRevision) || !Number.isSafeInteger(result.maxActive) || !Array.isArray(result.priorityIds) || !Array.isArray(result.selectedIds) || !Array.isArray(result.activeIds) || !Array.isArray(result.pausedIds)) throw new Error('核心未返回有效 NPC 资源状态');
      state.resources = result; renderNpcResources();
      return result;
    });
  }

  async function configureNpcResources(maxActive, priorityIds, expectedRevision = state.resources?.controlRevision) {
    return withBusy(async () => {
      assertBound();
      if (!Number.isSafeInteger(expectedRevision)) throw new Error('请先读取当前 NPC 资源状态');
      const scope = { ...state.scope }, epoch = state.epoch;
      const result = await request('/v1/scene/resources-configure', 'POST', { scope, maxActive, priorityIds, expectedRevision });
      assertHostScope(scope, epoch, '保存 NPC 资源配置期间聊天已切换');
      if (!result || !Number.isSafeInteger(result.controlRevision)) throw new Error('核心未返回有效 NPC 资源状态');
      state.resources = result; renderNpcResources();
      setStatus('NPC 资源配置已保存；后续模型任务按新上限分批运行。');
      return result;
    });
  }

  const PROFILE_CATEGORIES = ['experience','current_context','schedule','habit','observation','preference','hypothesis'];
  const PROFILE_CATEGORY_LABELS = {
    experience:'经历',current_context:'当前情境',schedule:'日程',habit:'习惯',observation:'行为观察',preference:'明确偏好',hypothesis:'推测',
  };

  function clearCompanionTimer() {
    if (state.companion.timer !== null && typeof globalThis.clearInterval === 'function') globalThis.clearInterval(state.companion.timer);
    state.companion.timer = null;
  }

  function resetCompanionState() {
    clearCompanionTimer();
    state.companion = { profile:null, status:null, timer:null, polling:false, pendingEvent:false, uncertainDeliveries:new Set() };
    renderCompanionPanel();
  }

  function companionCharacterId() {
    if (state.scene.roster.some(character => character.id === state.scene.targetId)) return state.scene.targetId;
    return state.scene.roster[0]?.id || '';
  }

  function companionControls() {
    return state.companion.profile?.controls || state.companion.status?.controls || null;
  }

  function companionHostBusy() {
    return state.busy || state.native.active || Boolean(state.candidate);
  }

  function assertCompanionCurrent(scope, epoch, characterId, requireIdle = false) {
    assertHostScope(scope, epoch, '主动陪伴检查期间聊天已切换');
    if (state.interaction?.mode !== 'companion' || companionCharacterId() !== characterId) throw new Error('伴侣模式或当前角色已变化');
    if (requireIdle && companionHostBusy()) throw new Error('当前聊天正忙，本次主动发送已取消');
  }

  function refreshCompanionTimer() {
    clearCompanionTimer();
    const controls = companionControls();
    if (!state.enabled || state.interaction?.mode !== 'companion' || !controls?.proactiveCompanionEnabled || !controls.scheduledWakeEnabled || typeof globalThis.setInterval !== 'function') return;
    state.companion.timer = globalThis.setInterval(() => {
      if (!state.enabled || state.interaction?.mode !== 'companion' || companionHostBusy()) return;
      void pollCompanion('scheduled').catch(error => setStatus(`定时主动陪伴检查失败：${error.message}`));
    }, 60000);
  }

  async function restoreCompanionState() {
    clearCompanionTimer();
    if (!state.enabled || state.interaction?.mode !== 'companion' || !companionCharacterId()) { renderCompanionPanel(); return null; }
    try { return await readCompanionStatus(); }
    catch (error) {
      state.companion.profile = null; state.companion.status = null; renderCompanionPanel();
      if (error?.message !== 'XLDB：companion_subject_not_bound') setStatus(`伴侣控制状态未恢复：${error.message}`);
      return null;
    }
  }

  async function bindCompanionSubject(subjectId) {
    return withBusy(async () => {
      assertBound();
      if (state.interaction?.mode !== 'companion') throw new Error('用户画像只在伴侣模式中绑定');
      const value = String(subjectId || '').trim();
      if (!value) throw new Error('请输入稳定的真实用户 ID；昵称和角色别名不能代替');
      const scope = { ...state.scope }, epoch = state.epoch, characterId = companionCharacterId();
      await request('/v1/scene/subject-bind', 'POST', { scope, subjectId:value });
      assertCompanionCurrent(scope, epoch, characterId);
      await readCompanionProfile();
      await readCompanionStatus();
      setStatus('真实用户画像主体已绑定；默认学习、应用和主动陪伴仍保持关闭。');
      return state.companion.profile;
    });
  }

  async function readCompanionProfile() {
    assertBound();
    if (state.interaction?.mode !== 'companion') throw new Error('请先切换到伴侣模式');
    const scope = { ...state.scope }, epoch = state.epoch, characterId = companionCharacterId();
    const result = await request('/v1/scene/profile', 'POST', { scope });
    assertCompanionCurrent(scope, epoch, characterId);
    if (!result?.subject || !result.controls || !Array.isArray(result.entries)) throw new Error('核心未返回有效用户画像');
    state.companion.profile = result; renderCompanionPanel(); refreshCompanionTimer(); return result;
  }

  async function readCompanionStatus() {
    assertBound();
    if (state.interaction?.mode !== 'companion') throw new Error('请先切换到伴侣模式');
    const characterId = companionCharacterId();
    if (!characterId) throw new Error('请先建立伴侣角色');
    const scope = { ...state.scope }, epoch = state.epoch;
    const result = await request('/v1/scene/companion-status', 'POST', { scope, characterId });
    assertCompanionCurrent(scope, epoch, characterId);
    if (!result?.subject || !result.controls || !result.contact || !result.status?.activity) throw new Error('核心未返回有效伴侣状态');
    state.companion.status = result;
    if (state.companion.profile) state.companion.profile = { ...state.companion.profile, subject:result.subject, controls:result.controls };
    renderCompanionPanel(); refreshCompanionTimer(); return result;
  }

  async function saveProfileControls(patch, expectedRevision = companionControls()?.revision) {
    return withBusy(async () => {
      assertBound(); const scope = { ...state.scope }, epoch = state.epoch, characterId = companionCharacterId();
      if (!Number.isSafeInteger(expectedRevision)) throw new Error('请先读取用户画像控制项');
      const controls = await request('/v1/scene/profile-controls', 'POST', { scope, patch, expectedRevision });
      assertCompanionCurrent(scope, epoch, characterId);
      if (!controls || !Number.isSafeInteger(controls.revision)) throw new Error('核心未返回有效画像控制项');
      if (state.companion.profile) state.companion.profile = { ...state.companion.profile, controls };
      if (state.companion.status) state.companion.status = { ...state.companion.status, controls };
      renderCompanionPanel(); refreshCompanionTimer();
      setStatus('画像学习、应用范围与主动陪伴授权已保存。');
      return controls;
    });
  }

  async function correctProfileEntry(id, claim) {
    return withBusy(async () => {
      assertBound(); const scope = { ...state.scope }, epoch = state.epoch, characterId = companionCharacterId();
      await request('/v1/scene/profile-correct', 'POST', { scope, id, correction:{claim:String(claim || '').trim()} });
      assertCompanionCurrent(scope, epoch, characterId);
      const result = await readCompanionProfile(); setStatus('画像条目已按用户纠正。'); return result;
    });
  }

  async function deleteProfileEntry(id) {
    return withBusy(async () => {
      assertBound(); const scope = { ...state.scope }, epoch = state.epoch, characterId = companionCharacterId();
      await request('/v1/scene/profile-delete', 'POST', { scope, id });
      assertCompanionCurrent(scope, epoch, characterId);
      const result = await readCompanionProfile(); setStatus('画像条目已删除，不再用于读取、策略或主动陪伴。'); return result;
    });
  }

  async function saveContactSettings(settings, expectedRevision = state.companion.status?.contact?.revision) {
    return withBusy(async () => {
      assertBound(); const scope = { ...state.scope }, epoch = state.epoch, characterId = companionCharacterId();
      if (!Number.isSafeInteger(expectedRevision)) throw new Error('请先读取伴侣联系设置');
      const contact = await request('/v1/scene/contact-settings', 'POST', { scope, settings, expectedRevision });
      assertCompanionCurrent(scope, epoch, characterId);
      if (!contact || !Number.isSafeInteger(contact.revision)) throw new Error('核心未返回有效联系设置');
      if (state.companion.status) state.companion.status = { ...state.companion.status, contact };
      renderCompanionPanel(); setStatus('可联系时段和频率限制已保存。'); return contact;
    });
  }

  async function saveCompanionBusy(busyUntilMs, expectedRevision = state.companion.status?.status?.activity?.revision) {
    return withBusy(async () => {
      assertBound(); const scope = { ...state.scope }, epoch = state.epoch, characterId = companionCharacterId();
      if (!Number.isSafeInteger(expectedRevision)) throw new Error('请先读取伴侣活动状态');
      const activity = await request('/v1/scene/companion-busy', 'POST', { scope, busyUntilMs, expectedRevision });
      assertCompanionCurrent(scope, epoch, characterId);
      await readCompanionStatus(); setStatus(busyUntilMs === null ? '已取消忙碌状态。' : '忙碌时段已保存，期间不会主动发送。'); return activity;
    });
  }

  function proactiveMarker(deliveryId, scope) {
    return (nativeHost().chat || []).find(message => message?.extra?.xldbProactive?.deliveryId === deliveryId && sameScope(message.extra.xldbProactive.scope, scope));
  }

  function hostMessageId(message, deliveryId) {
    for (const value of [message?.id,message?.message_id,message?.extra?.messageId,message?.send_date]) {
      if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) return String(value);
    }
    return message?.extra?.xldbProactive?.deliveryId === deliveryId ? `xldb-proactive:${deliveryId}` : '';
  }

  function hostMessageById(id) {
    const expected=String(id||'').trim();
    if(!expected)return null;
    return (nativeHost().chat||[]).find(message=>[message?.id,message?.message_id,message?.extra?.messageId,message?.send_date]
      .some(value=>(typeof value==='string'||typeof value==='number')&&String(value)===expected))||null;
  }

  async function recordCompanionUnknown(scope, characterId, deliveryId, claimToken, code) {
    state.companion.uncertainDeliveries.add(deliveryId);
    try { await request('/v1/scene/companion-receipt', 'POST', { scope, characterId, deliveryId, claimToken, outcome:{status:'unknown',code} }); }
    catch { /* A sending lease also expires to unknown; never retry the host write. */ }
  }

  async function reconcileCompanionUnknown(deliveryId, decision, context, explicitHostMessageId = '') {
    return withBusy(async()=>{
      assertCompanionCurrent(context.scope,context.epoch,context.characterId);
      const delivery=state.companion.status?.status?.deliveries?.find(item=>item.deliveryId===deliveryId&&item.status==='unknown');
      if(!delivery)throw new Error('该未知发送记录已变化，请重新读取伴侣状态');
      let message=null,outcome;
      if(decision==='sent') {
        message=proactiveMarker(deliveryId,context.scope);
        let messageId=message?hostMessageId(message,deliveryId):'';
        if(!message) {
          messageId=String(explicitHostMessageId||'').trim();
          if(!messageId)throw new Error('当前聊天没有该 delivery marker，请输入明确的宿主消息标识');
          message=hostMessageById(messageId);
          if(!message||message.is_user||message.is_system)throw new Error('当前聊天未找到该 assistant 宿主消息标识');
        }
        outcome={status:'sent',hostMessageId:messageId};
      } else if(decision==='failed') outcome={status:'failed',code:'confirmed_absent'};
      else throw new Error('无效未知发送处理');
      const receipt=await request('/v1/scene/companion-reconcile','POST',{scope:context.scope,characterId:context.characterId,deliveryId,outcome});
      assertCompanionCurrent(context.scope,context.epoch,context.characterId);
      if(!receipt?.delivery||receipt.delivery.deliveryId!==deliveryId)throw new Error('核心未返回未知发送处理结果');
      if(decision==='sent') {
        await commitCompanionReceipt(receipt,message,context.scope,context.epoch);
      } else {
        await recordSceneReceipt(receipt,context.scope,context.epoch);
      }
      state.companion.uncertainDeliveries.delete(deliveryId);
      await readCompanionStatus();
      setStatus(decision==='sent'?'已将现有宿主消息与主动发送记录对账，没有新造消息。':'已确认该主动消息未发送；旧候选不会重发，后续机会可继续检查。');
      return receipt;
    });
  }

  async function commitCompanionReceipt(receipt, message, scope, epoch) {
    if (!receipt?.source || receipt.source.role !== 'assistant' || receipt.source.text !== String(message?.mes || '')) throw new Error('核心未返回主动消息的权威来源');
    message.extra ||= {};
    message.extra.xldbScene = bindingForSource(receipt.source, scope);
    await recordSceneReceipt(receipt, scope, epoch);
    renderSceneMaterials(await inspectInternal());
  }

  async function pollCompanion(trigger = 'event') {
    if (state.companion.polling) return {status:'busy'};
    const controls = companionControls();
    if (!state.enabled || state.interaction?.mode !== 'companion' || !controls?.proactiveCompanionEnabled) return {status:'disabled'};
    if (trigger === 'scheduled' && !controls.scheduledWakeEnabled) return {status:'disabled'};
    if (companionHostBusy()) return {status:'busy'};
    const characterId = companionCharacterId();
    if (!characterId) return {status:'waiting'};
    const scope = { ...state.scope }, epoch = state.epoch;
    state.companion.polling = true; refreshButtons();
    try {
      const result = await request('/v1/scene/companion-poll', 'POST', { scope, characterId, trigger });
      assertCompanionCurrent(scope, epoch, characterId, true);
      if (result?.status !== 'ready') return result || {status:'waiting'};
      if (typeof result.deliveryId !== 'string' || typeof result.body !== 'string' || result.characterId !== characterId) throw new Error('核心未返回有效主动消息候选');
      if (state.companion.uncertainDeliveries.has(result.deliveryId)) return {status:'unknown'};
      const existing = proactiveMarker(result.deliveryId, scope);
      if (existing?.extra?.xldbScene) return {status:'duplicate'};
      const claim = await request('/v1/scene/companion-claim', 'POST', { scope, characterId, deliveryId:result.deliveryId });
      assertCompanionCurrent(scope, epoch, characterId, true);
      if (!claim || claim.deliveryId !== result.deliveryId || claim.characterId !== characterId || typeof claim.claimToken !== 'string' || typeof claim.body !== 'string') throw new Error('核心未返回有效主动消息 claim');
      const hostMessageId = `xldb-proactive:${result.deliveryId}`;
      let message = existing;
      if (!message) {
        if (typeof helpers.createChatMessages !== 'function') {
          await request('/v1/scene/companion-receipt', 'POST', { scope, characterId, deliveryId:result.deliveryId, claimToken:claim.claimToken,
            outcome:{status:'failed',code:'host_api_unavailable'} });
          throw new Error('未找到 Tavern Helper 的 createChatMessages');
        }
        state.selfInserting = true;
        try {
          await helpers.createChatMessages([{role:'assistant',message:claim.body,extra:{xldbProactive:{deliveryId:result.deliveryId,scope:{...scope}}}}],{insert_before:'end',refresh:'affected'});
        } catch (error) {
          await recordCompanionUnknown(scope,characterId,result.deliveryId,claim.claimToken,'host_write_uncertain');
          setStatus('主动消息写入结果不确定；已停止自动重发，请在聊天中核对。');
          return {status:'unknown'};
        } finally { state.selfInserting = false; }
        message = proactiveMarker(result.deliveryId, scope);
      }
      if (!message || message.is_user || message.is_system || String(message.mes || '') !== claim.body) {
        await recordCompanionUnknown(scope,characterId,result.deliveryId,claim.claimToken,'host_message_unconfirmed');
        setStatus('未能确认主动消息的宿主写入结果；不会自动重发。');
        return {status:'unknown'};
      }
      try { assertCompanionCurrent(scope, epoch, characterId, true); }
      catch {
        await recordCompanionUnknown(scope,characterId,result.deliveryId,claim.claimToken,'host_scope_changed');
        setStatus('主动消息写入期间聊天状态变化；结果按未知处理且不会自动重发。');
        return {status:'unknown'};
      }
      let receipt;
      try {
        receipt = await request('/v1/scene/companion-receipt', 'POST', { scope, characterId, deliveryId:result.deliveryId, claimToken:claim.claimToken,
          outcome:{status:'sent',hostMessageId} });
      } catch (error) {
        state.companion.uncertainDeliveries.add(result.deliveryId);
        setStatus('主动消息已写入，但核心回执结果不确定；不会自动重发。');
        return {status:'unknown'};
      }
      assertCompanionCurrent(scope, epoch, characterId);
      await commitCompanionReceipt(receipt,message,scope,epoch);
      await readCompanionStatus();
      setStatus(receipt.processing?.status==='failed'
        ? '主动陪伴消息已发送；后台整理失败：'+(receipt.processing.error||'未知错误')+'。请点击同步更改重试整理，不会重发消息。'
        : '主动陪伴消息已发送并写入权威场景。');
      return {status:'sent',deliveryId:result.deliveryId};
    } finally { state.companion.polling = false; refreshButtons(); }
  }

  function scheduleCompanionEventPoll() {
    if (!state.enabled || state.interaction?.mode !== 'companion' || !companionControls()?.proactiveCompanionEnabled) return;
    if (companionHostBusy()) state.companion.pendingEvent = true;
    else void pollCompanion('event').catch(error => setStatus(`主动陪伴检查失败：${error.message}`));
  }

  async function refreshNativeIdentities(force = false) {
    const epoch = state.epoch;
    const freshMaterials = await readIdentityMaterials();
    const unchanged = JSON.stringify(freshMaterials) === JSON.stringify(state.native.materials);
    const materials = { ...freshMaterials, documents: [...freshMaterials.documents] };
    // User-confirmed identities are valid fallback sources, never chat knowledge.
    for (const character of state.scene.roster.filter(item => item.identitySource?.kind !== 'automatic')) materials.documents.push({
      id: `confirmed:${character.id}`, name: character.name, keys: character.aliases,
      text: `${character.name}\n${character.aliases.join('、')}\n${character.persona}`,
    });
    const body = nativeHost().chat.filter(message => !message.is_system && !message.is_hidden && !message.extra?.xldbCandidate && message.mes
      && (!message.extra?.xldbScene || sameScope(message.extra.xldbScene.scope, state.scope))).slice(-6).map(message => String(message.mes)).join('\n').slice(-20000);
    // Once the roster is established, ordinary chat text does not invalidate
    // identity material. A scene plan that finds an unknown required NPC can
    // force one refresh from onNativePrompt below.
    if (!force && unchanged && state.scene.roster.length) return { rosterChanged: false };
    // A linked book may also be embedded in the card. Keep every document for
    // provenance verification, but send identical index content only once.
    const indexed = new Set();
    const identityIndex = materials.documents.filter(item => {
      if (item.id === 'card') return false;
      const key = JSON.stringify([item.name, item.keys, item.text]);
      if (indexed.has(key)) return false;
      indexed.add(key); return true;
    });
    setStatus('正在从当前角色卡和关联世界书识别正文中的人物……');
    const plan = await request('/v1/scene/identity-plan', 'POST', { scope: state.scope, materials: {
      playerName: materials.playerName, card: materials.card, body,
      index: identityIndex.map(item => ({ id: item.id, name: item.name.slice(0, 200), keys: Array.isArray(item.keys) ? item.keys.filter(key => typeof key === 'string').slice(0, 16) : [], preview: item.text.slice(0, 160) })),
    } });
    assertBound();
    if (epoch !== state.epoch) throw new Error('识别期间聊天已切换');
    if (plan.missing?.length) throw new Error(`资料不足，请补充独立身份：${plan.missing.join('；')}`);
    const unknown = plan.characters?.some(character => !state.scene.roster.some(existing => [existing.name, ...existing.aliases].includes(character.name) || character.aliases?.some(alias => [existing.name, ...existing.aliases].includes(alias))));
    if (!unknown && state.scene.roster.length && unchanged) {
      state.native.identityBody = body;
      return { rosterChanged: false };
    }
    const selected = new Set((plan.characters || []).flatMap(character => character.documentIds));
    for (const character of state.scene.roster) for (const evidence of character.identitySource?.evidence || []) selected.add(evidence.sourceId);
    const result = await request('/v1/scene/identity-extract', 'POST', { scope: state.scope, expectedVersion:state.scene.version, materials: {
      playerName: materials.playerName, plan, documents: materials.documents.filter(item => selected.has(item.id)).map(({ id, text }) => ({ id, text })),
    } });
    assertBound();
    if (epoch !== state.epoch) throw new Error('识别期间聊天已切换');
    setSceneRoster(result.roster);
    await recordSceneReceipt(result);
    renderSceneControls();
    if (state.interaction?.mode === 'companion') await restoreCompanionState();
    if (result.missing?.length) throw new Error(`资料不足，请补充独立身份：${result.missing.join('；')}`);
    if (!state.scene.roster.length) throw new Error('当前角色卡和世界书没有足够身份资料，请补充独立身份');
    state.native.materials = freshMaterials;
    state.native.identityBody = body;
    return { rosterChanged: true };
  }

  function nativeEnvelope() {
    if (!state.native.automatic) return sceneEnvelope();
    const ids = state.scene.roster.map(item => item.id);
    if (!ids.length) throw new Error('独立身份尚未识别');
    const playerName = nativeHost().name1;
    return { targetId: ids[0], mode: 'scene', presentIds: ids, ...(typeof playerName === 'string' && playerName.trim() ? { playerName: playerName.trim() } : {}) };
  }

  function tagNativeMessage(message) {
    message.extra ||= {};
    if(message.extra.xldbCandidate)return;
    if (message.extra.xldbScene && !sameScope(message.extra.xldbScene.scope, state.scope)) throw new Error('消息已绑定其它 XLDB 范围');
    if (!message.extra.xldbScene) message.extra.xldbScene = { id: newId('native'), revision: 1, scope: { ...state.scope },
      acceptedAtMs: Date.now(), envelope: nativeEnvelope(), ...(state.native.automatic ? { automatic: true } : {}) };
  }

  function refreshCurrentNativeBinding(message) {
    const binding = message?.extra?.xldbScene;
    if (!binding || !sameScope(binding.scope, state.scope)) throw new Error('当前用户消息的 XLDB 绑定已变更');
    const envelope = nativeEnvelope();
    if (JSON.stringify(binding.envelope) === JSON.stringify(envelope)) return false;
    binding.envelope = envelope;
    binding.revision = (Number(binding.revision) || 1) + 1;
    return true;
  }

  async function enableNative(options = {}) {
    return withBusy(async () => {
      assertBound();
      if (typeof nativeHost().stopGeneration !== 'function' || !host.eventTypes?.CHAT_COMPLETION_SETTINGS_READY) throw new Error('当前宿主不支持原生聊天接入');
      if (nativeHost().mainApi !== 'openai') throw new Error('原生接入需要酒馆对话补全模式');
      state.native.automatic = state.interaction?.mode !== 'companion' && options.automatic !== false;
      if (state.native.automatic) {
        state.native.materials = null;
        await refreshNativeIdentities();
        for (const message of nativeHost().chat) {
          if (message.is_system || message.is_hidden || message.extra?.xldbCandidate || !String(message.mes || '').trim()) continue;
          if (message.extra?.xldbScene && !sameScope(message.extra.xldbScene.scope, state.scope)) continue;
          if (message.extra?.xldb && !sameScope(message.extra.xldb.scope,state.scope))continue;
          tagNativeMessage(message);
        }
        await saveNativeMetadata();
        await syncInternal();
      }
      if (!state.scene.enabled) throw new Error('资料不足，请补充独立身份后再继续');
      state.native.enabled = true;
      state.native.error = '';
      state.native.turn = null;
      setStatus(state.native.automatic ? '身份已从角色卡和世界书识别；知识仅按正文视角更新。原生聊天自动同步已启用。' : '使用已补充身份的原生聊天已启用。');
    });
  }

  async function saveNativeMetadata() {
    if (typeof nativeHost().saveChat === 'function') await nativeHost().saveChat();
  }

  async function onNativeSent(index) {
    if (!state.native.enabled || state.selfInserting) return;
    assertBound();
    const message = nativeHost().chat?.[index];
    if (!message?.is_user || message.is_system) return;
    return queueNative(async () => {
      if (state.native.automatic) await refreshNativeIdentities();
      tagNativeMessage(message);
      await saveNativeMetadata();
      await syncInternal();
    });
  }

  async function onNativePrompt(event) {
    if (!state.native.enabled || !state.native.active || event?.dryRun) return;
    // Clear before waiting: a failing/cancelled background job must not fall through to raw history.
    const chat = event?.chat;
    if (!Array.isArray(chat)) { nativeHost().stopGeneration(); throw new Error('原生提示词格式不支持'); }
    chat.splice(0, chat.length);
    const epoch = state.epoch;
    try {
      assertBound();
      if (!['', 'normal'].includes(state.native.generationType)) throw new Error('原生接入暂不支持续写、重生成或滑动；请编辑或删除后重新发送');
      await state.native.queue;
      if (state.native.error) throw new Error(state.native.error);
      await ensureInitializationFreshForGeneration();
      await syncInternal();
      assertBound();
      if (state.scene.needsReview.length) throw new Error('存在待复核的依赖消息，请先处理');
      const messages = sceneManagedMessages();
      const last = messages.at(-1);
      if (!last || last.role !== 'user') throw new Error('请先通过酒馆输入框发送一条新消息');
      let fingerprint = nativeFingerprint();
      let selectionVersion = state.scene.selectionVersion;
      let result;
      try {
        result = await request('/v1/scene/native-context', 'POST', { scope: state.scope, expectedVersion:state.scene.version, envelope: nativeEnvelope(), sourceId: last.id });
      } catch (error) {
        if (!state.native.automatic || error?.message !== 'XLDB：invalid_scene_unresolved') throw error;
        if (epoch !== state.epoch || !state.native.enabled || state.native.stopped || selectionVersion !== state.scene.selectionVersion || fingerprint !== nativeFingerprint()) throw new Error('生成期间聊天或角色范围已变更');
        const current = nativeHost().chat.filter(message => message?.extra?.xldbScene?.id === last.id && message.is_user && !message.is_system);
        if (current.length !== 1) throw new Error('生成期间聊天或角色范围已变更');
        const beforeRefresh = state.scene.selectionVersion;
        const refreshed = await refreshNativeIdentities(true);
        const expectedSelection = beforeRefresh + (refreshed.rosterChanged ? 1 : 0);
        if (epoch !== state.epoch || !state.native.enabled || state.native.stopped || state.scene.selectionVersion !== expectedSelection || fingerprint !== nativeFingerprint()) throw new Error('生成期间聊天或角色范围已变更');
        if (!refreshed.rosterChanged || !refreshCurrentNativeBinding(current[0])) throw error;
        await saveNativeMetadata();
        await syncInternal();
        assertBound();
        if (epoch !== state.epoch || !state.native.enabled || state.native.stopped || state.scene.selectionVersion !== expectedSelection || fingerprint !== nativeFingerprint()) throw new Error('生成期间聊天或角色范围已变更');
        if (state.scene.needsReview.length) throw new Error('存在待复核的依赖消息，请先处理');
        const retried = sceneManagedMessages().at(-1);
        if (!retried || retried.id !== last.id || retried.role !== 'user') throw new Error('生成期间聊天或角色范围已变更');
        selectionVersion = state.scene.selectionVersion;
        fingerprint = nativeFingerprint();
        if (epoch !== state.epoch || !state.native.enabled || state.native.stopped) throw new Error('生成期间聊天或角色范围已变更');
        result = await request('/v1/scene/native-context', 'POST', { scope: state.scope, expectedVersion:state.scene.version, envelope: nativeEnvelope(), sourceId: retried.id });
      }
      assertBound();
      if (epoch !== state.epoch || !state.native.enabled || state.native.stopped || selectionVersion !== state.scene.selectionVersion || fingerprint !== nativeFingerprint()) throw new Error('生成期间聊天或角色范围已变更');
      if (!Array.isArray(result.messages) || !result.messages.length || result.messages.some(item => !['system', 'user', 'assistant'].includes(item.role) || typeof item.content !== 'string')) throw new Error('核心未返回有效的受限上下文');
      chat.push(...result.messages);
      if(typeof result.contextTicket!=='string'||!Number.isSafeInteger(result.version))throw new Error('核心未返回生成版本票据');
      await recordSceneReceipt(result,state.scope,epoch);
      state.native.turn = { epoch, selectionVersion, contextTicket:result.contextTicket, version:result.version, scope: { ...state.scope }, fingerprint, automatic: Boolean(result.automatic), envelope: result.envelope, dependencies: result.dependencies, targetId: result.speakerId || state.scene.targetId, messages: result.messages.map(item => ({ ...item })) };
      setStatus(Array.isArray(result.retrievalModes) && result.retrievalModes.some(mode=>mode==='bm25-fallback'||mode==='hybrid-fallback')
        ? '部分记忆检索服务暂时不可用，本轮使用已完成的检索结果，等待完整回复。'
        : '受限记忆与情绪已交给酒馆前台模型，等待完整回复。');
    } catch (error) {
      state.native.turn = null;
      chat.splice(0, chat.length);
      nativeHost().stopGeneration();
      setStatus(`已停止本轮生成：${error.message}`);
      throw error;
    }
  }

  async function onNativeReceived(index) {
    if (!state.native.enabled || state.selfInserting || !state.native.turn) return;
    const turn = state.native.turn;
    state.native.turn = null;
    assertBound();
    if(turn.epoch!==state.epoch||!sameScope(turn.scope,state.scope))throw new Error('原生回复来源已变更，未提交');
    const message=nativeHost().chat?.[index];
    if(!message||message.is_user||message.is_system||!String(message.mes||'').trim())return;
    const candidateId=newId('native');
    message.extra||={};message.extra.xldbCandidate={id:candidateId,scope:{...turn.scope}};
    await saveNativeMetadata();
    const processor = nativeHost().streamingProcessor;
    if (state.native.stopped || (processor && (!processor.isFinished || processor.isStopped || processor.abortController?.signal?.aborted || processor.toolCalls?.length))) {
      setStatus('生成已中止或失败，半截回复未写入 XLDB。'); return;
    }
    assertBound();
    if (turn.epoch !== state.epoch || turn.selectionVersion!==state.scene.selectionVersion || !sameScope(turn.scope, state.scope) || turn.fingerprint !== nativeFingerprint()) throw new Error('原生回复来源已变更，未提交');
    const binding = { id: candidateId, revision: 1, scope: turn.scope, acceptedAtMs: Date.now(),
      envelope: turn.envelope, ...(turn.automatic ? { automatic: true } : { speakerId: turn.targetId }), dependencies: turn.dependencies };
    const acceptedMessage={...binding,role:'assistant',text:String(message.mes)};
    void queueNative(async () => {
      if(turn.selectionVersion!==state.scene.selectionVersion||turn.fingerprint!==nativeFingerprint())throw new Error('原生回复来源已变更，未提交');
      const receipt=await request('/v1/scene/native-accept','POST',{scope:turn.scope,contextTicket:turn.contextTicket,message:acceptedMessage});
      assertHostScope(turn.scope,turn.epoch,'接受回复期间聊天已切换');
      if(String(message.mes)!==acceptedMessage.text)throw new Error('回复已在接受期间编辑，请先恢复权威正文');
      message.extra.xldbScene=binding;delete message.extra.xldbCandidate;
      const swipe=message.swipe_info?.[message.swipe_id];if(swipe)swipe.extra={...message.extra};
      await recordSceneReceipt(receipt,turn.scope,turn.epoch);
      if(receipt.status==='failed')throw new Error(`正文已接受，后台整理失败：${receipt.error}`);
      renderSceneMaterials(await inspectInternal());
      setStatus('原生回复已同步，记忆与情绪已更新。');
      scheduleCompanionEventPoll();
    });
    setStatus('正文已完成，后台正在整理记忆与情绪。');
  }

  function onNativeStart(type, _options, dryRun) {
    if (!state.native.enabled || dryRun) return;
    if (type === 'quiet') return;
    state.native.active = true;
    state.native.stopped = false;
    state.native.generationType = type || 'normal';
    state.native.turn = null;
    if (typeof host.eventSource.makeLast === 'function') host.eventSource.makeLast(host.eventTypes.CHAT_COMPLETION_PROMPT_READY, onNativePrompt);
    if (typeof host.eventSource.makeLast === 'function') host.eventSource.makeLast(host.eventTypes.CHAT_COMPLETION_SETTINGS_READY, onNativeSettings);
    if (typeof host.eventSource.makeLast === 'function') host.eventSource.makeLast(host.eventTypes.GENERATE_AFTER_DATA, onNativeData);
  }

  function onNativeSettings(data) {
    if (!state.native.enabled || !state.native.active) return;
    const turn = state.native.turn;
    if (!turn || state.native.stopped || turn.epoch !== state.epoch || turn.selectionVersion !== state.scene.selectionVersion || turn.fingerprint !== nativeFingerprint()) {
      data.messages = [];
      nativeHost().stopGeneration();
      return;
    }
    // This is the host's final awaited hook, immediately before JSON.stringify/fetch.
    data.messages = turn.messages.map(item => ({ ...item }));
    delete data.tools;
    delete data.tool_choice;
  }

  function onNativeStopped() { state.native.stopped = true; }
  // Streaming hides its stop button before it emits the completed message.
  function onNativeEnded() {
    state.native.active = false;
    if (state.companion.pendingEvent && !state.busy) { state.companion.pendingEvent=false;void pollCompanion('event').catch(error=>setStatus(`主动陪伴检查失败：${error.message}`)); }
  }

  function onNativeData(data, dryRun) {
    if (dryRun || !state.native.enabled || !state.native.active) return;
    if (nativeHost().mainApi === 'openai' && state.native.turn && !state.native.stopped) {
      data.prompt = state.native.turn.messages.map(item => ({ ...item }));
      return;
    }
    data.prompt = '';
    state.native.stopped = true;
    nativeHost().stopGeneration();
    setStatus('已停止生成：原生接入需要酒馆对话补全模式。');
  }

  function subscribeEvents() {
    const source = host.eventSource;
    const types = host.eventTypes || {};
    if (!source || typeof source.on !== 'function') return;
    const subscriptions = [
      [types.CHAT_CHANGED, disableForChatChange],
      [types.MESSAGE_EDITED, onManagedChange],
      [types.MESSAGE_DELETED, onManagedChange],
      [types.MESSAGE_SWIPED, onManagedChange],
      [types.MESSAGE_SENT, onNativeSent],
      [types.MESSAGE_RECEIVED, onNativeReceived],
      [types.GENERATION_STARTED, onNativeStart],
      [types.CHAT_COMPLETION_PROMPT_READY, onNativePrompt],
      [types.CHAT_COMPLETION_SETTINGS_READY, onNativeSettings],
      [types.GENERATION_STOPPED, onNativeStopped],
      [types.GENERATION_ENDED, onNativeEnded],
      [types.GENERATE_AFTER_DATA, onNativeData],
    ].filter(([event]) => event !== undefined && event !== null);
    for (const [event, handler] of subscriptions) {
      source.on(event, handler);
      state.listeners.push([source, event, handler]);
    }
  }

  function destroy() {
    clearCompanionTimer();
    if(state.panel?.progressTimer)globalThis.clearInterval(state.panel.progressTimer);
    if(state.panel?.clockTimer)globalThis.clearInterval(state.panel.clockTimer);
    if(state.panel?.dashboardTimer)globalThis.clearInterval(state.panel.dashboardTimer);
    state.panel?.variableRoot?.remove();state.panel?.dashboardStyle?.remove();
    for (const [source, event, handler] of state.listeners.splice(0)) {
      if (source && typeof source.removeListener === 'function') source.removeListener(event, handler);
    }
    if (state.panel && state.panel.root && typeof state.panel.root.remove === 'function') state.panel.root.remove();
    if (state.panel && state.panel.toggle && typeof state.panel.toggle.remove === 'function') state.panel.toggle.remove();
    state.panel = null;
    state.candidate = null;
    state.token = '';
  }

  function element(tag, text) {
    const node = viewDocument.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, handler) {
    const node = element('button', label);
    node.type = 'button';
    node.addEventListener('click', async () => {
      try { await handler(); } catch (error) { setStatus(error && error.message ? error.message : '操作失败'); }
    });
    return node;
  }

  function field(label, type = 'text') {
    const wrap = element('label');
    const caption = element('span', label);
    const input = element('input');
    input.type = type;
    wrap.append(caption, input);
    return { wrap, input };
  }

  function sceneRosterRow(character = {}) {
    const row = element('fieldset');
    row._npcId = String(character.id || newId('npc'));
    row.append(element('legend', `NPC ${row._npcId}`));
    const id = field('稳定 ID'); id.input.value = row._npcId; id.input.readOnly = true;
    const name = field('姓名'); name.input.value = String(character.name || '');
    const aliases = field('别名（用逗号分隔）'); aliases.input.value = Array.isArray(character.aliases) ? character.aliases.join(', ') : '';
    const persona = element('textarea'); persona.placeholder = '该 NPC 的独立设定'; persona.value = String(character.persona || '');
    const emotion = normalizeSceneEmotion(character.emotion);
    const emotionDetails = element('details');
    emotionDetails.append(element('summary', '情绪参数（OpenHer）'));
    const emotionInputs = { driveBaseline: {} };
    emotionInputs.randomizedBaseline = element('input'); emotionInputs.randomizedBaseline.type = 'checkbox'; emotionInputs.randomizedBaseline.checked = emotion.randomizedBaseline;
    const randomizedBaseline = element('label', '按角色身份稳定生成初始驱动力'); randomizedBaseline.append(emotionInputs.randomizedBaseline);
    emotionDetails.append(randomizedBaseline, element('p', '开启时由核心按角色身份生成可重现的初始差异；关闭时使用下方五项手动基线。随机种子无需填写。'));
    const emotionNumber = (label, value, min, max, step) => {
      const item = field(label, 'number');
      item.input.value = String(value);
      item.input.min = String(min); item.input.max = String(max); item.input.step = String(step);
      emotionDetails.append(item.wrap);
      return item.input;
    };
    emotionInputs.driveBaseline.connection = emotionNumber('关系驱动力基线（0–1）', emotion.driveBaseline.connection, 0, 1, 0.01);
    emotionInputs.driveBaseline.novelty = emotionNumber('新颖驱动力基线（0–1）', emotion.driveBaseline.novelty, 0, 1, 0.01);
    emotionInputs.driveBaseline.expression = emotionNumber('表达驱动力基线（0–1）', emotion.driveBaseline.expression, 0, 1, 0.01);
    emotionInputs.driveBaseline.safety = emotionNumber('安全驱动力基线（0–1）', emotion.driveBaseline.safety, 0, 1, 0.01);
    emotionInputs.driveBaseline.play = emotionNumber('玩乐驱动力基线（0–1）', emotion.driveBaseline.play, 0, 1, 0.01);
    emotionInputs.frustrationDecayPerHour = emotionNumber('受挫衰减（每小时，0–2）', emotion.frustrationDecayPerHour, 0, 2, 0.01);
    emotionInputs.connectionHungerPerHour = emotionNumber('关系需求增长（每小时，0–1）', emotion.connectionHungerPerHour, 0, 1, 0.01);
    emotionInputs.noveltyHungerPerHour = emotionNumber('新颖需求增长（每小时，0–1）', emotion.noveltyHungerPerHour, 0, 1, 0.01);
    emotionInputs.eventRetainedFraction = emotionNumber('事件保留比例（0–1）', emotion.eventRetainedFraction, 0, 1, 0.01);
    emotionInputs.stableRelationRate = emotionNumber('稳定关系变化率（0–0.1）', emotion.stableRelationRate, 0, 0.1, 0.01);
    emotionInputs.hebbianLearningRate = emotionNumber('神经连接学习率（Hebbian，0–0.1）', emotion.hebbianLearningRate, 0, 0.1, 0.001);
    emotionInputs.phaseThreshold = emotionNumber('累积受挫触发变化的阈值（0.1–20）', emotion.phaseThreshold, 0.1, 20, 0.1);
    emotionInputs.temperatureCoefficient = emotionNumber('情绪波动温度系数（0.001–1）', emotion.temperatureCoefficient, 0.001, 1, 0.001);
    emotionInputs.temperatureFloor = emotionNumber('情绪波动最低温度（0–0.5）', emotion.temperatureFloor, 0, 0.5, 0.001);
    const remove = button('移除 NPC', () => { row.remove(); });
    row.append(id.wrap, name.wrap, aliases.wrap, persona, emotionDetails, remove);
    row._xldbNpc = { id: id.input, name: name.input, aliases: aliases.input, persona, emotion: emotionInputs };
    return row;
  }

  function sceneRosterValues() {
    if (!state.panel || !state.panel.sceneRosterEditor) return [];
    return Array.from(state.panel.sceneRosterEditor.children).filter(row => row && row._xldbNpc).map(row => ({
      id: row._xldbNpc.id.value,
      name: row._xldbNpc.name.value,
      aliases: String(row._xldbNpc.aliases.value || '').split(',').map(value => value.trim()).filter(Boolean),
      persona: row._xldbNpc.persona.value,
      emotion: {
        driveBaseline: Object.fromEntries(Object.entries(row._xldbNpc.emotion.driveBaseline).map(([key, input]) => [key, Number(input.value)])),
        randomizedBaseline: row._xldbNpc.emotion.randomizedBaseline.checked,
        frustrationDecayPerHour: Number(row._xldbNpc.emotion.frustrationDecayPerHour.value),
        connectionHungerPerHour: Number(row._xldbNpc.emotion.connectionHungerPerHour.value),
        noveltyHungerPerHour: Number(row._xldbNpc.emotion.noveltyHungerPerHour.value),
        eventRetainedFraction: Number(row._xldbNpc.emotion.eventRetainedFraction.value),
        stableRelationRate: Number(row._xldbNpc.emotion.stableRelationRate.value),
        hebbianLearningRate: Number(row._xldbNpc.emotion.hebbianLearningRate.value),
        phaseThreshold: Number(row._xldbNpc.emotion.phaseThreshold.value),
        temperatureCoefficient: Number(row._xldbNpc.emotion.temperatureCoefficient.value),
        temperatureFloor: Number(row._xldbNpc.emotion.temperatureFloor.value),
      },
    }));
  }

  function renderSceneControls() {
    if (!state.panel) return;
    const panel = state.panel;
    panel.legacyPersonaSection.hidden = state.scene.enabled;
    const editor = panel.sceneRosterEditor;
    while (editor.firstChild) editor.removeChild(editor.firstChild);
    for (const character of state.scene.roster) editor.append(sceneRosterRow(character));
    const controls = panel.sceneControls;
    panel.sceneSelectionInputs = [];
    while (controls.firstChild) controls.removeChild(controls.firstChild);
    if (!state.scene.enabled) {
      controls.append(element('p', '启用原生聊天会自动读取身份；资料不足时可在上方补充。'));
      renderNpcResources();
      return;
    }
    const target = element('select');
    for (const character of state.scene.roster) {
      const option = element('option', character.name); option.value = character.id; option.selected = character.id === state.scene.targetId; target.append(option);
    }
    target.addEventListener('change', () => {
      if (state.busy) return;
      state.scene.targetId = target.value;
      persistScenePreferences();
      invalidateSceneCandidate();
      renderSceneControls();
      if (state.interaction?.mode === 'companion') { state.companion.status=null; clearCompanionTimer(); renderCompanionPanel(); void restoreCompanionState(); }
    });
    const mode = element('select');
    for (const value of ['scene', 'direct']) { const option = element('option', value === 'scene' ? '场景' : '直接'); option.value = value; option.selected = value === state.scene.mode; mode.append(option); }
    mode.addEventListener('change', () => {
      if (state.busy) return;
      state.scene.mode = mode.value === 'direct' ? 'direct' : 'scene';
      persistScenePreferences();
      invalidateSceneCandidate();
    });
    const presence = element('div');
    for (const character of state.scene.roster) {
      const item = element('label');
      const check = element('input'); check.type = 'checkbox'; check.checked = state.scene.presentIds.includes(character.id);
      check.addEventListener('change', () => {
        if (state.busy) return;
        const selected = new Set(state.scene.presentIds);
        if (check.checked) selected.add(character.id); else selected.delete(character.id);
        state.scene.presentIds = [...selected];
        persistScenePreferences();
        invalidateSceneCandidate();
      });
      panel.sceneSelectionInputs.push(check);
      item.append(check, element('span', character.name)); presence.append(item);
    }
    panel.sceneSelectionInputs.push(target, mode);
    controls.append(element('label', '目标 NPC'), target, element('label', '回应方式'), mode, element('p', '在场 NPC'), presence);
    renderNpcResources();
  }

  function renderSceneMaterials(data) {
    if (!state.panel) return;
    const area = state.panel.inspectArea;
    while (area.firstChild) area.removeChild(area.firstChild);
    if (data.world) {
      const world = data.world.state;
      area.append(element('h5', '世界时间与账本（管理视图）'), element('p', new Date(world.timeMs).toISOString()));
      const ownerName = id => id === 'player' ? '玩家' : state.scene.roster.find(actor => actor.id === id)?.name || id;
      for (const row of world.balances) area.append(element('p', `${ownerName(row.ownerId)}：${row.value} ${row.unit}`));
      for (const row of world.inventory) area.append(element('p', `${ownerName(row.ownerId)}：${row.item} × ${row.count}`));
      for (const receipt of data.world.receipts) area.append(element('p', `${receipt.applied ? '已生效' : '未推进'}：${receipt.quote}`));
      for (const issue of data.world.issues) area.append(element('p', `账本待处理：${issue.code}`));
    }
    const unresolved = Array.isArray(data && data.unresolved) ? data.unresolved : [];
    if (unresolved.length) area.append(element('p', `需要补充：${unresolved.join('；')}`));
    const observations = Array.isArray(data && data.observations) ? data.observations : [];
    if (observations.length) {
      area.append(element('h5', '本轮场景处理材料'));
      for (const observation of observations) area.append(element('p', String(observation.quote || observation.text || observation.summary || '（无可显示内容）')));
    }
    const views = Array.isArray(data && data.views) ? data.views : [];
    if (views.length) {
      area.append(element('h5', 'NPC 可见状态'));
      for (const view of views) {
        const name = String(view.name || view.characterName || view.characterId || 'NPC');
        const facts = Array.isArray(view.memories) ? view.memories.map(memory => memory.gist || memory.detail || memory.anchor).filter(Boolean).join(' · ') : '';
        area.append(element('p', `${name}${facts ? `：${facts}` : '：当前无可显示记忆。'}`));
        for (const memory of view.memories || []) {
          if(memory.source?.reference) { area.append(element('p',`[迁入参考资料] ${memory.detail||memory.gist||''}`));continue; }
          const row=element('div');
          const access=element('select');
          for (const level of ACCESS_LEVELS) { const option=element('option',level);option.value=level;option.selected=memory.access===level;access.append(option); }
          const kind=memory.kind==='episode'?'情景与感受':memory.kind==='fact'?'事实记录':'旧版记忆';
          row.append(element('span',`[${kind}] ${[memory.detail || memory.gist || memory.anchor, memory.feeling].filter(Boolean).join(' · ') || '无可见文本'}`),access,button('更新访问',()=>setAccess(memory.id,access.value,view.characterId)));
          area.append(row);
        }
        for(const preference of view.preferences||[]) {
          const row=element('div'),enabled=element('input'),text=element('input');
          enabled.type='checkbox';enabled.checked=Boolean(preference.enabled);text.value=String(preference.text||'');
          row.append(element('span',preference.category),enabled,text,button('保存偏好',()=>setPreference(preference.id,enabled.checked,text.value,view.characterId)));area.append(row);
        }
        area.append(element('pre',JSON.stringify({emotion:view.emotion},null,2)));
      }
    }
    const review = Array.isArray(data && data.needsReview) ? data.needsReview : state.scene.needsReview;
    if (review.length) {
      area.append(element('p', '以下记录因来源变更已暂停使用。核对正文后可按当前来源重新确认；来源已删除时请编辑或删除相关正文。'));
      for(const id of review)area.append(button(`按当前来源重新确认：${id}`,()=>reconfirmSceneSource(id)));
    }
  }

  function subjectIdOf(subject) {
    return typeof subject === 'string' ? subject : String(subject?.subjectId || '');
  }

  function categoryControls(title, selected) {
    const wrap = element('fieldset'); wrap.append(element('legend', title)); const checks = [];
    for (const category of PROFILE_CATEGORIES) {
      const check = element('input'); check.type = 'checkbox'; check.checked = selected.includes(category); check.setAttribute('aria-label', `${title}：${category}`);
      const label = element('label', PROFILE_CATEGORY_LABELS[category]); label.append(check); wrap.append(label); checks.push({category,check});
    }
    return {wrap,values:()=>checks.filter(item=>item.check.checked).map(item=>item.category)};
  }

  function booleanControl(labelText, value) {
    const check = element('input'); check.type = 'checkbox'; check.checked = Boolean(value); check.setAttribute('aria-label', labelText);
    const label = element('label', labelText); label.append(check); return {label,check};
  }

  function localDateTimeValue(value) {
    if (!Number.isFinite(value)) return '';
    const date = new Date(value - new Date(value).getTimezoneOffset() * 60000);
    return date.toISOString().slice(0,16);
  }

  function renderCompanionPanel() {
    const panel = state.panel;
    if (!panel?.companionProfileArea || !panel?.companionContactArea) return;
    const profileArea = panel.companionProfileArea, contactArea = panel.companionContactArea;
    clearElement(profileArea); clearElement(contactArea);
    if (state.interaction?.mode !== 'companion') {
      profileArea.append(element('p','画像和主动陪伴只在伴侣模式运行。')); return;
    }
    const profile = state.companion.profile, statusBundle = state.companion.status, controls = companionControls();
    const subjectId = subjectIdOf(profile?.subject || statusBundle?.subject);
    if (subjectId && !panel.companionSubject.value) panel.companionSubject.value = subjectId;
    if (!controls) {
      profileArea.append(element('p','尚未绑定稳定的真实用户主体。请输入用户 ID；角色名、昵称和别名不会自动合并为同一人。'));
      contactArea.append(element('p','绑定主体后才能配置联系时段和主动陪伴。'));
      return;
    }
    profileArea.append(element('p',`主体：${subjectId} · 控制版本 ${controls.revision}`));
    const learning=booleanControl('允许从已接受用户正文学习画像',controls.profileLearningEnabled);
    const apply=booleanControl('允许画像改善普通回复',controls.personalizationEnabled);
    const proactive=booleanControl('允许主动陪伴发送',controls.proactiveCompanionEnabled);
    const wake=booleanControl('允许每 60 秒定时检查',controls.scheduledWakeEnabled);
    const learningCategories=categoryControls('学习分类',controls.learningCategories||[]);
    const readCategories=categoryControls('用户查看分类',controls.readCategories||[]);
    const strategyCategories=categoryControls('普通回复策略分类',controls.strategyCategories||[]);
    const proactiveCategories=categoryControls('主动陪伴分类',controls.proactiveCategories||[]);
    profileArea.append(learning.label,apply.label,proactive.label,wake.label,learningCategories.wrap,readCategories.wrap,strategyCategories.wrap,proactiveCategories.wrap,
      button('保存画像与主动陪伴控制',()=>saveProfileControls({
        profileLearningEnabled:learning.check.checked,personalizationEnabled:apply.check.checked,
        proactiveCompanionEnabled:proactive.check.checked,scheduledWakeEnabled:wake.check.checked,
        learningCategories:learningCategories.values(),readCategories:readCategories.values(),strategyCategories:strategyCategories.values(),proactiveCategories:proactiveCategories.values(),
      },controls.revision)));
    for (const entry of profile?.entries || []) {
      const row = element('fieldset'); row.append(element('legend',`${PROFILE_CATEGORY_LABELS[entry.category] || entry.category} · ${entry.id}`));
      row.append(element('p',`${entry.claim}\n归因：${entry.attribution} · 依据：${entry.basis} · 状态：${entry.status}${entry.corrected?' · 已纠正':''}`));
      const correction = field('纠正后的描述'); correction.input.value = String(entry.claim || ''); correction.input.setAttribute('aria-label',`纠正画像：${entry.id}`);
      const deleteArea = element('span');
      row.append(correction.wrap,button('保存画像纠正',()=>correctProfileEntry(entry.id,correction.input.value)),button('准备删除画像条目',()=>{
        clearElement(deleteArea);deleteArea.append(element('span','删除后不会再用于任何分类。'),button('确认删除画像条目',()=>deleteProfileEntry(entry.id)));
      }),deleteArea);profileArea.append(row);
    }

    if (!statusBundle) { contactArea.append(element('p','读取伴侣状态后可配置联系时段。')); return; }
    const contact=statusBundle.contact,activity=statusBundle.status.activity;
    contactArea.append(element('p',`当前状态：${statusBundle.status.state} · 原因：${statusBundle.status.reason || '无'} · 未回复计数：${activity.unansweredCount}`));
    const recoveryContext={scope:{...state.scope},epoch:state.epoch,characterId:companionCharacterId()};
    for(const delivery of statusBundle.status.deliveries||[]) {
      if(delivery?.status!=='unknown'||typeof delivery.deliveryId!=='string')continue;
      const deliveryId=delivery.deliveryId,marker=proactiveMarker(deliveryId,recoveryContext.scope),row=element('fieldset');
      row.append(element('legend',`发送结果未知：${deliveryId}`));
      let hostIdInput=null;
      if(marker)row.append(element('p','当前聊天已找到该主动消息 marker，可直接关联现有消息，不会再发送一条。'));
      else {
        const hostId=field('已实际发送的宿主 assistant 消息标识');
        hostId.input.setAttribute('aria-label',`宿主消息标识：${deliveryId}`);hostIdInput=hostId.input;
        row.append(element('p','当前聊天没有该 delivery marker。只有确认现有 assistant 消息确为本次发送时，才填写它的宿主消息标识。'),hostId.wrap);
      }
      const confirmation=element('span');
      row.append(button(`标记为实际已发送：${deliveryId}`,()=>reconcileCompanionUnknown(deliveryId,'sent',recoveryContext,hostIdInput?.value||'')),
        button(`准备确认未发送：${deliveryId}`,()=>{
          clearElement(confirmation);
          confirmation.append(element('span','确认后旧候选不会重发，后续新的主动机会可以继续检查。'),
            button(`确认未发送且不重发：${deliveryId}`,()=>reconcileCompanionUnknown(deliveryId,'failed',recoveryContext)));
        }),confirmation);
      contactArea.append(row);
    }
    const timeZone=field('IANA 时区');timeZone.input.value=String(contact.timeZone||'');timeZone.input.setAttribute('aria-label','伴侣联系时区');
    const minimum=field('最短主动联系间隔（分钟）','number');minimum.input.value=String(contact.minimumIntervalMs/60000);minimum.input.min='0';minimum.input.setAttribute('aria-label','最短主动联系间隔（分钟）');
    const unanswered=field('连续未回复上限','number');unanswered.input.value=String(contact.maxUnanswered);unanswered.input.min='0';unanswered.input.setAttribute('aria-label','连续未回复上限');
    const windowsArea=element('div'),windowRows=[];
    const addWindow=initial=>{
      const row=element('fieldset'),days=[];
      row.append(element('legend','可联系时段'));
      for(const [day,labelText] of ['日','一','二','三','四','五','六'].entries()){
        const check=element('input');check.type='checkbox';check.checked=(initial?.days||[]).includes(day);check.setAttribute('aria-label',`星期${labelText}`);
        const label=element('label',`周${labelText}`);label.append(check);row.append(label);days.push({day,check});
      }
      const start=field('开始时间','time'),end=field('结束时间','time');start.input.value=initial?.start||'09:00';end.input.value=initial?.end||'21:00';
      const record={row,days,start:start.input,end:end.input};windowRows.push(record);
      row.append(start.wrap,end.wrap,button('移除此时段',()=>{row.remove();windowRows.splice(windowRows.indexOf(record),1);}));windowsArea.append(row);
    };
    for(const window of contact.windows||[])addWindow(window);
    const busy=field('忙碌至（本机时间，留空取消）','datetime-local');busy.input.value=localDateTimeValue(activity.busyUntilMs);busy.input.setAttribute('aria-label','忙碌至');
    contactArea.append(timeZone.wrap,windowsArea,button('添加可联系时段',()=>addWindow()),minimum.wrap,unanswered.wrap,
      button('保存联系设置',()=>saveContactSettings({timeZone:timeZone.input.value.trim(),windows:windowRows.map(row=>({days:row.days.filter(item=>item.check.checked).map(item=>item.day),start:row.start.value,end:row.end.value})),
        minimumIntervalMs:Math.round(Number(minimum.input.value)*60000),maxUnanswered:Number(unanswered.input.value)},contact.revision)),busy.wrap,
      button('保存忙碌状态',()=>saveCompanionBusy(busy.input.value?new Date(busy.input.value).getTime():null,activity.revision)));
  }

  function buildCompanionPanel(root) {
    const section=element('details');section.append(element('summary','伴侣画像与主动陪伴'));
    const subject=field('稳定真实用户 ID');subject.input.setAttribute('aria-label','稳定真实用户 ID');
    const profileArea=element('div'),contactArea=element('div');
    section.append(element('p','四项授权默认分别关闭。绑定只接受用户明确输入的稳定 ID，不会因昵称、角色名或别名相似而合并。'),subject.wrap,
      button('绑定真实用户主体',()=>bindCompanionSubject(subject.input.value)),button('查看用户画像',()=>withBusy(readCompanionProfile)),button('读取伴侣状态',()=>withBusy(readCompanionStatus)),
      profileArea,contactArea,button('立即检查主动陪伴',()=>pollCompanion('event')));
    root.append(section);Object.assign(state.panel,{companionSubject:subject.input,companionProfileArea:profileArea,companionContactArea:contactArea});renderCompanionPanel();
  }

  function buildPanel() {
    if (!viewDocument || !viewDocument.body || state.panel) return;
    const root = element('section');
    root.id = 'xldb-tavern-mvp';
    root.className = 'xldb-tavern-mvp';
    Object.assign(root.style, { position: 'fixed', right: '12px', bottom: '48px', zIndex: '2147483647', width: 'min(380px, calc(100vw - 24px))', maxHeight: 'calc(100vh - 84px)', overflowY: 'auto', background: '#1f1f1f', color: '#f5f5f5', padding: '12px', border: '1px solid #777', borderRadius: '8px', boxShadow: '0 4px 18px #0008' });
    root.hidden = true;
    const toggle = button('XLDB', () => setPanelOpen(root.hidden));
    toggle.id = 'xldb-tavern-mvp-toggle';
    Object.assign(toggle.style, { position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647' });
    const title = element('h3', 'XLDB · 世界与角色');
    const closeButton = button('收起', () => setPanelOpen(false));
    const status = element('p', '默认禁用。填写令牌后明确绑定当前单角色聊天。');
    const token = field('XLDB 访问令牌', 'password');
    token.input.autocomplete = 'off';
    token.input.addEventListener('input', () => { state.token = token.input.value; });
    const world = field('世界 ID');
    world.input.value = safeStorageGet('xldb.tavern.world', 'default');
    world.input.addEventListener('change', () => safeStorageSet('xldb.tavern.world', world.input.value));
    const bindButton = button('绑定当前聊天', () => bind(world.input.value));
    const recoverButton=button('使用核心当前正文（覆盖受管改动）',()=>recoverScene(world.input.value));
    const disableButton = button('禁用本聊天', disable);
    const syncButton = button('同步更改', sync);
    const inspectButton = button('查看当前状态', inspect);
    const nativeButton = button('启用原生聊天', enableNative);
    const interactionSection=element('section');
    interactionSection.append(element('h4','模式与时钟'));
    const interactionMode=element('select');interactionMode.setAttribute('aria-label','对话模式');
    for(const [value,label] of [['roleplay','跑团／角色扮演'],['companion','伴侣']]) {const option=element('option',label);option.value=value;interactionMode.append(option);}
    const timeZone=field('显示时区（留空跟随系统，如 Asia/Shanghai）');
    const directorInput=element('input');directorInput.type='checkbox';
    const directorLabel=element('label','启用导演');directorLabel.append(directorInput);
    directorInput.addEventListener('change',()=>setDirectorEnabled(directorInput.checked).catch(error=>setStatus(error.message)));
    const directorStatus=element('p'),clockText=element('p');
    interactionSection.append(interactionMode,button('切换模式',()=>switchMode(interactionMode.value)),timeZone.wrap,button('保存时区',()=>setTimeZone(timeZone.input.value)),directorLabel,directorStatus,clockText);
    const lifecycleSection = element('details'); lifecycleSection.append(element('summary', '保存点、撤销与分支'));
    const checkpointName = field('保存点名称'); checkpointName.input.value = '手动保存点';
    const checkpointSelect = element('select'); checkpointSelect.setAttribute('aria-label', '选择保存点');
    const branchName = field('分支名称'); branchName.input.value = 'main';
    lifecycleSection.append(element('p', '撤销或恢复会同步恢复当前分支的正文、记忆、情绪和账本。切换分支会移除聊天中的其它分支受管正文；分支数据保留在 XLDB，切回时重建。'), checkpointName.wrap,
      button('建立保存点', () => sceneCheckpoint(checkpointName.input.value)),
      button('读取保存点列表', () => withBusy(async () => { assertBound(); const rows = await request('/v1/scene/checkpoints', 'POST', { scope: state.scope }); while (checkpointSelect.firstChild) checkpointSelect.removeChild(checkpointSelect.firstChild); for (const row of rows) { const option = element('option', `${row.createdAt} · ${row.reason}`); option.value = row.id; checkpointSelect.append(option); } })), checkpointSelect,
      button('预览恢复所选保存点', () => { if (!checkpointSelect.value) throw new Error('请先选择保存点'); return previewLifecycle('restore', checkpointSelect.value); }),
      button('预览撤销最近操作', () => previewLifecycle('undo')), branchName.wrap,
      button('从当前状态创建分支', () => switchSceneBranch(branchName.input.value, true)), button('切换已有分支', () => switchSceneBranch(branchName.input.value)));
    const worldSection = element('details');
    worldSection.append(element('summary', '世界时间与账本'));
    const worldMode = element('select');
    for (const [value, label] of [['story', '剧情时间'], ['companion', '现实陪伴时间']]) { const option = element('option', label); option.value = value; worldMode.append(option); }
    worldMode.value = 'story';worldMode.disabled=true;
    const worldStart = field('初始时间（ISO，含时区）'); worldStart.input.value = new Date().toISOString();
    const playerName = field('玩家姓名');
    const publicTime = element('input'); publicTime.type = 'checkbox'; publicTime.checked = true;
    const timeLabel = element('label', '所有角色可知当前时间'); timeLabel.append(publicTime);
    const ledgerRows = element('div'); const ledgerEntries = [];
    const resetWorldForm = () => {
      ledgerEntries.splice(0); while (ledgerRows.firstChild) ledgerRows.removeChild(ledgerRows.firstChild);
      worldMode.value = state.interaction?.mode==='companion'?'companion':'story'; worldStart.input.value = new Date().toISOString(); playerName.input.value = ''; publicTime.checked = true;
    };
    const addLedgerRow = (kind, initial = {}) => {
      const row = element('div'); const owner = element('select');
      for (const actor of [{ id: 'player', name: '玩家' }, ...state.scene.roster]) { const option = element('option', actor.name); option.value = actor.id; option.selected = actor.id === initial.ownerId; owner.append(option); }
      owner.value = initial.ownerId || 'player';
      const name = field(kind === 'balance' ? '货币单位' : '物品名称'); name.input.value = initial.unit || initial.item || '';
      const amount = field(kind === 'balance' ? '初始余额（两位小数）' : '初始数量'); amount.input.value = String(initial.value ?? initial.count ?? (kind === 'balance' ? '0.00' : 0));
      const readers = element('div'); const checks = [];
      for (const actor of [{ id: 'player', name: '玩家' }, ...state.scene.roster]) { const label = element('label', actor.name); const check = element('input'); check.type = 'checkbox'; check.checked = (initial.readerIds || ['player']).includes(actor.id); label.append(check); readers.append(label); checks.push({ id: actor.id, check }); }
      const entry = { kind, row, owner, name, amount, checks }; ledgerEntries.push(entry);
      row.append(owner, name.wrap, amount.wrap, element('p', '可以知道这项完整余额或库存的角色'), readers, button('移除此项', () => { row.remove(); ledgerEntries.splice(ledgerEntries.indexOf(entry), 1); })); ledgerRows.append(row);
    };
    const loadWorld = button('读取世界设置', () => withBusy(async () => {
      assertBound(); const epoch = state.epoch; const data = await inspectInternal();
      if (state.epoch !== epoch) throw new Error('聊天已切换，请重新读取世界设置');
      assertBound(); const settings = data.worldSettings;
      if (!settings) { setStatus('此聊天尚未启用世界时钟与账本。'); return; }
      worldMode.value = settings.mode; worldStart.input.value = new Date(settings.startTimeMs).toISOString(); playerName.input.value = settings.playerName; publicTime.checked = settings.publicTime;
      ledgerEntries.splice(0); while (ledgerRows.firstChild) ledgerRows.removeChild(ledgerRows.firstChild);
      for (const row of settings.balances) addLedgerRow('balance', row);
      for (const row of settings.inventory) addLedgerRow('inventory', row);
    }));
    const saveWorld = button('保存并重算世界状态', () => withBusy(async () => {
      assertBound(); const epoch = state.epoch; const settings = { mode: worldMode.value, startTimeMs: Date.parse(worldStart.input.value), playerName: playerName.input.value.trim(), publicTime: publicTime.checked, balances: [], inventory: [] };
      for (const entry of ledgerEntries) {
        const common = { ownerId: entry.owner.value, readerIds: entry.checks.filter(item => item.check.checked).map(item => item.id) };
        if (entry.kind === 'balance') settings.balances.push({ ...common, unit: entry.name.input.value.trim(), value: entry.amount.input.value.trim() });
        else settings.inventory.push({ ...common, item: entry.name.input.value.trim(), count: Number(entry.amount.input.value) });
      }
      const receipt=await request('/v1/scene/world-configure', 'POST', { scope: state.scope, expectedVersion:state.scene.version, settings });
      if (state.epoch !== epoch) throw new Error('聊天已切换，原聊天设置已提交');
      assertBound();
      await recordSceneReceipt(receipt);
      await syncInternal(); renderSceneMaterials(await inspectInternal()); setStatus('世界状态已保存并重算。');
    }));
    worldSection.append(element('p', '先配置 world 模型。金额与数量由脚本计算；修改初始值会重算当前有效历史。支持明确购买、引用原购买的部分退款、消耗和时间线索。'), worldMode, worldStart.wrap, playerName.wrap, timeLabel, ledgerRows,
      button('添加初始余额', () => addLedgerRow('balance')), button('添加初始物品', () => addLedgerRow('inventory')), loadWorld, saveWorld,
      button('停用世界时钟与账本', () => withBusy(async () => { assertBound(); const receipt=await request('/v1/scene/world-configure', 'POST', { scope: state.scope, expectedVersion:state.scene.version, settings: null }); await recordSceneReceipt(receipt); await syncInternal(); setStatus('世界时钟与账本已停用。'); })));
    const persona = element('textarea');
    persona.placeholder = '在此粘贴并编辑角色设定；不会从历史聊天自动注入。';
    persona.value = safeStorageGet('xldb.tavern.persona', '');
    persona.addEventListener('change', () => safeStorageSet('xldb.tavern.persona', persona.value));
    const composer = element('textarea');
    composer.placeholder = '本轮用户输入';
    const generateButton = button('生成候选', () => generate(composer.value, persona.value));
    const regenerateButton = button('重新生成上一条回复', regenerateScene);
    const preview = element('pre', '');
    const acceptButton = button('接受并提交', accept);
    const rejectButton = button('拒绝候选', reject);
    const configArea = element('div');
    const configInputs = {};
    for (const stage of CONFIG_STAGES) {
      const group = element('fieldset');
      group.append(element('legend', `${stage} 模型配置`));
      const baseUrl = field('URL');
      const key = field('密钥', 'password');
      const model = field('模型');
      const thinking = element('select');
      for (const [value, label] of [['', '服务默认'], ['disabled', '关闭思考'], ['enabled', '开启思考']]) {
        const option = element('option', label); option.value = value; thinking.append(option);
      }
      const thinkingWrap = element('label'); thinkingWrap.append('思考模式', thinking);
      if (stage === 'embedding') {
        baseUrl.input.placeholder = 'https://api.siliconflow.cn/v1/embeddings';
        model.input.placeholder = 'BAAI/bge-m3';
      }
      if (stage === 'reranker') {
        baseUrl.input.placeholder = 'https://api.siliconflow.cn/v1/rerank';
        model.input.placeholder = 'BAAI/bge-reranker-v2-m3';
      }
      const copy = element('select');
      const copyPlaceholder = element('option', '复制另一项…'); copyPlaceholder.value = ''; copy.append(copyPlaceholder);
      for (const source of CONFIG_STAGES.filter(item => item !== stage)) {
        const option = element('option', source); option.value = source; copy.append(option);
      }
      copy.addEventListener('change', () => {
        if (!copy.value) return;
        const source = configInputs[copy.value];
        baseUrl.input.value = source.baseUrl.input.value;
        key.input.value = source.key.input.value;
        model.input.value = source.model.input.value;
        thinking.value = source.thinking.value;
        copy.value = '';
      });
      group.append(baseUrl.wrap, key.wrap, model.wrap, thinkingWrap, copy);
      configArea.append(group);
      configInputs[stage] = { baseUrl, key, model, thinking };
    }
    const loadConfigButton = button('读取本地配置', loadConfig);
    const saveConfigButton = button('保存全部配置', saveConfig);
    const inspectArea = element('div');
    const sceneRosterEditor = element('div');
    const sceneControls = element('div');
    const addNpcButton = button('添加 NPC', () => sceneRosterEditor.append(sceneRosterRow()));
    const saveSceneButton = button('保存 NPC 名单', () => configureScene(sceneRosterValues()));
    const sceneSection = element('section');
    sceneSection.append(element('h4', '多人场景'), element('p', '原生聊天会从角色卡和关联世界书自动识别身份。仅在资料不足时补充姓名、别名和身份设定；知识和在场情况按正文视角更新。'), sceneRosterEditor, addNpcButton, saveSceneButton, sceneControls);
    const siliconFlow = element('p');
    siliconFlow.append('向量和重排可选：留空时核心使用 BM25-only。可在 ');
    const keyLink = element('a', 'SiliconFlow 平台'); keyLink.href = 'https://cloud.siliconflow.cn/'; keyLink.target = '_blank'; keyLink.rel = 'noopener noreferrer';
    const docsLink = element('a', '快速开始文档'); docsLink.href = 'https://docs.siliconflow.cn/docs/userguide/quickstart'; docsLink.target = '_blank'; docsLink.rel = 'noopener noreferrer';
    siliconFlow.append(keyLink, ' 创建 API Key，并在平台选择可用的免费模型；建议先尝试 BAAI/bge-m3 与 BAAI/bge-reranker-v2-m3。详见 ', docsLink, '。');
    const legacyPersonaSection = element('section');
    legacyPersonaSection.append(element('h4', '角色设定（单角色兼容模式）'), persona);
    root.append(title, closeButton, status, token.wrap, world.wrap, bindButton, disableButton, syncButton, inspectButton, interactionSection, sceneSection, worldSection, lifecycleSection, legacyPersonaSection, element('h4', '受控生成'), composer, generateButton, regenerateButton, preview, acceptButton, rejectButton, element('h4', '独立模型配置'), configArea, siliconFlow, loadConfigButton, saveConfigButton, element('h4', '当前记忆与偏好'), inspectArea);
    root.append(nativeButton,recoverButton);
    viewDocument.body.append(root, toggle);
    state.panel = { root, toggle, status, token: token.input, world: world.input, persona, composer, preview, bindButton, disableButton, syncButton, inspectButton, nativeButton, generateButton, regenerateButton, acceptButton, rejectButton, configInputs, inspectArea, sceneRosterEditor, sceneControls, addNpcButton, saveSceneButton, legacyPersonaSection };
    state.panel.resetWorldForm = resetWorldForm;
    Object.assign(state.panel,{interactionMode,timeZoneInput:timeZone.input,directorInput,directorStatus,clockText,worldMode});
    state.panel.clockTimer=globalThis.setInterval(renderClock,1000);
    renderInteraction();
    state.panel.branchInput = branchName.input;
    buildWorkbench(root,lifecycleSection);
    buildCompanionPanel(root);
    buildDashboard(root);
    renderSceneControls();
    refreshButtons();
  }

  function clearElement(node) { while(node.firstChild)node.removeChild(node.firstChild); }

  function dashboardClock() {
    const clock=state.dashboard.data?.clock;
    if(!clock?.known||clock.timeMs==null)return '剧情日期尚未设置';
    const time=clock.timeMs+(clock.kind==='realtime'?Date.now()-(state.dashboard.data.sampledAt||Date.now()):0);
    return new Intl.DateTimeFormat('zh-CN',{timeZone:clock.timeZone,dateStyle:'medium',timeStyle:'medium'}).format(time);
  }

  async function refreshDashboard() {
    if(!state.scene.enabled||!state.scope)throw new Error('请先绑定当前聊天并启用场景');
    const scope={...state.scope},epoch=state.epoch;
    const requestId=(state.dashboard.requestId||0)+1;state.dashboard.requestId=requestId;
    state.dashboard.loading=true;
    try {
      const data=await request('/v1/scene/dashboard','POST',{scope});
      assertHostScope(scope,epoch);
      if(requestId!==state.dashboard.requestId)return;
      state.dashboard.data={...data,sampledAt:Date.now()};state.dashboard.error='';
      renderDashboard();return data;
    } catch(error) {
      if(requestId===state.dashboard.requestId&&sameScope(scope,state.scope)&&epoch===state.epoch){state.dashboard.data=null;state.dashboard.error=error.message;renderDashboard();}
      throw error;
    } finally { if(requestId===state.dashboard.requestId)state.dashboard.loading=false; }
  }

  function displayCard(label,value) {
    const node=element('div');node.className='xldb-card';node.append(element('small',label),element('strong',String(value)));return node;
  }

  function dashboardContent(tab,compact=false) {
    const area=element('div'),data=state.dashboard.data;
    if(!data){area.append(element('p',state.dashboard.error||'绑定当前聊天后，点击刷新读取状态。'));return area;}
    const balances=data.balances||[],inventory=data.inventory||[],transactions=data.transactions||[];
    const grid=element('div');grid.className='xldb-grid';
    const money=balances.length?balances.map(row=>`${row.value} ${row.unit}`).join(' · '):'尚未设置';
    if(tab==='overview'){
      const clockCard=displayCard(data.mode==='companion'?'现实时间':'世界时间',dashboardClock());clockCard.children[1].setAttribute('data-xldb-clock','');
      grid.append(clockCard,displayCard('当前用户',data.playerName),
        displayCard('名下余额',money),displayCard('物品种类',inventory.length));area.append(grid);
      area.append(element('p','余额按币种分别显示；未登记的资产与物品不会估算。'));
      if(!data.configured)area.append(element('p','在设置中填写起始时间、资产与物品后，接受的剧情会自动更新它们。'));
    } else if(tab==='assets') {
      for(const row of balances)grid.append(displayCard(row.unit,row.value));area.append(grid);
      if(!balances.length)area.append(element('p','尚无已登记余额。'));
    } else if(tab==='inventory') {
      for(const row of inventory)grid.append(displayCard(row.item,`× ${row.count}`));area.append(grid);
      if(!inventory.length)area.append(element('p','当前没有已登记物品。'));
    } else if(tab==='ledger') {
      const table=element('table'),head=element('tr');
      for(const label of ['事项 / 物品','金额变化','数量变化','状态'])head.append(element('th',label));table.append(head);
      for(const item of transactions){
        const row=element('tr');
        const cents=item.balanceDeltaCents;
        let amount='—';
        if(typeof cents==='string'&&/^-?\d+$/.test(cents)){
          const n=BigInt(cents),abs=n<0n?-n:n;amount=`${n<0n?'−':'+'}${abs/100n}.${String(abs%100n).padStart(2,'0')}`;
        }
        for(const value of [`${({purchase:'购买',refund:'退款',consume:'消耗'})[item.kind]||item.kind} · ${item.item||'未注明'}`,`${amount}${item.unit?' '+item.unit:''}`,item.inventoryDelta??'—',item.applied?'已生效':'未生效'])row.append(element('td',String(value)));
        row.title=`来源 ${item.sourceId} · 修订 ${item.revision}`;table.append(row);
      }
      area.append(table,element('p',transactions.length?'最近 30 项本人交易；各币种分别显示，不跨币种合计。':'暂无交易。'));
    } else if(tab==='body') {
      const physiology=data.physiology;
      area.append(element('p',physiology?.config?.enabled?'仅展示允许玩家知晓的虚拟角色身体状态。':'角色生理状态未启用。'));
      for(const actor of physiology?.characters||[]){
        const card=element('section');card.className='xldb-card';card.append(element('strong',actor.name||actor.characterId));
        if(!actor.known)card.append(element('p','尚无已接受的身体状态记录。'));
        const labels={hydration:'饮水',nutrition:'进食',bladder:'如厕（小便）',bowel:'如厕（排便）',sleep:'睡眠',energy:'精力'};
        const stages={unknown:'未知',settled:'舒适',noticeable:'开始在意',urgent:'迫切',strained:'明显负担'};
        for(const [key,value] of Object.entries(actor.needs||{}))card.append(element('p',`${labels[key]||key}：${stages[value?.stage]||'未知'}${value?.sleeping?' · 睡眠中':''}`));
        const effects={injury:'伤势',illness:'疾病',intoxication:'醉酒',pain:'疼痛',temperature:'体温不适',exhaustion:'疲惫',other:'其他影响'},severity={mild:'轻度',moderate:'中度',severe:'重度'};
        for(const effect of actor.effects||[])card.append(element('p',`${effects[effect.kind]||'持续影响'} · ${severity[effect.severity]||'程度未知'}${effect.detail?'：'+effect.detail:''}`));
        if(actor.reproductive)card.append(element('p',`生殖状态：${({unknown:'未知',cycle_started:'周期开始',pregnancy_possible:'可能妊娠',pregnancy_confirmed:'确认妊娠',pregnancy_ended:'妊娠结束'})[actor.reproductive.status]||'未知'}`));
        if(actor.sexualArousal)card.append(element('p',`唤起状态：${({unknown:'未知',low:'低',medium:'中',high:'高'})[actor.sexualArousal.level]||'未知'}`));
        area.append(card);
      }
      if(!compact)area.append(element('p','生理模块配置与纠正见设置中的“虚拟角色生理状态”。'));
    } else if(tab==='map')area.append(mapContent(data.map,compact));
    return area;
  }

  function renderDashboard() {
    const panel=state.panel;if(!panel?.dashboardArea)return;
    clearElement(panel.dashboardArea);panel.dashboardArea.append(dashboardContent(state.dashboard.tab));
    panel.dashboardArea.hidden=state.dashboard.tab==='settings';panel.settingsArea.hidden=state.dashboard.tab!=='settings';
    for(const [id,node] of panel.dashboardTabs)node.setAttribute('aria-selected',String(id===state.dashboard.tab));
    clearElement(panel.variableArea);panel.variableArea.append(dashboardContent(state.dashboard.compactTab,true));
    panel.variableArea.hidden=!state.dashboard.expanded;panel.variableTabs.hidden=!state.dashboard.expanded;panel.variableTools.hidden=!state.dashboard.expanded;
    panel.variableToggle.textContent=state.dashboard.data?`${dashboardClock()} · ${state.dashboard.data.playerName}`:'XLDB · 当前状态';
    panel.variableToggle.setAttribute('aria-expanded',String(state.dashboard.expanded));
    panel.dashboardRevision.textContent=state.dashboard.data?`修订 ${state.dashboard.data.version} · 玩家视图`:'尚未读取';
  }

  function mapContent(map,compact=false) {
    const area=element('div');
    if(state.dashboard.data?.mode!=='roleplay'){area.append(element('p','地图用于跑团／角色扮演模式。'));return area;}
    if(!map?.enabled||map.showMode==='hidden'){
      area.append(element('p',map?.showMode==='hidden'?'地图显示已关闭，已启用的剧情地理更新仍继续。':'地图尚未启用。可跟随剧情建图、整理背景或导入 JSON。'));
    }else{
      const places=map.places||[],byId=new Map(places.map(place=>[place.id,place]));
      const layer=element('select');layer.setAttribute('aria-label','地图层级');
      const options=[['','世界概览'],...places.filter(place=>places.some(child=>child.parentId===place.id)).map(place=>[place.id,place.name])];
      const selected=options.some(([id])=>id===state.dashboard.mapLayer)?state.dashboard.mapLayer:'';
      for(const [id,name] of options){const option=element('option',name);option.value=id;option.selected=id===selected;layer.append(option);}
      layer.addEventListener('change',()=>{state.dashboard.mapLayer=layer.value;renderDashboard();});area.append(layer);
      const svg=viewDocument.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 700 460');svg.setAttribute('role','img');svg.setAttribute('aria-label','玩家已知地理示意图');svg.style.cssText='width:100%;min-height:220px;background:#202d3d;border-radius:10px;touch-action:none';
      const make=(tag,attrs,value)=>{const node=viewDocument.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,v]of Object.entries(attrs))node.setAttribute(key,String(v));if(value!==undefined)node.textContent=value;return node;};
      const nodes=map.layout?.nodes||{},visible=new Map(places.filter(place=>(place.parentId||'')===selected&&nodes[place.id]).map(place=>[place.id,place]));
      const point=id=>({x:35+Number(nodes[id].x)*6.3,y:30+Number(nodes[id].y)*3.8});
      for(const route of map.routes||[]){if(!visible.has(route.from)||!visible.has(route.to))continue;const a=point(route.from),b=point(route.to);
        const line=make('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:route.passability==='blocked'?'#db8888':'#8ca5b9','stroke-width':2,'stroke-dasharray':route.passability==='unknown'?'6 5':'none'});
        line.append(make('title',{},`${route.id}：${route.travel?.text||'耗时未知'} · ${route.passability==='blocked'?'封闭':route.passability==='open'?'可通行':'通行未知'}`));svg.append(line);
      }
      for(const [id,place]of visible){const p=point(id),group=make('g',{transform:`translate(${p.x} ${p.y})`});group.style.cursor=compact?'default':'grab';
        group.append(make('circle',{r:compact?12:9,fill:place.basis==='map_report'?'#d7b37a':'#a5c9dc',stroke:'#fff','stroke-width':1}),make('text',{x:compact?17:13,y:compact?8:5,fill:'#e8eff5','font-size':compact?24:14},place.name+(place.basis==='map_report'?'（地图记载）':'')));
        const player=(map.positions||[]).find(entry=>entry.actorId==='player'&&entry.position?.placeId===id);
        if(player)group.append(make('text',{x:compact?17:13,y:compact?34:24,fill:'#f0d99d','font-size':compact?22:12},player.position.state==='within'?'你在此区域（位置不详）':'你在这里'));
        group.append(make('title',{},`${place.name} · ${id} · ${place.basis==='map_report'?'地图／传闻':'有来源记录'}`));
        if(!compact)group.addEventListener('pointerdown',event=>{
          if(state.busy)return;event.preventDefault();const scope={...state.scope},epoch=state.epoch,revision=map.layout.revision;
          state.dashboard.mapDragging=true;group.setPointerCapture?.(event.pointerId);let position={...nodes[id]},moved=false;
          const move=event=>{const rect=svg.getBoundingClientRect();position={...position,x:Math.max(0,Math.min(100,((event.clientX-rect.left)/rect.width*700-35)/6.3)),y:Math.max(0,Math.min(100,((event.clientY-rect.top)/rect.height*460-30)/3.8))};moved=true;group.setAttribute('transform',`translate(${35+position.x*6.3} ${30+position.y*3.8})`);};
          const finish=event=>{group.removeEventListener('pointermove',move);group.removeEventListener('pointerup',finish);group.removeEventListener('pointercancel',cancel);state.dashboard.mapDragging=false;
            if(moved)void withBusy(async()=>{assertHostScope(scope,epoch);await request('/v1/scene/geography/layout','POST',{scope,readerId:'player',expectedRevision:revision,operationId:newId('map-layout'),layout:{axes:map.layout.axes,nodes:{...nodes,[id]:position}}});assertHostScope(scope,epoch);await refreshDashboard();});};
          const cancel=()=>{group.removeEventListener('pointermove',move);group.removeEventListener('pointerup',finish);group.removeEventListener('pointercancel',cancel);state.dashboard.mapDragging=false;renderDashboard();};
          group.addEventListener('pointermove',move);group.addEventListener('pointerup',finish);group.addEventListener('pointercancel',cancel);
        });
        svg.append(group);
      }
      area.append(svg,element('p',`${map.layout?.axes==='free'?'无方位关系图':'北↑ · 东→'} · 示意布局，不表示精确距离${compact?'':'；可拖动地点图标，仅改变显示位置。'}`));
      if(!visible.size)area.append(element('p','当前层级没有可定位地点；未知位置不会放在原点。'));
      const names=id=>byId.get(id)?.name||'未知地点';
      for(const entry of map.positions||[]){const position=entry.position||entry,actor=entry.actorId==='player'?'玩家':state.scene.roster.find(actor=>actor.id===entry.actorId)?.name||entry.actorId;
        const description=position.state==='at'?`位于 ${names(position.placeId)}`:position.state==='within'?`在 ${names(position.placeId)} 范围内，具体位置不详`:position.state==='in_transit'?`行进中${position.fromId?' · 从 '+names(position.fromId):''}${position.toId?' 前往 '+names(position.toId):''}`:'位置未知';
        area.append(element('p',`${actor}：${description}${entry.actorId==='player'?'':'（最后得知的位置）'}`));
      }
      for(const item of map.unlocated||[])area.append(element('p',`尚未定位：${typeof item==='string'?names(item):item.name||names(item.id)}`));
      for(const item of map.issues||[])area.append(element('p',typeof item==='string'&&item.startsWith('layout_direction_conflict:')?'地图提示：显示位置与已知方向不一致；可拖动调整，或在地图设置中改用无方位布局。':'地图提示：布局需要核对，请检查地点和方向。'));
      if(!compact){const details=element('details');details.append(element('summary','已知地理关系与通路'));
        const relationLabels={north_of:'在其北方',south_of:'在其南方',east_of:'在其东方',west_of:'在其西方',northeast_of:'在其东北方',northwest_of:'在其西北方',southeast_of:'在其东南方',southwest_of:'在其西南方',inside:'位于其内部',adjacent_to:'相邻',connected_to:'连接',near:'附近',above:'上方',below:'下方',other:'其他关系'};
        for(const relation of map.relations||[])details.append(element('p',`${names(relation.from)} · ${relationLabels[relation.kind]||relation.kind} · ${names(relation.to)}`));
        for(const route of map.routes||[])details.append(element('p',`${names(route.from)} → ${names(route.to)}：${route.travel?.text||'耗时未知'}；${({open:'可通行',blocked:'封闭',unknown:'通行未知'})[route.passability]||route.passability}`));area.append(details);}
    }
    if(!compact)area.append(button('地图设置与导入',()=>{state.dashboard.tab='settings';renderDashboard();state.panel.geographySection.open=true;state.panel.geographySection.scrollIntoView?.({block:'start'});}));
    return area;
  }

  function buildGeographyPanel(root) {
    const section=element('details');section.append(element('summary','跑团地图与地理位置'));const status=element('p'),controls=element('div'),preview=element('div');
    const enabled=element('input');enabled.type='checkbox';const follow=element('input');follow.type='checkbox';const backgroundEnabled=element('input');backgroundEnabled.type='checkbox';
    const show=element('select');for(const [value,label]of [['map','显示地图'],['hidden','关闭地图显示']]){const option=element('option',label);option.value=value;show.append(option);}
    for(const [name,node]of [['启用地理状态',enabled],['跟随已接受正文更新',follow],['允许背景整理模型',backgroundEnabled]]){const label=element('label',name);label.append(node);controls.append(label);}controls.append(show);
    let configuration=null;
    const load=async()=>{assertBound();const scope={...state.scope},epoch=state.epoch;const data=await request('/v1/scene/geography/status','POST',{scope,readerId:'player'});assertHostScope(scope,epoch);configuration=data.configuration;
      enabled.checked=configuration.enabled;follow.checked=configuration.followAcceptedProse;backgroundEnabled.checked=configuration.backgroundSeed==='enabled';show.value=configuration.showMode;status.textContent=`地理设置修订 ${configuration.revision} · ${data.projection.places.length} 个玩家已知地点`;return data;};
    const documentInput=element('textarea');documentInput.setAttribute('aria-label','地图 JSON');documentInput.placeholder='粘贴 xldb-map-v1 JSON，或先从背景生成预览。';documentInput.rows=12;
    const basis=element('select');basis.setAttribute('aria-label','地图资料性质');for(const [value,label]of [['author_setting','确认为作者设定'],['map_report','角色得到的地图／传闻']]){const option=element('option',label);option.value=value;basis.append(option);}
    const previewDocument=async(document,evidence)=>{
      assertBound();const scope={...state.scope},epoch=state.epoch;const selected={...document,basis:basis.value};
      const result=await request('/v1/scene/geography/import-preview','POST',{scope,document:selected});assertHostScope(scope,epoch);documentInput.value=JSON.stringify(result.normalized,null,2);clearElement(preview);
      preview.append(element('p','请核对地点、通路、初始位置及每项 knownBy。未知范围不自动公开；初始位置不会覆盖现有剧情位置。'),element('pre',JSON.stringify({summary:result.summary,conflicts:result.conflicts,...(evidence?{evidence}:{})},null,2)));
      preview.append(button('确认导入以上地图',()=>withBusy(async()=>{assertHostScope(scope,epoch);const receipt=await request('/v1/scene/geography/import','POST',{scope,document:result.normalized,expectedVersion:result.expectedVersion,documentHash:result.documentHash,operationId:newId('map-import'),allowInitialPositionConflicts:true});await recordSceneReceipt(receipt,scope,epoch);clearElement(preview);await load();setStatus('地图资料已导入，已存在的剧情位置优先。');})));
    };
    const exportMap=()=>withBusy(async()=>{assertBound();const scope={...state.scope},epoch=state.epoch;const result=await request('/v1/scene/geography/export','POST',{scope,readerId:'player'});assertHostScope(scope,epoch);documentInput.value=JSON.stringify(result,null,2);clearElement(preview);});
    section.append(element('p','跑团专用。跟随正文与背景整理使用独立 geography API；关闭显示不停止已启用的地理更新。'),status,controls,
      button('读取地图设置',()=>withBusy(load)),button('保存地图设置',()=>withBusy(async()=>{const config={enabled:enabled.checked,followAcceptedProse:follow.checked,backgroundSeed:backgroundEnabled.checked?'enabled':'disabled',showMode:show.value};if(!configuration)await load();const scope={...state.scope},epoch=state.epoch;await request('/v1/scene/geography/configure','POST',{scope,expectedRevision:configuration.revision,operationId:newId('map-config'),config});assertHostScope(scope,epoch);const receipt=await request('/v1/scene/sync-state','POST',{scope});await recordSceneReceipt(receipt,scope,epoch);await load();})),
      element('h4','JSON 导入与导出'),basis,documentInput,button('预览地图 JSON',()=>withBusy(()=>previewDocument(JSON.parse(documentInput.value)))),button('导出玩家已知地图',exportMap),preview);
    const background=element('textarea');background.rows=5;background.setAttribute('aria-label','地理背景');background.placeholder='填写世界的地理背景，例如：河湾镇北是森林，镇东步行半天到码头。';
    const catalog=element('div');let sourceChoices=[];
    const mapId=field('地图 ID');mapId.input.value='world-map';const revision=field('地图文档版本','number');revision.input.value='1';revision.input.min='1';
    section.append(element('h4','根据背景生成预览'),background,mapId.wrap,revision.wrap,
      button('选择角色卡／世界书背景',()=>withBusy(async()=>{const scope={...state.scope},epoch=state.epoch;const sources=await collectInitializationSources();assertHostScope(scope,epoch);sourceChoices=[];clearElement(catalog);for(const source of sources){const label=element('label',`${source.kind==='character_card'?'角色卡':'世界书'}：${source.name}`),check=element('input');check.type='checkbox';check.checked=false;label.append(check);catalog.append(label);sourceChoices.push({source,check});}})),catalog,
      button('从所选背景生成地图预览',()=>withBusy(async()=>{assertBound();const scope={...state.scope},epoch=state.epoch;const sources=sourceChoices.filter(row=>row.check.checked).map(row=>row.source);if(background.value.trim())sources.push({id:'manual-background',name:'手动地理背景',text:background.value.trim()});
        const result=await request('/v1/scene/geography/background-preview','POST',{scope,sources,mapId:mapId.input.value,revision:Number(revision.input.value),basis:basis.value,allowedReaders:['player']});assertHostScope(scope,epoch);await previewDocument(result.document,result.evidence);})),
      element('p','只有勾选的资料和填写的正文会发送到地理模型。生成结果需预览确认；不会自动创造未提及地点或向 NPC 广播。'));
    const correction=element('textarea');correction.setAttribute('aria-label','地理纠正 JSON');correction.placeholder='{"basis":"author_setting","knownBy":["player"],"reason":"用户修正","operation":{"kind":"position","action":"set","actorId":"player","position":{"state":"at","placeId":"town"}}}';correction.rows=5;
    section.append(element('h4','修正地理事实或已知位置'),element('p','修正需填写原因和知情角色；只调整图标请在地图上拖动。纠正与地图资料随分支保存点恢复。'),correction,
      button('提交地理纠正',()=>withBusy(async()=>{assertBound();const scope={...state.scope},epoch=state.epoch;const receipt=await request('/v1/scene/geography/correct','POST',{scope,correction:JSON.parse(correction.value),expectedVersion:state.scene.version,operationId:newId('map-correct')});await recordSceneReceipt(receipt,scope,epoch);await load();})),
      button('改用无方位布局',()=>withBusy(async()=>{assertBound();const scope={...state.scope},epoch=state.epoch;const result=await load(),map=result.projection;await request('/v1/scene/geography/layout','POST',{scope,readerId:'player',expectedRevision:map.layout.revision,operationId:newId('map-layout'),layout:{axes:'free',nodes:map.layout.nodes}});assertHostScope(scope,epoch);await refreshDashboard();})));
    root.append(section);state.panel.geographySection=section;state.panel.resetGeography=()=>{configuration=null;status.textContent='请读取当前地图设置。';enabled.checked=false;follow.checked=false;backgroundEnabled.checked=false;show.value='hidden';documentInput.value='';background.value='';correction.value='';sourceChoices=[];clearElement(catalog);clearElement(preview);state.dashboard.mapLayer='';state.dashboard.mapDragging=false;};
  }

  function buildPhysiologyPanel(root) {
    const section=element('details'),area=element('div');section.append(element('summary','虚拟角色生理状态'));
    const reader=element('select');reader.setAttribute('aria-label','生理状态查看角色');
    const load=async()=>{
      assertBound();const scope={...state.scope},epoch=state.epoch;
      const selected=reader.value||'player';clearElement(reader);
      for(const actor of [{id:'player',name:'玩家可见'},...state.scene.roster]){const option=element('option',actor.name);option.value=actor.id;option.selected=actor.id===selected;reader.append(option);}
      reader.value=selected;
      const result=await request('/v1/scene/physiology/status','POST',{scope,readerId:selected});assertHostScope(scope,epoch);
      render(result,scope,epoch);return result;
    };
    const mutate=async(path,payload,scope,epoch)=>withBusy(async()=>{
      assertHostScope(scope,epoch);await syncInternal();assertHostScope(scope,epoch);
      await request(path,'POST',{scope,...payload});assertHostScope(scope,epoch);
      const data=await request('/v1/scene/inspect','POST',{scope});assertHostScope(scope,epoch);
      await recordSceneReceipt(data,scope,epoch);invalidateSceneCandidate();
      await load();await refreshDashboard();setStatus('虚拟角色生理设置已保存。');
    });
    const select=(label,choices)=>{const wrap=element('label',label),input=element('select');input.setAttribute('aria-label',label);for(const [value,name] of choices){const option=element('option',name);option.value=value;input.append(option);}wrap.append(input);return {wrap,input};};
    const render=(status,scope,epoch)=>{
      clearElement(area);const config=status.config;
      const enabled=element('input');enabled.type='checkbox';enabled.checked=config.enabled;enabled.setAttribute('aria-label','启用虚拟生理状态');
      const enableLabel=element('label','启用虚拟生理状态');enableLabel.append(enabled);area.append(enableLabel);
      const choices=[],needNames=[['hydration','饮水'],['nutrition','进食'],['bladder','小便'],['bowel','排便'],['sleep','睡眠'],['energy','精力']];
      const needs=element('fieldset');needs.append(element('legend','日常需求'));
      for(const [id,name] of needNames){const check=element('input');check.type='checkbox';check.checked=config.dailyNeeds.includes(id);const label=element('label',name);label.append(check);needs.append(label);choices.push({id,check});}area.append(needs);
      const tracked=element('fieldset'),actors=[];tracked.append(element('legend','跟踪的虚拟角色'));
      for(const actor of state.scene.roster){const check=element('input');check.type='checkbox';check.checked=config.trackedCharacterIds.includes(actor.id);const label=element('label',actor.name);label.append(check);tracked.append(label);actors.push({id:actor.id,check});}area.append(tracked);
      const features={};for(const [id,name] of [['sustainedEffects','持续身体影响'],['reproductive','生殖状态（跑团）'],['sexualArousal','唤起状态（跑团）']]){
        const check=element('input');check.type='checkbox';check.checked=Boolean(config[id]);check.disabled=id!=='sustainedEffects'&&state.interaction?.mode==='companion';
        const label=element('label',name);label.append(check);area.append(label);features[id]=check;
      }
      area.append(element('p','启用后需要配置独立 physiology 模型。默认不跟踪任何身体资料；伴侣仅使用日常需求与持续影响。'),
        button('保存生理设置',()=>mutate('/v1/scene/physiology/configure',{expectedRevision:status.revision,config:{enabled:enabled.checked,
          dailyNeeds:choices.filter(x=>x.check.checked).map(x=>x.id),trackedCharacterIds:actors.filter(x=>x.check.checked).map(x=>x.id),
          ...Object.fromEntries(Object.entries(features).map(([key,input])=>[key,input.disabled?false:input.checked]))}},scope,epoch)));
      const correction=element('fieldset');correction.append(element('legend','纠正虚拟角色状态'));
      const actor=select('被纠正角色',state.scene.roster.filter(x=>config.trackedCharacterIds.includes(x.id)).map(x=>[x.id,x.name]));
      const visibility=select('纠正知情范围',[['private','仅角色自己'],['player','角色与玩家'],['all_tracked','全部跟踪角色与玩家']]);
      const reason=field('纠正原因');reason.input.setAttribute('aria-label','生理纠正原因');
      correction.append(actor.wrap,visibility.wrap,reason.wrap);
      const commit=patch=>mutate('/v1/scene/physiology/correct',{expectedRevision:status.revision,correction:{characterId:actor.input.value,visibility:visibility.input.value,reason:reason.input.value,patch}},scope,epoch);
      const need=select('日常需求项目',needNames.filter(([id])=>config.dailyNeeds.includes(id))),stage=select('需求状态',[['unknown','未知'],['settled','舒适'],['noticeable','开始在意'],['urgent','迫切'],['strained','明显负担']]);
      correction.append(need.wrap,stage.wrap,button('纠正日常需求',()=>commit({kind:'need',need:need.input.value,state:stage.input.value})));
      if(config.sustainedEffects){
        const effect=select('身体影响',[['injury','伤势'],['illness','疾病'],['intoxication','醉酒'],['pain','疼痛'],['temperature','体温不适'],['exhaustion','疲惫'],['other','其他']]);
        const severity=select('影响程度',[['mild','轻度'],['moderate','中度'],['severe','重度']]);const detail=field('影响说明');
        correction.append(effect.wrap,severity.wrap,detail.wrap,button('记录持续影响',()=>commit({kind:'effect',effect:effect.input.value,action:'set',severity:severity.input.value,detail:detail.input.value})),button('清除持续影响',()=>commit({kind:'effect',effect:effect.input.value,action:'clear'})));
      }
      if(config.reproductive){const reproductive=select('生殖状态',[['unknown','未知'],['cycle_started','周期开始'],['pregnancy_possible','可能妊娠'],['pregnancy_confirmed','确认妊娠'],['pregnancy_ended','妊娠结束']]);correction.append(reproductive.wrap,button('纠正生殖状态',()=>commit({kind:'reproductive',status:reproductive.input.value})));}
      if(config.sexualArousal){const arousal=select('唤起状态',[['unknown','未知'],['low','低'],['medium','中'],['high','高']]);correction.append(arousal.wrap,button('纠正唤起状态',()=>commit({kind:'sexualArousal',level:arousal.input.value})));}
      if(config.enabled)area.append(correction);
      for(const character of status.characters){
        const row=element('div');row.append(element('strong',character.name));
        for(const id of character.correctionIds||[])row.append(button(`撤销纠正 ${id}`,()=>mutate('/v1/scene/physiology/clear',{expectedRevision:status.revision,characterId:character.characterId,id},scope,epoch)));
        area.append(row);
      }
    };
    section.append(element('p','以下是管理入口，可切换查看角色自己的已知状态。常驻变量面板始终只展示玩家可见内容。'),reader,button('读取生理设置',()=>withBusy(load)),area);
    root.append(section);state.panel.physiologyArea=area;state.panel.physiologyReader=reader;
  }

  function buildDashboard(root) {
    const panel=state.panel,settings=element('div');settings.className='xldb-settings';
    for(const child of [...root.children]){root.removeChild(child);settings.append(child);}
    // Tavern applies a transform to its zero-height html on mobile. Anchor from
    // the viewport top so fixed panels do not resolve bottom against that box.
    Object.assign(root.style,{width:'min(960px, calc(100vw - 472px))',left:'12px',right:'auto',top:'60px',bottom:'auto',maxHeight:'calc(100vh - 120px)',padding:'0',background:'#151d29',borderColor:'#40516a',borderRadius:'14px'});
    const style=element('style');style.textContent=`
      #xldb-tavern-mvp,#xldb-variable-ui{font:14px/1.55 system-ui,sans-serif;text-align:left;color:#e9eef6;box-sizing:border-box}
      #xldb-tavern-mvp [hidden],#xldb-variable-ui [hidden]{display:none!important}
      #xldb-tavern-mvp button,#xldb-variable-ui button{font:inherit;color:inherit;background:#243449;border:1px solid #4a607c;border-radius:7px;padding:7px 12px;cursor:pointer}
      #xldb-tavern-mvp button:focus-visible,#xldb-variable-ui button:focus-visible{outline:2px solid #9fcee8;outline-offset:2px}
      #xldb-tavern-mvp button[aria-selected=true]{background:#496478;color:#fff}
      .xldb-header,.xldb-tabs,.xldb-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:14px;border-bottom:1px solid #39495e}
      .xldb-header strong{font-size:19px;flex:1}.xldb-tabs{padding:10px 14px}.xldb-content,.xldb-settings{padding:18px}.xldb-settings{max-width:100%;overflow-wrap:anywhere}
      .xldb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}.xldb-card{padding:15px;background:#202d3d;border:1px solid #394b63;border-radius:10px;overflow-wrap:anywhere;margin-bottom:8px}
      .xldb-card small,.xldb-card strong{display:block}.xldb-card small{color:#abbacf;margin-bottom:7px}.xldb-card strong{font-size:17px;font-weight:600}
      #xldb-tavern-mvp table,#xldb-variable-ui table{width:100%;border-collapse:collapse}#xldb-tavern-mvp th,#xldb-tavern-mvp td,#xldb-variable-ui th,#xldb-variable-ui td{padding:9px 5px;border-bottom:1px solid #435068;text-align:left}
      #xldb-variable-ui{position:fixed;right:12px;top:60px;bottom:auto;width:min(420px,calc(100vw - 24px));max-height:calc(100vh - 120px);z-index:2147483646;background:#182333;border:1px solid #4a607c;border-radius:13px;box-shadow:0 8px 28px #0007;overflow:auto}
      #xldb-variable-ui .xldb-content{max-height:48vh;overflow:auto;padding:13px}#xldb-variable-ui .xldb-grid{grid-template-columns:repeat(2,minmax(0,1fr))}#xldb-variable-ui .xldb-tabs{gap:5px;padding:8px}#xldb-variable-ui button{padding:5px 8px}
      #xldb-variable-ui.xldb-paper{background:#efe8dc;color:#3e352c;border-color:#ac9981}#xldb-variable-ui.xldb-paper .xldb-card{background:#faf5ed;border-color:#c5b69e}#xldb-variable-ui.xldb-paper small{color:#6e604f}#xldb-variable-ui.xldb-paper button{background:#ddd0ba;color:#382f25;border-color:#b6a58b}
      @media(max-width:1100px){#xldb-tavern-mvp{width:calc(100vw - 24px)!important;left:12px!important;right:auto!important}#xldb-tavern-mvp:not([hidden]) ~ #xldb-variable-ui{display:none}}
      @media(max-width:600px){#xldb-tavern-mvp .xldb-content{padding:12px}.xldb-grid{grid-template-columns:1fr 1fr}.xldb-header{padding:10px}.xldb-tabs{gap:4px}#xldb-tavern-mvp button{padding:6px 9px}#xldb-tavern-mvp svg text{font-size:26px}}
    `;viewDocument.body.append(style);
    const header=element('header');header.className='xldb-header';const revision=element('small');
    header.append(element('strong','XLDB · 世界与角色'),revision,button('刷新状态',refreshDashboard),button('关闭工作台',()=>setPanelOpen(false)));
    const tabs=element('nav');tabs.className='xldb-tabs';tabs.setAttribute('aria-label','工作台栏目');
    const tabItems=[['overview','概览'],['assets','资产'],['inventory','物品'],['ledger','最近交易'],['body','生理'],['map','地图'],['settings','设置与资料管理']];
    const dashboardTabs=new Map();for(const [id,label] of tabItems){const node=button(label,()=>{state.dashboard.tab=id;renderDashboard();});node.setAttribute('role','tab');dashboardTabs.set(id,node);tabs.append(node);}
    const area=element('div');area.className='xldb-content';root.append(header,tabs,area,settings);
    const variableRoot=element('aside');variableRoot.id='xldb-variable-ui';variableRoot.setAttribute('aria-label','角色变量状态');
    const mini=element('div');mini.className='xldb-header';const variableToggle=button('XLDB · 当前状态',()=>{state.dashboard.expanded=!state.dashboard.expanded;renderDashboard();});
    mini.append(variableToggle,button('工作台',()=>setPanelOpen(true)));
    const variableTabs=element('nav');variableTabs.className='xldb-tabs';variableTabs.setAttribute('aria-label','变量栏目');
    for(const [id,label] of tabItems.filter(([id])=>id!=='settings'))variableTabs.append(button(label,()=>{state.dashboard.compactTab=id;renderDashboard();}));
    const variableArea=element('div');variableArea.className='xldb-content';const tools=element('div');tools.className='xldb-tools';
    let light=safeStorageGet('xldb.ui.theme')==='paper',left=safeStorageGet('xldb.ui.side')==='left',large=safeStorageGet('xldb.ui.large')==='true';
    const preference=()=>{variableRoot.className=light?'xldb-paper':'';variableRoot.style.left=left?'12px':'';variableRoot.style.right=left?'':'12px';variableRoot.style.fontSize=large?'16px':'14px';root.style.left=left?'auto':'12px';root.style.right=left?'12px':'auto';};
    tools.append(button('刷新变量',refreshDashboard),button('主题',()=>{light=!light;safeStorageSet('xldb.ui.theme',light?'paper':'dark');preference();}),button('左右位置',()=>{left=!left;safeStorageSet('xldb.ui.side',left?'left':'right');preference();}),button('字号',()=>{large=!large;safeStorageSet('xldb.ui.large',String(large));preference();}));
    variableRoot.append(mini,variableTabs,variableArea,tools);viewDocument.body.append(variableRoot);
    panel.toggle.style.left='12px';panel.toggle.style.right='auto';panel.toggle.style.top='calc(100vh - 90px)';panel.toggle.style.bottom='auto';
    Object.assign(panel,{settingsArea:settings,dashboardArea:area,dashboardTabs,dashboardRevision:revision,variableRoot,variableToggle,variableArea,variableTabs,variableTools:tools,dashboardStyle:style});
    buildPhysiologyPanel(settings);
    buildGeographyPanel(settings);
    preference();renderDashboard();
    panel.dashboardTimer=globalThis.setInterval(()=>{
      if(state.scene.enabled&&!state.busy&&!state.dashboard.loading&&!state.dashboard.mapDragging)void refreshDashboard().catch(()=>{});
    },15000);
  }

  async function previewLifecycle(operation,checkpointId) {
    return withBusy(async()=>{
      assertBound();const scope={...state.scope},epoch=state.epoch;
      const result=await request('/v1/scene/restore-preview','POST',{scope,operation,checkpointId});
      assertHostScope(scope,epoch);const area=state.panel.lifecyclePreview;clearElement(area);
      area.append(element('pre',JSON.stringify(result,null,2)));
      if(result.checkpointId)area.append(button('确认以上恢复',async()=>{
        assertHostScope(scope,epoch);
        await restoreScene(operation,result.checkpointId,result.version);clearElement(area);
      }));
      return result;
    });
  }

  async function workbenchData(options) {
    assertBound();const scope={...state.scope},epoch=state.epoch;
    const result=await request('/v1/scene/workbench','POST',{scope,...options});assertHostScope(scope,epoch);return result;
  }

  async function correctWorkbenchSource(row,replacement,version) {
    return withBusy(async()=>{
      assertBound();requireSceneRestoreHost();const scope={...state.scope},epoch=state.epoch;
      const metadata=nativeHost().chatMetadata||={};metadata.xldbHydrate=scope;await saveNativeMetadata();
      try {
        await request('/v1/scene/source-correct','POST',{scope,sourceId:row.sourceId,revision:row.revision,text:replacement,expectedVersion:version,operationId:newId('correction')});
        assertHostScope(scope,epoch);state.candidate=null;state.native.turn=null;
        await materializeScene(scope,await request('/v1/scene/inspect','POST',{scope}));
        setStatus('正文已纠正；相关资料按新来源重算。');
      } catch(error) { disable('正文纠正结果待载入，请重新绑定当前聊天。');throw error; }
    });
  }

  function buildWorkbench(root,lifecycleSection) {
    const panel=state.panel;
    panel.lifecyclePreview=element('div');lifecycleSection.append(panel.lifecyclePreview);
    const section=element('details');section.append(element('summary','资料工作台'));
    const view=element('select'),actor=field('角色 ID（角色视图必填）'),query=field('搜索资料'),type=element('select'),rows=element('div');
    for(const [value,label] of [['admin','管理员'],['character','角色所知']]){const option=element('option',label);option.value=value;view.append(option);}
    for(const [value,label] of [['','全部类型'],['source','正文来源'],['memory','记忆'],['commitment','约定与承诺'],['reference','导入资料'],['preference','偏好'],['identity','身份'],['emotion','情绪'],['clock','时间'],['balance','余额'],['inventory','物品'],['receipt','状态变更']]){const option=element('option',label);option.value=value;type.append(option);}
    view.setAttribute('aria-label','资料查看视角');type.setAttribute('aria-label','资料类型');
    const refresh=async()=>{
      assertBound();const scope={...state.scope},epoch=state.epoch;
      const result=await workbenchData({view:view.value,characterId:actor.input.value||undefined,query:query.input.value,type:type.value});
      clearElement(rows);rows.append(element('p',`${result.notice} 显示 ${result.items.length} / ${result.total} 项。`));
      const table=element('table'),head=element('tr');Object.assign(table.style,{width:'100%',borderCollapse:'collapse'});Object.assign(rows.style,{overflowX:'auto'});for(const title of ['类型与角色','内容','来源与时间','状态与操作'])head.append(element('th',title));table.append(head);
      for(const row of result.items) {
        const tr=element('tr'),value=typeof row.value==='string'?row.value:JSON.stringify(row.value,null,2),actions=element('td');
        tr.append(element('td',`${row.label} ${row.characterId||''}`));const content=element('td'),text=element('pre',value);Object.assign(text.style,{whiteSpace:'pre-wrap',overflowWrap:'anywhere',minWidth:'150px'});content.append(text);tr.append(content);
        tr.append(element('td',`${row.sourceId||row.id}\n发生：${row.occurredAtMs==null?'未知':new Date(row.occurredAtMs).toISOString()}\n记录：${row.updatedAtMs==null?'未知':new Date(row.updatedAtMs).toISOString()}`));
        actions.append(element('p',`${row.status} ${row.access||''}`));
        if(result.view==='admin'&&row.type==='source'&&row.status!=='deleted') {
          const edit=element('textarea');edit.value=String(row.value);edit.setAttribute('aria-label','纠正正文');
          actions.append(edit,button('预览纠正',()=>{
            const proposed=edit.value;clearElement(content);content.append(element('pre',`原文：${row.value}\n新文：${proposed}`),button('确认纠正正文',async()=>{assertHostScope(scope,epoch);await correctWorkbenchSource(row,proposed,result.version);await refresh();}));
          }),button('预览删除',()=>{clearElement(content);content.append(element('p','确认后删除正文及其派生影响。'),button('确认删除正文',async()=>{assertHostScope(scope,epoch);await correctWorkbenchSource(row,null,result.version);await refresh();}));}));
        }
        if(result.view==='admin'&&row.type==='memory') {
          const access=element('select');for(const level of ACCESS_LEVELS){const option=element('option',level);option.value=level;access.append(option);}access.value=row.access;
          actions.append(access,button('保存访问粒度',async()=>{assertHostScope(scope,epoch);if(state.scene.version!==result.version)throw new Error('资料已变化，请重新查询');await setAccess(row.id,access.value,row.characterId);await refresh();}));
        }
        if(result.view==='admin'&&row.type==='preference') {
          const edit=element('input'),enabled=element('input');edit.value=String(row.value);enabled.type='checkbox';enabled.checked=row.enabled;
          actions.append(edit,enabled,button('保存偏好',async()=>{assertHostScope(scope,epoch);if(state.scene.version!==result.version)throw new Error('资料已变化，请重新查询');await setPreference(row.id,enabled.checked,edit.value,row.characterId);await refresh();}));
        }
        if(result.view==='admin'&&row.type==='reference')actions.append(button('预览删除资料',()=>{
          content.append(button('确认删除参考资料',()=>withBusy(async()=>{assertHostScope(scope,epoch);const receipt=await request('/v1/scene/reference-delete','POST',{scope,id:row.id,expectedVersion:result.version,operationId:newId('reference-delete')});assertHostScope(scope,epoch);await recordSceneReceipt(receipt);await refresh();})));
        }));
        tr.append(actions);table.append(tr);
      }
      rows.append(table);return result;
    };
    section.append(view,actor.wrap,type,query.wrap,button('查询资料',refresh),rows);root.append(section);

    const progressSection=element('details'),progress=element('div');progressSection.append(element('summary','后台处理进度'));
    const refreshProgress=async()=>{
      if(!state.enabled||!state.scene.enabled)return;
      const scope={...state.scope},epoch=state.epoch,result=await request('/v1/scene/progress','POST',{scope});assertHostScope(scope,epoch);
      clearElement(progress);progress.append(element('p',`已接受 ${result.accepted.total} 条 · 完成 ${result.accepted.ready} · 待处理 ${result.accepted.pending} · 失败 ${result.accepted.failed}。${result.generationBlocked?'必要材料未就绪，生成暂停。':'必要材料已就绪。'}`));
      for(const source of result.sources) {
        const line=element('div');line.append(element('p',`${source.sourceId} r${source.revision}：${source.status}`));
        for(const stage of source.stages)line.append(element('p',`${stage.stage} ${stage.characterId||''}：${stage.status}${stage.failure?`（${stage.failure.kind}）`:''}`));
        if(['failed','pending'].includes(source.status))line.append(button('重试该来源未完成阶段',()=>withBusy(async()=>{
          assertHostScope(scope,epoch);const receipt=await request('/v1/scene/retry','POST',{scope,sourceId:source.sourceId,revision:source.revision});await recordSceneReceipt(receipt);await refreshProgress();
        })));
        progress.append(line);
      }
      return result;
    };
    progressSection.append(button('刷新处理进度',refreshProgress),progress);root.append(progressSection);
    if(typeof globalThis.setInterval==='function')panel.progressTimer=globalThis.setInterval(()=>{
      if(!root.hidden&&progressSection.open&&state.enabled&&!panel.progressLoading){panel.progressLoading=true;refreshProgress().catch(()=>{}).finally(()=>{panel.progressLoading=false;});}
    },1500);

    const initializationSection=element('details'),initializationSources=element('div'),initializationPreview=element('div'),initializationMaintenance=element('div');
    initializationSection.append(element('summary','从角色卡与世界书初始化'),
      element('p','先读取当前角色卡与关联世界书。只有明确勾选的来源会交给 initialization 模型；世界书中未明确启用的条目不会出现。预览会列出分类、知情角色、冲突和非历史参考，确认前不会写入。'),
      button('读取角色卡与世界书',loadInitializationSources),initializationSources,
      button('预览所选初始化来源',previewInitialization),initializationPreview,
      element('p','初始化完成后，可在此查看每项产物来自哪些来源。生成前会自动核对当前所有已启用来源；需撤销／恢复参考或 NPC 设定冲突时会暂停生成。'),
      button('查看初始化来源与产物',readInitializationProvenance),
      button('核对当前启用来源变更',previewInitializationRefresh),initializationMaintenance);
    panel.initializationSection=initializationSection;panel.initializationSources=initializationSources;panel.initializationPreview=initializationPreview;panel.initializationMaintenance=initializationMaintenance;root.append(initializationSection);
    renderInitializationMaintenance();

    const resourceSection=element('details'),resourceArea=element('div');
    resourceSection.append(element('summary','NPC 资源控制'),
      element('p','默认同时激活上限为 2；这是尚未经过宿主内存与延迟实测的初始值，可按设备表现调整。'),
      button('读取 NPC 资源状态',readNpcResources),resourceArea);
    panel.resourceArea=resourceArea;root.append(resourceSection);renderNpcResources();

    const transfer=element('details'),documentInput=element('textarea'),transferPreview=element('div');transfer.append(element('summary','模板与参考资料迁入'));
    documentInput.placeholder='粘贴 XLDB 模板或参考资料 JSON';documentInput.setAttribute('aria-label','迁入 JSON');
    transfer.append(element('p','导入先预览。参考资料不视为已发生经历；缺少知情角色时只供管理员查看。模板仅含身份与世界规则，不含密钥或历史。'),documentInput,
      button('导出当前模板',()=>withBusy(async()=>{assertBound();const data=await request('/v1/scene/template-export','POST',{scope:state.scope,name:'当前场景'});documentInput.value=JSON.stringify(data,null,2);clearElement(transferPreview);})),
      button('预览迁入',()=>withBusy(async()=>{
        assertBound();const scope={...state.scope},epoch=state.epoch,document=JSON.parse(documentInput.value);
        const preview=await request('/v1/scene/transfer-preview','POST',{scope,document});assertHostScope(scope,epoch);
        clearElement(transferPreview);transferPreview.append(element('pre',JSON.stringify(preview,null,2)));
        if(preview.valid) {
          const operationId=newId('transfer');transferPreview.append(button('确认以上迁入',()=>withBusy(async()=>{
            assertHostScope(scope,epoch);const receipt=await request('/v1/scene/transfer-apply','POST',{scope,document,expectedVersion:preview.expectedVersion,previewId:preview.previewId,operationId});
            assertHostScope(scope,epoch);await recordSceneReceipt(receipt);state.candidate=null;
            const data=await request('/v1/scene/inspect','POST',{scope});assertHostScope(scope,epoch);setSceneRoster(data.roster);renderSceneControls();
            clearElement(transferPreview);transferPreview.append(element('p',`迁入完成：新增 ${receipt.imported}，跳过 ${receipt.skipped}。`));
          })));
        }
      })),transferPreview);root.append(transfer);

    const setup=element('details'),diagnostics=element('pre');setup.append(element('summary','连接检查与批量配置'));
    panel.resetWorkbench=()=>{
      state.dashboard.requestId=(state.dashboard.requestId||0)+1;state.dashboard.loading=false;state.dashboard.data=null;state.dashboard.error='';renderDashboard();
      panel.resetGeography?.();
      if(panel.physiologyArea)clearElement(panel.physiologyArea);
      if(panel.physiologyReader)clearElement(panel.physiologyReader);
      for(const node of [rows,progress,transferPreview,panel.lifecyclePreview,diagnostics,panel.inspectArea,initializationSources,initializationPreview,initializationMaintenance,resourceArea])clearElement(node);
      documentInput.value='';actor.input.value='';state.initialization={catalog:[],selectedIds:[],preview:null,hasInitialized:false,provenance:null,refresh:null};state.resources=null;renderInitializationMaintenance();renderNpcResources();
    };
    const base=field('共用 API 地址'),key=field('共用密钥','password'),model=field('共用模型'),targets=[];
    setup.append(element('p','检查核心连接后，填写共用连接并选择要应用的环节；每个环节仍可独立修改。配置诊断不发起模型请求。'),button('检查核心连接',async()=>{
      assertToken();const result=await request('/v1/diagnostics','POST',{});diagnostics.textContent=JSON.stringify({...result,
        host:{createMessages:typeof helpers.createChatMessages==='function',editMessages:typeof helpers.setChatMessages==='function',deleteMessages:typeof helpers.deleteChatMessages==='function'},
        binding:{enabled:state.enabled,scope:state.scope,recoveryPending:Boolean(nativeHost().chatMetadata?.xldbHydrate)}},null,2);
    }),diagnostics,base.wrap,key.wrap,model.wrap);
    for(const stage of CONFIG_STAGES){const label=element('label',stage),checked=element('input');checked.type='checkbox';checked.checked=!['embedding','reranker'].includes(stage);label.append(checked);setup.append(label);targets.push({stage,checked});}
    setup.append(button('填入所选环节（保存后生效）',()=>{for(const {stage,checked} of targets)if(checked.checked){const fields=panel.configInputs[stage];fields.baseUrl.input.value=base.input.value;fields.key.input.value=key.input.value;fields.model.input.value=model.input.value;}setStatus('已填入所选环节，请检查并保存全部配置。');}));root.append(setup);
  }

  function setPanelOpen(open) {
    if (!state.panel) return;
    state.panel.root.hidden = !open;
    state.panel.toggle.textContent = open ? '收起 XLDB' : 'XLDB';
    state.panel.toggle.setAttribute('aria-expanded', String(Boolean(open)));
  }

  function readConfigValues() {
    const config = emptyConfig();
    if (!state.panel) return config;
    for (const stage of CONFIG_STAGES) {
      const fields = state.panel.configInputs[stage];
      config[stage] = { baseUrl: fields.baseUrl.input.value, key: fields.key.input.value, model: fields.model.input.value,
        ...(fields.thinking.value ? { thinking: fields.thinking.value } : {}) };
    }
    return config;
  }

  function renderConfigValues() {
    if (!state.panel) return;
    for (const stage of CONFIG_STAGES) {
      const fields = state.panel.configInputs[stage];
      const source = state.config[stage];
      fields.baseUrl.input.value = source.baseUrl;
      fields.key.input.value = source.key;
      fields.model.input.value = source.model;
      fields.thinking.value = source.thinking || '';
    }
  }

  function setPreview(text) {
    if (state.panel && state.panel.preview) state.panel.preview.textContent = text;
  }

  function refreshButtons() {
    if (!state.panel) return;
    const panel = state.panel;
    panel.bindButton.disabled = state.busy;
    panel.disableButton.disabled = false;
    panel.syncButton.disabled = state.busy || !state.enabled;
    panel.inspectButton.disabled = state.busy || !state.enabled;
    panel.nativeButton.disabled = state.busy || !state.enabled;
    panel.generateButton.disabled = state.busy || !state.enabled;
    panel.regenerateButton.disabled = state.busy || !state.enabled || !state.scene.enabled;
    panel.saveSceneButton.disabled = state.busy || !state.enabled;
    for (const input of panel.sceneSelectionInputs || []) input.disabled = state.busy || !state.scene.enabled;
    panel.acceptButton.disabled = state.busy || !state.candidate;
    panel.rejectButton.disabled = state.busy || !state.candidate;
  }

  function renderInspect(data) {
    if (!state.panel) return;
    const area = state.panel.inspectArea;
    while (area.firstChild) area.removeChild(area.firstChild);
    const memories = Array.isArray(data.memories) ? data.memories : [];
    for (const memory of memories) {
      const row = element('div');
      const memoryId = memory.id || memory.memoryId;
      const visible = [memory.detail, memory.gist, memory.feeling, memory.anchor, ...(Array.isArray(memory.protectedFacts) ? memory.protectedFacts : []), memory.forgotten]
        .filter(value => typeof value === 'string' && value.trim()).join(' · ');
      const kind=memory.kind==='episode'?'情景与感受':memory.kind==='fact'?'事实记录':'旧版记忆';
      const text = element('span', `[${kind}] ${visible || '此记忆当前无可见文本。'}`);
      const access = element('select');
      for (const level of ACCESS_LEVELS) { const option = element('option', level); option.value = level; if (memory.access === level) option.selected = true; access.append(option); }
      row.append(text, access, button('更新访问', () => setAccess(memoryId, access.value)));
      area.append(row);
    }
    const preferences = Array.isArray(data.preferences) ? data.preferences : [];
    for (const preference of preferences) {
      const row = element('div');
      const enabled = element('input'); enabled.type = 'checkbox'; enabled.checked = Boolean(preference.enabled);
      const text = element('input'); text.value = String(preference.text || '');
      row.append(enabled, text, button('保存偏好', () => setPreference(preference.id, enabled.checked, text.value)));
      area.append(row);
    }
    const emotion = element('pre', String(data.emotion ? JSON.stringify(data.emotion, null, 2) : ''));
    area.append(emotion);
  }

  const api = { connect,switchMode,setTimeZone,setDirectorEnabled,refreshClock,sceneCheckpoint, restoreScene, recoverScene, switchSceneBranch, regenerateScene, enableNative, bind, disable, sync, generate, accept, reject, configureScene, loadInitializationSources, previewInitialization, applyInitialization, readInitializationProvenance, previewInitializationRefresh, applyInitializationRefresh, readNpcResources, configureNpcResources, bindCompanionSubject, readCompanionProfile, readCompanionStatus, saveProfileControls, correctProfileEntry, deleteProfileEntry, saveContactSettings, saveCompanionBusy, pollCompanion, reconcileCompanionUnknown, loadConfig, saveConfig, inspect, setAccess, setPreference, destroy, getState: () => ({ interaction:state.interaction,clock:state.clock,enabled: state.enabled, nativeEnabled: state.native.enabled, busy: state.busy, scope: state.scope, hasCandidate: Boolean(state.candidate), companion:{profile:state.companion.profile,status:state.companion.status,scheduled:Boolean(state.companion.timer),polling:state.companion.polling}, resources:state.resources ? { ...state.resources, priorityIds:[...state.resources.priorityIds], selectedIds:[...state.resources.selectedIds], activeIds:[...state.resources.activeIds], pausedIds:[...state.resources.pausedIds] } : null, scene: { enabled: state.scene.enabled, targetId: state.scene.targetId, presentIds: [...state.scene.presentIds], mode: state.scene.mode, roster: state.scene.roster.map(character => ({ ...character })) } }), setToken: token => { state.token = String(token || ''); } };
  api.refreshDashboard=refreshDashboard;
  globalThis.XLDBTavernMvp = api;
  buildPanel();
  subscribeEvents();
  if (globalThis.addEventListener) globalThis.addEventListener('pagehide', destroy, { once: true });
})();
