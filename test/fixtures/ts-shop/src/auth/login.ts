export function login(email: string, password: string) {
  return fetch(`https://${process.env.SUPABASE_PROJECT_REF}.supabase.co/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_ANON_KEY ?? '' },
    body: JSON.stringify({ email, password }),
  });
}
