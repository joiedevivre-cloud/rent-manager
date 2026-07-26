import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import Layout from './components/Layout'
import LoginPage from './pages/LoginPage'
import Dashboard from './pages/Dashboard'
import Bills from './pages/Bills'
import Tenants from './pages/Tenants'
import TenantDetail from './pages/Tenants/Detail'
import TenantEdit from './pages/Tenants/Edit'
import TenantNew from './pages/Tenants/New'
import Units from './pages/Units'
import Overdue from './pages/Overdue'
import './index.css'

const queryClient = new QueryClient()

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth()
  if (loading) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-gray-400">로딩 중...</div>
    </div>
  )
  if (!user) return <Navigate to="/login" replace />
  return children
}

function AppRoutes() {
  const { user } = useAuth()
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="payments" element={<Navigate to="/" replace />} />
        <Route path="bills" element={<Bills />} />
        <Route path="tenants" element={<Tenants />} />
        <Route path="tenants/new" element={<TenantNew />} />
        <Route path="tenants/:id" element={<TenantDetail />} />
        <Route path="tenants/:id/edit" element={<TenantEdit />} />
        <Route path="units" element={<Units />} />
        <Route path="overdue" element={<Overdue />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  useEffect(() => {
    const key = import.meta.env.VITE_KAKAO_JS_KEY
    if (key && window.Kakao && !window.Kakao.isInitialized()) {
      window.Kakao.init(key)
    }
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
