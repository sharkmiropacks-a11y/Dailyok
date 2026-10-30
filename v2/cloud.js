/**
 * Presok cloud sync layer.
 * Modes: 'mock' (local mock-server.mjs) | 'supabase' | 'local' (offline demo, no sync)
 */
(function (global) {
  const SESSION_KEY = 'presok_v2_device';

  function loadDevice() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch { return null; }
  }
  function saveDevice(d) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(d));
  }
  function clearDevice() {
    localStorage.removeItem(SESSION_KEY);
  }

  class MockCloud {
    constructor(baseUrl) {
      this.baseUrl = (baseUrl || 'http://127.0.0.1:8787').replace(/\/$/, '');
      this.sessionId = null;
      this.userId = null;
      this._es = null;
      this._handlers = new Set();
    }
    async init() {
      const dev = loadDevice();
      if (dev && dev.mode === 'mock' && dev.sessionId) {
        this.sessionId = dev.sessionId;
        this.userId = dev.userId;
        // verify
        try {
          await this._fetch('/me');
          return { restored: true, device: dev };
        } catch {
          clearDevice();
          this.sessionId = null;
        }
      }
      return { restored: false };
    }
    async _fetch(path, opts = {}) {
      const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
      if (this.sessionId) headers['X-Session-Id'] = this.sessionId;
      const res = await fetch(this.baseUrl + path, Object.assign({}, opts, { headers }));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    }
    async signInAnonymous() {
      const data = await this._fetch('/auth/anonymous', { method: 'POST', body: '{}' });
      this.sessionId = data.session_id;
      this.userId = data.user_id;
      return data;
    }
    async createHousehold(name) {
      return this._fetch('/rpc/create_household', { method: 'POST', body: JSON.stringify({ name: name || 'My family' }) });
    }
    async getState() { return this._fetch('/state'); }
    async addElder(householdId, name, nick) {
      return this._fetch('/rpc/add_elder', { method: 'POST', body: JSON.stringify({ household_id: householdId, name, nick }) });
    }
    async refreshPairingCode(elderId) {
      return this._fetch('/rpc/refresh_pairing_code', { method: 'POST', body: JSON.stringify({ elder_id: elderId }) });
    }
    async pairWithCode(code) {
      return this._fetch('/rpc/pair_with_code', { method: 'POST', body: JSON.stringify({ code }) });
    }
    async doCheckIn(elderId) {
      return this._fetch('/rpc/do_check_in', { method: 'POST', body: JSON.stringify({ elder_id: elderId }) });
    }
    async markMessagesRead(elderId, viewer) {
      return this._fetch('/rpc/mark_messages_read', { method: 'POST', body: JSON.stringify({ elder_id: elderId, viewer }) });
    }
    async markMessageRead(messageId, viewer) {
      /* presok-msg-read-badge-v40 — single-message read flag (guard allows) */
      return this._fetch('/messages/mark_read', { method: 'POST', body: JSON.stringify({ id: messageId, viewer }) });
    }
    async updateHousehold(patch) {
      return this._fetch('/household', { method: 'PATCH', body: JSON.stringify(patch) });
    }
    async deleteElder(id) {
      return this._fetch('/elders?id=' + encodeURIComponent(id), { method: 'DELETE' });
    }
    async setLastCheckIn(elderId, iso, stepNotified) {
      return this._fetch('/elders/set_last_check_in', {
        method: 'POST',
        body: JSON.stringify({ elder_id: elderId, last_check_in: iso, step_notified: stepNotified })
      });
    }
    async sweepMyHouseholdMissed() {
      return this._fetch('/rpc/sweep_missed_checkins', { method: 'POST', body: '{}' });
    }
    async addContact(householdId, name, phone, role) {
      return this._fetch('/contacts', { method: 'POST', body: JSON.stringify({ household_id: householdId, name, phone, role }) });
    }
    async deleteContact(id) {
      return this._fetch('/contacts?id=' + encodeURIComponent(id), { method: 'DELETE' });
    }
    async reorderContact(id, dir) {
      return this._fetch('/contacts/reorder', { method: 'POST', body: JSON.stringify({ id, dir }) });
    }
    async clearNotifications(householdId) {
      return this._fetch('/notifications?household_id=' + encodeURIComponent(householdId), { method: 'DELETE' });
    }
    async sos(elderId) {
      return this._fetch('/sos', { method: 'POST', body: JSON.stringify({ elder_id: elderId }) });
    }
    async sendVoice(elderId, fromRole, blob, durationMs) {
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const audio_base64 = btoa(binary);
      return this._fetch('/messages', {
        method: 'POST',
        body: JSON.stringify({
          elder_id: elderId,
          from_role: fromRole,
          duration_ms: durationMs,
          mime: blob.type || 'audio/webm',
          audio_base64
        })
      });
    }
    async voiceUrl(storagePath) {
      if (!storagePath) return null;
      return this.baseUrl + '/voice/' + encodeURIComponent(storagePath);
    }
    async upsertMedicationReminder(elderId, name, doseNote, times, active, id, timezone) {
      return this._fetch('/rpc/upsert_medication_reminder', {
        method: 'POST',
        body: JSON.stringify({
          p_elder_id: elderId,
          p_name: name,
          p_dose_note: doseNote || null,
          p_times: times,
          p_active: active != null ? !!active : true,
          p_id: id || null,
          p_timezone: timezone || 'Australia/Melbourne',
        })
      });
    }
    async deleteMedicationReminder(id) {
      return this._fetch('/rpc/delete_medication_reminder', {
        method: 'POST', body: JSON.stringify({ p_id: id })
      });
    }
    async ensureMedicationDoses(days) {
      return this._fetch('/rpc/ensure_medication_doses', {
        method: 'POST', body: JSON.stringify({ p_days: days || 1 })
      });
    }
    async markMedicationTaken(doseId) {
      return this._fetch('/rpc/mark_medication_taken', {
        method: 'POST', body: JSON.stringify({ p_dose_id: doseId })
      });
    }
    async sweepMyHouseholdMissedMeds() {
      return this._fetch('/rpc/sweep_my_household_missed_meds', { method: 'POST', body: '{}' });
    }
    async sweepMyHouseholdEscalations() {
      return this._fetch('/rpc/sweep_my_household_escalations', { method: 'POST', body: '{}' });
    }

    async acknowledgeAlert(notificationId) {
      return this._fetch('/rpc/acknowledge_alert', { method: 'POST', body: JSON.stringify({ p_notification_id: notificationId }) });
    }
    async reorderMemberPriority(memberId, dir) {
      return this._fetch('/rpc/reorder_member_priority', { method: 'POST', body: JSON.stringify({ p_member_id: memberId, p_dir: dir }) });
    }
    async setMemberDisplayName(memberId, name) {
      return this._fetch('/rpc/set_member_display_name', { method: 'POST', body: JSON.stringify({ p_member_id: memberId, p_name: name }) });
    }
    async joinHouseholdAsFamily(householdId, displayName) {
      return this._fetch('/rpc/join_household_as_family', { method: 'POST', body: JSON.stringify({ household_id: householdId, display_name: displayName }) });
    }
    async testForceEscalationAge(escalationId, minutesAgo) {
      return this._fetch('/rpc/test_force_escalation_age', { method: 'POST', body: JSON.stringify({ escalation_id: escalationId, minutes_ago: minutesAgo }) });
    }
    async sendRtcSignal(payload) {
      return this._fetch('/rtc/signal', { method: 'POST', body: JSON.stringify(payload) });
    }
    async testForceMedicationDose(reminderId, dueAt, timeLocal, status) {
      return this._fetch('/rpc/test_force_medication_dose', {
        method: 'POST',
        body: JSON.stringify({
          reminder_id: reminderId,
          due_at: dueAt,
          time_local: timeLocal,
          status: status || 'pending',
        })
      });
    }
    subscribe(handler) {
      this._handlers.add(handler);
      if (this._es) return () => this._handlers.delete(handler);
      this._es = new EventSource(this.baseUrl + '/events');
      const forward = (type) => (ev) => {
        let payload = null;
        try { payload = JSON.parse(ev.data); } catch {}
        for (const h of this._handlers) {
          try { h(type, payload); } catch (e) { console.warn(e); }
        }
      };
      ['elder', 'message', 'notification', 'household', 'contact', 'messages', 'contacts', 'elder_deleted', 'notifications_cleared', 'contact_deleted', 'medication_reminder', 'medication_dose', 'escalation_case', 'member', 'rtc']
        .forEach(t => this._es.addEventListener(t, forward(t)));
      this._es.onerror = () => { /* browser will retry */ };
      return () => this._handlers.delete(handler);
    }
    persistDevice(extra) {
      saveDevice(Object.assign({
        mode: 'mock',
        sessionId: this.sessionId,
        userId: this.userId,
      }, extra || {}));
    }
    signOut() {
      clearDevice();
      this.sessionId = null;
      if (this._es) { try { this._es.close(); } catch {} this._es = null; }
    }
  }

  class SupabaseCloud {
    constructor(url, anonKey) {
      this.url = url;
      this.anonKey = anonKey;
      this.client = null;
      this.channels = [];
      this._handlers = new Set();
    }
    async init() {
      if (!global.supabase || !global.supabase.createClient) {
        throw new Error('supabase-js not loaded');
      }
      this.client = global.supabase.createClient(this.url, this.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
      });
      const { data: { session } } = await this.client.auth.getSession();
      const dev = loadDevice();
      if (session && dev && dev.mode === 'supabase') {
        return { restored: true, device: dev, session };
      }
      return { restored: !!(session && dev), device: dev, session };
    }
    async signInAnonymous() {
      const { data, error } = await this.client.auth.signInAnonymously();
      if (error) throw error;
      return data;
    }
    async createHousehold(name) {
      const { data, error } = await this.client.rpc('create_household', { p_name: name || 'My family' });
      if (error) throw error;
      return data;
    }
    async getState() {
      const { data: { user } } = await this.client.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      const { data: memberships, error: mErr } = await this.client
        .from('household_members').select('*').eq('user_id', user.id);
      if (mErr) throw mErr;
      if (!memberships || !memberships.length) {
        return { memberships: [], membership: null, household: null, elders: [], contacts: [], messages: [], notifications: [], medication_reminders: [], medication_doses: [], members: [] };
      }
      const membership = memberships.find(m => m.role === 'family') || memberships[0];
      const hid = membership.household_id;
      const [hRes, eRes, cRes, msgRes, nRes, mrRes, mdRes, memRes] = await Promise.all([
        this.client.from('households').select('*').eq('id', hid).single(),
        this.client.from('elders').select('*').eq('household_id', hid).order('created_at'),
        this.client.from('contacts').select('*').eq('household_id', hid).order('sort_order'),
        this.client.from('messages').select('*').eq('household_id', hid).order('created_at', { ascending: false }),
        this.client.from('notifications').select('*').eq('household_id', hid).order('created_at', { ascending: false }).limit(80),
        this.client.from('medication_reminders').select('*').eq('household_id', hid).order('created_at'),
        this.client.from('medication_doses').select('*').eq('household_id', hid).order('due_at', { ascending: false }).limit(200),
        this.client.from('household_members').select('*').eq('household_id', hid).order('notify_priority'),
      ]);
      if (hRes.error) throw hRes.error;
      const myMid = membership && membership.id;
      const notifs = (nRes.data || []).filter(n => {
        if (!n.recipient_member_id) return true;
        return myMid && n.recipient_member_id === myMid;
      });
      return {
        memberships,
        membership,
        household: hRes.data,
        elders: eRes.data || [],
        contacts: cRes.data || [],
        messages: msgRes.data || [],
        notifications: notifs,
        medication_reminders: mrRes.data || [],
        medication_doses: mdRes.data || [],
        members: memRes.data || [],
      };
    }
    async addElder(householdId, name, nick) {
      const { data, error } = await this.client.rpc('add_elder', {
        p_household_id: householdId, p_name: name, p_nick: nick || null
      });
      if (error) throw error;
      return data;
    }
    async refreshPairingCode(elderId) {
      const { data, error } = await this.client.rpc('refresh_pairing_code', { p_elder_id: elderId });
      if (error) throw error;
      return data;
    }
    async pairWithCode(code) {
      const { data, error } = await this.client.rpc('pair_with_code', { p_code: code });
      if (error) throw error;
      return data;
    }
    async doCheckIn(elderId) {
      const { data, error } = await this.client.rpc('do_check_in', { p_elder_id: elderId });
      if (error) throw error;
      return data;
    }
    async markMessagesRead(elderId, viewer) {
      const { error } = await this.client.rpc('mark_messages_read', { p_elder_id: elderId, p_viewer: viewer });
      if (error) throw error;
    }
    async markMessageRead(messageId, viewer) {
      /* presok-msg-read-badge-v40 — direct update of read flag (messages_guard_update allows) */
      const patch = viewer === 'elder' ? { read_by_elder: true } : { read_by_family: true };
      const { error } = await this.client.from('messages').update(patch).eq('id', messageId);
      if (error) throw error;
    }
    async updateHousehold(patch) {
      const row = {};
      if (patch.threshold_hours != null) row.threshold_hours = patch.threshold_hours;
      if (patch.care_reply_hours != null) row.care_reply_hours = patch.care_reply_hours;
      if (patch.auto_answer_calls != null) row.auto_answer_calls = patch.auto_answer_calls;
      if (patch.escalation_minutes != null) row.escalation_minutes = patch.escalation_minutes;
      const { data, error } = await this.client.from('households').update(row).eq('id', patch.id).select().single();
      if (error) throw error;
      return data;
    }
    async deleteElder(id) {
      const { error } = await this.client.from('elders').delete().eq('id', id);
      if (error) throw error;
    }
    async setLastCheckIn(elderId, iso, stepNotified) {
      const { data, error } = await this.client.from('elders').update({
        last_check_in: iso,
        step_notified: stepNotified != null ? stepNotified : 1,
        reminded_at: null,
        alerted_at: null,
      }).eq('id', elderId).select().single();
      if (error) throw error;
      return data;
    }
    async sweepMyHouseholdMissed() {
      const { data, error } = await this.client.rpc('sweep_my_household_missed');
      if (error) throw error;
      return data;
    }
    async addContact(householdId, name, phone, role) {
      const { data: existing } = await this.client.from('contacts').select('sort_order').eq('household_id', householdId).order('sort_order', { ascending: false }).limit(1);
      const sort_order = existing && existing[0] ? existing[0].sort_order + 1 : 0;
      const { data, error } = await this.client.from('contacts').insert({
        household_id: householdId, name, phone: phone || '', role: role || 'family', sort_order
      }).select().single();
      if (error) throw error;
      return data;
    }
    async deleteContact(id) {
      const { error } = await this.client.from('contacts').delete().eq('id', id);
      if (error) throw error;
    }
    async reorderContact(id, dir) {
      const { data: c, error } = await this.client.from('contacts').select('*').eq('id', id).single();
      if (error) throw error;
      const { data: list, error: lErr } = await this.client.from('contacts').select('*').eq('household_id', c.household_id).order('sort_order');
      if (lErr) throw lErr;
      const idx = list.findIndex(x => x.id === id);
      const swap = list[idx + (dir === 'up' ? -1 : 1)];
      if (!swap) return;
      await this.client.from('contacts').update({ sort_order: swap.sort_order }).eq('id', c.id);
      await this.client.from('contacts').update({ sort_order: c.sort_order }).eq('id', swap.id);
    }
    async clearNotifications(householdId) {
      const { error } = await this.client.from('notifications').delete().eq('household_id', householdId);
      if (error) throw error;
    }
    async sos(elderId) {
      const { data, error } = await this.client.rpc('raise_sos', { p_elder_id: elderId });
      if (error) throw error;
      return data;
    }
    async acknowledgeAlert(notificationId) {
      const { data, error } = await this.client.rpc('acknowledge_alert', { p_notification_id: notificationId });
      if (error) throw error;
      return data;
    }
    async reorderMemberPriority(memberId, dir) {
      const { error } = await this.client.rpc('reorder_member_priority', { p_member_id: memberId, p_dir: dir });
      if (error) throw error;
    }
    async setMemberDisplayName(memberId, name) {
      const { data, error } = await this.client.rpc('set_member_display_name', { p_member_id: memberId, p_name: name });
      if (error) throw error;
      return data;
    }
    async sendRtcSignal(payload) {
      const hid = payload && payload.household_id;
      if (!hid) throw new Error('household_id required');
      const chName = 'presok-rtc-' + hid;
      let ch = this._rtcChannels && this._rtcChannels[hid];
      if (!ch) {
        if (!this._rtcChannels) this._rtcChannels = {};
        ch = this.client.channel(chName, { config: { broadcast: { self: false } } });
        ch.on('broadcast', { event: 'signal' }, ({ payload: p }) => {
          for (const h of this._handlers) {
            try { h('rtc', p); } catch (e) { console.warn(e); }
          }
        });
        await new Promise((resolve) => { ch.subscribe((status) => { if (status === 'SUBSCRIBED') resolve(); }); });
        this._rtcChannels[hid] = ch;
        this.channels.push(ch);
      }
      const { data: { user } } = await this.client.auth.getUser();
      await ch.send({
        type: 'broadcast',
        event: 'signal',
        payload: Object.assign({}, payload, { from_user_id: user && user.id, at: new Date().toISOString() }),
      });
      return { ok: true };
    }
    async sendVoice(elderId, fromRole, blob, durationMs) {
      const st = await this.getState();
      const elder = (st.elders || []).find(e => e.id === elderId);
      if (!elder) throw new Error('Elder not found');
      const id = crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(16).slice(2));
      const ext = (blob.type || '').includes('mp4') ? 'm4a' : 'webm';
      const storage_path = `${elder.household_id}/${id}.${ext}`;
      const { error: upErr } = await this.client.storage.from('voice').upload(storage_path, blob, {
        contentType: blob.type || 'audio/webm',
        upsert: false
      });
      if (upErr) throw upErr;
      const { data, error } = await this.client.from('messages').insert({
        id,
        household_id: elder.household_id,
        elder_id: elderId,
        from_role: fromRole,
        storage_path,
        duration_ms: durationMs || 0,
        read_by_elder: fromRole === 'elder',
        read_by_family: fromRole === 'family',
      }).select().single();
      if (error) throw error;
      if (fromRole === 'elder') {
        await this.doCheckIn(elderId);
      }
      return data;
    }
    async voiceUrl(storagePath) {
      if (!storagePath) return null;
      const { data, error } = await this.client.storage.from('voice').createSignedUrl(storagePath, 3600);
      if (error) throw error;
      return data.signedUrl;
    }
    async upsertMedicationReminder(elderId, name, doseNote, times, active, id, timezone) {
      const { data, error } = await this.client.rpc('upsert_medication_reminder', {
        p_elder_id: elderId,
        p_name: name,
        p_dose_note: doseNote || null,
        p_times: times,
        p_active: active != null ? !!active : true,
        p_id: id || null,
        p_timezone: timezone || 'Australia/Melbourne',
      });
      if (error) throw error;
      return data;
    }
    async deleteMedicationReminder(id) {
      const { error } = await this.client.rpc('delete_medication_reminder', { p_id: id });
      if (error) throw error;
    }
    async ensureMedicationDoses(days) {
      const { data, error } = await this.client.rpc('ensure_medication_doses', { p_days: days || 1 });
      if (error) throw error;
      return data;
    }
    async markMedicationTaken(doseId) {
      const { data, error } = await this.client.rpc('mark_medication_taken', { p_dose_id: doseId });
      if (error) throw error;
      return data;
    }
    async sweepMyHouseholdMissedMeds() {
      const { data, error } = await this.client.rpc('sweep_my_household_missed_meds');
      if (error) throw error;
      return data;
    }
    async sweepMyHouseholdEscalations() {
      const { data, error } = await this.client.rpc('sweep_my_household_escalations');
      if (error) throw error;
      return data;
    }
    subscribe(handler) {
      this._handlers.add(handler);
      const notify = (type, payload) => {
        for (const h of this._handlers) {
          try { h(type, payload); } catch (e) { console.warn(e); }
        }
      };
      const ch = this.client.channel('presok-live')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'elders' }, (p) => notify('elder', p.new || p.old))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, (p) => notify('message', p.new || p.old))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, (p) => notify('notification', p.new || p.old))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'contacts' }, (p) => notify('contact', p.new || p.old))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'households' }, (p) => notify('household', p.new || p.old))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'medication_reminders' }, (p) => notify('medication_reminder', p.new || p.old))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'medication_doses' }, (p) => notify('medication_dose', p.new || p.old))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'escalation_cases' }, (p) => notify('escalation_case', p.new || p.old))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'household_members' }, (p) => notify('member', p.new || p.old))
        .subscribe();
      this.channels.push(ch);
      return () => this._handlers.delete(handler);
    }
    persistDevice(extra) {
      saveDevice(Object.assign({ mode: 'supabase' }, extra || {}));
    }
    signOut() {
      clearDevice();
      try { this.client && this.client.auth.signOut(); } catch {}
      this.channels.forEach(c => { try { this.client.removeChannel(c); } catch {} });
      this.channels = [];
    }
  }

  function createCloud(config) {
    if (!config || config.mode === 'local') return null;
    if (config.mode === 'supabase') {
      if (!config.supabaseUrl || !config.supabaseAnonKey || config.supabaseAnonKey.indexOf('YOUR_') === 0) {
        console.warn('Presok: supabase credentials missing — falling back to local');
        return null;
      }
      return new SupabaseCloud(config.supabaseUrl, config.supabaseAnonKey);
    }
    return new MockCloud(config.mockUrl);
  }

  function mapRemoteToState(remote, prev) {
    const h = remote.household || {};
    const elders = (remote.elders || []).map(e => ({
      id: e.id,
      name: e.name,
      nick: e.nick || null,
      lastCheckIn: e.last_check_in ? Date.parse(e.last_check_in) : null,
      remindedAt: e.reminded_at ? Date.parse(e.reminded_at) : null,
      alertedAt: e.alerted_at ? Date.parse(e.alerted_at) : null,
      stepNotified: e.step_notified || 1,
      pairingCode: e.pairing_code || null,
      pairingExpiresAt: e.pairing_expires_at || null,
    }));
    const contacts = (remote.contacts || []).map(c => ({
      id: c.id, name: c.name, phone: c.phone || '', role: c.role || 'family', sortOrder: c.sort_order
    }));
    const messages = (remote.messages || []).map(m => ({
      id: m.id,
      elderId: m.elder_id,
      from: m.from_role,
      durationMs: m.duration_ms || 0,
      at: m.created_at ? Date.parse(m.created_at) : Date.now(),
      readByElder: !!m.read_by_elder,
      readByFamily: !!m.read_by_family,
      storagePath: m.storage_path || null,
    }));
    const notifications = (remote.notifications || []).map(n => ({
      id: n.id,
      level: n.level,
      kind: n.kind,
      elderId: n.elder_id,
      message: n.message,
      at: n.created_at ? Date.parse(n.created_at) : Date.now(),
      recipientMemberId: n.recipient_member_id || null,
      escalationTier: n.escalation_tier != null ? Number(n.escalation_tier) : null,
      escalationId: n.escalation_id || null,
      ackedAt: n.acked_at ? Date.parse(n.acked_at) : null,
      ackedByMemberId: n.acked_by_member_id || null,
      handlingName: n.handling_name || null,
    }));
    const rawMembers = remote.members || remote.household_members || [];
    const members = rawMembers.map(m => ({
      id: m.id,
      userId: m.user_id,
      role: m.role,
      elderId: m.elder_id || null,
      displayName: m.display_name || '',
      notifyPriority: m.notify_priority != null ? Number(m.notify_priority) : 99,
    }));
    const medicationReminders = (remote.medication_reminders || []).map(r => ({
      id: r.id,
      elderId: r.elder_id,
      name: r.name,
      doseNote: r.dose_note || '',
      timesLocal: r.times_local || [],
      timezone: r.timezone || 'Australia/Melbourne',
      active: r.active !== false,
    }));
    const medicationDoses = (remote.medication_doses || []).map(d => ({
      id: d.id,
      reminderId: d.reminder_id,
      elderId: d.elder_id,
      timeLocal: d.time_local,
      dueAt: d.due_at ? Date.parse(d.due_at) : null,
      status: d.status || 'pending',
      takenAt: d.taken_at ? Date.parse(d.taken_at) : null,
      missedNotifiedAt: d.missed_notified_at ? Date.parse(d.missed_notified_at) : null,
    }));
    const membership = remote.membership;
    return {
      schemaVersion: 6,
      cloud: true,
      householdId: h.id || null,
      membershipRole: membership ? membership.role : null,
      membershipId: membership ? membership.id : null,
      membershipElderId: membership && membership.elder_id ? membership.elder_id : null,
      lang: (prev && prev.lang) || 'en',
      role: membership && membership.role === 'elder' ? 'elder' : 'family',
      thresholdHours: h.threshold_hours || 24,
      careReplyHours: h.care_reply_hours != null ? Number(h.care_reply_hours) : 12,
      autoAnswerCalls: !!h.auto_answer_calls,
      escalationMinutes: h.escalation_minutes != null ? Number(h.escalation_minutes) : 15,
      timeOffsetMs: (prev && prev.timeOffsetMs) || 0,
      activeElderId: (membership && membership.elder_id)
        || (prev && prev.activeElderId && elders.some(e => e.id === prev.activeElderId) && prev.activeElderId)
        || (elders[0] && elders[0].id)
        || null,
      activeCall: null,
      elders,
      contacts,
      members,
      notifications,
      messages,
      medicationReminders,
      medicationDoses,
      alertsSeenAt: (prev && prev.alertsSeenAt) || 0,
    };
  }

  global.PresokCloud = {
    createCloud,
    mapRemoteToState,
    loadDevice,
    saveDevice,
    clearDevice,
    SESSION_KEY,
  };
})(typeof window !== 'undefined' ? window : globalThis);
