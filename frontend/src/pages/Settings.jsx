import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import toast from 'react-hot-toast';

export default function Settings() {
  const { user, refreshUser } = useAuth();
  const [searchParams] = useSearchParams();
  const [aliases, setAliases] = useState([]);
  const [signature, setSignature] = useState('');
  const [savingSig, setSavingSig] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [smtpAccounts, setSmtpAccounts] = useState([]);
  const [showSmtpForm, setShowSmtpForm] = useState(false);
  const [smtpForm, setSmtpForm] = useState({
    smtp_host: 'smtp-auth.iitb.ac.in',
    smtp_port: '587',
    smtp_user: '',
    smtp_password: '',
    display_name: '',
    imap_host: '',
    imap_port: '993'
  });
  const [showImapFields, setShowImapFields] = useState(false);
  const [addingSmtp, setAddingSmtp] = useState(false);
  const [editingSmtp, setEditingSmtp] = useState(null); // id of account being edited
  const [imapEditForm, setImapEditForm] = useState({ imap_host: '', imap_port: '993' });
  const [savingImap, setSavingImap] = useState(false);

  useEffect(() => {
    const gmailStatus = searchParams.get('gmail');
    if (gmailStatus === 'connected') toast.success('Gmail connected successfully!');
    if (gmailStatus === 'error') toast.error('Gmail connection failed: ' + (searchParams.get('msg') || 'Unknown error'));
  }, []);

  useEffect(() => {
    if (user?.signature) setSignature(user.signature);
    if (user?.gmail_email) {
      api.get('/auth/gmail/aliases').then(res => setAliases(res.data)).catch(() => {});
    }
    loadSmtpAccounts();
  }, [user]);

  const loadSmtpAccounts = async () => {
    try {
      const res = await api.get('/smtp');
      setSmtpAccounts(res.data);
    } catch {}
  };

  const connectGmail = async () => {
    setConnecting(true);
    try {
      const res = await api.get('/auth/gmail/url');
      window.location.href = res.data.url;
    } catch { toast.error('Failed to get auth URL'); setConnecting(false); }
  };

  const disconnectGmail = async () => {
    if (!window.confirm('Disconnect Gmail? Active sequences using Gmail will stop sending.')) return;
    await api.post('/auth/gmail/disconnect');
    await refreshUser();
    setAliases([]);
    toast.success('Gmail disconnected');
  };

  const saveSignature = async () => {
    setSavingSig(true);
    try {
      await api.put('/auth/signature', { signature });
      toast.success('Signature saved');
    } catch { toast.error('Failed'); }
    finally { setSavingSig(false); }
  };

  const addSmtp = async (e) => {
    e.preventDefault();
    setAddingSmtp(true);
    try {
      await api.post('/smtp', smtpForm);
      toast.success('SMTP account connected!');
      setShowSmtpForm(false);
      setSmtpForm({ smtp_host: 'smtp-auth.iitb.ac.in', smtp_port: '587', smtp_user: '', smtp_password: '', display_name: '', imap_host: '', imap_port: '993' });
      setShowImapFields(false);
      loadSmtpAccounts();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to connect SMTP');
    } finally {
      setAddingSmtp(false);
    }
  };

  const deleteSmtp = async (id) => {
    if (!window.confirm('Remove this SMTP account?')) return;
    try {
      await api.delete(`/smtp/${id}`);
      toast.success('SMTP account removed');
      loadSmtpAccounts();
    } catch { toast.error('Failed'); }
  };

  const startEditImap = (account) => {
    setImapEditForm({ imap_host: account.imap_host || '', imap_port: String(account.imap_port || 993) });
    setEditingSmtp(account.id);
  };

  const saveImapSettings = async (e, id) => {
    e.preventDefault();
    setSavingImap(true);
    try {
      await api.put(`/smtp/${id}`, imapEditForm);
      toast.success('IMAP settings saved — reply detection enabled!');
      setEditingSmtp(null);
      loadSmtpAccounts();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save IMAP settings');
    } finally {
      setSavingImap(false);
    }
  };

  return (
    <div className="main-content">
      <div className="page-header">
        <div>
          <div className="page-title">Settings</div>
          <div className="page-subtitle">Configure your email connections and preferences</div>
        </div>
      </div>

      <div className="page-body" style={{ maxWidth: 600 }}>

        {/* Gmail Connection */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>📧 Gmail Connection</div>
          <div className="text-sm text-muted" style={{ marginBottom: 16 }}>
            Connect Gmail to send via Gmail API and detect replies
          </div>

          {user?.gmail_email ? (
            <div>
              <div className="alert alert-success" style={{ marginBottom: 14 }}>
                ✅ Connected as <strong>{user.gmail_email}</strong>
                {user.gmail_connected_at && <span style={{ marginLeft: 8, opacity: 0.7 }}>since {new Date(user.gmail_connected_at.replace('Z','').replace(/[+-]\d{2}:\d{2}$/, '')).toLocaleDateString('en-IN')}</span>}
              </div>

              {aliases.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div className="form-label" style={{ marginBottom: 8 }}>Send As Aliases Detected</div>
                  {aliases.map(a => (
                    <div key={a.email} className="flex-center gap-8" style={{ padding: '8px 12px', background: 'var(--bg3)', borderRadius: 6, marginBottom: 6 }}>
                      <span style={{ fontSize: 13 }}>📧</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 500, fontSize: 13 }}>{a.email}</div>
                        {a.name && <div className="text-xs">{a.name}</div>}
                      </div>
                      {a.isPrimary && <span className="badge badge-active">Primary</span>}
                    </div>
                  ))}
                </div>
              )}

              <button className="btn btn-danger btn-sm" onClick={disconnectGmail}>Disconnect Gmail</button>
            </div>
          ) : (
            <div>
              <div className="alert alert-warning" style={{ marginBottom: 14 }}>
                ⚠️ Gmail not connected.
              </div>
              <button className="btn btn-primary" onClick={connectGmail} disabled={connecting}>
                {connecting ? 'Redirecting...' : '🔗 Connect Gmail'}
              </button>
            </div>
          )}
        </div>

        {/* SMTP Accounts */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>🔌 SMTP Accounts</div>
            <button className="btn btn-primary btn-sm" onClick={() => setShowSmtpForm(t => !t)}>
              {showSmtpForm ? 'Cancel' : '+ Add SMTP'}
            </button>
          </div>
          <div className="text-sm text-muted" style={{ marginBottom: 16 }}>
            Connect via SMTP for unlimited sending through your own mail server
          </div>

          {smtpAccounts.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              {smtpAccounts.map(a => (
                <div key={a.id} style={{ marginBottom: 8 }}>
                  <div className="flex-center gap-8" style={{ padding: '8px 12px', background: 'var(--bg3)', borderRadius: editingSmtp === a.id ? '6px 6px 0 0' : 6 }}>
                    <span style={{ fontSize: 13 }}>🔌</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500, fontSize: 13 }}>{a.smtp_user}</div>
                      <div className="text-xs">{a.display_name} · {a.smtp_host}:{a.smtp_port}</div>
                      <div className="text-xs" style={{ color: a.imap_host ? 'var(--success, #22c55e)' : 'var(--text3)' }}>
                        {a.imap_host
                          ? `✓ Reply detection active: ${a.imap_host}:${a.imap_port || 993}`
                          : '⚠ No IMAP — reply detection disabled'}
                      </div>
                    </div>
                    <button className="btn btn-secondary btn-sm" onClick={() => editingSmtp === a.id ? setEditingSmtp(null) : startEditImap(a)}>
                      {editingSmtp === a.id ? 'Cancel' : '⚙ Set IMAP'}
                    </button>
                    <span className="badge badge-active">Connected</span>
                    <button className="btn btn-danger btn-sm" onClick={() => deleteSmtp(a.id)}>✕</button>
                  </div>
                  {editingSmtp === a.id && (
                    <form onSubmit={e => saveImapSettings(e, a.id)} style={{ background: 'var(--bg3)', borderTop: '1px solid var(--border)', padding: '12px 12px', borderRadius: '0 0 6px 6px' }}>
                      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>
                        IMAP host for reply detection. Uses same username/password as SMTP.
                        {a.smtp_host?.startsWith('smtp.gmail.com') && <span style={{ color: 'var(--accent)' }}> For Gmail: use <strong>imap.gmail.com</strong></span>}
                        {a.smtp_host?.includes('iitb') && <span style={{ color: 'var(--accent)' }}> For IITB: try <strong>imap.iitb.ac.in</strong> or ask IT for the IMAP server</span>}
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                        <div style={{ flex: 3 }} className="form-group" style={{ margin: 0, flex: 3 }}>
                          <label className="form-label" style={{ marginBottom: 4 }}>IMAP Host</label>
                          <input className="input" placeholder="e.g. imap.gmail.com" value={imapEditForm.imap_host}
                            onChange={e => setImapEditForm(f => ({ ...f, imap_host: e.target.value }))} />
                        </div>
                        <div style={{ width: 80 }} className="form-group" style={{ margin: 0, width: 80 }}>
                          <label className="form-label" style={{ marginBottom: 4 }}>Port</label>
                          <input className="input" placeholder="993" value={imapEditForm.imap_port}
                            onChange={e => setImapEditForm(f => ({ ...f, imap_port: e.target.value }))} />
                        </div>
                        <button type="submit" className="btn btn-primary" disabled={savingImap} style={{ marginBottom: 0 }}>
                          {savingImap ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              ))}
            </div>
          )}

          {smtpAccounts.length === 0 && !showSmtpForm && (
            <div style={{ color: 'var(--text3)', fontSize: 13, marginBottom: 12 }}>No SMTP accounts connected yet.</div>
          )}

          {showSmtpForm && (
            <form onSubmit={addSmtp} style={{ background: 'var(--bg3)', padding: 16, borderRadius: 8, marginTop: 8 }}>
              <div className="form-group">
                <label className="form-label">Display Name</label>
                <input className="input" placeholder="e.g. Manish Chahar" value={smtpForm.display_name}
                  onChange={e => setSmtpForm(f => ({ ...f, display_name: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label className="form-label">SMTP Host</label>
                <input className="input" value={smtpForm.smtp_host}
                  onChange={e => setSmtpForm(f => ({ ...f, smtp_host: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label className="form-label">Port</label>
                <input className="input" value={smtpForm.smtp_port}
                  onChange={e => setSmtpForm(f => ({ ...f, smtp_port: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label className="form-label">Username (Email)</label>
                <input className="input" type="email" placeholder="manish.chahar@iitb.ac.in" value={smtpForm.smtp_user}
                  onChange={e => setSmtpForm(f => ({ ...f, smtp_user: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label className="form-label">Password</label>
                <input className="input" type="password" placeholder="Your webmail password" value={smtpForm.smtp_password}
                  onChange={e => setSmtpForm(f => ({ ...f, smtp_password: e.target.value }))} required />
              </div>
              <div style={{ borderTop: '1px solid var(--border)', marginTop: 12, paddingTop: 12 }}>
                <button type="button" className="btn btn-secondary btn-sm" style={{ marginBottom: 10 }}
                  onClick={() => setShowImapFields(v => !v)}>
                  {showImapFields ? '▲ Hide IMAP settings' : '▼ Add IMAP settings (for reply detection)'}
                </button>
                {showImapFields && (
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>
                      IMAP lets MailFlow check your inbox for replies and automatically stop follow-ups. Uses the same password as SMTP.
                    </div>
                    <div className="form-group">
                      <label className="form-label">IMAP Host</label>
                      <input className="input" placeholder="e.g. imap.iitb.ac.in or mail.yourdomain.com"
                        value={smtpForm.imap_host}
                        onChange={e => setSmtpForm(f => ({ ...f, imap_host: e.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">IMAP Port</label>
                      <input className="input" placeholder="993" value={smtpForm.imap_port}
                        onChange={e => setSmtpForm(f => ({ ...f, imap_port: e.target.value }))} />
                    </div>
                  </div>
                )}
              </div>
              <button type="submit" className="btn btn-primary" disabled={addingSmtp}>
                {addingSmtp ? 'Connecting & Verifying...' : '🔌 Connect SMTP'}
              </button>
            </form>
          )}
        </div>

        {/* Signature */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Email Signature</div>
          <div className="text-sm text-muted" style={{ marginBottom: 16 }}>
            Appended to emails when "Include Signature" is enabled in a sequence.
          </div>
          <div className="form-group">
            <textarea className="textarea" style={{ minHeight: 120, fontFamily: 'inherit' }}
              value={signature} onChange={e => setSignature(e.target.value)}
              placeholder={"Your Name\nYour Title | Your Company\nPhone | Website"} />
            <div className="form-hint">Supports plain text and basic HTML</div>
          </div>
          <button className="btn btn-primary" onClick={saveSignature} disabled={savingSig}>
            {savingSig ? 'Saving...' : 'Save Signature'}
          </button>
        </div>

        {/* Account info */}
        <div className="card">
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Account</div>
          <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 6 }}>
            Logged in as: <strong style={{ color: 'var(--text)' }}>{user?.email}</strong>
          </div>
          <div className="divider" />
          <div style={{ fontSize: 12, color: 'var(--text3)', lineHeight: 1.8 }}>
            <div>📬 Gmail API: sends via Gmail, detects replies automatically</div>
            <div>🔌 SMTP: sends via your mail server, no daily limits</div>
            <div>💬 SMTP reply detection: requires IMAP host to be configured above</div>
            <div>🔄 Scheduler checks every 5 minutes for pending sends</div>
            <div>💬 Reply detection runs every 15 minutes (Gmail + SMTP via IMAP)</div>
          </div>
        </div>
      </div>
    </div>
  );
}
