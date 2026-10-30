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
      ['elder', 'message', 'notification', 'household', 'contact', 'messages', 'contacts', 'elder_deleted', 'notifications_cleared', 'contact_deleted']
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
        return { memberships: [], membership: null, household: null, elders: [], contacts: [], messages: [], notifications: [] };
      }
      const membership = memberships.find(m => m.role === 'family') || memberships[0];
      const hid = membership.household_id;
      const [hRes, eRes, cRes, msgRes, nRes] = await Promise.all([
        this.client.from('households').select('*').eq('id', hid).single(),
        this.client.from('elders').select('*').eq('household_id', hid).order('created_at'),
        this.client.from('contacts').select('*').eq('household_id', hid).order('sort_order'),
        this.client.from('messages').select('*').eq('household_id', hid).order('created_at', { ascending: false }),
        this.client.from('notifications').select('*').eq('household_id', hid).order('created_at', { ascending: false }).limit(50),
      ]);
      if (hRes.error) throw hRes.error;
      return {
        memberships,
        membership,
        household: hRes.data,
        elders: eRes.data || [],
        contacts: cRes.data || [],
        messages: msgRes.data || [],
        notifications: nRes.data || [],
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
    async updateHousehold(patch) {
      const { data, error } = await this.client.from('households').update({
        threshold_hours: patch.threshold_hours,
        care_reply_hours: patch.care_reply_hours,
        auto_answer_calls: patch.auto_answer_calls,
      }).eq('id', patch.id).select().single();
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
      const st = await this.getState();
      const elder = (st.elders || []).find(e => e.id === elderId);
      if (!elder) throw new Error('Elder not found');
      const { data, error } = await this.client.from('notifications').insert({
        household_id: elder.household_id,
        elder_id: elderId,
        level: 'alert',
        kind: 'sos',
        message: `🆘 ${elder.name} pressed SOS! Contact them or call 000 now`,
      }).select().single();
      if (error) throw error;
      return data;
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
    }));
    const membership = remote.membership;
    return {
      schemaVersion: 5,
      cloud: true,
      householdId: h.id || null,
      membershipRole: membership ? membership.role : null,
      membershipElderId: membership && membership.elder_id ? membership.elder_id : null,
      lang: (prev && prev.lang) || 'en',
      role: membership && membership.role === 'elder' ? 'elder' : 'family',
      thresholdHours: h.threshold_hours || 24,
      careReplyHours: h.care_reply_hours != null ? Number(h.care_reply_hours) : 12,
      autoAnswerCalls: !!h.auto_answer_calls,
      timeOffsetMs: 0,
      activeElderId: (membership && membership.elder_id)
        || (prev && prev.activeElderId && elders.some(e => e.id === prev.activeElderId) && prev.activeElderId)
        || (elders[0] && elders[0].id)
        || null,
      activeCall: null,
      elders,
      contacts,
      notifications,
      messages,
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
