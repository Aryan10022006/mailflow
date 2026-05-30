import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../utils/api';
import toast from 'react-hot-toast';

const STATUS_COLORS = {
  active: 'badge-active', paused: 'badge-paused', stopped: 'badge-stopped',
  draft: 'badge-draft', completed: 'badge-completed'
};

const FOLDER_COLORS = [
  '#6c63ff', '#22d3a5', '#ff5c7a', '#ffb547', '#4db8ff',
  '#a855f7', '#f97316', '#10b981', '#ef4444', '#3b82f6'
];

export default function Dashboard() {
  const [folders, setFolders] = useState([]);
  const [sequences, setSequences] = useState([]);
  const [trashed, setTrashed] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showTrash, setShowTrash] = useState(false);
  const [openFolder, setOpenFolder] = useState(null); // folder id
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [showCreateSeq, setShowCreateSeq] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderColor, setNewFolderColor] = useState('#6c63ff');
  const [newSeqName, setNewSeqName] = useState('');
  const [newSeqFolder, setNewSeqFolder] = useState('');
  const [creating, setCreating] = useState(false);
  const [editFolder, setEditFolder] = useState(null); // { id, name, color }
  const [dragSeq, setDragSeq] = useState(null); // sequence being dragged
  const [dragOver, setDragOver] = useState(null); // folder id being dragged over
  const navigate = useNavigate();

  const load = async () => {
    try {
      const [fRes, sRes] = await Promise.all([
        api.get('/folders'),
        api.get('/sequences')
      ]);
      setFolders(fRes.data);
      setSequences(sRes.data);
      // Auto-open first folder if none open
      if (!openFolder && fRes.data.length > 0) {
        setOpenFolder(fRes.data[0].id);
      }
    } catch (err) {
      toast.error('Failed to load');
    } finally {
      setLoading(false);
    }
  };

  const loadTrash = async () => {
    try {
      const res = await api.get('/sequences/trash');
      setTrashed(res.data);
    } catch { toast.error('Failed to load trash'); }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { if (showTrash) loadTrash(); }, [showTrash]);

  // --- Folder actions ---
  const createFolder = async (e) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    try {
      await api.post('/folders', { name: newFolderName.trim(), color: newFolderColor });
      toast.success('Folder created!');
      setShowCreateFolder(false);
      setNewFolderName('');
      setNewFolderColor('#6c63ff');
      load();
    } catch { toast.error('Failed to create folder'); }
  };

  const saveEditFolder = async (e) => {
    e.preventDefault();
    try {
      await api.put(`/folders/${editFolder.id}`, { name: editFolder.name, color: editFolder.color });
      toast.success('Folder updated!');
      setEditFolder(null);
      load();
    } catch { toast.error('Failed to update folder'); }
  };

  const deleteFolder = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm('Delete folder? Sequences inside will become unfoldered.')) return;
    try {
      await api.delete(`/folders/${id}`);
      toast.success('Folder deleted');
      if (openFolder === id) setOpenFolder(null);
      load();
    } catch { toast.error('Failed'); }
  };

  // --- Sequence actions ---
  const createSeq = async (e) => {
    e.preventDefault();
    if (!newSeqName.trim() || !newSeqFolder) return toast.error('Please select a folder');
    setCreating(true);
    try {
      const res = await api.post('/sequences', { name: newSeqName.trim() });
      await api.post('/folders/move', { sequence_id: res.data.id, folder_id: newSeqFolder });
      toast.success('Sequence created!');
      navigate(`/sequences/${res.data.id}/edit`);
    } catch { toast.error('Failed to create'); setCreating(false); }
  };

  const duplicate = async (id, e) => {
    e.stopPropagation();
    try {
      const res = await api.post(`/sequences/${id}/duplicate`);
      // Keep in same folder
      const orig = sequences.find(s => s.id === id);
      if (orig?.folder_id) await api.post('/folders/move', { sequence_id: res.data.id, folder_id: orig.folder_id });
      toast.success('Duplicated!');
      navigate(`/sequences/${res.data.id}/edit`);
    } catch { toast.error('Failed'); }
  };

  const pause = async (id, e) => {
    e.stopPropagation();
    try { await api.post(`/sequences/${id}/pause`); toast.success('Paused'); load(); }
    catch { toast.error('Failed'); }
  };

  const resume = async (id, e) => {
    e.stopPropagation();
    try { await api.post(`/sequences/${id}/resume`); toast.success('Resumed'); load(); }
    catch { toast.error('Failed'); }
  };

  const stop = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm('Stop this sequence?')) return;
    try { await api.post(`/sequences/${id}/stop`); toast.success('Stopped'); load(); }
    catch { toast.error('Failed'); }
  };

  const trashSeq = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm('Move to trash? Deleted after 7 days.')) return;
    try { await api.post(`/sequences/${id}/trash`); toast.success('Moved to trash'); load(); }
    catch { toast.error('Failed'); }
  };

  const restoreSeq = async (id) => {
    try { await api.post(`/sequences/${id}/restore`); toast.success('Restored!'); loadTrash(); load(); }
    catch { toast.error('Failed'); }
  };

  const deleteForever = async (id) => {
    if (!window.confirm('Permanently delete?')) return;
    try { await api.delete(`/sequences/${id}`); toast.success('Deleted'); loadTrash(); }
    catch { toast.error('Failed'); }
  };

  // --- Drag and Drop ---
  const onDragStart = (e, seq) => {
    setDragSeq(seq);
    e.dataTransfer.effectAllowed = 'move';
  };

  const onDragOver = (e, folderId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(folderId);
  };

  const onDrop = async (e, folderId) => {
    e.preventDefault();
    setDragOver(null);
    if (!dragSeq || dragSeq.folder_id === folderId) return;
    try {
      await api.post('/folders/move', { sequence_id: dragSeq.id, folder_id: folderId });
      toast.success(`Moved to folder!`);
      load();
    } catch { toast.error('Failed to move'); }
    setDragSeq(null);
  };

  const daysLeft = (trashedAt) => Math.max(0, 7 - Math.floor((Date.now() - new Date(trashedAt)) / (1000 * 60 * 60 * 24)));

  const folderSeqs = (folderId) => sequences.filter(s => s.folder_id === folderId);
  const unfoldered = sequences.filter(s => !s.folder_id);

  const totalStats = sequences.reduce((acc, s) => ({
    total: acc.total + parseInt(s.total_contacts || 0),
    sent: acc.sent + parseInt(s.sent_count || 0),
    opened: acc.opened + parseInt(s.opened_count || 0),
    replied: acc.replied + parseInt(s.replied_count || 0),
  }), { total: 0, sent: 0, opened: 0, replied: 0 });

  return (
    <div className="main-content">
      <div className="page-header">
        <div>
          <div className="page-title">{showTrash ? '🗑 Trash' : 'Dashboard'}</div>
          <div className="page-subtitle">{showTrash ? 'Sequences deleted after 7 days' : 'Organise your email sequences in folders'}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => setShowTrash(t => !t)}>
            {showTrash ? '← Back' : '🗑 Trash'}
          </button>
          {!showTrash && <>
            <button className="btn btn-secondary" onClick={() => setShowCreateFolder(true)}>📁 New Folder</button>
            <button className="btn btn-primary" onClick={() => setShowCreateSeq(true)}>+ New Sequence</button>
          </>}
        </div>
      </div>

      <div className="page-body">
        {!showTrash ? (
          <>
            {/* Stats */}
            <div className="stats-grid" style={{ marginBottom: 24 }}>
              {[
                { label: 'Total Contacts', value: totalStats.total, color: 'var(--text)' },
                { label: 'Emails Sent', value: totalStats.sent, color: 'var(--green)' },
                { label: 'Opened', value: totalStats.opened, color: 'var(--yellow)' },
                { label: 'Replied', value: totalStats.replied, color: 'var(--accent2)' },
              ].map(s => (
                <div key={s.label} className="stat-card">
                  <div className="stat-value" style={{ color: s.color }}>{s.value}</div>
                  <div className="stat-label">{s.label}</div>
                </div>
              ))}
            </div>

            {loading ? <div className="page-loader"><div className="spinner" /></div> : (
              <>
                {/* Folders */}
                {folders.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-state-icon">📁</div>
                    <div className="empty-state-title">No folders yet</div>
                    <div className="empty-state-desc">Create a folder to organise your sequences</div>
                    <button className="btn btn-primary" onClick={() => setShowCreateFolder(true)}>Create Folder</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {folders.map(folder => (
                      <div key={folder.id}
                        onDragOver={e => onDragOver(e, folder.id)}
                        onDragLeave={() => setDragOver(null)}
                        onDrop={e => onDrop(e, folder.id)}
                        style={{
                          border: `2px solid ${dragOver === folder.id ? folder.color : 'var(--border)'}`,
                          borderRadius: 12,
                          overflow: 'hidden',
                          transition: 'border-color 0.2s',
                          background: dragOver === folder.id ? `${folder.color}10` : 'var(--bg2)'
                        }}>
                        {/* Folder Header */}
                        <div
                          style={{ padding: '12px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: openFolder === folder.id ? '1px solid var(--border)' : 'none' }}
                          onClick={() => setOpenFolder(openFolder === folder.id ? null : folder.id)}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontSize: 20 }}>{openFolder === folder.id ? '📂' : '📁'}</span>
                            <div>
                              <div style={{ fontWeight: 700, fontSize: 14, color: folder.color }}>{folder.name}</div>
                              <div style={{ fontSize: 11, color: 'var(--text3)' }}>{folder.sequence_count} sequence{folder.sequence_count !== 1 ? 's' : ''}</div>
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
                            <button className="btn btn-ghost btn-sm" onClick={() => setEditFolder({ id: folder.id, name: folder.name, color: folder.color })} title="Rename">✏️</button>
                            <button className="btn btn-danger btn-sm" onClick={e => deleteFolder(folder.id, e)} title="Delete">🗑</button>
                            <span style={{ color: 'var(--text3)', fontSize: 18, marginLeft: 4 }}>{openFolder === folder.id ? '▾' : '▸'}</span>
                          </div>
                        </div>

                        {/* Folder Contents */}
                        {openFolder === folder.id && (
                          <div style={{ padding: '8px 12px 12px' }}>
                            {folderSeqs(folder.id).length === 0 ? (
                              <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text3)', fontSize: 13 }}>
                                No sequences yet — drag one here or create new
                              </div>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {folderSeqs(folder.id).map(seq => (
                                  <div key={seq.id}
                                    draggable
                                    onDragStart={e => onDragStart(e, seq)}
                                    className="card card-hover"
                                    style={{ cursor: 'grab', padding: '12px 16px', opacity: dragSeq?.id === seq.id ? 0.5 : 1 }}
                                    onClick={() => navigate(`/sequences/${seq.id}`)}>
                                    <div className="flex-between">
                                      <div className="flex-center gap-12">
                                        <span style={{ color: 'var(--text3)', fontSize: 16 }}>⠿</span>
                                        <span className={`badge ${STATUS_COLORS[seq.status] || 'badge-draft'}`}>
                                          {seq.status === 'active' && '● '}{seq.status}
                                        </span>
                                        <div>
                                          <div style={{ fontWeight: 600, fontSize: 14 }}>{seq.name}</div>
                                          <div className="text-xs" style={{ marginTop: 2 }}>
                                            {seq.from_email || 'No sender'} · {seq.total_contacts || 0} contacts
                                          </div>
                                        </div>
                                      </div>
                                      <div className="flex-center gap-16">
                                        <div className="flex-center gap-12" style={{ fontSize: 12, color: 'var(--text2)' }}>
                                          <span>📤 {seq.sent_count || 0}</span>
                                          <span>👁 {seq.opened_count || 0}</span>
                                          <span>💬 {seq.replied_count || 0}</span>
                                          {seq.failed_count > 0 && <span style={{ color: 'var(--red)' }}>❌ {seq.failed_count}</span>}
                                        </div>
                                        <div className="flex-center gap-8" onClick={e => e.stopPropagation()}>
                                          <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/sequences/${seq.id}/edit`)}>✏️</button>
                                          <button className="btn btn-ghost btn-sm" onClick={e => duplicate(seq.id, e)}>⧉</button>
                                          {seq.status === 'active' && <button className="btn btn-ghost btn-sm" onClick={e => pause(seq.id, e)}>⏸</button>}
                                          {seq.status === 'paused' && <button className="btn btn-success btn-sm" onClick={e => resume(seq.id, e)}>▶</button>}
                                          {['active', 'paused'].includes(seq.status) && <button className="btn btn-danger btn-sm" onClick={e => stop(seq.id, e)}>⏹</button>}
                                          <button className="btn btn-danger btn-sm" onClick={e => trashSeq(seq.id, e)}>🗑</button>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}

                    {/* Unfoldered sequences */}
                    {unfoldered.length > 0 && (
                      <div style={{ border: '2px dashed var(--border)', borderRadius: 12, padding: 12 }}>
                        <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>📌 Unfoldered ({unfoldered.length}) — drag to a folder</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {unfoldered.map(seq => (
                            <div key={seq.id}
                              draggable
                              onDragStart={e => onDragStart(e, seq)}
                              className="card card-hover"
                              style={{ cursor: 'grab', padding: '12px 16px' }}
                              onClick={() => navigate(`/sequences/${seq.id}`)}>
                              <div className="flex-between">
                                <div className="flex-center gap-12">
                                  <span style={{ color: 'var(--text3)', fontSize: 16 }}>⠿</span>
                                  <span className={`badge ${STATUS_COLORS[seq.status] || 'badge-draft'}`}>{seq.status}</span>
                                  <div>
                                    <div style={{ fontWeight: 600, fontSize: 14 }}>{seq.name}</div>
                                    <div className="text-xs">{seq.from_email || 'No sender'} · {seq.total_contacts || 0} contacts</div>
                                  </div>
                                </div>
                                <div className="flex-center gap-8" onClick={e => e.stopPropagation()}>
                                  <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/sequences/${seq.id}/edit`)}>✏️</button>
                                  <button className="btn btn-danger btn-sm" onClick={e => trashSeq(seq.id, e)}>🗑</button>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          /* Trash view */
          <div>
            {trashed.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">🗑</div>
                <div className="empty-state-title">Trash is empty</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {trashed.map(seq => (
                  <div key={seq.id} className="card" style={{ padding: '16px 20px', opacity: 0.85 }}>
                    <div className="flex-between">
                      <div>
                        <div style={{ fontWeight: 600 }}>{seq.name}</div>
                        <div className="text-xs" style={{ color: 'var(--red)', marginTop: 2 }}>
                          🗑 {daysLeft(seq.trashed_at)} day(s) left
                        </div>
                      </div>
                      <div className="flex-center gap-8">
                        <button className="btn btn-secondary btn-sm" onClick={() => restoreSeq(seq.id)}>↩ Restore</button>
                        <button className="btn btn-danger btn-sm" onClick={() => deleteForever(seq.id)}>✕ Delete Forever</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create Folder Modal */}
      {showCreateFolder && (
        <div className="modal-overlay" onClick={() => setShowCreateFolder(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">📁 New Folder</div>
              <button className="btn btn-ghost btn-icon" onClick={() => setShowCreateFolder(false)}>✕</button>
            </div>
            <form onSubmit={createFolder}>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">Folder Name</label>
                  <input className="input" autoFocus value={newFolderName} onChange={e => setNewFolderName(e.target.value)} placeholder="e.g. FMCG Companies" required />
                </div>
                <div className="form-group">
                  <label className="form-label">Color</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                    {FOLDER_COLORS.map(c => (
                      <div key={c} onClick={() => setNewFolderColor(c)}
                        style={{ width: 28, height: 28, borderRadius: '50%', background: c, cursor: 'pointer', border: newFolderColor === c ? '3px solid var(--text)' : '3px solid transparent', transition: 'border 0.15s' }} />
                    ))}
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowCreateFolder(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Create Folder</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Folder Modal */}
      {editFolder && (
        <div className="modal-overlay" onClick={() => setEditFolder(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">✏️ Edit Folder</div>
              <button className="btn btn-ghost btn-icon" onClick={() => setEditFolder(null)}>✕</button>
            </div>
            <form onSubmit={saveEditFolder}>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">Folder Name</label>
                  <input className="input" autoFocus value={editFolder.name} onChange={e => setEditFolder(f => ({ ...f, name: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Color</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                    {FOLDER_COLORS.map(c => (
                      <div key={c} onClick={() => setEditFolder(f => ({ ...f, color: c }))}
                        style={{ width: 28, height: 28, borderRadius: '50%', background: c, cursor: 'pointer', border: editFolder.color === c ? '3px solid var(--text)' : '3px solid transparent' }} />
                    ))}
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setEditFolder(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create Sequence Modal */}
      {showCreateSeq && (
        <div className="modal-overlay" onClick={() => setShowCreateSeq(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">New Sequence</div>
              <button className="btn btn-ghost btn-icon" onClick={() => setShowCreateSeq(false)}>✕</button>
            </div>
            <form onSubmit={createSeq}>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">Sequence Name</label>
                  <input className="input" autoFocus value={newSeqName} onChange={e => setNewSeqName(e.target.value)} placeholder="e.g. Internship Outreach" required />
                </div>
                <div className="form-group">
                  <label className="form-label">Folder</label>
                  <select className="input" value={newSeqFolder} onChange={e => setNewSeqFolder(e.target.value)} required>
                    <option value="">Select a folder...</option>
                    {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                  {folders.length === 0 && <div className="form-hint" style={{ color: 'var(--red)' }}>Create a folder first!</div>}
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowCreateSeq(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={creating || folders.length === 0}>
                  {creating ? 'Creating...' : 'Create & Edit'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
