import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../utils/api';
import toast from 'react-hot-toast';

const STATUS_COLORS = {
  active: 'badge-active', paused: 'badge-paused', stopped: 'badge-stopped',
  draft: 'badge-draft', completed: 'badge-completed', replied: 'badge-replied'
};

const SEND_STATUS = {
  sent: { label: 'Sent', cls: 'badge-sent' },
  scheduled: { label: 'Scheduled', cls: 'badge-scheduled' },
  failed: { label: 'Failed', cls: 'badge-failed' },
  skipped: { label: 'Skipped', cls: 'badge-skipped' },
  opened: { label: 'Opened', cls: 'badge-opened' },
};

function getSendStatus(send) {
  if (!send) return { label: 'Pending', cls: 'badge-draft' };
  if (send.opened_at) return { label: '👁 Opened', cls: 'badge-opened' };
  return SEND_STATUS[send.status] || { label: send.status, cls: 'badge-draft' };
}

function getSeenBadge(send) {
  if (!send?.opened_at) return null;
  return { label: 'Seen', cls: 'badge-opened' };
}

export default function SequenceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [seq, setSeq] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [activity, setActivity] = useState([]);
  const [tab, setTab] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [tooltip, setTooltip] = useState(null);
  const [selectedContacts, setSelectedContacts] = useState(new Set());
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkAction, setBulkAction] = useState('reschedule'); // reschedule | send_now
  const [bulkDateTime, setBulkDateTime] = useState('');
  const [bulkSender, setBulkSender] = useState('');
  const [aliases, setAliases] = useState([]);
  const [smtpAccounts, setSmtpAccounts] = useState([]);
  const [bulkLoading, setBulkLoading] = useState(false); // { x, y, step, send, emailMeta }

  const [seqEmails, setSeqEmails] = useState([]);

  const loadSendingOptions = async () => {
    try {
      const [aliasRes, smtpRes] = await Promise.all([
        api.get('/auth/gmail/aliases').catch(() => ({ data: [] })),
        api.get('/smtp').catch(() => ({ data: [] }))
      ]);
      setAliases(aliasRes.data || []);
      setSmtpAccounts(smtpRes.data || []);
    } catch {}
  };


  const formatIST = (dateStr) => {
    if (!dateStr) return '';
    // Strip Z or timezone offset — DB stores in IST already, no conversion needed
    const clean = dateStr.replace('Z', '').replace(/[+-]\d{2}:\d{2}$/, '');
    const d = new Date(clean);
    if (isNaN(d)) return dateStr;
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy}, ${hh}:${min}`;
  };

  const load = async () => {
    try {
      const [seqRes, contRes, actRes] = await Promise.all([
        api.get(`/sequences/${id}`),
        api.get(`/sequences/${id}/contacts`),
        api.get(`/sequences/${id}/activity`)
      ]);
      setSeq(seqRes.data);
      setSeqEmails(seqRes.data.emails || []);
      setContacts(contRes.data);
      setActivity(actRes.data);
    } catch { toast.error('Failed to load'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); loadSendingOptions(); }, [id]);

  // Auto refresh every 30s if active
  useEffect(() => {
    if (seq?.status !== 'active') return;
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [seq?.status]);

  const pause = async () => {
    await api.post(`/sequences/${id}/pause`);
    toast.success('Paused'); load();
  };

  const resume = async () => {
    await api.post(`/sequences/${id}/resume`);
    toast.success('Resumed'); load();
  };

  const stop = async () => {
    if (!window.confirm('Stop this sequence?')) return;
    await api.post(`/sequences/${id}/stop`);
    toast.success('Stopped'); load();
  };

  const duplicate = async () => {
    const res = await api.post(`/sequences/${id}/duplicate`);
    toast.success('Duplicated!');
    navigate(`/sequences/${res.data.id}/edit`);
  };

  if (loading) return <div className="page-loader"><div className="spinner" /></div>;

  const stopContact = async (contactId, email) => {
    if (!window.confirm(`Stop sending emails to ${email}?`)) return;
    try {
      await api.post(`/sequences/${id}/contacts/${contactId}/stop`);
      toast.success(`Stopped emails to ${email}`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to stop contact');
    }
  };

  const resumeContact = async (contactId, email) => {
    try {
      const res = await api.post(`/sequences/${id}/contacts/${contactId}/resume`);
      toast.success(res.data.message || `Resumed ${email} from step ${res.data.nextStep}`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to resume contact');
    }
  };

  const forceSend = async (contactId, stepNumber) => {
    if (!window.confirm('Send this email now immediately?')) return;
    try {
      await api.post(`/sequences/${id}/force-send`, { contact_id: contactId, step_number: stepNumber });
      toast.success('Email sent!');
      loadContacts();
      loadActivity();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to send');
    }
  };



  const renderTemplate = (text, data) => {
    if (!text || !data) return text || '';
    return text.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
      const trimmed = key.trim();
      if (data[trimmed] !== undefined) return data[trimmed];
      const found = Object.keys(data).find(k => k.toLowerCase() === trimmed.toLowerCase());
      return found !== undefined ? data[found] : match;
    });
  };

  const showTooltip = (e, step, send, stepNum, contactData) => {
    const emailMeta = seqEmails.find(em => em.step_number === stepNum);
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip({
      x: rect.left + rect.width / 2,
      y: rect.top - 10,
      step, send, emailMeta, stepNum, contactData
    });
  };

  const hideTooltip = () => setTooltip(null);


  const toggleSelect = (contactId) => {
    setSelectedContacts(prev => {
      const next = new Set(prev);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });
  };

  const selectAllFailed = () => {
    const failedIds = filteredContacts
      .filter(c => (c.sends || []).some(s => s.status === 'failed'))
      .map(c => c.id);
    setSelectedContacts(new Set(failedIds));
  };

  const selectAllScheduled = () => {
    const scheduledIds = filteredContacts
      .filter(c => (c.sends || []).some(s => s.status === 'scheduled'))
      .map(c => c.id);
    setSelectedContacts(new Set(scheduledIds));
  };

  const clearSelection = () => setSelectedContacts(new Set());

  const executeBulkAction = async () => {
    if (selectedContacts.size === 0) return toast.error('No contacts selected');
    if (bulkAction === 'reschedule' && !bulkDateTime) return toast.error('Please select a date and time');

    // Close modal immediately
    setShowBulkModal(false);
    setSelectedContacts(new Set());
    toast.success(bulkAction === 'reschedule' ? '🕐 Rescheduling in background...' : '⚡ Sending in background...');

    // Process in background without blocking UI
    const contactsToProcess = Array.from(selectedContacts);
    (async () => {
      let success = 0, failed = 0;
      for (const contactId of contactsToProcess) {
        const contact = contacts.find(c => c.id === contactId);
        if (!contact) continue;
        const failedOrScheduled = (contact.sends || []).filter(s => s.status === 'failed' || s.status === 'scheduled');
        for (const send of failedOrScheduled) {
          try {
            if (bulkAction === 'reschedule') {
              await api.post(`/sequences/${id}/reschedule-send`, {
                scheduled_at: new Date(bulkDateTime).toISOString(),
                contact_id: contactId,
                step_number: send.step,
                override_sender: bulkSender || undefined
              });
            } else {
              await api.post(`/sequences/${id}/force-send`, {
                contact_id: contactId,
                step_number: send.step,
                override_sender: bulkSender || undefined
              });
            }
            success++;
          } catch { failed++; }
        }
      }
      toast.success(`✅ Done! ${success} succeeded${failed > 0 ? `, ${failed} failed` : ''}`);
      load();
    })();
  };

  if (!seq) return <div className="page-loader">Sequence not found</div>;

  const filteredContacts = filter === 'all' ? contacts : contacts.filter(c => c.status === filter);

  const EVENT_ICONS = {
    email_sent: '📤', email_opened: '👁', reply_detected: '💬',
    followup_skipped: '⏭', limit_reached: '⚠️', sequence_launched: '🚀',
    sequence_paused: '⏸', sequence_stopped: '⏹', sequence_resumed: '▶'
  };

  return (
    <div className="main-content">
      <div className="page-header">
        <div>
          <div className="flex-center gap-8" style={{ marginBottom: 4 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>← Back</button>
          </div>
          <div className="flex-center gap-12">
            <div className="page-title">{seq.name}</div>
            <span className={`badge ${STATUS_COLORS[seq.status]}`}>{seq.status}</span>
          </div>
          <div className="page-subtitle">From: {seq.from_email || 'Not set'}</div>
        </div>
        <div className="flex-center gap-8">
          <button className="btn btn-secondary" onClick={() => navigate(`/sequences/${id}/edit`)}>✏️ Edit</button>
          <button className="btn btn-secondary" onClick={duplicate}>⧉ Duplicate</button>
          {seq.status === 'active' && <button className="btn btn-secondary" onClick={pause}>⏸ Pause</button>}
          {seq.status === 'paused' && <button className="btn btn-success" onClick={resume}>▶ Resume</button>}
          {['active', 'paused'].includes(seq.status) && <button className="btn btn-danger" onClick={stop}>⏹ Stop</button>}
        </div>
      </div>

      <div className="page-body">
        {/* Daily limit warning */}
        {seq.daily_limit_hit && (
          <div className="alert alert-warning" style={{ marginBottom: 16 }}>
            ⚠️ Gmail daily sending limit reached. Sending will resume at {seq.daily_limit_reset_at ? formatIST(seq.daily_limit_reset_at) : 'tomorrow'}.
          </div>
        )}

        {/* Stats */}
        <div className="stats-grid" style={{ marginBottom: 24 }}>
          {[
            { label: 'Total Contacts', value: contacts.length, color: 'var(--text)' },
            { label: 'Sent', value: seq.sent_count || 0, color: 'var(--green)' },
            { label: 'Opened', value: seq.opened_count || 0, color: 'var(--yellow)' },
            { label: 'Replied', value: seq.replied_count || 0, color: 'var(--accent2)' },
          ].map(s => (
            <div key={s.label} className="stat-card">
              <div className="stat-value" style={{ color: s.color }}>{s.value}</div>
              <div className="stat-label">{s.label}</div>
              {s.value > 0 && contacts.length > 0 && (
                <div className="text-xs" style={{ marginTop: 4 }}>
                  {Math.round((s.value / contacts.length) * 100)}%
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="tabs">
          {['Contacts', 'Activity Log'].map((t, i) => (
            <button key={t} className={`tab ${tab === i ? 'active' : ''}`} onClick={() => setTab(i)}>{t}</button>
          ))}
        </div>

        {/* Contacts tab */}
        {tab === 0 && (
          <div>
            {/* Filter */}
            <div className="flex-center gap-8" style={{ marginBottom: 16 }}>
              {['all', 'active', 'replied', 'completed', 'stopped'].map(f => (
                <button key={f} className={`btn btn-sm ${filter === f ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setFilter(f)}>
                  {f === 'all' ? `All (${contacts.length})` : f}
                </button>
              ))}
            </div>

            {filteredContacts.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-title">No contacts</div>
              </div>
            ) : (
              <>
              {/* Bulk Action Bar */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <button className="btn btn-sm btn-secondary" onClick={selectAllFailed}>Select Failed</button>
                <button className="btn btn-sm btn-secondary" onClick={selectAllScheduled}>Select Scheduled</button>
                {selectedContacts.size > 0 && <>
                  <span style={{ fontSize: 12, color: 'var(--text2)' }}>{selectedContacts.size} selected</span>
                  <button className="btn btn-sm btn-primary" onClick={() => setShowBulkModal(true)}>⚡ Bulk Action</button>
                  <button className="btn btn-sm btn-ghost" onClick={clearSelection}>Clear</button>
                </>}
              </div>
              <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
                <table className="table" style={{ minWidth: 700 }}>
                  <thead>
                    <tr>
                      <th style={{ minWidth: 200 }}>Email</th>
                      <th style={{ minWidth: 90 }}>Status</th>
                      <th style={{ minWidth: 260 }}>
                        <div>Steps {seqEmails.length > 0 && <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--text3)' }}>({seqEmails.length} — hover to preview)</span>}</div>
                        <div style={{ fontSize: 10, fontWeight: 400, color: 'var(--text3)', marginTop: 2, display: 'flex', gap: 6 }}>
                          <span style={{ color: '#22c55e' }}>■ sent</span>
                          <span style={{ color: '#f59e0b' }}>■ opened</span>
                          <span style={{ color: 'var(--accent, #6c63ff)' }}>■ scheduled</span>
                          <span style={{ color: '#ef4444' }}>■ failed</span>
                          <span style={{ color: '#6b7280' }}>■ skipped</span>
                        </div>
                      </th>
                      <th style={{ minWidth: 150 }}>Last Activity</th>
                      <th style={{ minWidth: 90 }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredContacts.map(c => {
                      const sends = c.sends || [];

                      return (
                        <tr key={c.id}>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <input type="checkbox" checked={selectedContacts.has(c.id)}
                                onChange={() => toggleSelect(c.id)}
                                onClick={e => e.stopPropagation()}
                                style={{ cursor: 'pointer', width: 14, height: 14 }} />
                              <div>
                                <div style={{ fontWeight: 500 }}>{c.email}</div>
                                {c.data?.name && <div className="text-xs">{c.data.name}</div>}
                              </div>
                            </div>
                          </td>
                          <td><span className={`badge ${STATUS_COLORS[c.status] || 'badge-draft'}`}>{c.status}</span></td>
                          <td>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'flex-start' }}>
                              {seqEmails.map(emailMeta => {
                                const send = sends.find(s => s.step === emailMeta.step_number);
                                const dotColor = !send ? '#374151'
                                  : send.opened_at ? '#f59e0b'
                                  : send.status === 'sent' ? '#22c55e'
                                  : send.status === 'scheduled' ? 'var(--accent, #6c63ff)'
                                  : send.status === 'failed' ? '#ef4444'
                                  : '#6b7280';
                                return (
                                  <div key={emailMeta.step_number} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                                    <div
                                      onMouseEnter={e => send && showTooltip(e, send, send, emailMeta.step_number, c.data)}
                                      onMouseLeave={hideTooltip}
                                      style={{
                                        width: 26, height: 26, borderRadius: 5,
                                        background: dotColor,
                                        border: !send ? '1px dashed #4b5563' : 'none',
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        cursor: send ? 'pointer' : 'default',
                                        fontSize: 11, color: '#fff', fontWeight: 700,
                                        flexShrink: 0,
                                      }}
                                      title={`Step ${emailMeta.step_number}: ${send ? getSendStatus(send).label : 'Not yet scheduled'}`}
                                    >
                                      {emailMeta.step_number}
                                    </div>
                                    {send?.status === 'scheduled' && (
                                      <button
                                        onClick={() => forceSend(c.id, emailMeta.step_number)}
                                        title="Send now"
                                        style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 3, padding: '1px 5px', fontSize: 10, cursor: 'pointer', fontWeight: 600 }}
                                      >⚡</button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </td>
                          <td className="text-xs">
                            {(() => {
                              // Find next scheduled email
                              const nextScheduled = sends.filter(s => s.status === 'scheduled' && s.scheduled_at).sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))[0];
                              if (nextScheduled) {
                                return <span style={{ color: 'var(--accent)' }}>🕐 {formatIST(nextScheduled.scheduled_at)}</span>;
                              }
                              // If no scheduled, show last sent time
                              const lastSentItem = sends.filter(s => s.sent_at).sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))[0];
                              if (lastSentItem) {
                                return <span style={{ color: 'var(--text3)' }}>✅ Sent {formatIST(lastSentItem.sent_at)}</span>;
                              }
                              return '—';
                            })()}
                          </td>
                          <td>
                            {c.status === 'stopped' ? (
                              <button
                                onClick={() => resumeContact(c.id, c.email)}
                                style={{ background: 'var(--green, #22c55e)', color: '#fff', border: 'none', borderRadius: 4, padding: '3px 9px', fontSize: 11, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}
                                title="Resume sending to this contact">
                                ▶ Resume
                              </button>
                            ) : ['active', 'pending'].includes(c.status) ? (
                              <button
                                onClick={() => stopContact(c.id, c.email)}
                                style={{ background: 'var(--red, #ef4444)', color: '#fff', border: 'none', borderRadius: 4, padding: '3px 9px', fontSize: 11, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}
                                title="Stop all future emails to this contact">
                                ⏹ Stop
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </div>
        )}

        {/* Activity log tab */}
        {tab === 1 && (
          <div>
            {activity.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-title">No activity yet</div>
                <div className="empty-state-desc">Activity will appear here once the sequence is launched</div>
              </div>
            ) : (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Event</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.map(a => (
                      <tr key={a.id}>
                        <td className="text-xs mono">{formatIST(a.created_at)}</td>
                        <td>
                          <span style={{ fontSize: 13 }}>
                            {EVENT_ICONS[a.event_type] || '•'} {a.event_type?.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className="text-sm" style={{ color: 'var(--text2)' }}>{a.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>


      {/* Bulk Action Modal */}
      {showBulkModal && (
        <div className="modal-overlay" onClick={() => setShowBulkModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">⚡ Bulk Action — {selectedContacts.size} contacts</div>
              <button className="btn btn-ghost btn-icon" onClick={() => setShowBulkModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              {/* Action Type */}
              <div className="form-group">
                <label className="form-label">Action</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className={`btn btn-sm ${bulkAction === 'reschedule' ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setBulkAction('reschedule')}>🕐 Reschedule</button>
                  <button className={`btn btn-sm ${bulkAction === 'send_now' ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setBulkAction('send_now')}>⚡ Send Now</button>
                </div>
              </div>

              {/* Reschedule - date/time picker + sender */}
              {bulkAction === 'reschedule' && (
                <>
                  <div className="form-group">
                    <label className="form-label">New Schedule Date & Time</label>
                    <input className="input" type="datetime-local"
                      value={bulkDateTime} onChange={e => setBulkDateTime(e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Send From (optional)</label>
                    <select className="input" value={bulkSender} onChange={e => setBulkSender(e.target.value)}>
                      <option value="">Use sequence default</option>
                      {aliases.length > 0 && (
                        <optgroup label="📧 Gmail API">
                          {aliases.map(a => <option key={a.email} value={`gmail:${a.email}`}>{a.name ? `${a.name} <${a.email}>` : a.email}</option>)}
                        </optgroup>
                      )}
                      {smtpAccounts.length > 0 && (
                        <optgroup label="🔌 SMTP">
                          {smtpAccounts.map(a => <option key={a.id} value={`smtp:${a.id}`}>{a.display_name} &lt;{a.smtp_user}&gt;</option>)}
                        </optgroup>
                      )}
                    </select>
                  </div>
                </>
              )}

              {/* Send Now - sender picker */}
              {bulkAction === 'send_now' && (
                <div className="form-group">
                  <label className="form-label">Send From (optional — uses sequence default if empty)</label>
                  <select className="input" value={bulkSender} onChange={e => setBulkSender(e.target.value)}>
                    <option value="">Use sequence default</option>
                    {aliases.length > 0 && (
                      <optgroup label="📧 Gmail API">
                        {aliases.map(a => <option key={a.email} value={`gmail:${a.email}`}>{a.name ? `${a.name} <${a.email}>` : a.email}</option>)}
                      </optgroup>
                    )}
                    {smtpAccounts.length > 0 && (
                      <optgroup label="🔌 SMTP">
                        {smtpAccounts.map(a => <option key={a.id} value={`smtp:${a.id}`}>{a.display_name} &lt;{a.smtp_user}&gt;</option>)}
                      </optgroup>
                    )}
                  </select>
                </div>
              )}

              <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 8 }}>
                This will apply to all failed and scheduled emails for the {selectedContacts.size} selected contact(s).
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowBulkModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={executeBulkAction} disabled={bulkLoading}>
                {bulkLoading ? 'Processing...' : bulkAction === 'reschedule' ? '🕐 Reschedule' : '⚡ Send Now'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Hover Preview Tooltip */}
      {tooltip && (
        <div style={{
          position: 'fixed',
          left: Math.min(tooltip.x, window.innerWidth - 380),
          top: Math.max(tooltip.y - 220, 10),
          width: 360,
          background: 'var(--bg2)',
          border: '1px solid var(--border2)',
          borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
          zIndex: 9999,
          pointerEvents: 'none',
          overflow: 'hidden',
        }}>
          {/* Header */}
          <div style={{ background: 'var(--accent)', padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#fff', fontWeight: 700, fontSize: 13 }}>📧 Step {tooltip.stepNum} Preview</span>
            <span style={{ color: 'rgba(255,255,255,0.8)', fontSize: 11 }}>
              {tooltip.send.status === 'scheduled' ? '🕐 Scheduled' : tooltip.send.status === 'sent' ? '✅ Sent' : tooltip.send.status}
            </span>
          </div>
          {/* Date/Time */}
          <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg3)' }}>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 2 }}>
              {tooltip.send.status === 'sent' ? 'Sent at' : 'Scheduled for'}
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
              {new Date((tooltip.send.sent_at || tooltip.send.scheduled_at || '').replace('Z','').replace(/[+-]\d{2}:\d{2}$/, '')).toLocaleString('en-IN', {
                weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
              })}
            </div>
          </div>
          {/* Subject */}
          {tooltip.emailMeta?.subject && (
            <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 2 }}>Subject</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{renderTemplate(tooltip.emailMeta.subject, tooltip.contactData)}</div>
            </div>
          )}
          {/* Body preview */}
          {tooltip.emailMeta?.body && (
            <div style={{ padding: '8px 14px', maxHeight: 100, overflow: 'hidden' }}>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>Preview</div>
              <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.5, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}
                dangerouslySetInnerHTML={{ __html: renderTemplate(tooltip.emailMeta.body, tooltip.contactData).replace(/<[^>]*>/g, ' ').substring(0, 200) + '...' }}
              />
            </div>
          )}
        </div>
      )}

    </div>
  );
}