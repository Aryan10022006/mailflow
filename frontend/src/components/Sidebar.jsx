import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useEffect, useState } from 'react';

export default function Sidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [dark, setDark] = useState(() => localStorage.getItem('theme') !== 'light');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, [dark]);

  const handleLogout = () => { logout(); navigate('/login'); };

  return (
    <div className="sidebar">
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon">✉️</div>
        <div className="sidebar-logo-text">MailFlow</div>
      </div>
      <nav className="sidebar-nav">
        <NavLink to="/" end className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="icon">📊</span> Dashboard
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="icon">⚙️</span> Settings
        </NavLink>
      </nav>
      <div className="sidebar-bottom">
        <div style={{ padding: '8px 12px', marginBottom: 4 }}>
          <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 2 }}>Logged in as</div>
          <div style={{ fontSize: 12, color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {user?.gmail_email || user?.email}
          </div>
        </div>
        <button className="nav-item" onClick={() => setDark(d => !d)}>
          <span className="icon">{dark ? '☀️' : '🌙'}</span> {dark ? 'Light Mode' : 'Dark Mode'}
        </button>
        <button className="nav-item" onClick={handleLogout}>
          <span className="icon">↩</span> Logout
        </button>
      </div>
    </div>
  );
}
