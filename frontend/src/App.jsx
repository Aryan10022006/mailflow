import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './hooks/useAuth';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import SequenceEditor from './pages/SequenceEditor';
import SequenceDetail from './pages/SequenceDetail';
import Settings from './pages/Settings';
import { LoginPage, SetupPage } from './pages/Auth';
import api from './utils/api';
import './index.css';

function AppRoutes() {
  const { user, loading } = useAuth();
  const [setupDone, setSetupDone] = useState(null);

  useEffect(() => {
    api.get('/auth/status').then(res => setSetupDone(res.data.setup)).catch(() => setSetupDone(false));
  }, []);

  if (loading || setupDone === null) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg)' }}>
      <div className="spinner" style={{ width: 32, height: 32 }} />
    </div>;
  }

  if (!setupDone) return <Routes><Route path="*" element={<SetupPage />} /></Routes>;
  if (!user) return <Routes><Route path="*" element={<LoginPage />} /></Routes>;

  return (
    <div className="app-layout">
      <Sidebar />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/sequences/:id" element={<SequenceDetail />} />
        <Route path="/sequences/:id/edit" element={<SequenceEditor />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
        <Toaster position="top-right" toastOptions={{
          style: { background: 'var(--bg3)', color: 'var(--text)', border: '1px solid var(--border)', fontSize: 13 },
          success: { iconTheme: { primary: 'var(--green)', secondary: 'var(--bg3)' } },
          error: { iconTheme: { primary: 'var(--red)', secondary: 'var(--bg3)' } },
        }} />
      </AuthProvider>
    </BrowserRouter>
  );
}
