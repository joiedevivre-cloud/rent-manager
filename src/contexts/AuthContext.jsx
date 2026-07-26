import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [accessDenied, setAccessDenied] = useState(false)

  async function checkAllowed(email) {
    const { data } = await supabase
      .from('allowed_emails')
      .select('email, name')
      .eq('email', email)
      .single()
    return data
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session?.user) {
        const allowed = await checkAllowed(session.user.email)
        if (!allowed) {
          await supabase.auth.signOut()
          setAccessDenied(true)
          setUser(null)
        } else {
          setUser(session.user)
          setAccessDenied(false)
        }
      }
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (session?.user) {
        const allowed = await checkAllowed(session.user.email)
        if (!allowed) {
          await supabase.auth.signOut()
          setAccessDenied(true)
          setUser(null)
        } else {
          setUser(session.user)
          setAccessDenied(false)
        }
      } else {
        setUser(null)
        if (event === 'SIGNED_OUT') {
          // keep accessDenied state if set
        }
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function signInWithGoogle() {
    setAccessDenied(false)
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
      },
    })
    if (error) throw error
  }

  async function signInWithKakao() {
    setAccessDenied(false)
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'kakao',
      options: {
        redirectTo: window.location.origin,
      },
    })
    if (error) throw error
  }

  async function signOut() {
    await supabase.auth.signOut()
    setUser(null)
    setAccessDenied(false)
  }

  return (
    <AuthContext.Provider value={{ user, loading, accessDenied, signInWithGoogle, signInWithKakao, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
