import os

import httpx

SUPABASE_URL = os.getenv("SUPABASE_URL")


async def sign_in(email: str, password: str):
    async with httpx.AsyncClient(timeout=5) as client:
        r = await client.post(f"{SUPABASE_URL}/auth/v1/token?grant_type=password", json={"email": email, "password": password})
        r.raise_for_status()
        return r.json()
