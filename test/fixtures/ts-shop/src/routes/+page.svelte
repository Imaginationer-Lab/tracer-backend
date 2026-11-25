<script lang="ts">
  import { PUBLIC_SUPABASE_URL } from '$env/static/public';
  import { createClient } from '@supabase/supabase-js';

  const supabase = createClient(PUBLIC_SUPABASE_URL, 'public-anon-key');
  const session = supabase.auth.getSession();
</script>

<h1>Welcome</h1>
