import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../utils/api';
import toast from 'react-hot-toast';
import RichEditor from '../components/editor/RichEditor';

const TABS = ['Settings', 'Contacts', 'Emails', 'Preview & Launch'];

export default function SequenceEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState(0);
  const [seq, setSeq] = useState(null);
  const [aliases, setAliases] = useState([]);
  const [smtpAccounts, setSmtpAccounts] = useState([]);
  const [smtpAccountId, setSmtpAccountId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Settings state
  const [name, setName] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [includeSignature, setIncludeSignature] = useState(true);
  const [openTracking, setOpenTracking] = useState(true);
  const [sendDelay, setSendDelay] = useState(7);

  // AI Assistant state
  const [aiPanel, setAiPanel] = useState(null); // { idx, mode }
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState('');

  // Contacts state
  const [csvColumns, setCsvColumns] = useState([]);
  const [contactCount, setContactCount] = useState(0);
  const [csvFilename, setCsvFilename] = useState('');
  const [uploading, setUploading] = useState(false);
  const [attachFilename, setAttachFilename] = useState('');
  const [uploadingAttach, setUploadingAttach] = useState(false);

  // Emails state
  const [emails, setEmails] = useState([{
    step_number: 1, subject: '', body: '', scheduled_at: '', delay_days: 0, delay_hours: 0, delay_minutes: 0
  }]);

  const subjectRefs = useRef([]);
  const [pickerOpen, setPickerOpen] = useState(null);

  const MAX_FOLLOWUPS = 6;
  const MAX_TOTAL_EMAILS = MAX_FOLLOWUPS + 1;

  const load = useCallback(async () => {
    try {
      const [seqRes, aliasRes, smtpRes] = await Promise.all([
        api.get(`/sequences/${id}`),
        api.get('/auth/gmail/aliases').catch(() => ({ data: [] })),
        api.get('/smtp').catch(() => ({ data: [] }))
      ]);
      const s = seqRes.data;
      setSeq(s);
      setName(s.name);
      if (s.smtp_account_id) {
        setSmtpAccountId(s.smtp_account_id);
        setFromEmail('');
      } else {
        setSmtpAccountId(null);
        setFromEmail(s.from_email || '');
      }
      setIncludeSignature(s.include_signature);
      setOpenTracking(s.open_tracking);
      setSendDelay(s.send_delay_seconds ?? 7);
      setCsvColumns(s.csv_columns || []);
      setContactCount(parseInt(s.total_contacts) || 0);
      setCsvFilename(s.csv_filename || '');
      setAttachFilename(s.attachment_filename || '');
      if (s.emails?.length > 0) {
        setEmails(s.emails.map(e => ({
          step_number: e.step_number,
          subject: e.subject || '',
          body: e.body || '',
          scheduled_at: e.scheduled_at ? e.scheduled_at.slice(0, 16) : '',
          delay_days: e.delay_days || 0,
          delay_hours: e.delay_hours || 0,
          delay_minutes: e.delay_minutes || 0
        })));
      }
      setAliases(aliasRes.data || []);
      setSmtpAccounts(smtpRes.data || []);
    } catch (err) {
      toast.error('Failed to load sequence');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const saveSettings = async () => {
    setSaving(true);
    try {
      await api.put(`/sequences/${id}`, { name, from_email: smtpAccountId ? null : fromEmail, include_signature: includeSignature, open_tracking: openTracking, send_delay_seconds: sendDelay, smtp_account_id: smtpAccountId || null });
      toast.success('Settings saved');
    } catch { toast.error('Failed to save'); }
    finally { setSaving(false); }
  };

  const saveEmails = async () => {
    setSaving(true);
    try {
      await api.put(`/sequences/${id}/emails`, { emails });
      toast.success('Emails saved');
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to save emails'); }
    finally { setSaving(false); }
  };

  const uploadCsv = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    const form = new FormData();
    form.append('csv', file);
    try {
      const res = await api.post(`/sequences/${id}/csv`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
      setCsvColumns(res.data.columns);
      setContactCount(res.data.count);
      setCsvFilename(file.name);
      toast.success(`${res.data.count} contacts imported`);
    } catch (err) { toast.error(err.response?.data?.error || 'Upload failed'); }
    finally { setUploading(false); e.target.value = ''; }
  };

  const uploadAttachment = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploadingAttach(true);
    const form = new FormData();
    form.append('attachment', file);
    try {
      await api.post(`/sequences/${id}/attachment`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
      setAttachFilename(file.name);
      toast.success('Attachment uploaded');
    } catch { toast.error('Upload failed'); }
    finally { setUploadingAttach(false); e.target.value = ''; }
  };

  const removeAttachment = async () => {
    try {
      await api.delete(`/sequences/${id}/attachment`);
      setAttachFilename('');
      toast.success('Attachment removed');
    } catch { toast.error('Failed'); }
  };

  const addFollowUp = () => {
    if (emails.length >= MAX_TOTAL_EMAILS) {
      toast.error(`You can add at most ${MAX_FOLLOWUPS} follow-ups`);
      return;
    }
    setEmails(prev => [...prev, {
      step_number: prev.length + 1, subject: '', body: '', scheduled_at: '', delay_days: 3, delay_hours: 0, delay_minutes: 0
    }]);
  };

  const removeFollowUp = (idx) => {
    setEmails(prev => prev.filter((_, i) => i !== idx).map((e, i) => ({ ...e, step_number: i + 1 })));
  };

  const updateEmail = (idx, field, value) => {
    setEmails(prev => prev.map((e, i) => i === idx ? { ...e, [field]: value } : e));
  };

  const insertVariable = (idx, col) => {
    const ref = subjectRefs.current[idx];
    const placeholder = `{{${col}}}`;
    const current = emails[idx]?.subject || '';
    if (ref) {
      const start = typeof ref.selectionStart === 'number' ? ref.selectionStart : current.length;
      const end = typeof ref.selectionEnd === 'number' ? ref.selectionEnd : start;
      const newVal = current.slice(0, start) + placeholder + current.slice(end);
      updateEmail(idx, 'subject', newVal);
      // restore focus and caret after update
      setTimeout(() => {
        try { ref.focus(); ref.setSelectionRange(start + placeholder.length, start + placeholder.length); } catch (e) {}
      }, 0);
    } else {
      updateEmail(idx, 'subject', current + placeholder);
    }
    setPickerOpen(null);
  };

  const launch = async () => {
    if (!window.confirm(`Launch sequence to ${contactCount} contacts?`)) return;
    try {
      await api.put(`/sequences/${id}/emails`, { emails });
      const res = await api.post(`/sequences/${id}/launch`);
      toast.success(`🚀 Launched! ${res.data.contactsScheduled} emails scheduled.`);
      navigate(`/sequences/${id}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Launch failed');
    }
  };


  const runAI = async (idx, mode) => {
    const email = emails[idx];
    setAiPanel({ idx, mode });
    setAiResult('');
    setAiLoading(true);

    const isFollowUp = idx > 0;

    try {
      const response = await api.post('/ai/suggest', {
        mode,
        subject: email.subject,
        body: email.body
      });
      setAiResult(response.data.result || 'No response received.');
    } catch (err) {
      setAiResult('Error connecting to AI. Please try again.');
    } finally {
      setAiLoading(false);
    }
  };

  const applyAiResult = (idx, mode) => {
    if (mode === 'improve' || mode === 'followup') {
      updateEmail(idx, 'body', '<p>' + aiResult.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>') + '</p>');
      toast.success('Applied to email body!');
    } else if (mode === 'subject') {
      // Extract first subject line
      const firstLine = aiResult.split('\n').find(l => l.match(/^1[\.\)]/));
      if (firstLine) {
        updateEmail(idx, 'subject', firstLine.replace(/^1[\.\)]\s*/, ''));
        toast.success('Applied first subject line!');
      }
    }
    setAiPanel(null);
    setAiResult('');
  };

  if (loading) return <div className="page-loader"><div className="spinner" /></div>;

  return (
    <div className="main-content">
      <div className="page-header">
        <div>
          <div className="flex-center gap-8" style={{ marginBottom: 4 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>← Back</button>
            <span style={{ color: 'var(--text3)' }}>/</span>
            <span style={{ fontSize: 13, color: 'var(--text2)' }}>{name}</span>
          </div>
          <div className="page-title">Edit Sequence</div>
        </div>
        {tab === 3 ? (
          <button className="btn btn-primary btn-lg" onClick={launch}>🚀 Launch Sequence</button>
        ) : (
          <button className="btn btn-secondary" onClick={tab === 0 ? saveSettings : tab === 2 ? saveEmails : null} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        )}
      </div>

      <div className="page-body">
        <div className="tabs">
          {TABS.map((t, i) => (
            <button key={t} className={`tab ${tab === i ? 'active' : ''}`} onClick={() => setTab(i)}>{t}</button>
          ))}
        </div>

        {/* TAB 0: Settings */}
        {tab === 0 && (
          <div style={{ maxWidth: 560 }}>
            <div className="form-group">
              <label className="form-label">Sequence Name</label>
              <input className="input" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Send From</label>
              <select className="select"
                value={smtpAccountId ? `smtp:${smtpAccountId}` : fromEmail}
                onChange={e => {
                  const val = e.target.value;
                  if (val.startsWith('smtp:')) {
                    setSmtpAccountId(val.replace('smtp:', ''));
                    setFromEmail('');
                  } else {
                    setSmtpAccountId(null);
                    setFromEmail(val);
                  }
                }}>
                <option value="">Select sender...</option>
                {aliases.length > 0 && (
                  <optgroup label="📧 Gmail API">
                    {aliases.map(a => (
                      <option key={a.email} value={a.email}>
                        {a.name ? `${a.name} <${a.email}>` : a.email}
                      </option>
                    ))}
                  </optgroup>
                )}
                {smtpAccounts.length > 0 && (
                  <optgroup label="🔌 SMTP">
                    {smtpAccounts.map(a => (
                      <option key={a.id} value={`smtp:${a.id}`}>
                        {a.display_name} &lt;{a.smtp_user}&gt; (SMTP)
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              {smtpAccountId && <div className="form-hint">✅ Sending via SMTP — no Gmail limits</div>}
            </div>
            <div className="form-group">
              <div className="flex-between">
                <div>
                  <div className="form-label" style={{ marginBottom: 2 }}>Include Signature</div>
                  <div className="form-hint" style={{ marginTop: 0 }}>Append your Gmail signature to every email</div>
                </div>
                <label className="toggle">
                  <input type="checkbox" checked={includeSignature} onChange={e => setIncludeSignature(e.target.checked)} />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>
            <div className="form-group">
              <div className="flex-between">
                <div>
                  <div className="form-label" style={{ marginBottom: 2 }}>Open Tracking</div>
                  <div className="form-hint" style={{ marginTop: 0 }}>Track when recipients open emails</div>
                </div>
                <label className="toggle">
                  <input type="checkbox" checked={openTracking} onChange={e => setOpenTracking(e.target.checked)} />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>
            <div className="form-group">
              <div className="form-label">Delay Between Emails (seconds)</div>
              <div className="form-hint">Wait time between sending each email to avoid spam filters</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                <input
                  type="range" min="0" max="60" step="1"
                  value={sendDelay}
                  onChange={e => setSendDelay(parseInt(e.target.value))}
                  style={{ flex: 1 }}
                />
                <span style={{ minWidth: 60, fontWeight: 600, color: 'var(--accent)' }}>{sendDelay}s</span>
              </div>
            </div>
            <button className="btn btn-primary" onClick={saveSettings} disabled={saving}>
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        )}

        {/* TAB 1: Contacts */}
        {tab === 1 && (
          <div style={{ maxWidth: 560 }}>
            {/* CSV Upload */}
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="flex-between" style={{ marginBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 3 }}>Contact List (CSV)</div>
                  <div className="text-xs">CSV must have an "email" column. Other columns become variables.</div>
                </div>
                {csvFilename && <span className="badge badge-active">✓ Loaded</span>}
              </div>

              {csvFilename ? (
                <div>
                  <div className="alert alert-success" style={{ marginBottom: 12 }}>
                    📄 {csvFilename} — {contactCount} contacts imported
                  </div>
                  {csvColumns.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div className="form-label" style={{ marginBottom: 6 }}>Available Variables</div>
                      <div className="flex-center" style={{ flexWrap: 'wrap', gap: 6 }}>
                        {csvColumns.map(c => (
                          <span key={c} className="var-chip">{`{{${c}}}`}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
                    {uploading ? 'Uploading...' : 'Replace CSV'}
                    <input type="file" accept=".csv" style={{ display: 'none' }} onChange={uploadCsv} />
                  </label>
                </div>
              ) : (
                <label className="btn btn-secondary" style={{ cursor: 'pointer', display: 'inline-flex' }}>
                  {uploading ? <><span className="spinner" style={{width:14,height:14}} /> Uploading...</> : '📂 Upload CSV'}
                  <input type="file" accept=".csv" style={{ display: 'none' }} onChange={uploadCsv} disabled={uploading} />
                </label>
              )}
            </div>

            {/* Attachment */}
            <div className="card">
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Attachment</div>
              <div className="text-xs" style={{ marginBottom: 12 }}>One file attached to every email in this sequence (e.g. resume, brochure)</div>
              {attachFilename ? (
                <div className="flex-center gap-8">
                  <div className="alert alert-info" style={{ flex: 1 }}>📎 {attachFilename}</div>
                  <button className="btn btn-danger btn-sm" onClick={removeAttachment}>Remove</button>
                </div>
              ) : (
                <label className="btn btn-secondary" style={{ cursor: 'pointer', display: 'inline-flex' }}>
                  {uploadingAttach ? <><span className="spinner" style={{width:14,height:14}} /> Uploading...</> : '📎 Attach File'}
                  <input type="file" style={{ display: 'none' }} onChange={uploadAttachment} disabled={uploadingAttach} />
                </label>
              )}
            </div>
          </div>
        )}

        {/* TAB 2: Emails */}
        {tab === 2 && (
          <div style={{ maxWidth: 720 }}>
            {csvColumns.length === 0 && (
              <div className="alert alert-warning" style={{ marginBottom: 16 }}>
                ⚠️ Upload a CSV first to use personalization variables in your emails
              </div>
            )}

            <div className="steps">
              {emails.map((email, idx) => (
                <div key={idx} className="step-item">
                  <div className="step-line">
                    <div className="step-dot" style={{ background: idx === 0 ? 'var(--accent)' : 'var(--text3)' }} />
                    <div className="step-connector" />
                  </div>
                  <div className="step-content">
                    <div className="card" style={{ marginBottom: 0 }}>
                      <div className="flex-between" style={{ marginBottom: 14 }}>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>
                          {idx === 0 ? '✉️ Initial Email' : `🔁 Follow-up ${idx}`}
                        </div>
                        {idx > 0 && (
                          <button className="btn btn-danger btn-sm" onClick={() => removeFollowUp(idx)}>Remove</button>
                        )}
                      </div>

                      {/* Schedule */}
                      {idx === 0 ? (
                        <div className="form-group">
                          <label className="form-label">Send Date & Time</label>
                          <input type="datetime-local" className="input" value={email.scheduled_at}
                            onChange={e => updateEmail(idx, 'scheduled_at', e.target.value)}
                            min={(() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}T${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}`; })()} />
                          <div className="form-hint">When to send the initial email</div>
                        </div>
                      ) : (
                            <div className="grid-3" style={{ marginBottom: 16 }}>
                          <div className="form-group" style={{ marginBottom: 0 }}>
                            <label className="form-label">Delay (Days)</label>
                            <input type="number" className="input" min="0" value={email.delay_days}
                              onChange={e => updateEmail(idx, 'delay_days', parseInt(e.target.value) || 0)} />
                          </div>
                          <div className="form-group" style={{ marginBottom: 0 }}>
                            <label className="form-label">Delay (Hours)</label>
                            <input type="number" className="input" min="0" max="23" value={email.delay_hours}
                              onChange={e => updateEmail(idx, 'delay_hours', parseInt(e.target.value) || 0)} />
                          </div>
                          <div className="form-group" style={{ marginBottom: 0 }}>
                            <label className="form-label">Delay (Minutes)</label>
                            <input type="number" className="input" min="0" max="59" value={email.delay_minutes}
                              onChange={e => updateEmail(idx, 'delay_minutes', parseInt(e.target.value) || 0)} />
                          </div>
                          <div className="form-hint" style={{ gridColumn: '1/-1' }}>
                            Sent {email.delay_days}d {email.delay_hours}h {email.delay_minutes}m after previous email — only if no reply received
                          </div>
                        </div>
                      )}

                      {/* Subject */}
                      <div className="form-group">
                        <label className="form-label">Subject</label>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <input
                            ref={el => subjectRefs.current[idx] = el}
                            className="input"
                            style={{ flex: 1 }}
                            value={email.subject}
                            onChange={e => updateEmail(idx, 'subject', e.target.value)}
                            placeholder={idx === 0 ? 'e.g. Internship Application — {{name}}' : `Re: ${emails[0]?.subject || 'your email'}`}
                          />
                          <div style={{ position: 'relative' }}>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPickerOpen(p => p === idx ? null : idx)} disabled={csvColumns.length === 0}>Vars</button>
                            {pickerOpen === idx && csvColumns.length > 0 && (
                              <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', background: 'var(--bg)', border: '1px solid var(--border)', padding: 8, borderRadius: 6, zIndex: 30, minWidth: 180 }}>
                                <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 6 }}>Insert variable</div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                  {csvColumns.map(c => (
                                    <button key={c} type="button" className="btn btn-sm btn-secondary" onClick={() => insertVariable(idx, c)}>
                                      {`{{${c}}}`}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Body */}
                      <div className="form-group">
                        <label className="form-label">Email Body</label>
                        <RichEditor
                          value={email.body}
                          onChange={val => updateEmail(idx, 'body', val)}
                          variables={csvColumns}
                        />
                        {/* AI Buttons */}
                        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 11, color: 'var(--text3)', alignSelf: 'center', marginRight: 4 }}>🤖 AI:</span>
                          <button type="button" className="btn btn-sm btn-secondary" onClick={() => runAI(idx, 'improve')}>✨ Improve Email</button>
                          <button type="button" className="btn btn-sm btn-secondary" onClick={() => runAI(idx, 'subject')}>📝 Subject Lines</button>
                          {idx > 0 && <button type="button" className="btn btn-sm btn-secondary" onClick={() => runAI(idx, 'followup')}>↩ Generate Follow-up</button>}
                          <button type="button" className="btn btn-sm btn-secondary" onClick={() => runAI(idx, 'spam')}>🚫 Check Spam</button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex-center gap-8" style={{ marginTop: 8 }}>
              <button className="btn btn-secondary" onClick={addFollowUp} disabled={emails.length >= MAX_TOTAL_EMAILS}>+ Add Follow-up</button>
              <button className="btn btn-primary" onClick={saveEmails} disabled={saving}>
                {saving ? 'Saving...' : 'Save All Emails'}
              </button>
            </div>
            <div className="form-hint" style={{ marginTop: 10 }}>
              Limit: {MAX_FOLLOWUPS} follow-ups max ({MAX_TOTAL_EMAILS} total emails)
            </div>
          </div>
        )}

        {/* TAB 3: Preview & Launch */}
        {tab === 3 && (
          <div style={{ maxWidth: 600 }}>
            <div className="card" style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 16 }}>Launch Checklist</div>
              {[
                { label: 'Sequence name set', ok: !!name },
                { label: 'Sender email configured', ok: !!(fromEmail || smtpAccountId) },
                { label: 'Contacts uploaded', ok: contactCount > 0, detail: contactCount > 0 ? `${contactCount} contacts` : 'Upload a CSV' },
                { label: 'Initial email written', ok: !!emails[0]?.subject && !!emails[0]?.body },
                { label: 'Initial send time set', ok: !!emails[0]?.scheduled_at, detail: emails[0]?.scheduled_at ? new Date(emails[0].scheduled_at).toLocaleString() : 'Set a date/time' },
                { label: 'Follow-ups configured', ok: emails.length > 1, detail: emails.length > 1 ? `${Math.min(emails.length - 1, MAX_FOLLOWUPS)} follow-up(s)` : 'Optional' },
                { label: 'Attachment ready', ok: true, detail: attachFilename || 'None (optional)' },
              ].map(item => (
                <div key={item.label} className="flex-center gap-12" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 16 }}>{item.ok ? '✅' : '⚠️'}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{item.label}</div>
                    {item.detail && <div className="text-xs" style={{ marginTop: 2 }}>{item.detail}</div>}
                  </div>
                </div>
              ))}
            </div>

            <div className="card" style={{ marginBottom: 20 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Sequence Summary</div>
              <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 2 }}>
                <div>📧 From: <strong style={{ color: 'var(--text)' }}>{smtpAccountId ? `SMTP: ${smtpAccounts.find(a=>a.id===smtpAccountId)?.smtp_user || smtpAccountId}` : (fromEmail || 'Not set')}</strong></div>
                <div>👥 Contacts: <strong style={{ color: 'var(--text)' }}>{contactCount}</strong></div>
                <div>📬 Steps: <strong style={{ color: 'var(--text)' }}>{emails.length} ({emails.length === 1 ? 'initial only' : `1 initial + ${Math.min(emails.length - 1, MAX_FOLLOWUPS)} follow-up(s)`})</strong></div>
                <div>📎 Attachment: <strong style={{ color: 'var(--text)' }}>{attachFilename || 'None'}</strong></div>
                <div>✍️ Signature: <strong style={{ color: 'var(--text)' }}>{includeSignature ? 'Included' : 'Not included'}</strong></div>
                <div>👁 Open Tracking: <strong style={{ color: 'var(--text)' }}>{openTracking ? 'Enabled' : 'Disabled'}</strong></div>
                <div>⏱ Delay: <strong style={{ color: 'var(--text)' }}>{sendDelay}s between emails</strong></div>
              </div>
            </div>

            {(!fromEmail && !smtpAccountId || contactCount === 0 || !emails[0]?.subject || !emails[0]?.scheduled_at) ? (
              <div className="alert alert-warning">
                ⚠️ Please complete all required fields before launching
              </div>
            ) : (
              <button className="btn btn-primary btn-lg" style={{ width: '100%' }} onClick={launch}>
                🚀 Launch Sequence — Send to {contactCount} Contacts
              </button>
            )}
          </div>
        )}
      </div>

      {/* AI Result Panel */}
      {aiPanel && (
        <div className="modal-overlay" onClick={() => { setAiPanel(null); setAiResult(''); }}>
          <div className="modal" style={{ maxWidth: 540, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header" style={{ background: 'linear-gradient(135deg, #6c63ff, #8b84ff)' }}>
              <div className="modal-title" style={{ color: '#fff' }}>
                {aiPanel.mode === 'improve' && '✨ AI Email Improvement'}
                {aiPanel.mode === 'subject' && '📝 AI Subject Line Suggestions'}
                {aiPanel.mode === 'followup' && '↩ AI Follow-up Email'}
                {aiPanel.mode === 'spam' && '🚫 Spam Analysis'}
              </div>
              <button className="btn btn-ghost btn-icon" style={{ color: '#fff' }} onClick={() => { setAiPanel(null); setAiResult(''); }}>✕</button>
            </div>
            <div className="modal-body" style={{ flex: 1, overflowY: 'auto' }}>
              {aiLoading ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '32px 0', gap: 12 }}>
                  <div className="spinner" style={{ width: 32, height: 32 }} />
                  <div style={{ color: 'var(--text2)', fontSize: 13 }}>Claude is thinking...</div>
                </div>
              ) : (
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.7, color: 'var(--text)', background: 'var(--bg3)', padding: 16, borderRadius: 8 }}>
                  {aiResult}
                </div>
              )}
            </div>
            {!aiLoading && aiResult && (
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => { setAiPanel(null); setAiResult(''); }}>Discard</button>
                {(aiPanel.mode === 'improve' || aiPanel.mode === 'followup' || aiPanel.mode === 'subject') && (
                  <button className="btn btn-primary" onClick={() => applyAiResult(aiPanel.idx, aiPanel.mode)}>
                    {aiPanel.mode === 'subject' ? 'Apply First Subject' : 'Apply to Email'}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}