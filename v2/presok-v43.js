/**
 * Presok v43–v45: tiered escalation UI hooks, simple senior styles,
 * and real WebRTC video calls (presok-escalation / presok-simple-senior / presok-webrtc).
 * Loaded after index.html inline script exposes window.PresokApp.
 */
(function (global) {
  'use strict';

  const STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
  const RING_MS = 30000;
  const FEATURE = {
    escalation: 'presok-escalation',
    simpleSenior: 'presok-simple-senior',
    webrtc: 'presok-webrtc',
  };

  let pc = null;
  let localStream = null;
  let remoteStream = null;
  let callSession = null; // { callId, role, peerUserId, peerMemberId, elderId, status, ringTimer, candidates }
  let ringAudioStop = null;
  let facingMode = 'user';
  let muted = false;
  let camOff = false;

  function app() { return global.PresokApp || {}; }
  function getState() { return app().state || {}; }
  function getCloud() { return app().cloud; }
  function t(k) {
    try {
      if (typeof global.t === 'function') return global.t(k);
    } catch (e) {}
    return k;
  }
  function toast(msg) {
    try { if (typeof global.toast === 'function') global.toast(msg); } catch (e) {}
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function uid() {
    return (global.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('c' + Date.now() + Math.random().toString(16).slice(2));
  }

  function familyMembersRanked() {
    const st = getState();
    return (st.members || [])
      .filter(m => m.role === 'family')
      .slice()
      .sort((a, b) => (a.notifyPriority - b.notifyPriority) || String(a.id).localeCompare(String(b.id)));
  }

  function myMembership() {
    const st = getState();
    if (st.membershipId) {
      return (st.members || []).find(m => m.id === st.membershipId) || null;
    }
    return null;
  }

  /* ---------- Escalation UI helpers ---------- */
  async function acknowledgeAlert(notifId) {
    const cloud = getCloud();
    if (!cloud || typeof cloud.acknowledgeAlert !== 'function') {
      toast('Ack unavailable offline');
      return;
    }
    try {
      await cloud.acknowledgeAlert(notifId);
      if (typeof app().pullCloudState === 'function') await app().pullCloudState({ silent: true });
      toast(t('toastAcked') || 'You are handling it');
      if (typeof global.renderFamily === 'function') global.renderFamily();
    } catch (e) {
      console.warn(e);
      toast((e && e.message) || 'Ack failed');
    }
  }

  async function moveMemberPriority(memberId, dir) {
    const cloud = getCloud();
    if (!cloud || typeof cloud.reorderMemberPriority !== 'function') return;
    try {
      await cloud.reorderMemberPriority(memberId, dir === -1 || dir === 'up' ? 'up' : 'down');
      if (typeof app().pullCloudState === 'function') await app().pullCloudState({ silent: true });
      if (typeof global.renderFamily === 'function') global.renderFamily();
    } catch (e) {
      console.warn(e);
      toast((e && e.message) || 'Reorder failed');
    }
  }

  async function saveEscalationMinutes() {
    const sel = document.getElementById('escalationMinutesSelect');
    const cloud = getCloud();
    const st = getState();
    if (!sel || !st.householdId) return;
    const mins = Math.max(1, Number(sel.value) || 15);
    st.escalationMinutes = mins;
    try {
      if (cloud && typeof cloud.updateHousehold === 'function') {
        await cloud.updateHousehold({ id: st.householdId, escalation_minutes: mins });
        if (typeof app().pullCloudState === 'function') await app().pullCloudState({ silent: true });
      }
      toast(t('toastSaved') || 'Saved');
    } catch (e) {
      console.warn(e);
    }
  }

  function renderMemberPriorityList() {
    const host = document.getElementById('memberPriorityList');
    if (!host) return;
    const ranked = familyMembersRanked();
    if (!ranked.length) {
      host.innerHTML = '<div class="empty muted">No family members yet</div>';
      return;
    }
    const n = ranked.length;
    host.innerHTML = ranked.map((m, idx) => `
      <div class="contact-item member-prio" data-member-id="${escapeHtml(m.id)}">
        <div style="display:flex;align-items:flex-start;gap:8px;min-width:0;flex:1">
          <span class="prio">${idx + 1}</span>
          <div style="min-width:0">
            <div class="c-name">${escapeHtml(m.displayName || 'Family')}</div>
            <div class="c-phone muted">${escapeHtml(t('notifyPriority') || 'Notify priority')} ${idx + 1}</div>
          </div>
        </div>
        <div class="c-actions">
          <button type="button" class="btn-icon" ${idx === 0 ? 'disabled' : ''} onclick="PresokV43.moveMemberPriority('${m.id}','up')" aria-label="Up">↑</button>
          <button type="button" class="btn-icon" ${idx === n - 1 ? 'disabled' : ''} onclick="PresokV43.moveMemberPriority('${m.id}','down')" aria-label="Down">↓</button>
        </div>
      </div>`).join('');
  }

  function enhanceNotifHtml(n) {
    const handling = n.handlingName || n.handling_name;
    const acked = n.ackedAt || n.acked_at;
    let extra = '';
    if (handling || acked) {
      extra += `<div class="handling-banner">${escapeHtml((t('handlingBy') || 'Handling:') + ' ' + (handling || 'Family'))}</div>`;
    } else if (n.escalationId || n.escalation_id || n.level === 'alert' || n.kind === 'sos' || n.kind === 'medMissed' || String(n.kind || '').indexOf('care') === 0) {
      extra += `<button type="button" class="btn btn-primary btn-block ack-btn" style="margin-top:10px;min-height:48px" onclick="PresokV43.acknowledgeAlert('${escapeHtml(n.id)}')">${escapeHtml(t('btnOnIt') || "I'm on it")}</button>`;
    }
    return extra;
  }

  /* ---------- Ringtone (different from med alarm) ---------- */
  function playCallRingtone() {
    stopCallRingtone();
    try {
      const Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const master = ctx.createGain();
      master.gain.value = 0.55;
      master.connect(ctx.destination);
      let stopped = false;
      const beep = (t0, freq, dur) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'square';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.45, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        o.connect(g); g.connect(master);
        o.start(t0); o.stop(t0 + dur + 0.02);
      };
      const loop = () => {
        if (stopped) return;
        const t0 = ctx.currentTime;
        beep(t0, 880, 0.18);
        beep(t0 + 0.22, 988, 0.18);
        beep(t0 + 0.44, 880, 0.18);
        setTimeout(loop, 1400);
      };
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      loop();
      if (navigator.vibrate) {
        try { navigator.vibrate([200, 100, 200, 100, 200]); } catch (e) {}
      }
      ringAudioStop = () => {
        stopped = true;
        try { ctx.close(); } catch (e) {}
        ringAudioStop = null;
      };
    } catch (e) {
      console.warn('ringtone', e);
    }
  }
  function stopCallRingtone() {
    if (ringAudioStop) try { ringAudioStop(); } catch (e) {}
    ringAudioStop = null;
    if (navigator.vibrate) try { navigator.vibrate(0); } catch (e) {}
  }

  /* ---------- WebRTC core ---------- */
  async function signal(payload) {
    const cloud = getCloud();
    const st = getState();
    if (!cloud || typeof cloud.sendRtcSignal !== 'function' || !st.householdId) {
      throw new Error('signaling unavailable');
    }
    return cloud.sendRtcSignal(Object.assign({ household_id: st.householdId }, payload));
  }

  function cleanupPeer(keepUi) {
    stopCallRingtone();
    if (callSession && callSession.ringTimer) {
      clearTimeout(callSession.ringTimer);
      callSession.ringTimer = null;
    }
    if (pc) {
      try { pc.onicecandidate = null; pc.ontrack = null; pc.onconnectionstatechange = null; pc.close(); } catch (e) {}
      pc = null;
    }
    if (localStream) {
      try { localStream.getTracks().forEach(tr => tr.stop()); } catch (e) {}
      localStream = null;
    }
    remoteStream = null;
    muted = false;
    camOff = false;
    if (!keepUi) {
      callSession = null;
      const ov = document.getElementById('callOverlay');
      if (ov) { ov.classList.add('hidden'); ov.innerHTML = ''; ov.className = 'call-overlay hidden'; }
      const st = getState();
      if (st) st.activeCall = null;
    }
  }

  async function ensureLocalMedia() {
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { facingMode: facingMode, width: { ideal: 640 }, height: { ideal: 480 } },
    });
    return localStream;
  }

  function attachLocalPreview() {
    const vid = document.getElementById('selfPreview');
    if (vid && localStream) {
      vid.srcObject = localStream;
      vid.muted = true;
      vid.setAttribute('playsinline', '');
      vid.setAttribute('webkit-playsinline', '');
      vid.play().catch(() => {});
    }
  }

  function attachRemote() {
    const vid = document.getElementById('remoteVideo');
    if (vid && remoteStream) {
      vid.srcObject = remoteStream;
      vid.setAttribute('playsinline', '');
      vid.setAttribute('webkit-playsinline', '');
      vid.play().catch(() => {});
    }
  }

  function makePeerConnection() {
    pc = new RTCPeerConnection(STUN);
    remoteStream = new MediaStream();
    pc.ontrack = (ev) => {
      ev.streams[0].getTracks().forEach(tr => remoteStream.addTrack(tr));
      attachRemote();
    };
    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !callSession) return;
      signal({
        type: 'ice',
        call_id: callSession.callId,
        to_user_id: callSession.peerUserId,
        candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate,
      }).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      const s = pc.connectionState;
      if (s === 'failed' || s === 'disconnected') {
        showCallError(t('callIceFailed') || 'Video blocked on this network (no TURN relay). Try Wi-Fi or another network.');
      }
      if (s === 'connected' && callSession) {
        callSession.status = 'connected';
        stopCallRingtone();
      }
    };
    return pc;
  }

  function showCallError(msg) {
    const el = document.getElementById('callErrorBanner');
    if (el) { el.textContent = msg; el.classList.remove('hidden'); }
    else toast(msg);
  }

  function showOutgoingUi(name, statusText) {
    const ov = document.getElementById('callOverlay');
    if (!ov) return;
    ov.classList.remove('hidden');
    ov.className = 'call-overlay';
    ov.innerHTML = `
      <div>
        <div class="call-avatar">📹</div>
        <div class="call-name">${escapeHtml(name || '')}</div>
        <div class="call-status">${escapeHtml(statusText || (t('callCalling') || 'Calling…'))}</div>
        <div class="call-countdown" id="rtcRingCountdown"></div>
        <p id="callErrorBanner" class="call-error hidden"></p>
      </div>
      <div class="call-actions">
        <button type="button" class="call-btn hangup" onclick="PresokV43.hangUp()"><span class="ico">📞</span>${escapeHtml(t('callHangup') || 'Hang up')}</button>
      </div>`;
  }

  function showIncomingUi(fromName) {
    const ov = document.getElementById('callOverlay');
    if (!ov) return;
    ov.classList.remove('hidden');
    ov.className = 'call-overlay';
    ov.innerHTML = `
      <div>
        <div class="call-avatar">📹</div>
        <div class="call-name">${escapeHtml(t('callIncoming') || 'Incoming call')}</div>
        <div class="call-status">${escapeHtml(fromName || '')}</div>
      </div>
      <div class="call-actions">
        <button type="button" class="call-btn decline" onclick="PresokV43.decline()"><span class="ico">📵</span>${escapeHtml(t('callDecline') || 'Decline')}</button>
        <button type="button" class="call-btn answer" onclick="PresokV43.answer()"><span class="ico">📹</span>${escapeHtml(t('callAnswer') || 'Answer')}</button>
      </div>`;
    playCallRingtone();
  }

  function showInCallUi(peerName) {
    const ov = document.getElementById('callOverlay');
    if (!ov) return;
    ov.classList.remove('hidden');
    ov.className = 'call-overlay in-call webrtc-call';
    ov.innerHTML = `
      <div class="webrtc-stage">
        <video id="remoteVideo" class="remote-video" playsinline webkit-playsinline autoplay></video>
        <video id="selfPreview" class="self" playsinline webkit-playsinline autoplay muted></video>
        <div class="call-peer-label">${escapeHtml(peerName || '')}</div>
        <p id="callErrorBanner" class="call-error hidden"></p>
      </div>
      <div class="in-call-bar">
        <button type="button" class="call-btn mute" id="btnCallMute" onclick="PresokV43.toggleMute()"><span class="ico">🔇</span><span id="lblCallMute">${escapeHtml(t('callMute') || 'Mute')}</span></button>
        <button type="button" class="call-btn hangup" onclick="PresokV43.hangUp()"><span class="ico">📞</span>${escapeHtml(t('callHangup') || 'Hang up')}</button>
        <button type="button" class="call-btn cam" id="btnCallCam" onclick="PresokV43.toggleCam()"><span class="ico">📷</span><span id="lblCallCam">${escapeHtml(t('callCamOff') || 'Cam')}</span></button>
        <button type="button" class="call-btn flip" id="btnCallFlip" onclick="PresokV43.flipCam()"><span class="ico">🔄</span>${escapeHtml(t('callFlip') || 'Flip')}</button>
      </div>`;
    attachLocalPreview();
    attachRemote();
  }

  async function startCallToMember(member, elderId, asRole) {
    cleanupPeer(false);
    const callId = uid();
    callSession = {
      callId,
      role: 'caller',
      peerUserId: member.userId,
      peerMemberId: member.id,
      peerName: member.displayName || 'Family',
      elderId,
      status: 'ringing',
      asRole,
      ringTimer: null,
      pendingInvite: true,
    };
    const st = getState();
    st.activeCall = { elderId, status: 'ringing', from: asRole, at: Date.now(), callId, peerMemberId: member.id };
    showOutgoingUi(member.displayName || 'Family', t('callCalling') || 'Calling…');
    try {
      await ensureLocalMedia();
      makePeerConnection();
      localStream.getTracks().forEach(tr => pc.addTrack(tr, localStream));
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      await signal({
        type: 'invite',
        call_id: callId,
        to_user_id: member.userId,
        to_member_id: member.id,
        from_role: asRole,
        elder_id: elderId,
        sdp: offer,
        from_name: (myMembership() && myMembership().displayName) || (asRole === 'elder' ? 'Senior' : 'Family'),
      });
      let left = Math.round(RING_MS / 1000);
      const tick = () => {
        const el = document.getElementById('rtcRingCountdown');
        if (el) el.textContent = left + 's';
      };
      tick();
      const iv = setInterval(() => { left -= 1; if (left >= 0) tick(); }, 1000);
      callSession.ringTimer = setTimeout(async () => {
        clearInterval(iv);
        await signal({ type: 'noanswer', call_id: callId, to_user_id: member.userId }).catch(() => {});
        await onNoAnswerAdvance();
      }, RING_MS);
      callSession._tickIv = iv;
    } catch (e) {
      console.warn(e);
      showCallError((e && e.message) || (t('toastCamDenied') || 'Camera/mic denied'));
      cleanupPeer(false);
    }
  }

  async function onNoAnswerAdvance() {
    if (!callSession || callSession.status === 'connected') return;
    const ranked = familyMembersRanked();
    const curIdx = ranked.findIndex(m => m.id === callSession.peerMemberId);
    if (callSession.asRole === 'elder' && curIdx >= 0 && curIdx + 1 < ranked.length) {
      toast(t('toastTryingNext') || 'Trying next…');
      const next = ranked[curIdx + 1];
      const elderId = callSession.elderId;
      cleanupPeer(false);
      await startCallToMember(next, elderId, 'elder');
    } else {
      toast(t('toastNoAnswerAll') || 'No one answered');
      cleanupPeer(false);
      if (typeof global.render === 'function') global.render();
    }
  }

  async function startElderVideoCall() {
    const st = getState();
    const elder = (typeof global.getActiveElder === 'function') ? global.getActiveElder() : (st.elders || [])[0];
    if (!elder) return;
    const ranked = familyMembersRanked();
    if (!ranked.length) {
      // fallback to phone contacts toast
      toast(t('toastNoContacts') || 'Add a family member first');
      return;
    }
    try {
      if (typeof global.applyCheckIn === 'function') global.applyCheckIn(true);
    } catch (e) {}
    await startCallToMember(ranked[0], elder.id, 'elder');
  }

  async function startVideoCall(elderId) {
    const st = getState();
    const elder = (elderId && (st.elders || []).find(e => e.id === elderId))
      || ((typeof global.getActiveElder === 'function') ? global.getActiveElder() : null)
      || (st.elders || [])[0];
    if (!elder) return;
    // Prefer calling the senior's linked user via members
    const elderMember = (st.members || []).find(m => m.role === 'elder' && (m.elderId === elder.id || !m.elderId));
    if (!elderMember || !elderMember.userId) {
      toast(t('toastSeniorOffline') || 'Senior phone is not paired yet');
      return;
    }
    cleanupPeer(false);
    const callId = uid();
    const me = myMembership();
    callSession = {
      callId,
      role: 'caller',
      peerUserId: elderMember.userId,
      peerMemberId: elderMember.id,
      peerName: elder.name || 'Senior',
      elderId: elder.id,
      status: 'ringing',
      asRole: 'family',
      ringTimer: null,
    };
    st.activeCall = { elderId: elder.id, status: 'ringing', from: 'family', at: Date.now(), callId };
    st.activeElderId = elder.id;
    showOutgoingUi(elder.name || 'Senior', t('callCalling') || 'Calling…');
    try {
      await ensureLocalMedia();
      makePeerConnection();
      localStream.getTracks().forEach(tr => pc.addTrack(tr, localStream));
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      await signal({
        type: 'invite',
        call_id: callId,
        to_user_id: elderMember.userId,
        to_member_id: elderMember.id,
        from_role: 'family',
        elder_id: elder.id,
        sdp: offer,
        from_name: (me && me.displayName) || 'Family',
      });
      callSession.ringTimer = setTimeout(async () => {
        await signal({ type: 'noanswer', call_id: callId, to_user_id: elderMember.userId }).catch(() => {});
        toast(t('toastNoAnswerAll') || 'No answer');
        cleanupPeer(false);
      }, RING_MS);
    } catch (e) {
      console.warn(e);
      showCallError((e && e.message) || 'Camera/mic denied');
      cleanupPeer(false);
    }
  }

  async function onRtcSignal(msg) {
    if (!msg || !msg.type) return;
    const st = getState();
    const cloud = getCloud();
    let myUserId = null;
    try {
      if (cloud && cloud.userId) myUserId = cloud.userId;
      else if (cloud && cloud.client && cloud.client.auth) {
        const { data } = await cloud.client.auth.getUser();
        myUserId = data && data.user && data.user.id;
      }
    } catch (e) {}
    if (!myUserId && st.membershipId) {
      const me = (st.members || []).find(m => m.id === st.membershipId);
      if (me) myUserId = me.userId;
    }
    if (msg.to_user_id && myUserId && msg.to_user_id !== myUserId && msg.from_user_id !== myUserId) {
      // not for us (unless broadcast without target during ice to peer)
      if (msg.type === 'invite' || msg.type === 'answer' || msg.type === 'hangup' || msg.type === 'noanswer' || msg.type === 'decline') {
        if (msg.to_user_id !== myUserId) return;
      }
    }
    if (msg.type === 'invite') {
      if (myUserId && msg.to_user_id && msg.to_user_id !== myUserId) return;
      if (callSession && callSession.status === 'connected') {
        signal({ type: 'busy', call_id: msg.call_id, to_user_id: msg.from_user_id }).catch(() => {});
        return;
      }
      callSession = {
        callId: msg.call_id,
        role: 'callee',
        peerUserId: msg.from_user_id,
        peerMemberId: msg.from_member_id,
        peerName: msg.from_name || 'Caller',
        elderId: msg.elder_id,
        status: 'ringing',
        remoteOffer: msg.sdp,
        asRole: st.membershipRole || st.role,
      };
      st.activeCall = { elderId: msg.elder_id, status: 'ringing', from: msg.from_role, at: Date.now(), callId: msg.call_id };
      showIncomingUi(msg.from_name || (msg.from_role === 'family' ? 'Family' : 'Senior'));
      return;
    }
    if (!callSession || (msg.call_id && msg.call_id !== callSession.callId)) {
      if (msg.type !== 'ice') return;
    }
    if (msg.type === 'answer' && callSession && callSession.role === 'caller' && pc) {
      try {
        await pc.setRemoteDescription(msg.sdp);
        callSession.status = 'connected';
        if (callSession.ringTimer) clearTimeout(callSession.ringTimer);
        if (callSession._tickIv) clearInterval(callSession._tickIv);
        stopCallRingtone();
        showInCallUi(callSession.peerName);
        attachLocalPreview();
      } catch (e) {
        console.warn(e);
        showCallError('Could not connect video');
      }
      return;
    }
    if (msg.type === 'ice' && pc && msg.candidate) {
      try { await pc.addIceCandidate(msg.candidate); } catch (e) { console.warn('ice', e); }
      return;
    }
    if (msg.type === 'hangup' || msg.type === 'decline' || msg.type === 'noanswer' || msg.type === 'busy') {
      if (callSession && callSession.role === 'caller' && msg.type === 'noanswer') {
        // caller side handled by timer
        return;
      }
      stopCallRingtone();
      cleanupPeer(false);
      toast(msg.type === 'decline' ? (t('toastCallDeclined') || 'Declined') : (t('callEnded') || 'Call ended'));
      if (typeof global.render === 'function') global.render();
    }
  }

  async function answer() {
    if (!callSession || callSession.role !== 'callee') return;
    stopCallRingtone();
    try {
      await ensureLocalMedia();
      makePeerConnection();
      localStream.getTracks().forEach(tr => pc.addTrack(tr, localStream));
      await pc.setRemoteDescription(callSession.remoteOffer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await signal({
        type: 'answer',
        call_id: callSession.callId,
        to_user_id: callSession.peerUserId,
        sdp: answer,
      });
      callSession.status = 'connected';
      const st = getState();
      if (st.activeCall) st.activeCall.status = 'connected';
      try { if (typeof global.applyCheckIn === 'function' && (st.membershipRole === 'elder' || st.role === 'elder')) global.applyCheckIn(true); } catch (e) {}
      showInCallUi(callSession.peerName);
      attachLocalPreview();
    } catch (e) {
      console.warn(e);
      showCallError((e && e.message) || 'Camera/mic denied');
      await decline();
    }
  }

  async function decline() {
    if (callSession) {
      try {
        await signal({ type: 'decline', call_id: callSession.callId, to_user_id: callSession.peerUserId });
      } catch (e) {}
    }
    cleanupPeer(false);
    toast(t('toastCallDeclined') || 'Declined');
    if (typeof global.render === 'function') global.render();
  }

  async function hangUp() {
    if (callSession) {
      try {
        await signal({ type: 'hangup', call_id: callSession.callId, to_user_id: callSession.peerUserId });
      } catch (e) {}
    }
    cleanupPeer(false);
    toast(t('callEnded') || 'Call ended');
    if (typeof global.render === 'function') global.render();
  }

  function toggleMute() {
    if (!localStream) return;
    muted = !muted;
    localStream.getAudioTracks().forEach(tr => { tr.enabled = !muted; });
    const lbl = document.getElementById('lblCallMute');
    if (lbl) lbl.textContent = muted ? (t('callUnmute') || 'Unmute') : (t('callMute') || 'Mute');
  }

  function toggleCam() {
    if (!localStream) return;
    camOff = !camOff;
    localStream.getVideoTracks().forEach(tr => { tr.enabled = !camOff; });
    const lbl = document.getElementById('lblCallCam');
    if (lbl) lbl.textContent = camOff ? (t('callCamOn') || 'Cam on') : (t('callCamOff') || 'Cam off');
  }

  async function flipCam() {
    if (!navigator.mediaDevices || !localStream || !pc) return;
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode },
      });
      const newVid = newStream.getVideoTracks()[0];
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender && newVid) await sender.replaceTrack(newVid);
      localStream.getVideoTracks().forEach(tr => tr.stop());
      const audio = localStream.getAudioTracks();
      localStream = new MediaStream([...audio, newVid].filter(Boolean));
      // keep old audio if new stream also has audio — prefer continuity
      const newAud = newStream.getAudioTracks()[0];
      if (newAud) {
        const as = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
        if (as) await as.replaceTrack(newAud);
        localStream.getAudioTracks().forEach(tr => tr.stop());
        localStream = newStream;
      }
      attachLocalPreview();
    } catch (e) {
      console.warn('flip', e);
      toast('Flip camera failed');
    }
  }

  /* Hook into cloud subscribe for rtc events */
  function installRtcListener() {
    const prev = global.onCloudRealtimeEvent;
    global.onCloudRealtimeEvent = function (type, payload) {
      if (type === 'rtc') {
        onRtcSignal(payload).catch(e => console.warn(e));
      }
      if (typeof prev === 'function') return prev.apply(this, arguments);
    };
  }

  /* Family sweep escalations ~2 min */
  let _escSweepTimer = null;
  function startEscalationSweep() {
    if (_escSweepTimer) clearInterval(_escSweepTimer);
    _escSweepTimer = setInterval(async () => {
      const cloud = getCloud();
      const st = getState();
      if (!cloud || !app().cloudReady) return;
      if (document.visibilityState === 'hidden') return;
      if (st.membershipRole !== 'family' && st.role !== 'family') return;
      try {
        if (typeof cloud.sweepMyHouseholdMissed === 'function') await cloud.sweepMyHouseholdMissed();
        if (typeof cloud.sweepMyHouseholdMissedMeds === 'function') await cloud.sweepMyHouseholdMissedMeds();
        if (typeof cloud.sweepMyHouseholdEscalations === 'function') await cloud.sweepMyHouseholdEscalations();
        if (typeof app().pullCloudState === 'function') await app().pullCloudState({ silent: true });
      } catch (e) {}
    }, 120000);
  }

  function patchRenderFamily() {
    const orig = global.renderFamily;
    if (typeof orig !== 'function') return;
    global.renderFamily = function () {
      const r = orig.apply(this, arguments);
      try {
        renderMemberPriorityList();
        const sel = document.getElementById('escalationMinutesSelect');
        const st = getState();
        if (sel && st.escalationMinutes != null) sel.value = String(st.escalationMinutes);
        // Enhance notif cards with ack / handling
        const nl = document.getElementById('notifList');
        if (nl && st.notifications && st.notifications.length) {
          const cards = nl.querySelectorAll('.notif');
          st.notifications.forEach((n, i) => {
            if (!cards[i]) return;
            if (cards[i].querySelector('.ack-btn, .handling-banner')) return;
            const extra = enhanceNotifHtml(n);
            if (extra) cards[i].insertAdjacentHTML('beforeend', extra);
          });
        }
      } catch (e) { console.warn(e); }
      return r;
    };
  }

  function overrideCallEntryPoints() {
    global.startElderVideoCall = startElderVideoCall;
    global.startVideoCall = startVideoCall;
    global.hangUpCall = hangUp;
    global.answerCall = answer;
    global.declineCall = decline;
  }

  function applySimpleSeniorClass() {
    document.documentElement.classList.add('presok-simple-senior');
    document.body.classList.add('presok-simple-senior');
  }

  function boot() {
    applySimpleSeniorClass();
    installRtcListener();
    patchRenderFamily();
    overrideCallEntryPoints();
    startEscalationSweep();
    // Expose on PresokApp
    const A = app();
    A.acknowledgeAlert = acknowledgeAlert;
    A.moveMemberPriority = moveMemberPriority;
    A.startElderVideoCall = startElderVideoCall;
    A.startVideoCall = startVideoCall;
    A.PresokV43 = FEATURE;
    A.onRtcSignal = onRtcSignal;
    A.getCallSession = () => callSession;
  }

  global.PresokV43 = {
    FEATURE,
    acknowledgeAlert,
    moveMemberPriority,
    saveEscalationMinutes,
    renderMemberPriorityList,
    startElderVideoCall,
    startVideoCall,
    answer,
    decline,
    hangUp,
    toggleMute,
    toggleCam,
    flipCam,
    onRtcSignal,
    boot,
    enhanceNotifHtml,
    familyMembersRanked,
    getCallSession: () => callSession,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})(typeof window !== 'undefined' ? window : globalThis);
