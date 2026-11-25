from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    stripe_api_key: str = ""
    supabase_url: str = ""


settings = Settings()
